#!/usr/bin/env node
// D15 W4: the sealed retrieval set. Model-free and product-free: candidates come from the frozen heads of clean input
// checkouts (tree-sitter-java declarations, MyBatis mapper XML), never from the product index, its ranking or any
// product result. Every task is a `locate` task: the agent-visible prompt names two anchors (an owner type and a
// member), and the private gold is the declaration head the anchors name (role declaration, the primary metric) plus,
// for implementations and xml tasks, the reached declarations (role relation, end-to-end only). Selection order,
// quotas and the audit sample are fixed by SEALED_RULES before anything runs; the dataset is written by the MAC-10
// converter (ilv2-mac-eval-dataset.mjs), so the retrieval runner and the ranking diagnosis read it unchanged.
//
//   generate  --inputs F --exclude-dataset M --out DIR      selection + audit sheet (private) and counts
//   freeze    --selection DIR --audit F --inputs F --out D   audited selection -> MAC-10 dataset (holdout = sealed)
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { CURATION_SCHEMA, TEST_SOURCE, assignSplits, convertDataset, leaks, readJsonl, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { assertPristineInput } from "./eval-mac10-live.mjs";
import { planQueries } from "./ilv2-mac-retrieval-eval.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

export const SELECTION_SCHEMA = "post-ilv2/sealed-selection/v1";
export const AUDIT_SCHEMA = "post-ilv2/sealed-audit/v1";
/** Pre-registered in docs/post-ilv2/d15-discovery-ranking.md §7; any change is a new rules version. */
export const SEALED_RULES = Object.freeze({
  version: "sealed-rules/v1",
  datasetId: "d15-sealed-v1",
  sampleSeed: "d15-sealed-20261112",
  auditSeed: "d15-audit-20261112",
  categories: Object.freeze(["declaration", "implementations", "xml"]),
  quotaPerStratum: 6,
  minSealed: 50,
  holdoutRatio: 0.85,
  auditRatio: 0.25,
  maxRelations: 5,
  overlapLimit: 0.5,
  // Trivial members a real task does not target: accessors with a body of at most 3 lines (an abstract or interface
  // method has no body and is never an accessor by length) and Object's own methods.
  accessor: "^(get|set|is)[A-Z]",
  accessorMaxLines: 3,
  objectMethods: Object.freeze(["toString", "equals", "hashCode"]),
  statements: Object.freeze(["select", "insert", "update", "delete"])
});
export const rulesDigest = rules => sha256(JSON.stringify(rules));

const TYPE_NODES = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]);
const order = (seed, ...parts) => createHash("sha256").update([seed, ...parts].join("\0")).digest("hex");

let parserInstance;
function parser() {
  if (!parserInstance) {
    const Parser = require("tree-sitter");
    parserInstance = new Parser();
    parserInstance.setLanguage(require("tree-sitter-java"));
  }
  return parserInstance;
}

/** Package, imports and every named type with its own methods (nested types are separate entries). */
export function javaFacts(source) {
  const tree = parser().parse(source);
  const root = tree.rootNode;
  const text = node => source.slice(node.startIndex, node.endIndex);
  const pkgNode = root.namedChildren.find(node => node.type === "package_declaration");
  const pkg = pkgNode ? text(pkgNode).replace(/^package\s+/, "").replace(/;\s*$/, "").replace(/\s+/g, "") : "";
  const imports = root.namedChildren.filter(node => node.type === "import_declaration").map(node => text(node).replace(/\s+/g, " ").trim())
    .filter(line => !/^import static /.test(line)).map(line => line.replace(/^import /, "").replace(/;$/, ""));
  const types = [];
  const visit = (node, outer) => {
    if (TYPE_NODES.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      if (!nameNode) return;
      const name = text(nameNode);
      const binary = outer ? `${outer}.${name}` : name;
      const supers = [];
      const interfaces = node.childForFieldName("interfaces");
      // super_interfaces > type_list > (type_identifier | scoped_type_identifier | generic_type); a generic's
      // type arguments are not supertypes, so only its own (first) name counts.
      for (const list of interfaces?.namedChildren.filter(child => child.type === "type_list") ?? []) {
        for (const item of list.namedChildren) {
          const named = item.type === "generic_type" ? item.namedChildren[0] : item;
          if (named && (named.type === "type_identifier" || named.type === "scoped_type_identifier")) supers.push(text(named).replace(/\s+/g, ""));
        }
      }
      const body = node.childForFieldName("body");
      const methods = [];
      for (const member of body?.namedChildren ?? []) {
        if (member.type !== "method_declaration") continue;
        const methodName = member.childForFieldName("name");
        const params = member.childForFieldName("parameters");
        methods.push({ name: text(methodName), arity: params ? params.namedChildren.filter(child => child.type === "formal_parameter" || child.type === "spread_parameter").length : 0,
          startLine: member.startPosition.row + 1, nameLine: methodName.startPosition.row + 1, endLine: member.endPosition.row + 1, hasBody: member.childForFieldName("body") !== null });
      }
      types.push({ name, binary, fqn: pkg ? `${pkg}.${binary}` : binary, kind: node.type.replace(/_declaration$/, ""), startLine: node.startPosition.row + 1,
        nameLine: nameNode.startPosition.row + 1, supers, methods });
      for (const member of body?.namedChildren ?? []) visit(member, binary);
      return;
    }
    for (const child of node.namedChildren) visit(child, outer);
  };
  visit(root, "");
  return { pkg, imports, types };
}

/** MyBatis mapper statements: namespace and, per statement, its id and the lines of its element. */
export function mapperFacts(source, statements = SEALED_RULES.statements) {
  const namespace = /<mapper\b[^>]*\bnamespace\s*=\s*"([^"]+)"/.exec(source)?.[1];
  if (!namespace) return null;
  const lineAt = index => source.slice(0, index).split("\n").length;
  const rows = [];
  const open = new RegExp(`<(${statements.join("|")})\\b([^>]*)>`, "g");
  for (const match of source.matchAll(open)) {
    const id = /\bid\s*=\s*"([^"]+)"/.exec(match[2])?.[1];
    if (!id) continue;
    const close = source.indexOf(`</${match[1]}>`, match.index);
    const end = match[2].trimEnd().endsWith("/") ? match.index + match[0].length : close < 0 ? -1 : close;
    if (end < 0) continue;
    rows.push({ id, startLine: lineAt(match.index), endLine: lineAt(end) });
  }
  return { namespace, statements: rows };
}

/** A simple or qualified type reference in a file, resolved to an indexed FQN: explicit import, same package, then on-demand imports. */
function resolveType(reference, file, typesByFqn) {
  if (reference.includes(".")) return typesByFqn.has(reference) ? reference : null;
  const explicit = file.imports.find(item => item.endsWith(`.${reference}`));
  if (explicit) return typesByFqn.has(explicit) ? explicit : null;
  const local = file.pkg ? `${file.pkg}.${reference}` : reference;
  if (typesByFqn.has(local)) return local;
  const onDemand = file.imports.filter(item => item.endsWith(".*")).map(item => `${item.slice(0, -2)}.${reference}`).filter(fqn => typesByFqn.has(fqn));
  return onDemand.length === 1 ? onDemand[0] : null;
}

const head = (file, member) => ({ path: file, startLine: member.startLine, endLine: member.nameLine });

/** Every eligible candidate of one corpus, deterministic in the frozen tree alone. */
export function corpusCandidates({ corpusId, javaFiles, xmlFiles, rules = SEALED_RULES }) {
  const accessor = new RegExp(rules.accessor);
  const files = [...javaFiles].sort((a, b) => a.path.localeCompare(b.path));
  const typesByFqn = new Map();
  const nameCount = new Map();
  const bump = key => nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
  const fqnCount = new Map();
  for (const file of files) for (const type of file.facts.types) fqnCount.set(type.fqn, (fqnCount.get(type.fqn) ?? 0) + 1);
  for (const file of files) {
    for (const type of file.facts.types) {
      // A FQN declared twice (two modules) cannot be resolved by name: relation rules skip it.
      if (fqnCount.get(type.fqn) === 1) typesByFqn.set(type.fqn, { file, type });
      bump(`type:${type.name}`);
      for (const method of type.methods) bump(`method:${method.name}`);
    }
  }
  const main = file => !TEST_SOURCE.test(file.path);
  const targetable = (type, method) => !method.hasBody || !accessor.test(method.name) || method.endLine - method.startLine + 1 > rules.accessorMaxLines;
  const single = (type, method) => type.methods.filter(item => item.name === method.name).length === 1;
  const usable = (type, method) => !rules.objectMethods.includes(method.name) && targetable(type, method) && single(type, method);
  const candidates = [];
  const add = (category, key, row) => candidates.push({ id: `S-${sha256(`${corpusId}\0${category}\0${key}`).slice(0, 16).toUpperCase()}`, corpusId, category, ...row });
  for (const file of files.filter(main)) {
    for (const type of file.facts.types) {
      const members = type.methods.filter(method => usable(type, method));
      for (const method of members) {
        add("declaration", `${type.fqn}#${method.name}`, { shape: "method", anchors: [type.name, method.name],
          prompt: `Locate the declaration of method \`${method.name}\` in type \`${type.name}\`.`,
          sameNameCount: nameCount.get(`method:${method.name}`), targets: [{ ...head(file.path, method), role: "declaration", why: `method ${type.fqn}#${method.name} declaration head` }] });
      }
      if (members.length > 0) {
        const member = [...members].sort((a, b) => order(rules.sampleSeed, corpusId, type.fqn, a.name).localeCompare(order(rules.sampleSeed, corpusId, type.fqn, b.name)))[0];
        add("declaration", type.fqn, { shape: "type", anchors: [type.name, member.name],
          prompt: `Locate the declaration of type \`${type.name}\`, the one that declares \`${member.name}\`.`,
          sameNameCount: nameCount.get(`type:${type.name}`), targets: [{ ...head(file.path, type), role: "declaration", why: `type ${type.fqn} declaration head` }] });
      }
    }
  }
  // implementations: an interface method and the same-name, same-arity methods of main classes implementing it.
  const implementors = new Map();
  for (const file of files.filter(main)) {
    for (const type of file.facts.types.filter(item => item.kind === "class" || item.kind === "enum" || item.kind === "record")) {
      for (const reference of type.supers) {
        const fqn = resolveType(reference.replace(/<.*$/, ""), file.facts, typesByFqn);
        if (!fqn) continue;
        if (!implementors.has(fqn)) implementors.set(fqn, []);
        implementors.get(fqn).push({ file, type });
      }
    }
  }
  for (const file of files.filter(main)) {
    for (const type of file.facts.types.filter(item => item.kind === "interface" && typesByFqn.get(item.fqn)?.type === item)) {
      for (const method of type.methods.filter(item => usable(type, item))) {
        const reached = (implementors.get(type.fqn) ?? []).flatMap(({ file: implFile, type: impl }) =>
          impl.methods.filter(item => item.name === method.name && item.arity === method.arity).map(item => ({ ...head(implFile.path, item), role: "relation", why: `${impl.fqn}#${method.name} implements ${type.fqn}#${method.name}` })));
        if (reached.length === 0 || reached.length > rules.maxRelations) continue;
        add("implementations", `${type.fqn}#${method.name}`, { shape: "method", anchors: [type.name, method.name],
          prompt: `Find the implementations of method \`${method.name}\` declared by interface \`${type.name}\`.`,
          sameNameCount: nameCount.get(`method:${method.name}`),
          targets: [{ ...head(file.path, method), role: "declaration", why: `interface method ${type.fqn}#${method.name} declaration head` }, ...reached] });
      }
    }
  }
  // xml: a mapper interface method and its one statement in a mapper XML outside test sources.
  for (const xml of [...xmlFiles].filter(main).sort((a, b) => a.path.localeCompare(b.path))) {
    const owner = typesByFqn.get(xml.facts.namespace);
    if (!owner || owner.type.kind !== "interface" || !main(owner.file)) continue;
    for (const statement of xml.facts.statements) {
      if (xml.facts.statements.filter(item => item.id === statement.id).length !== 1) continue;
      const method = owner.type.methods.find(item => item.name === statement.id);
      if (!method || !usable(owner.type, method)) continue;
      add("xml", `${xml.path}#${statement.id}`, { shape: "method", anchors: [owner.type.name, method.name],
        prompt: `Find the MyBatis SQL statement that mapper method \`${method.name}\` of \`${owner.type.name}\` executes.`,
        sameNameCount: nameCount.get(`method:${method.name}`),
        targets: [{ ...head(owner.file.path, method), role: "declaration", why: `mapper method ${owner.type.fqn}#${method.name} declaration head` },
          { path: xml.path, startLine: statement.startLine, endLine: statement.endLine, role: "relation", why: `mapper statement ${xml.facts.namespace}.${statement.id}` }] });
    }
  }
  return candidates;
}

/** Reasons a candidate cannot enter the sealed set; empty means eligible. */
export function exclusionReasons(candidate, exposure, rules = SEALED_RULES) {
  const reasons = [];
  if (candidate.anchors.some(anchor => exposure.terms.has(anchor))) reasons.push("EXPOSED_ANCHOR");
  const files = [...new Set(candidate.targets.map(item => item.path))];
  const overlap = files.filter(file => exposure.evidence.has(`${candidate.corpusId}\0${file}`)).length;
  if (overlap / files.length > rules.overlapLimit) reasons.push("EXPOSED_EVIDENCE");
  const found = leaks({ prompt: candidate.prompt, anchors: candidate.anchors, evidence: candidate.targets });
  if (found.length) reasons.push("LEAK");
  return reasons;
}

/** Agent-visible terms and (corpus, evidence path) pairs of every split of an earlier dataset. */
export async function exposureOf(datasetFile) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const terms = new Set();
  const evidence = new Set();
  for (const split of ["dev", "holdout"]) {
    for (const task of await readJsonl(path.join(root, manifest.parts[`tasks-${split}`].file))) for (const term of planQueries(task).terms) terms.add(term);
    for (const row of await readJsonl(path.join(root, manifest.parts[`gold-${split}`].file))) for (const item of row.requiredEvidence) evidence.add(`${row.corpusId}\0${item.path}`);
  }
  return { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, terms, evidence };
}

/** The pre-registered quota: the smallest q >= quotaPerStratum whose planned sealed count reaches minSealed, or the largest useful q. */
export function quotaFor(available, rules = SEALED_RULES) {
  const sizes = Object.values(available);
  const sealed = q => sizes.reduce((sum, n) => sum + Math.round(Math.min(q, n) * rules.holdoutRatio), 0);
  const ceiling = Math.max(rules.quotaPerStratum, ...sizes);
  let q = rules.quotaPerStratum;
  while (sealed(q) < rules.minSealed && q < ceiling) q += 1;
  return { quota: q, plannedSealed: sealed(q) };
}

/** Per stratum, eligible candidates in seeded order; round r of a stratum takes the r-th block of `quota` (a failed audit moves to the next block). */
export function selectSealed(candidates, { rules = SEALED_RULES, rounds = {} } = {}) {
  const strata = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.corpusId}/${candidate.category}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(candidate);
  }
  for (const [key, rows] of strata) rows.sort((a, b) => order(rules.sampleSeed, key, a.id).localeCompare(order(rules.sampleSeed, key, b.id)));
  const available = Object.fromEntries([...strata].map(([key, rows]) => [key, rows.length]));
  const { quota, plannedSealed } = quotaFor(available, rules);
  const selected = [];
  const audit = [];
  for (const [key, rows] of [...strata].sort(([a], [b]) => a.localeCompare(b))) {
    const round = rounds[key] ?? 0;
    const chosen = rows.slice(round * quota, (round + 1) * quota);
    selected.push(...chosen.map(row => ({ ...row, stratum: key, round })));
    const auditCount = Math.ceil(chosen.length * rules.auditRatio);
    audit.push(...[...chosen].sort((a, b) => order(rules.auditSeed, key, a.id).localeCompare(order(rules.auditSeed, key, b.id))).slice(0, auditCount).map(row => row.id));
  }
  return { quota, plannedSealed, available, selected, audit };
}

const bucket = n => (n <= 1 ? "1" : n <= 3 ? "2-3" : n <= 7 ? "4-7" : "8+");
async function writePrivate(file, text) {
  await writeFile(file, text, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
}
const git = (record, args) => execute("git", ["--no-optional-locks", "-C", record.repoRoot, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });

export async function generateSealed({ inputsFile, excludeDataset, out, rounds = {}, rules = SEALED_RULES, checkInput = assertPristineInput }) {
  const inputs = await readJson(inputsFile);
  const exposure = await exposureOf(excludeDataset);
  const all = [];
  const corpora = [];
  for (const record of [...inputs].sort((a, b) => a.name.localeCompare(b.name))) {
    await checkInput(record);
    const tracked = (await git(record, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean).sort();
    const javaFiles = [];
    const xmlFiles = [];
    for (const file of tracked) {
      if (file.endsWith(".java")) javaFiles.push({ path: file, facts: javaFacts(await readFile(path.join(record.repoRoot, file), "utf8")) });
      else if (file.endsWith(".xml")) {
        const facts = mapperFacts(await readFile(path.join(record.repoRoot, file), "utf8"), rules.statements);
        if (facts) xmlFiles.push({ path: file, facts });
      }
    }
    const committedAt = (await git(record, ["show", "-s", "--format=%cI", record.head])).stdout.trim();
    corpora.push({ corpusId: record.name, head: record.head, committedAt, javaFiles: javaFiles.length, mapperFiles: xmlFiles.length });
    all.push(...corpusCandidates({ corpusId: record.name, javaFiles, xmlFiles, rules }));
  }
  const excluded = {};
  const eligible = [];
  for (const candidate of all) {
    const reasons = exclusionReasons(candidate, exposure, rules);
    for (const reason of reasons) excluded[reason] = (excluded[reason] ?? 0) + 1;
    if (reasons.length === 0) eligible.push(candidate);
  }
  const selection = selectSealed(eligible, { rules, rounds });
  await mkdir(out, { recursive: false, mode: 0o700 });
  const identity = { rules: rulesDigest(rules), rulesVersion: rules.version, inputsSha256: sha256(await readFile(inputsFile)), exposure: { datasetId: exposure.datasetId, datasetDigest: exposure.datasetDigest }, rounds };
  // The latest frozen head commit time, not the wall clock: the same inputs, rules and rounds give the same dataset digest.
  const generatedAt = corpora.map(item => new Date(item.committedAt).toISOString()).sort().at(-1);
  await writePrivate(path.join(out, "selection.json"), `${JSON.stringify({ schema: SELECTION_SCHEMA, identity, rules, corpora, generatedAt, ...selection }, null, 2)}\n`);
  const byId = new Map(selection.selected.map(row => [row.id, row]));
  const sheet = [];
  for (const id of selection.audit) {
    const row = byId.get(id);
    const record = inputs.find(item => item.name === row.corpusId);
    const targets = [];
    for (const target of row.targets) {
      const lines = (await readFile(path.join(record.repoRoot, target.path), "utf8")).split("\n");
      targets.push({ ...target, source: lines.slice(Math.max(0, target.startLine - 3), target.endLine + 2).join("\n") });
    }
    sheet.push({ taskId: id, stratum: row.stratum, prompt: row.prompt, anchors: row.anchors, targets, verdict: null, by: null, at: null, notes: null });
  }
  await writePrivate(path.join(out, "audit-sheet.json"), `${JSON.stringify({ schema: AUDIT_SCHEMA, identity, instructions: "For each task set verdict PASS when every target is the declaration or relation its why names and the prompt with its anchors identifies it without the answer; else FAIL with notes. Any FAIL redoes the whole stratum (next round).", entries: sheet }, null, 2)}\n`);
  const summary = { identity, corpora, candidates: all.length, excluded, eligible: selection.available, quota: selection.quota, plannedSealed: selection.plannedSealed,
    selected: selection.selected.length, audit: selection.audit.length,
    sameNameCount: Object.fromEntries(rules.categories.map(category => [category, selection.selected.filter(row => row.category === category)
      .reduce((out, row) => ({ ...out, [bucket(row.sameNameCount)]: (out[bucket(row.sameNameCount)] ?? 0) + 1 }), {})])),
    shapes: selection.selected.reduce((out, row) => ({ ...out, [`${row.category}/${row.shape}`]: (out[`${row.category}/${row.shape}`] ?? 0) + 1 }), {}),
    belowMinimum: selection.plannedSealed < rules.minSealed };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

/** Audit gate, then the MAC-10 converter; the sealed part is the converter's holdout split. */
export async function freezeSealed({ selectionDir, auditFile, inputsFile, out }) {
  const selection = await readJson(path.join(selectionDir, "selection.json"));
  requireValue(selection.schema === SELECTION_SCHEMA, "not a sealed selection");
  const rules = selection.rules;
  requireValue(rulesDigest(rules) === selection.identity.rules, "selection rules changed after generation");
  requireValue(sha256(await readFile(inputsFile)) === selection.identity.inputsSha256, "inputs differ from the generation inputs");
  const audit = await readJson(auditFile);
  requireValue(audit.schema === AUDIT_SCHEMA && audit.identity?.rules === selection.identity.rules, "audit sheet is not for this selection");
  const entries = new Map(audit.entries.map(entry => [entry.taskId, entry]));
  const byId = new Map(selection.selected.map(row => [row.id, row]));
  const failed = new Set();
  for (const id of selection.audit) {
    const entry = entries.get(id);
    requireValue(entry && ["PASS", "FAIL"].includes(entry.verdict) && typeof entry.by === "string" && entry.by && !Number.isNaN(Date.parse(entry.at)), `audit of ${id} is incomplete`);
    if (entry.verdict === "FAIL") failed.add(byId.get(id).stratum);
  }
  requireValue(failed.size === 0, `audit failed in ${[...failed].sort().join(", ")}: regenerate with --rounds ${JSON.stringify(Object.fromEntries([...failed].sort().map(key => [key, (selection.identity.rounds[key] ?? 0) + 1])))}`);
  const records = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const tasks = selection.selected.map(row => {
    const entry = entries.get(row.id);
    const verification = entry
      ? { by: entry.by, at: entry.at, method: `manual audit of a generated target (${rules.version})`, notes: entry.notes && entry.notes.length >= 20 ? entry.notes : `audited PASS: targets match their rule (${row.category}/${row.shape})` }
      : { by: "ilv2-sealed-set generator", at: selection.generatedAt, method: `generated by ${rules.version} ${row.category}/${row.shape}`, notes: `not individually audited; the ${Math.round(rules.auditRatio * 100)}% stratified audit of ${row.stratum} passed` };
    return { id: row.id, repo: row.corpusId, kind: "locate", category: row.category, source: { type: "static-head", commit: records.get(row.corpusId).head },
      prompt: row.prompt, anchors: row.anchors, evidence: row.targets.map(({ path: file, startLine, endLine, role, why }) => ({ path: file, startLine, endLine, role, why })), verification };
  });
  const holdout = { ratio: rules.holdoutRatio, seed: rules.sampleSeed };
  // The converter's own split rule, checked before anything is written.
  const sealed = [...assignSplits(tasks, holdout).values()].filter(split => split === "holdout").length;
  requireValue(sealed >= rules.minSealed, `only ${sealed} sealed tasks; the rules require ${rules.minSealed}`);
  const curationFile = path.join(selectionDir, "curation.json");
  await writeFile(curationFile, `${JSON.stringify({ schema: CURATION_SCHEMA, datasetId: rules.datasetId, holdout, tasks }, null, 2)}\n`, { mode: 0o600 });
  await chmod(curationFile, 0o600);
  const manifest = await convertDataset({ curationFile, inputsFile, candidateFiles: [], out });
  requireValue((manifest.counts.bySplit.holdout ?? 0) === sealed, "converter split differs from the pre-checked split");
  return manifest;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "generate") {
    const options = cliOptions(rest, ["--inputs", "--exclude-dataset", "--out", "--rounds"]);
    for (const name of ["inputs", "exclude-dataset", "out"]) requireValue(options[name], `--${name} is required`);
    const summary = await generateSealed({ inputsFile: path.resolve(options.inputs), excludeDataset: path.resolve(options["exclude-dataset"]), out: path.resolve(options.out),
      rounds: options.rounds ? JSON.parse(options.rounds) : {} });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.belowMinimum) process.exitCode = 1;
  } else if (command === "freeze") {
    const options = cliOptions(rest, ["--selection", "--audit", "--inputs", "--out"]);
    for (const name of ["selection", "audit", "inputs", "out"]) requireValue(options[name], `--${name} is required`);
    const manifest = await freezeSealed({ selectionDir: path.resolve(options.selection), auditFile: path.resolve(options.audit), inputsFile: path.resolve(options.inputs), out: path.resolve(options.out) });
    console.log(JSON.stringify({ datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, counts: manifest.counts }, null, 2));
  } else throw new Error("usage: ilv2-sealed-set.mjs generate --inputs F --exclude-dataset MANIFEST --out DIR [--rounds JSON] | freeze --selection DIR --audit F --inputs F --out DIR");
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
