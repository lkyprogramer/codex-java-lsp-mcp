#!/usr/bin/env node
// D18, model-free. For the D17 targets whose source shows a relation to the task's anchor (DIRECT or INDIRECT),
// (1) re-run java_impact on the current build with the same anchor and policy as D15-F, and (2) describe each
// target's code shape with categorical features only (docs/post-ilv2/d18-relation-defect-shape.md). The summary
// carries no names or paths, so the shapes can be turned into synthetic regression fixtures off the Mac.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus } from "./ilv2-mac-retrieval-eval.mjs";
import { openProductSession } from "./ilv2-ranking-diagnosis.mjs";
import { CORE_EXCEEDED_GAP, PROTECTED_CORE_KINDS } from "./ilv2-impact-budget-diagnosis.mjs";
import { FOCUS, breakdown } from "./ilv2-impact-miss-breakdown.mjs";
import { UNPROVEN, anchorNames, exactAnchors, hierarchyOf, linkForTarget, stripJava, superDepth, typeHeaders } from "./ilv2-relation-text-check.mjs";

export const DEFECT_SHAPE_SCHEMA = "post-ilv2/relation-defect-shape/v1";
export const LINKS = Object.freeze(["DIRECT", "INDIRECT"]);
// src/agent-router/candidate-collectors.ts shouldUseTypeGraph: interface anchors, or these profiles.
export const TYPE_GRAPH_PROFILES = Object.freeze(["port", "repository", "service"]);
export const IMPACT_ARGS = Object.freeze({ semanticPolicy: "fast", mode: "balanced", verbosity: "diagnostic", deadlineMs: 15000 });
// src/agent-router/candidate-collectors.ts: findImplementers(typeName, 20, ...); the store returns direct IMPLEMENTS/EXTENDS edges only.
export const IMPLEMENTER_LIMIT = 20;
// Reason kinds allowed into the summary. Reasons outside this list (for example lexical `rg:` reasons) are only counted.
export const REASON_ALLOWLIST = Object.freeze(new Set([...PROTECTED_CORE_KINDS, "typeGraph", "importGraph", "reference", "typeReference", "semantic-definition",
  "semantic-implementation", "EXACT_SEMANTIC", "STATIC_STRUCTURE", "AST_EXACT", "AST_RESOLVED", "JDT_EXACT", "PERSISTED_JDT", "REFERENCE", "EXPLICIT_IMPORT",
  "QUALIFIED", "WILDCARD_IMPORT", "DIRECT_DECLARATION", "FIELD_TYPE", "ENCLOSING_TYPE", "IMPORTED_BY", "KIND_PAIRING", "PACKAGE_PROXIMITY", "SAME_PACKAGE",
  "ANNOTATION_COLLABORATION", "METHOD_INVOCATION", "JAVA_LANG", "SUPPORT_FILE", "config", "target", "anchor"]));
const POOL_KINDS = Object.freeze(["typeGraph", "typeGraph:implementation-lookup", "IMPLEMENTS", "CALLS", "METHOD_RELATION"]);

/** name -> [{ keyword, abstract, relations, path }] over the corpus. */
export function typeIndexOf(files) {
  const index = new Map();
  for (const { path: file, text } of files) for (const header of typeHeaders(stripJava(text))) {
    if (!index.has(header.name)) index.set(header.name, []);
    index.get(header.name).push({ keyword: header.keyword, abstract: header.abstract, relations: header.relations, path: file });
  }
  return index;
}

const kindOf = declaration => declaration ? (declaration.keyword === "class" && declaration.abstract ? "abstract-class" : declaration.keyword) : "unknown";
/** The module a path belongs to: everything before its first `src/` segment ("" at the root). */
export const moduleOf = file => { const index = file.split("/").indexOf("src"); return index <= 0 ? "" : file.split("/").slice(0, index).join("/"); };
const declarationOf = (index, name, preferPath) => (index.get(name) ?? []).find(entry => entry.path === preferPath) ?? (index.get(name) ?? [])[0];

/** Implementation shape: the anchor type's kind, the clause linking the target, and the first hop of an indirect path. */
export function implementationShape({ anchor, link, lines, index, graph }) {
  const { type } = anchorNames(anchor);
  const anchorDecl = declarationOf(index, type, anchor.relativePath);
  const relations = typeHeaders(lines.join("\n")).flatMap(header => header.relations);
  const shape = { anchorKind: kindOf(anchorDecl), anchorDeclaredIn: anchorDecl ? "corpus" : "not-found", ...subtypeCounts(graph, type) };
  if (link.linkClass === "DIRECT") {
    const relation = relations.find(entry => entry.name === type);
    return { ...shape, clause: relation?.keyword ?? "unknown", genericArgs: relation?.generic ?? null };
  }
  // A first hop on a shortest path to the anchor type.
  const hop = relations.find(entry => superDepth(graph, [entry.name], type) === link.depth - 1);
  const hopDecl = hop ? declarationOf(index, hop.name) : undefined;
  return { ...shape, clause: hop?.keyword ?? "unknown", genericArgs: hop?.generic ?? null, viaKind: kindOf(hopDecl), viaSameModuleAsAnchor: hopDecl && anchorDecl ? moduleOf(hopDecl.path) === moduleOf(anchorDecl.path) : null };
}

const escape = name => name.replace(/[$]/g, "\\$");
/** Callers shape: how the first call to the member inside the gold range is written, and the receiver's declared type. */
export function callShape({ anchor, item, lines, index, graph }) {
  const { type: owner, member } = anchorNames(anchor);
  const ownerDecl = declarationOf(index, owner, anchor.relativePath);
  const range = lines.slice(Math.max(0, item.startLine - 1), item.endLine).join("\n");
  const file = lines.join("\n");
  const match = new RegExp(`(?<![\\w$])${escape(member)}\\s*\\(`).exec(range);
  const shape = { ownerKind: kindOf(ownerDecl), receiver: "none", receiverType: null };
  if (!match) return shape;
  const before = range.slice(0, match.index).replace(/\s+$/, "");
  if (!before.endsWith(".")) return { ...shape, receiver: before.endsWith("::") ? "method-ref" : "unqualified" };
  const head = before.slice(0, -1).replace(/\s+$/, "");
  if (head.endsWith(")") || head.endsWith("]")) return { ...shape, receiver: "chained" };
  const ident = /([A-Za-z_$][\w$]*)$/.exec(head)?.[1];
  if (!ident) return { ...shape, receiver: "other" };
  if (ident === "this" || ident === "super") return { ...shape, receiver: ident };
  if (ident === owner) return { ...shape, receiver: "static-owner" };
  if (/^[A-Z]/.test(ident)) return { ...shape, receiver: "static-other" };
  const declared = new RegExp(`([A-Z][\\w$]*)(?:<[^;=(){}]*>)?\\s+${escape(ident)}\\b`).exec(file)?.[1];
  const receiverType = !declared ? "undeclared" : declared === owner ? "owner"
    : superDepth(graph, [owner], declared) !== null ? `supertype-of-owner:${kindOf(declarationOf(index, declared))}` : "other";
  return { ...shape, receiver: "variable", receiverType };
}

const hasProtected = reasons => reasons.some(reason => PROTECTED_CORE_KINDS.has(reason));
/** The current build's view of one target under the D15-F call. `reproduced`: the relation is still not proven
 *  (target absent, or present without a protected reason), not "still uncredited". */
export function reproduction(diagnostic, item) {
  const files = diagnostic?.files ?? [];
  const file = files.find(entry => entry.path === item.path);
  const selected = Boolean(file && (diagnostic.readPlan ?? []).some(entry => entry.fileId === file.id));
  const reasons = file?.reasons ?? [];
  // Pool-wide counts show whether the type graph or call relations ran at all for this anchor.
  const poolWith = Object.fromEntries(POOL_KINDS.map(kind => [kind, files.filter(entry => (entry.reasons ?? []).includes(kind)).length]));
  return { status: diagnostic?.status ?? null, anchorProfile: diagnostic?.target?.profile ?? null, coverage: diagnostic?.freshness?.coverage ?? null,
    coreExceeded: (diagnostic?.evidenceGaps ?? []).some(gap => String(gap).startsWith(CORE_EXCEEDED_GAP)), poolSize: files.length, poolWith,
    inPool: Boolean(file), selected, protectedReason: hasProtected(reasons),
    reasonKinds: [...new Set(reasons.filter(reason => REASON_ALLOWLIST.has(reason)))].sort(), otherReasons: reasons.filter(reason => !REASON_ALLOWLIST.has(reason)).length,
    reproduced: !file || !hasProtected(reasons) };
}

/** Direct and transitive (<= 4 hops) subtypes of a type in the corpus graph. */
export function subtypeCounts(graph, type) {
  const children = new Map();
  for (const [name, supers] of graph) for (const parent of supers) { if (!children.has(parent)) children.set(parent, new Set()); children.get(parent).add(name); }
  const direct = children.get(type)?.size ?? 0;
  const seen = new Set();
  let frontier = [type];
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    const next = [];
    for (const name of frontier) for (const child of children.get(name) ?? []) if (!seen.has(child)) { seen.add(child); next.push(child); }
    frontier = next;
  }
  return { directSubtypes: direct, transitiveSubtypes: seen.size, overImplementerLimit: direct > IMPLEMENTER_LIMIT };
}

/** Which pre-registered hypotheses (d18 §3) a reproduced target matches. */
export function hypotheses(row) {
  if (row.repro?.callFailed || !row.repro.reproduced) return [];
  const out = [];
  if (row.category === "implementations") {
    if (row.shape.anchorKind === "unknown") return ["H_UNKNOWN_ANCHOR"];
    if (row.shape.overImplementerLimit) out.push("H_CAP");
    const gated = row.shape.anchorKind !== "interface" && !TYPE_GRAPH_PROFILES.includes(row.repro.anchorProfile);
    if (gated) out.push("H1_TYPEGRAPH_GATED");
    else if (row.shape.anchorKind !== "interface" && row.repro.reasonKinds.includes("typeGraph")) out.push("H2_NON_INTERFACE_WEAK");
    if (row.linkClass === "INDIRECT") out.push("H3_ONE_HOP");
    if (out.length === 0) out.push("H0_UNEXPLAINED");
  } else {
    const { receiver, receiverType } = row.shape;
    if (receiver === "static-owner" || (receiver === "variable" && receiverType === "owner")) out.push("C_OWNER_BOUND");
    else if (receiver === "variable" && String(receiverType).startsWith("supertype-of-owner")) out.push("C_OVERRIDE_FAMILY");
    else out.push(`C_OTHER:${receiver}/${receiverType ?? "-"}`);
  }
  return out;
}

// d18 §3.3: what each hypothesis leads to.
export const OUTCOME = Object.freeze({ H0_UNEXPLAINED: "defect", C_OWNER_BOUND: "defect", H1_TYPEGRAPH_GATED: "test-then-user", H2_NON_INTERFACE_WEAK: "test-then-user",
  H3_ONE_HOP: "user", H_CAP: "user", C_OVERRIDE_FAMILY: "user", H_UNKNOWN_ANCHOR: "report" });
export const outcomeOf = name => OUTCOME[name] ?? (name.startsWith("C_OTHER:") ? "user" : "report");

const tally = (rows, key) => rows.reduce((acc, row) => { for (const value of [].concat(key(row))) { if (!Object.hasOwn(acc, value)) acc[value] = 0; acc[value] += 1; } return acc; }, {});
export function summarize(rows) {
  const called = rows.filter(row => !row.repro?.callFailed);
  const reproduced = called.filter(row => row.repro.reproduced);
  const byHypothesis = tally(reproduced, hypotheses);
  const byOutcome = {};
  for (const [name, count] of Object.entries(byHypothesis)) (byOutcome[outcomeOf(name)] ??= {})[name] = count;
  return {
    targets: rows.length,
    callFailed: rows.length - called.length,
    reproduced: reproduced.length,
    reproGate: { closeIfZero: true, passed: reproduced.length > 0 },
    byHypothesis,
    byOutcome,
    // De-identified per-target rows: categorical features only.
    shapes: rows.map(row => ({ category: row.category, cause: row.cause, linkClass: row.linkClass, depth: row.depth ?? null, sameModule: row.sameModule, testSource: row.testSource,
      shape: row.shape ?? null, repro: row.repro, hypotheses: hypotheses(row) }))
  };
}

async function javaFiles(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await javaFiles(root, full, out);
    else if (entry.isFile() && entry.name.endsWith(".java")) out.push(full);
  }
  return out;
}
const jsonl = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

export async function runDefectShape({ datasetFile, tasksFile, goldFile, inputsFile, serverJs, responsesFile, rowsFile, expect, out, readyTimeoutMs = 900000,
  verify = verifyDataset, materialize = materializeCorpus, openSession = openProductSession }) {
  const { root, manifest } = await verify(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  requireValue(manifest.parts["tasks-dev"]?.sha256 === sha256(tasksBytes), "tasks file is not this dataset's dev split");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const responsesBytes = await readFile(responsesFile);
  const rowsBytes = await readFile(rowsFile);
  requireValue(sha256(responsesBytes) === expect.responses, "responses.jsonl is not the recorded D15-F artifact");
  requireValue(sha256(rowsBytes) === expect.rows, "rows.jsonl is not the recorded D15-F artifact");
  const tasks = new Map(jsonl(tasksBytes).map(task => [task.taskId, task]));
  const gold = new Map(jsonl(goldBytes).map(row => [row.taskId, row]));
  const observations = jsonl(responsesBytes);
  const byTask = new Map(observations.map(observation => [observation.taskId, observation]));
  const misses = breakdown({ rows: jsonl(rowsBytes), observations, gold })
    .filter(row => row.config === "C0" && FOCUS.includes(row.category) && UNPROVEN.includes(row.cause));
  await mkdir(out, { recursive: true });
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const rows = [];
  const sessions = {};
  for (const corpusId of [...new Set(misses.map(row => tasks.get(row.taskId).corpusId))].sort()) {
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(entry => entry.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId) });
    const files = [];
    for (const file of await javaFiles(corpusRoot)) files.push({ path: path.relative(corpusRoot, file).split(path.sep).join("/"), text: await readFile(file, "utf8") });
    const graph = hierarchyOf(files.map(file => file.text));
    const index = typeIndexOf(files);
    const linked = [];
    for (const miss of misses.filter(row => tasks.get(row.taskId).corpusId === corpusId)) {
      const item = gold.get(miss.taskId).requiredEvidence[miss.index];
      const lines = stripJava(await readFile(path.join(corpusRoot, item.path), "utf8")).split("\n");
      const anchors = exactAnchors(byTask.get(miss.taskId));
      const link = linkForTarget({ category: miss.category, item, anchors, lines, graph });
      if (LINKS.includes(link.linkClass)) linked.push({ miss, item, lines, link, anchor: anchors[link.anchorIndex] });
    }
    if (linked.length === 0) continue;
    const workDir = path.join(out, "sessions", corpusId);
    await mkdir(workDir, { recursive: true });
    const session = await openSession({ serverJs, corpusRoot, workDir, readyTimeoutMs });
    sessions[corpusId] = { readyMs: Math.round(session.readyMs) };
    try {
      for (const { miss, item, lines, link, anchor } of linked) {
        let repro;
        try {
          repro = reproduction(await session.call("java_impact", { file: anchor.relativePath, line: anchor.selection.line, column: anchor.selection.column, ...IMPACT_ARGS }), item);
        } catch (error) {
          // One failed call leaves the other targets' evidence intact; it is kept out of every denominator.
          repro = { callFailed: true, error: String(error?.message ?? error).slice(0, 200).replace(/\/[^\s"]+/g, "<path>") };
        }
        const shape = miss.category === "implementations" ? implementationShape({ anchor, link, lines, index, graph }) : callShape({ anchor, item, lines, index, graph });
        rows.push({ taskId: miss.taskId, path: item.path, anchorPath: anchor.relativePath, category: miss.category, cause: miss.cause, linkClass: link.linkClass, depth: link.depth ?? null,
          sameModule: moduleOf(item.path) === moduleOf(anchor.relativePath), testSource: item.path.includes("/src/test/"), shape, repro });
      }
    } finally { await session.close(); }
  }
  await writeFile(path.join(out, "shape-rows.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: DEFECT_SHAPE_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes), responsesSha256: expect.responses, rowsSha256: expect.rows,
      serverBuildStampSha256: sha256(await readFile(path.join(path.dirname(serverJs), "build-stamp.json"))), impactArgs: IMPACT_ARGS },
    sessions,
    ...summarize(rows),
    notClaimed: "Shapes are text heuristics over the frozen source (simple names, no binding). Reproduction is one diagnostic java_impact call per target on the current build without JDT, as D15-F ran."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const names = ["--dataset", "--tasks", "--gold", "--inputs", "--server-js", "--responses", "--rows", "--expect-responses-sha256", "--expect-rows-sha256", "--out"];
  const options = cliOptions(args, names);
  for (const name of names) requireValue(options[name.slice(2)], `${name} is required`);
  const summary = await runDefectShape({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), serverJs: path.resolve(options["server-js"]), responsesFile: path.resolve(options.responses), rowsFile: path.resolve(options.rows),
    expect: { responses: options["expect-responses-sha256"], rows: options["expect-rows-sha256"] }, out: path.resolve(options.out) });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
