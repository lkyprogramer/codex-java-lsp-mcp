#!/usr/bin/env node
// D19, offline and model-free. Two follow-ups to D18 (docs/post-ilv2/d19-relation-followup-check.md):
// (1) the two implementations targets that directly implement the anchor yet were absent from the pool (H0):
//     does each target's `implements` resolve to the anchor's FQN, and which of the anchor's text-level direct
//     subtypes were in the D15-F C0 pool, with or without @Primary;
// (2) the callers targets D15-F C0 did credit: which label and reason kinds carried them into the read plan.
// Reads D15-F artifacts and the frozen corpus only; no product call. summary.json carries no names or paths.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus } from "./ilv2-mac-retrieval-eval.mjs";
import { PROTECTED_CORE_KINDS } from "./ilv2-impact-budget-diagnosis.mjs";
import { breakdown, callsOf } from "./ilv2-impact-miss-breakdown.mjs";
import { UNPROVEN, anchorNames, exactAnchors, linkForTarget, hierarchyOf, stripJava, typeHeaders } from "./ilv2-relation-text-check.mjs";
import { REASON_ALLOWLIST, moduleOf } from "./ilv2-relation-defect-shape.mjs";

export const FOLLOWUP_SCHEMA = "post-ilv2/relation-followup-check/v1";
export const H0_VERDICTS = Object.freeze(["SAME_NAME_OTHER_TYPE", "PRIMARY_FILTER", "EDGE_MISSING", "UNDETERMINED"]);

const simple = name => String(name).split(/[.$]/).pop();
const packageOf = stripped => /\bpackage\s+([\w.]+)\s*;/.exec(stripped)?.[1] ?? "";
const importsOf = stripped => [...stripped.matchAll(/\bimport\s+(?!static\b)([\w.]+(?:\.\*)?)\s*;/g)].map(match => match[1]);

/** Where a supertype name written in `stripped` resolves, relative to the anchor's FQN. */
export function resolveSuper(stripped, written, anchorFqn) {
  const anchorSimple = simple(anchorFqn);
  const anchorPkg = anchorFqn.slice(0, Math.max(0, anchorFqn.lastIndexOf(".")));
  if (written.includes(".")) return written === anchorFqn ? "anchor" : simple(written) === anchorSimple ? "other-same-name" : "unrelated";
  if (written !== anchorSimple) return "unrelated";
  const imports = importsOf(stripped);
  const exact = imports.filter(entry => !entry.endsWith(".*") && simple(entry) === anchorSimple);
  if (exact.length > 0) return exact.includes(anchorFqn) ? "anchor" : "other-same-name";
  if (packageOf(stripped) === anchorPkg) return "anchor";
  if (imports.includes(`${anchorPkg}.*`)) return "anchor";
  return "unresolved";
}

/** The raw supertype names a file writes after extends/implements (qualified names kept). */
export function writtenSupers(stripped) {
  const out = [];
  for (const match of stripped.matchAll(/\b(?:class|interface|enum|record)\s+[\w$]+/g)) {
    // Skip the declaration's own type parameters (and a record's components) so `<T extends X>` is not read as a supertype.
    let index = match.index + match[0].length, depth = 0;
    for (; index < stripped.length; index += 1) {
      const char = stripped[index];
      if (char === "<" || char === "(") depth += 1;
      else if (char === ">" || char === ")") depth -= 1;
      else if (depth === 0 && !/\s/.test(char)) break;
    }
    const brace = stripped.indexOf("{", index);
    if (brace < 0) continue;
    const permits = stripped.slice(index, brace).search(/\bpermits\b/);
    const end = permits < 0 ? brace : index + permits;
    let current = "";
    depth = 0;
    const flush = () => { if (current.trim()) out.push(current); current = ""; };
    for (const char of stripped.slice(index, end)) {
      if (char === "<") depth += 1;
      else if (char === ">") depth -= 1;
      else if (depth === 0 && char === ",") flush();
      else if (depth === 0) current += char;
    }
    flush();
  }
  return out.map(entry => entry.replace(/@[\w.]+(\([^)]*\))?/g, "").replace(/\b(?:extends|implements)\b/g, " ").trim())
    .flatMap(entry => entry.split(/\s+/)).filter(Boolean);
}

/** Whether the declaration of `name` in `stripped` carries @Primary among its leading annotations. */
export function hasPrimary(stripped, name) {
  const match = new RegExp(`\\b(class|interface|enum|record)\\s+${name.replace(/[$]/g, "\\$")}\\b`).exec(stripped);
  if (!match) return false;
  let before = stripped.slice(0, match.index), previous;
  // Annotation arguments such as @X({A.class}) contain braces; drop balanced parentheses so they do not end the window.
  do { previous = before; before = before.replace(/\([^()]*\)/g, ""); } while (before !== previous);
  const start = Math.max(before.lastIndexOf(";"), before.lastIndexOf("}"), before.lastIndexOf("{"));
  return /@(?:[\w.]+\.)?Primary\b/.test(before.slice(start + 1));
}

/** d19 §3.1: one H0 target's verdict from its resolution and the anchor's direct subtypes. */
export function h0Verdict({ resolution, subtypes }) {
  if (resolution === "other-same-name") return "SAME_NAME_OTHER_TYPE";
  if (resolution !== "anchor") return "UNDETERMINED";
  const target = subtypes.find(entry => entry.isTarget);
  const primaryKept = subtypes.some(entry => !entry.isTarget && entry.primary && entry.inPool && entry.resolvesToAnchor);
  if (target && !target.primary && primaryKept) return "PRIMARY_FILTER";
  return "EDGE_MISSING";
}

const tally = values => values.reduce((acc, value) => { if (!Object.hasOwn(acc, value)) acc[value] = 0; acc[value] += 1; return acc; }, {});

async function javaFiles(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await javaFiles(root, full, out);
    else if (entry.isFile() && entry.name.endsWith(".java")) out.push(full);
  }
  return out.sort();
}
const jsonl = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

/** The C0 call that used `anchor`, from the F observation. */
const callFor = (observation, anchor) => observation.terms.find(row => row.impacts?.C0 && row.symbol?.candidates?.[0]?.declaration === anchor)?.impacts.C0.diagnostic;

/** Credited callers targets: F's label, and for impact-credited ones the selected file's reason kinds. */
export function creditedCallers({ rows, observations, gold }) {
  const byTask = new Map(observations.map(observation => [observation.taskId, observation]));
  const out = [];
  for (const row of rows.filter(entry => entry.category === "callers")) {
    const required = gold.get(row.taskId)?.requiredEvidence ?? [];
    (row.configs.C0?.targets ?? []).forEach((target, index) => {
      if (!target.credited || target.kind !== "java") return;
      const item = required[index];
      let reasons = [];
      let inPlan = false;
      if (target.label === "IMPACT_SPAN") {
        for (const { diagnostic } of callsOf(byTask.get(row.taskId) ?? { terms: [] }, "C0")) {
          const file = diagnostic?.files.find(entry => entry.path === item.path);
          if (file && diagnostic.readPlan.some(entry => entry.fileId === file.id)) { reasons = file.reasons ?? []; inPlan = true; break; }
        }
      }
      out.push({ label: target.label, impactSpanNotInPlan: target.label === "IMPACT_SPAN" && !inPlan, protectedReason: reasons.some(reason => PROTECTED_CORE_KINDS.has(reason)),
        reasonKinds: [...new Set(reasons.filter(reason => REASON_ALLOWLIST.has(reason)))].sort() });
    });
  }
  return { targets: out.length, byLabel: tally(out.map(entry => entry.label)), withProtectedReason: out.filter(entry => entry.protectedReason).length,
    impactSpanNotInPlan: out.filter(entry => entry.impactSpanNotInPlan).length,
    reasonKinds: tally(out.flatMap(entry => entry.reasonKinds)) };
}

export async function runFollowupCheck({ datasetFile, tasksFile, goldFile, inputsFile, responsesFile, rowsFile, expect, out, verify = verifyDataset, materialize = materializeCorpus }) {
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
  const rows = jsonl(rowsBytes);
  const byTask = new Map(observations.map(observation => [observation.taskId, observation]));
  const candidates = breakdown({ rows, observations, gold })
    .filter(row => row.config === "C0" && row.category === "implementations" && UNPROVEN.includes(row.cause));
  await mkdir(out, { recursive: true });
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const h0Rows = [];
  for (const corpusId of [...new Set(candidates.map(row => tasks.get(row.taskId).corpusId))].sort()) {
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(entry => entry.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId) });
    const files = [];
    for (const file of await javaFiles(corpusRoot)) files.push({ path: path.relative(corpusRoot, file).split(path.sep).join("/"), stripped: stripJava(await readFile(file, "utf8")) });
    const graph = hierarchyOf(files.map(file => file.stripped));
    for (const miss of candidates.filter(row => tasks.get(row.taskId).corpusId === corpusId)) {
      const item = gold.get(miss.taskId).requiredEvidence[miss.index];
      const target = files.find(file => file.path === item.path);
      requireValue(target, `target ${miss.taskId}#${miss.index} is not a corpus Java file`);
      const anchors = exactAnchors(byTask.get(miss.taskId));
      const link = linkForTarget({ category: "implementations", item, anchors, lines: target.stripped.split("\n"), graph });
      if (link.linkClass !== "DIRECT") continue;
      const anchor = anchors[link.anchorIndex];
      // The anchor's FQN from its own file (package + type name); declaration fields are not relied on.
      const anchorSimple = anchorNames(anchor).type;
      const anchorFile = files.find(file => file.path === anchor.relativePath);
      requireValue(anchorSimple && anchorFile && typeHeaders(anchorFile.stripped).some(header => header.name === anchorSimple),
        `anchor type of ${miss.taskId}#${miss.index} is not declared in its file`);
      const anchorPkg = packageOf(anchorFile.stripped);
      const anchorFqn = anchorPkg ? `${anchorPkg}.${anchorSimple}` : anchorSimple;
      const resolutions = writtenSupers(target.stripped).filter(name => simple(name) === anchorSimple).map(name => resolveSuper(target.stripped, name, anchorFqn));
      const resolution = resolutions.includes("anchor") ? "anchor" : resolutions.includes("other-same-name") ? "other-same-name" : resolutions[0] ?? "unresolved";
      const diagnostic = callFor(byTask.get(miss.taskId), anchor);
      // The anchor's text-level direct subtypes across the corpus, with what F's C0 pool did with each.
      const subtypes = files.flatMap(file => typeHeaders(file.stripped).filter(header => header.supers.includes(anchorSimple)).map(header => {
        const pooled = diagnostic?.files.find(entry => entry.path === file.path);
        const supers = writtenSupers(file.stripped).filter(name => simple(name) === anchorSimple);
        return { isTarget: file.path === item.path, primary: hasPrimary(file.stripped, header.name), inPool: Boolean(pooled),
          implLookup: Boolean(pooled?.reasons?.includes("typeGraph:implementation-lookup")), testSource: file.path.includes("/src/test/"),
          sameModuleAsAnchor: moduleOf(file.path) === moduleOf(anchor.relativePath),
          resolvesToAnchor: supers.some(name => resolveSuper(file.stripped, name, anchorFqn) === "anchor") };
      }));
      h0Rows.push({ taskId: miss.taskId, path: item.path, cause: miss.cause, resolution,
        sameNameDeclarations: files.reduce((count, file) => count + typeHeaders(file.stripped).filter(header => header.name === anchorSimple).length, 0),
        subtypes, verdict: h0Verdict({ resolution, subtypes }) });
    }
  }
  await writeFile(path.join(out, "h0-rows.jsonl"), h0Rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: FOLLOWUP_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes), responsesSha256: expect.responses, rowsSha256: expect.rows },
    h0: { targets: h0Rows.length, byVerdict: { ...Object.fromEntries(H0_VERDICTS.map(name => [name, 0])), ...tally(h0Rows.map(row => row.verdict)) },
      rows: h0Rows.map(row => ({ cause: row.cause, resolution: row.resolution, sameNameDeclarations: row.sameNameDeclarations, verdict: row.verdict,
        subtypes: row.subtypes.map(({ isTarget, primary, inPool, implLookup, testSource, sameModuleAsAnchor, resolvesToAnchor }) => ({ isTarget, primary, inPool, implLookup, testSource, sameModuleAsAnchor, resolvesToAnchor })) })) },
    creditedCallers: creditedCallers({ rows, observations, gold }),
    notClaimed: "Text resolution of package, imports and written supertypes; no compiler binding. Pool facts are D15-F's recorded C0 calls, not a new product run."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const names = ["--dataset", "--tasks", "--gold", "--inputs", "--responses", "--rows", "--expect-responses-sha256", "--expect-rows-sha256", "--out"];
  const options = cliOptions(args, names);
  for (const name of names) requireValue(options[name.slice(2)], `${name} is required`);
  const summary = await runFollowupCheck({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), responsesFile: path.resolve(options.responses), rowsFile: path.resolve(options.rows),
    expect: { responses: options["expect-responses-sha256"], rows: options["expect-rows-sha256"] }, out: path.resolve(options.out) });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
