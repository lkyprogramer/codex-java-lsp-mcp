#!/usr/bin/env node
// input: Tuning-only golden + compact/diagnostic impact dump (pool vs read-plan).
// output: NOT_IN_POOL / IN_POOL_EVICTED / RANGE_MISS mix. Holdout rows never accepted.
// pos: B0. Pure labels so T0 can drive them without MCP.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isHoldoutScene, loadTuningScenes, posixPath } from "./audit-golden-quality.mjs";

export const B0_SCHEMA = "b-b0-diagnosis/v1";
export const MISS_NOT_IN_POOL = "NOT_IN_POOL";
export const MISS_IN_POOL_EVICTED = "IN_POOL_EVICTED";
export const MISS_RANGE_MISS = "RANGE_MISS";

export function rangesCover(needed, got) {
  if (!needed?.length) return true;
  return needed.every(want =>
    (got ?? []).some(span =>
      Number(span.endLine) >= Number(want.startLine) && Number(span.startLine) <= Number(want.endLine)
    )
  );
}

export function labelFromBlockedBy(blockedBy, rangeMiss = false) {
  if (blockedBy === "absent") return MISS_NOT_IN_POOL;
  if (blockedBy === "readplan-budget" || blockedBy === "candidate-limit") return MISS_IN_POOL_EVICTED;
  if (blockedBy === "hit") return rangeMiss ? MISS_RANGE_MISS : null;
  return undefined;
}

export function classifyMustHitFile(file, {
  pool,
  selected,
  selectedRanges,
  mustReadRanges,
  attribution,
  compactFiles
} = {}) {
  const rel = posixPath(file);
  const needed = mustReadRanges?.[rel] ?? mustReadRanges?.[file];
  const got = selectedRanges instanceof Map
    ? (selectedRanges.get(rel) ?? selectedRanges.get(file) ?? [])
    : (selectedRanges?.[rel] ?? []);
  const rangeMiss = Boolean(needed?.length) && !rangesCover(needed, got);
  const attr = attribution instanceof Map ? attribution.get(rel) : attribution?.[rel];
  const fromAttr = labelFromBlockedBy(attr?.blockedBy, rangeMiss);
  if (fromAttr !== undefined) return fromAttr;

  const inPool = pool instanceof Set ? pool.has(rel) : (pool ?? []).map(posixPath).includes(rel);
  const inSelected = selected instanceof Set ? selected.has(rel) : (selected ?? []).map(posixPath).includes(rel);
  const onCompact = compactFiles == null
    ? true
    : (compactFiles instanceof Set ? compactFiles.has(rel) : compactFiles.map(posixPath).includes(rel));
  // Ranked familyScores / productionRanking is the pool. Compact files[] is
  // truncated at candidateLimit (~26); missing there is eviction, not absence.
  if (!inSelected && inPool) return MISS_IN_POOL_EVICTED;
  if (!inSelected && !inPool && !onCompact) return MISS_NOT_IN_POOL;
  if (!inSelected && !inPool) return MISS_NOT_IN_POOL;
  if (rangeMiss) return MISS_RANGE_MISS;
  return null;
}

export function diagnoseScene(scene, impact) {
  const mustHit = [...new Set((scene?.golden?.mustHit ?? []).map(posixPath))];
  const pool = new Set((impact?.pool ?? []).map(posixPath));
  const selected = new Set((impact?.selected ?? []).map(posixPath));
  const compactFiles = impact?.compactFiles == null ? null : new Set((impact.compactFiles ?? []).map(posixPath));
  const attribution = impact?.attribution instanceof Map
    ? impact.attribution
    : new Map(Object.entries(impact?.attribution ?? {}).map(([file, row]) => [posixPath(file), row]));
  const selectedRanges = new Map();
  for (const [file, spans] of Object.entries(impact?.rangesByFile ?? {})) {
    selectedRanges.set(posixPath(file), spans);
  }
  const misses = [];
  for (const file of mustHit) {
    const label = classifyMustHitFile(file, {
      pool,
      selected,
      selectedRanges,
      mustReadRanges: scene?.golden?.mustReadRanges,
      attribution,
      compactFiles
    });
    if (label) misses.push({ file, label, blockedBy: attribution.get(file)?.blockedBy ?? null });
  }
  return {
    scenarioId: scene?.id,
    mustHit: mustHit.length,
    hit: mustHit.length - misses.length,
    misses
  };
}

export function summarizeDiagnosis(sceneRows) {
  const counts = {
    [MISS_NOT_IN_POOL]: 0,
    [MISS_IN_POOL_EVICTED]: 0,
    [MISS_RANGE_MISS]: 0
  };
  let missFiles = 0;
  const pattern = new Map();
  for (const row of sceneRows ?? []) {
    for (const miss of row.misses ?? []) {
      missFiles += 1;
      counts[miss.label] += 1;
      const base = posixPath(miss.file).split("/").pop() ?? miss.file;
      const key = `${miss.label}:${suffixPattern(base)}`;
      pattern.set(key, (pattern.get(key) ?? 0) + 1);
    }
  }
  const share = label => (missFiles > 0 ? counts[label] / missFiles : 0);
  const notInPool = share(MISS_NOT_IN_POOL);
  const selection = share(MISS_IN_POOL_EVICTED) + share(MISS_RANGE_MISS);
  // Pool is productionRanking, not compact files[]. B3 only if discovery
  // still dominates after that correction; otherwise B1.
  const next = notInPool > 0.4 ? "B3" : "B1";
  return {
    missFiles,
    counts,
    shares: {
      [MISS_NOT_IN_POOL]: notInPool,
      [MISS_IN_POOL_EVICTED]: share(MISS_IN_POOL_EVICTED),
      [MISS_RANGE_MISS]: share(MISS_RANGE_MISS),
      selectionLayer: selection
    },
    next,
    topPatterns: [...pattern.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8)
      .map(([key, n]) => ({ key, n }))
  };
}

function suffixPattern(base) {
  if (/Mapper\.java$/.test(base)) return "*Mapper.java";
  if (/DO\.java$/.test(base)) return "*DO.java";
  if (/ServiceImpl\.java$/.test(base)) return "*ServiceImpl.java";
  if (/Controller\.java$/.test(base)) return "*Controller.java";
  if (/Test\.java$/.test(base)) return "*Test.java";
  return base.replace(/^[A-Z][a-zA-Z]+/, "*");
}

export function impactFromBenchmarkAttempt(attempt) {
  const det = attempt?.determinism ?? {};
  const compactFiles = (det.candidatePaths ?? []).map(posixPath);
  const familyPool = (det.familyScores ?? [])
    .map(row => posixPath(row?.path))
    .filter(Boolean);
  const attribution = new Map();
  for (const row of attempt?.goldenAttribution ?? []) {
    if (!row?.file) continue;
    attribution.set(posixPath(row.file), row);
  }
  const attrPool = [...attribution.values()]
    .filter(row => row.inCandidates === true || row.blockedBy === "readplan-budget" || row.blockedBy === "candidate-limit")
    .map(row => posixPath(row.file));
  const rankingPool = (attempt?.productionRanking?.candidates ?? [])
    .map(row => posixPath(row.path))
    .filter(Boolean);
  const pool = familyPool.length
    ? familyPool
    : rankingPool.length
      ? rankingPool
      : attrPool.length
        ? attrPool
        : compactFiles;
  const readPlan = det.readPlan ?? [];
  const selected = readPlan.map(item => posixPath(item.path));
  const rangesByFile = {};
  for (const item of readPlan) {
    rangesByFile[posixPath(item.path)] = (item.ranges ?? []).map(range => ({
      startLine: range.startLine,
      endLine: range.endLine
    }));
  }
  return {
    pool,
    selected,
    rangesByFile,
    compactFiles,
    attribution,
    poolSource: familyPool.length
      ? "familyScores"
      : rankingPool.length
        ? "productionRanking"
        : attrPool.length
          ? "goldenAttribution"
          : "compactCandidatePaths"
  };
}

export function diagnoseBenchmarkPayload(payload, scenes) {
  const byId = new Map((scenes ?? []).map(scene => [scene.id, scene]));
  const rows = [];
  for (const row of payload?.rows ?? []) {
    if (isHoldoutScene({ id: row.id, evaluationSplit: byId.get(row.id)?.evaluationSplit })) {
      continue;
    }
    const scene = byId.get(row.id);
    if (!scene) continue;
    const attempt = row.attempts?.[0];
    rows.push(diagnoseScene(scene, impactFromBenchmarkAttempt(attempt)));
  }
  return rows;
}

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    jsonl: options.get("--jsonl"),
    benchmark: options.get("--benchmark"),
    output: options.get("--output")
  };
}

function main(argv = process.argv.slice(2)) {
  const cli = parseCli(argv);
  if (cli.help) {
    console.log("usage: node scripts/diagnose-impact-misses.mjs --jsonl <tuning.jsonl> --benchmark <bench.json> --output <json>");
    return;
  }
  if (!cli.jsonl || !cli.benchmark || !cli.output) throw new Error("--jsonl, --benchmark, and --output are required");
  const loaded = loadTuningScenes(readFileSync(cli.jsonl, "utf8"));
  const payload = JSON.parse(readFileSync(cli.benchmark, "utf8"));
  const scenes = diagnoseBenchmarkPayload(payload, loaded.tuning);
  const summary = summarizeDiagnosis(scenes);
  const report = {
    schemaVersion: B0_SCHEMA,
    dated: "2026-08-24",
    holdoutSkipped: loaded.holdoutSkipped,
    tuning: loaded.tuning.length,
    diagnosed: scenes.length,
    ...summary,
    scenes
  };
  writeFileSync(cli.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: cli.output,
    next: summary.next,
    missFiles: summary.missFiles,
    shares: summary.shares,
    holdoutSkipped: loaded.holdoutSkipped
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
