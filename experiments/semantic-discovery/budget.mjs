// input:  Ranked lexical (product java_symbol) and dense declaration ids, the
//         product index (declaration facts), the frozen task budget and kit.
// output: R11 equal-budget arms: RRF fusion, one shared declaration resolver
//         and evidence renderer for A2 and A3, the frozen kit scorer bridge,
//         the ExperimentProfile/protocol hash and the four-way decision rule.
// pos:    docs/next-stage/experiment-v1.1.md; kit docs/06-experiment-redesign.md
//         (A3 = RRF(lexical, dense, k0=60).dedup(declarationId).top(10);
//         sameRenderer(candidates, sourceBudget); frozen evaluator).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";

/** Frozen fusion constants (kit 06: k0=60 is a frozen initial value, not tuned). */
export const RRF_K0 = 60;
export const CANDIDATE_K = 10;
/** Each channel contributes its own top-K to the pool; the cap is on the fused list. */
export const CHANNEL_POOL_K = 10;
export const RENDERER_VERSION = "declaration-head-window/v1";
/** decideFourWay rule version: v2 adds the fill control, MRR/line non-regression and agent gates. */
export const DECISION_RULE_VERSION = "decideFourWay/v2";

/** Canonical JSON: object keys sorted at every depth. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = data => createHash("sha256").update(data).digest("hex");

/**
 * The fixed experiment profile: everything that has to be equal between arms
 * or between a run and its rerun. Changing any field is a new protocol.
 */
export function experimentProfile({
  question,
  arms,
  corpus,
  representation,
  provider,
  lexical,
  budget,
  scorer,
  agent = null
}) {
  for (const [name, value] of Object.entries({ question, arms, corpus, representation, lexical, budget, scorer })) {
    if (value === undefined || value === null) throw new Error(`experimentProfile: ${name} is required`);
  }
  for (const key of ["max_regions", "max_lines", "max_bytes"]) {
    if (!Number.isInteger(budget[key]) || budget[key] <= 0) throw new Error(`experimentProfile: budget.${key} must be a positive integer`);
  }
  return Object.freeze({
    schema: "java-specialist-experiment-profile/v1",
    question,
    arms,
    corpus,
    representation,
    provider: provider ?? null,
    lexical,
    fusion: { method: "RRF", k0: RRF_K0, candidateK: CANDIDATE_K, channelPoolK: CHANNEL_POOL_K, dedup: "declarationId" },
    renderer: {
      version: RENDERER_VERSION,
      window: "declaration start line, floor(max_lines / max_regions) lines, clipped to the remaining line and byte budget",
      stale: "DROP (current file sha256 differs from the indexed hash)"
    },
    budget: { max_regions: budget.max_regions, max_lines: budget.max_lines, max_bytes: budget.max_bytes },
    scorer,
    decision: DECISION_RULE_VERSION,
    agent
  });
}

export function protocolHash(profile) {
  return sha256(canonicalJson(profile));
}

/**
 * The protocols whose results are INVALID_EXPERIMENT_FOR_CAUSAL_CLAIMS (kit
 * 06): A3 = A2 + extra hints (unequal budget) and scorers that credited
 * path-only hints with the whole file or skipped region validation.
 */
export const LEGACY_INVALID_PROTOCOLS = Object.freeze([
  Object.freeze({
    schema: "java-specialist-m3-retrieval/v1",
    a3: "a2 + up to 8 dense hints appended (unequal budget)",
    scorer: "compare.mjs coverage(): path-only hint = whole file, any overlap = full evidence item"
  }),
  Object.freeze({
    schema: "java-specialist-m3-retrieval/v2",
    a3: "a2 + up to 8 dense hints appended (unequal budget)",
    scorer: "line-recall.mjs line-set recall without region validation or budget"
  })
]);

export const LEGACY_INVALID_PROTOCOL_HASHES = Object.freeze(LEGACY_INVALID_PROTOCOLS.map(protocolHash));

/**
 * Reciprocal rank fusion over declaration ids (1-based ranks). A channel that
 * did not return a declaration contributes 0; duplicates within a channel
 * keep their best rank. Ties: higher score, then better lexical rank, then
 * better dense rank, then id - deterministic.
 */
export function rrfFuse(lexicalIds, denseIds, { k0 = RRF_K0, k = CANDIDATE_K } = {}) {
  const entries = new Map();
  const add = (ids, channel) => {
    ids.forEach((id, index) => {
      if (typeof id !== "string" || id === "") return;
      const entry = entries.get(id) ?? { declarationId: id, score: 0, lexicalRank: null, denseRank: null };
      if (entry[channel] !== null) return;
      entry[channel] = index + 1;
      entry.score += 1 / (k0 + index + 1);
      entries.set(id, entry);
    });
  };
  add(lexicalIds, "lexicalRank");
  add(denseIds, "denseRank");
  const rankOr = value => (value === null ? Number.POSITIVE_INFINITY : value);
  return [...entries.values()]
    .sort((a, b) => b.score - a.score || rankOr(a.lexicalRank) - rankOr(b.lexicalRank) ||
      rankOr(a.denseRank) - rankOr(b.denseRank) || (a.declarationId < b.declarationId ? -1 : 1))
    .slice(0, k);
}

/** Ranked, de-duplicated declaration ids of a product java_symbol result. */
export function lexicalDeclarationIds(result, k = CHANNEL_POOL_K) {
  const ids = [];
  for (const candidate of result?.candidates ?? []) {
    const id = candidate?.declaration?.id;
    if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    if (ids.length >= k) break;
  }
  return ids;
}

/**
 * Declaration locators from the product index facts (type/method rows), the
 * same source the product's own locator uses: line = the name
 * (nameRange.start), the window starts at the declaration head
 * (range.start, annotations included). Both arms resolve through this one
 * resolver.
 */
export class DeclarationResolver {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
    this.memo = new Map();
    this.typeRow = this.db.prepare(
      "SELECT t.facts AS facts, f.path AS path, f.content_hash AS contentHash FROM type t JOIN sym s ON s.id=t.sym JOIN file f ON f.id=t.file_id WHERE s.text=?"
    );
    this.methodRow = this.db.prepare(
      "SELECT m.facts AS facts, f.path AS path, f.content_hash AS contentHash FROM method m JOIN sym s ON s.id=m.sym JOIN file f ON f.id=m.file_id WHERE s.text=?"
    );
  }

  resolve(declarationId) {
    if (this.memo.has(declarationId)) return this.memo.get(declarationId);
    let locator = null;
    for (const [kind, statement] of [["type", this.typeRow], ["method", this.methodRow]]) {
      const row = statement.get(declarationId);
      if (!row) continue;
      const facts = JSON.parse(inflateRawSync(Buffer.from(row.facts)).toString("utf8"));
      const range = facts.range;
      if (!range?.start?.line || !range?.end?.line) break;
      locator = {
        declarationId,
        kind,
        name: kind === "type" ? facts.simpleName : facts.name,
        path: row.path,
        contentHash: row.contentHash,
        // The product locator: the declaration name (facts revision 4).
        line: (facts.nameRange?.start ?? range.start).line,
        startLine: range.start.line,
        endLine: range.end.line
      };
      break;
    }
    this.memo.set(declarationId, locator);
    return locator;
  }

  close() {
    this.db.close();
  }
}

/** Source lines with their terminators, as the kit counts them (bytes.splitlines(keepends=True)). */
function sourceLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a || buffer[i] === 0x0d) {
      const end = buffer[i] === 0x0d && buffer[i + 1] === 0x0a ? i + 2 : i + 1;
      lines.push(buffer.subarray(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < buffer.length) lines.push(buffer.subarray(start));
  return lines;
}

/**
 * The one evidence renderer of both arms. Walks the ranked declarations:
 * - an unresolvable id or a file whose current sha256 differs from the
 *   indexed hash is DROPPED (never a path-only or stale-range credit);
 * - up to K candidates {path, line, name};
 * - up to max_regions regions, each from the declaration head for
 *   floor(max_lines / max_regions) lines, clipped to the remaining line and
 *   byte budget, so emitted lines/bytes never exceed the task budget.
 */
export function renderEvidence({ declarationIds, resolver, repoRoot, budget, k = CANDIDATE_K }) {
  const share = Math.floor(budget.max_lines / budget.max_regions);
  const files = new Map();
  const fileOf = relativePath => {
    if (!files.has(relativePath)) {
      const absolute = path.join(repoRoot, relativePath);
      if (!existsSync(absolute)) {
        files.set(relativePath, null);
      } else {
        const buffer = readFileSync(absolute);
        files.set(relativePath, { hash: sha256(buffer), lines: sourceLines(buffer) });
      }
    }
    return files.get(relativePath);
  };
  const finalCandidates = [];
  const regions = [];
  const dropped = { unresolved: [], stale: [] };
  let lines = 0;
  let bytes = 0;
  for (const declarationId of declarationIds) {
    if (finalCandidates.length >= k) break;
    const locator = resolver.resolve(declarationId);
    if (!locator) {
      dropped.unresolved.push(declarationId);
      continue;
    }
    const file = fileOf(locator.path);
    if (!file || file.hash !== locator.contentHash || (locator.startLine ?? locator.line) > file.lines.length) {
      dropped.stale.push(declarationId);
      continue;
    }
    finalCandidates.push({ path: locator.path, line: locator.line, name: locator.name, declarationId });
    if (regions.length >= budget.max_regions) continue;
    const start = locator.startLine ?? locator.line;
    let end = Math.min(locator.endLine, start + share - 1, start + (budget.max_lines - lines) - 1, file.lines.length);
    let size = 0;
    for (let line = start; line <= end; line += 1) size += file.lines[line - 1].length;
    while (end >= start && bytes + size > budget.max_bytes) {
      size -= file.lines[end - 1].length;
      end -= 1;
    }
    if (end < start) continue;
    regions.push({ path: locator.path, start_line: start, end_line: end, content_hash: file.hash });
    lines += end - start + 1;
    bytes += size;
  }
  return { finalCandidates, regions, emitted_lines: lines, emitted_bytes: bytes, dropped };
}

/**
 * The one candidate block both arms receive: ranked locators only (no source
 * text), at most K entries, same header and wording; only the list differs.
 */
export function formatCandidateBlock(finalCandidates) {
  const lines = finalCandidates.length
    ? finalCandidates.map((candidate, index) => `${index + 1}. ${candidate.path}:${candidate.line} ${candidate.name}`)
    : ["(none)"];
  return `\nPrecomputed discovery candidates (ranked declaration locators, at most ${CANDIDATE_K}; verify by reading the code):\n${lines.join("\n")}`;
}

/** One kit result row (java-specialist-results/v1 `results[]` entry). */
export function kitResult(taskId, rendered, variant = "primary") {
  return {
    task_id: taskId,
    variant,
    status: "OK",
    regions: rendered.regions,
    candidates: rendered.finalCandidates.map(({ path: candidatePath, line, name }) => ({ path: candidatePath, line, name })),
    answer: null,
    usage: null
  };
}

function runPython(kitRoot, args, input, python) {
  const run = spawnSync(python, ["-B", ...args], {
    cwd: kitRoot,
    input,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  });
  if (run.status !== 0) throw new Error(`kit scorer failed: ${(run.error?.message ?? run.stderr ?? "").slice(0, 400)}`);
  return run.stdout;
}

/**
 * The frozen kit scorer itself (harness/scoring.py evaluate), one row per
 * case: {task, gold, result, root}. Used where a case is not a dataset task
 * (fixtures) or for per-case diagnostics.
 */
export function kitEvaluate({ kitRoot, cases, python = process.env.JSB_PYTHON ?? "python3" }) {
  const script = [
    "import json,sys",
    "from pathlib import Path",
    "from harness.scoring import evaluate",
    "cases=json.load(sys.stdin)",
    "print(json.dumps([evaluate(c['task'],c['gold'],c['result'],Path(c['root'])) for c in cases]))"
  ].join("\n");
  return JSON.parse(runPython(kitRoot, ["-c", script], JSON.stringify(cases), python));
}

/** dataset_hash / corpus_hash exactly as the kit computes them. */
export function kitHashes({ kitRoot, corporaRoot, python = process.env.JSB_PYTHON ?? "python3" }) {
  const script = [
    "import json,sys",
    "from pathlib import Path",
    "from harness.dataset import dataset_digest",
    "from harness.cli import corpus_fingerprint",
    "print(json.dumps({'dataset':dataset_digest(Path(sys.argv[1])),'corpus':corpus_fingerprint(Path(sys.argv[2])),",
    "  'scorer':__import__('hashlib').sha256(Path('harness/scoring.py').read_bytes()).hexdigest()}))"
  ].join("\n");
  return JSON.parse(runPython(kitRoot, ["-c", script, path.join(kitRoot, "dataset"), corporaRoot], "", python));
}

/** `harness score` over a java-specialist-results/v1 pack file; returns the report. */
export function kitScorePack({ kitRoot, corporaRoot, packPath, reportPath, split = "dev", python = process.env.JSB_PYTHON ?? "python3" }) {
  runPython(kitRoot, ["-m", "harness", "--dataset", path.join(kitRoot, "dataset"), "--corpora-root", corporaRoot,
    "score", "--input", packPath, "--split", split, "--output", reportPath], "", python);
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

/** `harness compare` (paired, cluster bootstrap) of two kit reports. */
export function kitCompare({ kitRoot, baselinePath, candidatePath, outputPath, python = process.env.JSB_PYTHON ?? "python3" }) {
  runPython(kitRoot, ["-m", "harness", "--dataset", path.join(kitRoot, "dataset"), "compare",
    "--baseline", baselinePath, "--candidate", candidatePath, "--output", outputPath], "", python);
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

/**
 * Macro (mean of per-task recall, the kit's aggregate) and micro evidence
 * (pooled required lines) with their numerators and denominators. The micro
 * numerator is recovered from the kit's per-task recall and the gold line
 * count, and must be an integer.
 */
export function evidenceTotals(rows, goldById) {
  let required = 0;
  let hit = 0;
  let recallSum = 0;
  let tasks = 0;
  for (const row of rows) {
    const gold = goldById.get(row.task_id);
    if (!gold || row.required_line_recall === null || row.required_line_recall === undefined) continue;
    const lines = new Set();
    for (const evidence of gold.required_evidence ?? []) {
      for (let line = evidence.start_line; line <= evidence.end_line; line += 1) lines.add(`${evidence.path}:${line}`);
    }
    const taskHit = row.required_line_recall * lines.size;
    if (Math.abs(taskHit - Math.round(taskHit)) > 1e-9) throw new Error(`non-integer covered line count for ${row.task_id}`);
    required += lines.size;
    hit += Math.round(taskHit);
    recallSum += row.required_line_recall;
    tasks += 1;
  }
  return {
    macroTask: { numerator: recallSum, denominator: tasks, value: tasks ? recallSum / tasks : null },
    microEvidence: { numerator: hit, denominator: required, value: required ? hit / required : null }
  };
}

/**
 * Non-semantic control for the dense arm (R11 review P1-1): the lexical list
 * padded to K with a seeded shuffle of the remaining declarations. A3 must beat
 * this, or its gain is only "more candidates", not dense semantics.
 */
export function seededFill(lexicalIds, allIds, { k = CANDIDATE_K, seed = "r11-fill" } = {}) {
  const keyOf = id => createHash("sha256").update(`${seed}\u0000${id}`).digest("hex");
  const rest = [...new Set(allIds)].filter(id => !lexicalIds.includes(id)).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  return [...lexicalIds, ...rest].slice(0, k);
}

const lower = metric => metric?.cluster_bootstrap_95?.[0];

/**
 * Four-way decision (kit 06), deterministic, thresholds from the frozen kit
 * gates. The retrieval layer alone can at most pass the screen:
 * - INVALID_EXPERIMENT: invalid or over-budget rows in any arm;
 * - NO_GO: the Recall@10 delta's bootstrap UPPER bound is below the gate over
 *   >= minClusters clusters (the gate cannot be reached);
 * - GO_OPTIONAL needs every one of: the screen (Recall@10 delta >= gate, lower
 *   bound > 0, >= minClusters), A3 also beating the non-semantic fill control
 *   on Recall@10 (lower bound > 0), no rank regression (MRR and line recall
 *   lower bounds >= 0), and agent evidence (QA delta lower bound >= 0 and the
 *   prompt-token median ratio <= dense_input_token_median_max_ratio);
 * - INCONCLUSIVE otherwise, with every unmet condition listed.
 * KEEP_EXTERNAL is a product judgment the experiment cannot produce.
 */
export function decideFourWay({ comparison, fillComparison = null, reports, gates, agent = null, minClusters = 8 }) {
  const invalid = [];
  for (const [arm, report] of Object.entries(reports)) {
    const overall = report.summary?.overall ?? {};
    if (overall.invalid > 0) invalid.push(`${arm}: ${overall.invalid} invalid rows`);
    if (overall.over_budget > 0) invalid.push(`${arm}: ${overall.over_budget} over-budget rows`);
  }
  if (invalid.length > 0) return { decision: "INVALID_EXPERIMENT", screen: null, reasons: invalid };
  const gate = gates.dense_recall_at_10_min_delta;
  const recall = comparison.metrics?.declaration_recall_at_10;
  if (!recall) return { decision: "INCONCLUSIVE", screen: null, reasons: ["no paired Recall@10 delta"] };
  const [low, high] = recall.cluster_bootstrap_95;
  const enough = recall.clusters >= minClusters;
  const ci = `Recall@10 delta ${recall.cluster_macro_delta}, CI [${low}, ${high}] over ${recall.clusters} clusters; gate ${gate}`;
  if (high < gate && enough) return { decision: "NO_GO", screen: "FAIL", reasons: [ci, "even the upper bound is below the gate"] };
  const unmet = [];
  if (!(recall.cluster_macro_delta >= gate && low > 0)) unmet.push(`screen: ${ci}`);
  if (!enough) unmet.push(`only ${recall.clusters} clusters (< ${minClusters})`);
  const screen = unmet.length === 0 ? "PASS" : "FAIL";
  const fill = fillComparison?.metrics?.declaration_recall_at_10;
  if (!(lower(fill) > 0)) unmet.push(fill ? `A3 vs fill control Recall@10 lower bound ${lower(fill)} <= 0` : "no fill-control comparison");
  for (const name of ["mrr", "required_line_recall"]) {
    const metric = comparison.metrics?.[name];
    if (!(lower(metric) >= 0)) unmet.push(`${name} lower bound ${lower(metric)} < 0 (rank or evidence regression)`);
  }
  if (!agent) {
    unmet.push("no agent-layer evidence (QA delta, prompt-token median ratio)");
  } else {
    if (!(agent.qaDeltaLower >= 0)) unmet.push(`agent QA delta lower bound ${agent.qaDeltaLower} < 0`);
    const maxRatio = gates.dense_input_token_median_max_ratio;
    if (!(agent.tokenMedianRatio <= maxRatio)) unmet.push(`agent prompt-token median ratio ${agent.tokenMedianRatio} > ${maxRatio}`);
  }
  if (unmet.length === 0) return { decision: "GO_OPTIONAL", screen, reasons: [ci] };
  return { decision: "INCONCLUSIVE", screen, reasons: unmet };
}

/**
 * Paired kit comparison restricted to a pilot's tasks: the kit scores the
 * whole split, and tasks outside the pilot are MISSING in both arms (zero
 * deltas). The filtered reports drop the whole-split summary.
 */
export function comparePilotReports({ kitRoot, baselineReportPath, candidateReportPath, pilotIds, outputDir, name }) {
  const filtered = (reportPath, label) => {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const target = path.join(outputDir, `${name}-${label}-pilot-report.json`);
    const { summary: _wholeSplit, ...rest } = report;
    writeFileSync(target, `${JSON.stringify({ ...rest, rows: report.rows.filter(row => pilotIds.includes(row.task_id)) }, null, 1)}\n`);
    return target;
  };
  return kitCompare({
    kitRoot,
    baselinePath: filtered(baselineReportPath, "baseline"),
    candidatePath: filtered(candidateReportPath, "candidate"),
    outputPath: path.join(outputDir, `${name}-compare.json`)
  });
}

/** Median of the per-attempt prompt tokens; null when any attempt lacks usage. */
export function medianPromptTokens(runs) {
  const values = runs.map(run => run.usage?.promptTokens ?? run.usage?.inputTokens);
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Per-origin / per-corpus / per-variant deltas of one metric from two kit reports (paired by task, variant, repeat). */
export function stratifiedDelta(baseline, candidate, metric, by) {
  const groups = new Map();
  const keyOf = row => `${row.task_id}\u0000${row.variant ?? "primary"}\u0000${row.repeat ?? 0}`;
  const index = new Map(baseline.rows.map(row => [keyOf(row), row]));
  for (const row of candidate.rows) {
    const base = index.get(keyOf(row));
    if (!base || base[metric] == null || row[metric] == null) continue;
    const key = row[by] ?? base[by];
    const entry = groups.get(key) ?? { tasks: 0, baseline: 0, candidate: 0 };
    entry.tasks += 1;
    entry.baseline += base[metric];
    entry.candidate += row[metric];
    groups.set(key, entry);
  }
  return Object.fromEntries([...groups].map(([key, entry]) => [key, {
    tasks: entry.tasks,
    baseline: entry.baseline / entry.tasks,
    candidate: entry.candidate / entry.tasks,
    delta: (entry.candidate - entry.baseline) / entry.tasks
  }]));
}
