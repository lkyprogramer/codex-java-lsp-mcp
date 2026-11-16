#!/usr/bin/env node
// S3 step 0, model-free and without changing src. For every dev `callers` task, take the C0 java_impact calls the S1
// replay recorded, ask the current build's static index who calls each call's anchor (queryCallers), and count whether a
// pooled CALLER file could be credited under the C0 read budget, and how many already-credited targets it would put at
// risk (docs/post-ilv2/s3-static-callers-design.md §4.1). The summary carries counts only; per-target rows stay private.
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus } from "./ilv2-mac-retrieval-eval.mjs";
import { CORE_EXCEEDED_GAP, PROTECTED_CORE_KINDS } from "./ilv2-impact-budget-diagnosis.mjs";
import { callsOf } from "./ilv2-impact-miss-breakdown.mjs";

export const PROBE_SCHEMA = "post-ilv2/s3-callers-probe/v1";
// The S1 replay's rows.jsonl (docs/post-ilv2/results/S1-GATE.json s1Gate.identity.rowsSha256): main's current baseline.
export const S1_ROWS_SHA256 = "18b61c2afd61bbdeed64b3995b370c03847585096ca12bc9f1589367adf51b40";
// C0 = balanced (src/agent-router/read-plan.ts READ_PLAN_BUDGETS, BUCKET_RULES.core.max).
export const C0 = Object.freeze({ maxFiles: 6, maxReadBytes: 14 * 1024, coreMax: 4 });
// The retrieval reader caps every span at 80 lines (scripts/ilv2-mac-retrieval-eval.mjs WINDOW_DEFAULT.maxLines).
export const READER_MAX_LINES = 80;
// Design §3.3: at most 8 caller files per anchor, from a 16-edge query. The probe asks for 81 edges to see truncation.
export const CALLER_FILE_CAP = 8;
export const DESIGN_EDGE_LIMIT = 16;
export const PROBE_EDGE_LIMIT = 80;

const isProtected = reasons => (reasons ?? []).some(reason => PROTECTED_CORE_KINDS.has(reason));
const tally = values => values.reduce((acc, value) => { acc[value] = (acc[value] ?? 0) + 1; return acc; }, {});
const utf8Bytes = (lines, start, end) => Buffer.byteLength(lines.slice(start - 1, end).join("\n") + "\n");
/** The declaring file of a named type id (`type:v2:<path>#<fqn>`, src/java-index/stable-id.ts); local types have none here. */
export const typePath = typeId => (typeId.startsWith("type:v2:") ? decodeURIComponent(typeId.slice("type:v2:".length).split("#")[0]) : null);

/**
 * The C0 call's read plan as the probe needs it: which files are selected, how many of them are protected core,
 * and the bytes the anchor plus the protected core already take (UTF-8 of the planned line ranges, an approximation
 * of the product's exact slices). `lines(path)` returns a corpus file's lines. Protected is read from the reasons; the
 * planner's own isProtectedCore also needs CALLS depth <= 1 and some Spring conditions, so this can overcount the core
 * and only makes the probe more likely to stop.
 */
export function planState(diagnostic, lines) {
  const byId = new Map((diagnostic?.files ?? []).map(file => [file.id, file]));
  const selected = [];
  for (const entry of diagnostic?.readPlan ?? []) {
    const file = byId.get(entry.fileId);
    if (!file) continue;
    const source = lines(file.path);
    const bytes = source ? (entry.ranges ?? []).reduce((sum, range) => sum + utf8Bytes(source, range.startLine, range.endLine), 0) : 0;
    // The diagnostic projection names the anchor's role "target" (src/agent-router/output-v6.ts ROLE_PRECEDENCE).
    const anchor = file.role === "target" || (file.reasons ?? []).includes("anchor");
    selected.push({ path: file.path, anchor, core: !anchor && isProtected(file.reasons), bytes });
  }
  return {
    coreExceeded: (diagnostic?.evidenceGaps ?? []).some(gap => String(gap).startsWith(CORE_EXCEEDED_GAP)),
    selectedPaths: new Set(selected.map(file => file.path)),
    selectedFiles: selected.length,
    coreSelected: selected.filter(file => file.core).length,
    coreBytes: selected.filter(file => file.anchor || file.core).reduce((sum, file) => sum + file.bytes, 0),
    planBytes: selected.reduce((sum, file) => sum + file.bytes, 0),
    poolSize: (diagnostic?.files ?? []).length,
    reasonsOf: filePath => (diagnostic?.files ?? []).find(file => file.path === filePath)?.reasons ?? []
  };
}

/**
 * Caller files for one method, as design §3.3 would keep them: main sources only, the anchor's own file dropped,
 * grouped by file, best edge confidence first, then path, at most CALLER_FILE_CAP files. `edges` is queryCallers output
 * with each edge's calling method range resolved (`callerRange`, or null when the method is not found).
 */
export function callerFiles(edges, anchorPath) {
  const byFile = new Map();
  for (const edge of edges) {
    if (edge.sourceSet === "test" || edge.sourceFile === anchorPath) continue;
    const entry = byFile.get(edge.sourceFile) ?? { path: edge.sourceFile, confidence: 0, ranges: [] };
    entry.confidence = Math.max(entry.confidence, edge.confidence ?? 0);
    if (edge.callerRange) entry.ranges.push(edge.callerRange);
    byFile.set(edge.sourceFile, entry);
  }
  return [...byFile.values()].sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path)).slice(0, CALLER_FILE_CAP);
}

/** Whether a calling method's range would credit the gold item: it covers the item and the item ends within the reader cap. */
export function spanCredits(range, item) {
  return range.startLine <= item.startLine && range.endLine >= item.endLine && item.endLine - range.startLine + 1 <= READER_MAX_LINES;
}

/**
 * One gold target against one C0 call. Reachable = returned as a caller, its calling method range credits the item,
 * the call did not exceed the protected core, the core has a free slot, and anchor + core + the new span fit the bytes.
 * A credited target is at risk when it is returned, was selected in this call without a protected reason, and the call's
 * core is exceeded or full: a CALLER reason would lock it into the core bucket (read-plan.ts bucketOf).
 */
export function judgeTarget({ item, credited, plan, direct, via, lines }) {
  const directFile = direct.find(file => file.path === item.path);
  const viaFile = via.find(file => file.path === item.path);
  const returned = directFile ? "direct" : viaFile ? "via-supertype" : "none";
  const file = directFile ?? viaFile;
  const span = file?.ranges.find(range => spanCredits(range, item));
  const source = lines(item.path);
  const spanBytes = span && source ? utf8Bytes(source, span.startLine, Math.min(span.endLine, span.startLine + READER_MAX_LINES - 1)) : null;
  const coreRoom = !plan.coreExceeded && plan.coreSelected < C0.coreMax;
  const fits = spanBytes !== null && plan.coreBytes + spanBytes <= C0.maxReadBytes;
  const alreadyProtected = isProtected(plan.reasonsOf(item.path));
  return {
    returned,
    spanCredits: Boolean(span),
    coreExceeded: plan.coreExceeded,
    coreRoom,
    fits,
    reachable: !credited && returned === "direct" && Boolean(span) && coreRoom && fits,
    reachableViaSupertype: !credited && returned === "via-supertype" && Boolean(span) && coreRoom && fits,
    atRisk: credited && returned !== "none" && plan.selectedPaths.has(item.path) && !alreadyProtected
      && (plan.coreExceeded || plan.coreSelected >= C0.coreMax)
  };
}

/** Counts only. `rows`: one per (task, target) with the best call's judgement and the per-call facts. */
export function summarize({ rows, calls }) {
  const uncredited = rows.filter(row => !row.credited);
  const credited = rows.filter(row => row.credited);
  const reachable = uncredited.filter(row => row.judgement?.reachable);
  const groups = new Set(reachable.map(row => row.taskGroup ?? row.taskId));
  return {
    calls: {
      total: calls.length,
      anchorKinds: tally(calls.map(call => call.anchorKind)),
      queried: calls.filter(call => call.queried).length,
      truncatedAtDesignLimit: calls.filter(call => call.directEdges > DESIGN_EDGE_LIMIT).length,
      truncatedAtProbeLimit: calls.filter(call => call.directEdges > PROBE_EDGE_LIMIT).length,
      directEdges: spread(calls.filter(call => call.queried).map(call => call.directEdges)),
      callerFiles: spread(calls.filter(call => call.queried).map(call => call.directFiles)),
      viaSupertypeFiles: spread(calls.filter(call => call.queried).map(call => call.viaFiles)),
      coreExceeded: calls.filter(call => call.coreExceeded).length,
      selectedFiles: spread(calls.map(call => call.selectedFiles)),
      planBytes: spread(calls.map(call => call.planBytes)),
      poolSize: spread(calls.map(call => call.poolSize))
    },
    targets: {
      total: rows.length,
      credited: credited.length,
      uncredited: uncredited.length,
      uncreditedByAnchorKind: tally(uncredited.map(row => row.bestAnchorKind ?? "no-call")),
      returned: tally(uncredited.map(row => row.judgement?.returned ?? "no-method-call")),
      returnedSpanCredits: uncredited.filter(row => row.judgement?.returned !== undefined && row.judgement.returned !== "none" && row.judgement.spanCredits).length,
      blockedByCore: uncredited.filter(row => row.judgement?.returned === "direct" && row.judgement.spanCredits && !row.judgement.coreRoom).length,
      blockedByBytes: uncredited.filter(row => row.judgement?.returned === "direct" && row.judgement.spanCredits && row.judgement.coreRoom && !row.judgement.fits).length,
      reachable: reachable.length,
      reachableViaSupertype: uncredited.filter(row => row.judgement?.reachableViaSupertype).length,
      reachableTaskGroups: groups.size,
      creditedReturned: credited.filter(row => row.judgement && row.judgement.returned !== "none").length,
      creditedAtRisk: credited.filter(row => row.judgement?.atRisk).length
    },
    stopRule: stopRule({ reachable: reachable.length, groups: groups.size, atRisk: credited.filter(row => row.judgement?.atRisk).length })
  };
}

/**
 * Design §8 (fixed before the run): stop when fewer than 2 reachable targets or fewer than 2 task groups. Credited targets
 * at risk do not stop S3 on their own: they rule out the "locked into core" shape of review F1, leaving the other two.
 */
export function stopRule({ reachable, groups, atRisk }) {
  const reasons = [];
  if (reachable < 2) reasons.push("reachable<2");
  if (groups < 2) reasons.push("taskGroups<2");
  return { stop: reasons.length > 0, reasons, lockedCoreShapeExcluded: atRisk > 0 };
}

function spread(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { n: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) };
}

/**
 * The index side of one call: anchor kind at the call's selection, direct callers, and callers of the methods the anchor
 * overrides in its direct repo supertypes (same name and arity). `index` is the subset of SqlJavaIndexClient used here.
 */
export async function callersOf(index, anchor) {
  const facts = await index.queryAnchor(anchor.relativePath, anchor.selection.line, anchor.selection.column);
  const anchorKind = facts?.symbolKind ?? "NONE";
  if (anchorKind !== "METHOD" || !facts.method) return { anchorKind, queried: false, directEdges: 0, direct: [], via: [] };
  const methodsByPath = new Map();
  const methodsIn = async file => {
    if (!methodsByPath.has(file)) methodsByPath.set(file, (await index.queryFiles([file]))[0]?.methods ?? []);
    return methodsByPath.get(file);
  };
  const withRanges = async edges => Promise.all(edges.map(async edge => {
    const method = (await methodsIn(edge.sourceFile)).find(entry => entry.methodId === edge.sourceId);
    return { ...edge, callerRange: method ? { startLine: method.range.start.line, endLine: method.range.end.line } : null };
  }));
  const directRaw = await index.queryCallers(facts.method.methodId, PROBE_EDGE_LIMIT + 1);
  const direct = callerFiles(await withRanges(directRaw), anchor.relativePath);
  const supers = [...(facts.type?.extends ?? []), ...(facts.type?.implements ?? [])]
    .filter(ref => ref.resolution.state === "RESOLVED_REPO").map(ref => ref.resolution.typeId);
  const viaEdges = [];
  for (const typeId of supers) {
    const typeFile = typePath(typeId);
    if (!typeFile) continue;
    for (const method of (await methodsIn(typeFile)).filter(entry => entry.ownerTypeId === typeId && entry.constructor !== true
      && entry.name === facts.method.name && entry.parameters.length === facts.method.parameters.length)) {
      viaEdges.push(...await index.queryCallers(method.methodId, PROBE_EDGE_LIMIT + 1));
    }
  }
  const directPaths = new Set(direct.map(file => file.path));
  const via = callerFiles(await withRanges(viaEdges), anchor.relativePath).filter(file => !directPaths.has(file.path));
  return { anchorKind, queried: true, directEdges: directRaw.length, direct, via };
}

const jsonl = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

/** Pure over its inputs: every dev callers task against its recorded C0 calls and an index view per corpus. */
export async function probeTasks({ tasks, gold, rows, observations, indexFor, linesFor }) {
  const byTask = new Map(observations.map(observation => [observation.taskId, observation]));
  const outRows = [];
  const outCalls = [];
  for (const row of rows.filter(entry => entry.category === "callers")) {
    const task = tasks.get(row.taskId);
    const required = gold.get(row.taskId)?.requiredEvidence ?? [];
    const index = await indexFor(task.corpusId);
    const lines = linesFor(task.corpusId);
    const observation = byTask.get(row.taskId) ?? { terms: [] };
    const anchors = observation.terms.filter(term => term.impacts?.C0).map(term => term.symbol?.candidates?.[0]?.declaration ?? null);
    const calls = [];
    for (const [i, { diagnostic }] of callsOf(observation, "C0").entries()) {
      const anchor = anchors[i];
      const plan = planState(diagnostic, lines);
      const found = anchor?.selection ? await callersOf(index, anchor) : { anchorKind: "NO_ANCHOR", queried: false, directEdges: 0, direct: [], via: [] };
      calls.push({ plan, ...found });
      outCalls.push({ anchorKind: found.anchorKind, queried: found.queried, directEdges: found.directEdges, directFiles: found.direct.length, viaFiles: found.via.length,
        coreExceeded: plan.coreExceeded, selectedFiles: plan.selectedFiles, planBytes: plan.planBytes, poolSize: plan.poolSize });
    }
    (row.configs.C0?.targets ?? []).forEach((target, index) => {
      if (target.kind !== "java") return;
      const item = required[index];
      const judged = calls.filter(call => call.queried).map(call => judgeTarget({ item, credited: target.credited, plan: call.plan, direct: call.direct, via: call.via, lines }));
      const rank = judgement => (judgement.reachable ? 4 : 0) + (judgement.atRisk ? 8 : 0) + (judgement.reachableViaSupertype ? 2 : 0) + (judgement.returned !== "none" ? 1 : 0);
      const best = judged.sort((a, b) => rank(b) - rank(a))[0] ?? null;
      outRows.push({ taskId: row.taskId, taskGroup: task.taskGroup ?? null, path: item.path, index, credited: target.credited, label: target.label,
        bestAnchorKind: calls.find(call => call.queried)?.anchorKind ?? calls[0]?.anchorKind ?? null, judgement: best });
    });
  }
  return { rows: outRows, calls: outCalls };
}

/** Lines of any corpus file (Java or not, e.g. MyBatis XML in the plan), read once; undefined outside the corpus or when missing. */
export function corpusLines(root) {
  const cache = new Map();
  return relativePath => {
    if (!cache.has(relativePath)) {
      const full = path.resolve(root, relativePath);
      let lines;
      if (full.startsWith(root + path.sep)) { try { lines = readFileSync(full, "utf8").split("\n"); } catch { lines = undefined; } }
      cache.set(relativePath, lines);
    }
    return cache.get(relativePath);
  };
}

export async function runProbe({ datasetFile, tasksFile, goldFile, inputsFile, distRoot, responsesFile, rowsFile, out, verify = verifyDataset, materialize = materializeCorpus }) {
  const { root, manifest } = await verify(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  requireValue(manifest.parts["tasks-dev"]?.sha256 === sha256(tasksBytes), "tasks file is not this dataset's dev split");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const rowsBytes = await readFile(rowsFile);
  requireValue(sha256(rowsBytes) === S1_ROWS_SHA256, "rows.jsonl is not the recorded S1 replay");
  const responsesBytes = await readFile(responsesFile);
  const tasks = new Map(jsonl(tasksBytes).map(task => [task.taskId, task]));
  const gold = new Map(jsonl(goldBytes).map(row => [row.taskId, row]));
  const rows = jsonl(rowsBytes);
  const observations = jsonl(responsesBytes);
  // The replay appends responses per corpus and writes rows in task order, so only the task sets must agree.
  const ids = list => JSON.stringify(list.map(entry => entry.taskId).sort());
  requireValue(ids(observations) === ids(rows), "responses.jsonl is not the replay that wrote rows.jsonl");
  await mkdir(out, { recursive: true });
  const dist = file => import(pathToFileURL(path.join(distRoot, file)).href);
  const [{ runSqlColdBuild }, { close, openIndexDb }, { ensureSchema }, { SqlJavaIndexClient }] = await Promise.all([
    dist("index-builder/cold-build.js"), dist("java-index/sql/driver.js"), dist("java-index/sql/schema.js"), dist("java-index/sql/sql-client.js")]);
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const clients = new Map();
  const sources = new Map();
  const indexFor = async corpusId => {
    if (clients.has(corpusId)) return clients.get(corpusId);
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(entry => entry.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId) });
    sources.set(corpusId, corpusLines(path.resolve(corpusRoot)));
    const dbPath = path.join(out, "index", `${corpusId}.db`);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = openIndexDb(dbPath);
    try { ensureSchema(db); await runSqlColdBuild({ repoRoot: corpusRoot, db, generation: 1 }); } finally { close(db); }
    const client = new SqlJavaIndexClient(corpusRoot, dbPath);
    await client.open(1);
    // The probe speaks corpus-relative paths; the client resolves inputs against its own layout from absolute paths.
    const at = file => path.join(corpusRoot, file);
    const view = { client, queryAnchor: (file, line, column) => client.queryAnchor(at(file), line, column),
      queryFiles: files => client.queryFiles(files.map(at)), queryCallers: (methodId, limit) => client.queryCallers(methodId, limit) };
    clients.set(corpusId, view);
    return view;
  };
  // Corpora are opened before their tasks are probed, so linesFor is always called after indexFor for the same corpus.
  const linesFor = corpusId => filePath => sources.get(corpusId)?.(filePath);
  let result;
  try {
    result = await probeTasks({ tasks, gold, rows, observations, indexFor, linesFor });
  } finally {
    for (const view of clients.values()) await view.client.close().catch(() => {});
  }
  await writeFile(path.join(out, "probe-rows.jsonl"), result.rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: PROBE_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes),
      rowsSha256: S1_ROWS_SHA256, responsesSha256: sha256(responsesBytes), distBuildStampSha256: sha256(await readFile(path.join(distRoot, "build-stamp.json"))) },
    limits: { C0, READER_MAX_LINES, CALLER_FILE_CAP, DESIGN_EDGE_LIMIT, PROBE_EDGE_LIMIT },
    ...summarize(result),
    notClaimed: "Mechanism counts on the seen dev split. Reachable is computed from the recorded S1 C0 plans with UTF-8 line bytes and reason-based protection (may overcount the core), not by re-running the planner with a CALLER reason; the supertype count uses one-hop same-name-and-arity overrides; no product change is measured."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const names = ["--dataset", "--tasks", "--gold", "--inputs", "--dist", "--responses", "--rows", "--out"];
  const options = cliOptions(args, names);
  for (const name of names) requireValue(options[name.slice(2)], `${name} is required`);
  const summary = await runProbe({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), distRoot: path.resolve(options.dist), responsesFile: path.resolve(options.responses), rowsFile: path.resolve(options.rows),
    out: path.resolve(options.out) });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
