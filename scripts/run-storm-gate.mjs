#!/usr/bin/env node
// input: three real Java repositories and an iteration count.
// output: quiet-vs-storm foreground anchor-latency ratio, staleness and
//   settled-state digest evidence, per repository.
// pos: V3.2-17/18 storm gate (new script; the existing quiet progressive
//   verifier is not modified). Each cell uses its own detached golden-repo
//   clone and private cache/JDT-disabled runtime, per the isolation contract.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDetachedLocalClone, scrubHostNodeRuntimeState } from "./isolation-utils.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
const STORM_FILE_COUNT = 500;
const SAMPLES_PER_WINDOW = 8;
const SETTLE_POLL_MS = 100;
const SETTLE_TIMEOUT_MS = 180_000;
const STORM_P95_RATIO_LIMIT = 1.10;

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  const candidateRoot = path.resolve(cli.candidateRoot);
  const { RepoRuntimeManager } = await import(path.join(candidateRoot, "dist", "repo-runtime-manager.js"));
  const { RepoResolver } = await import(path.join(candidateRoot, "dist", "repo-resolver.js"));
  const { AliasRegistry } = await import(path.join(candidateRoot, "dist", "alias-registry.js"));
  const { javaImpact, impactSchema } = await import(path.join(candidateRoot, "dist", "tools", "impact.js"));
  const { probeLayout } = await import(path.join(candidateRoot, "dist", "layout-probe.js"));
  const { isJavaIndexCompleteAt, isJavaIndexSnapshotDurableAt } = await import(
    path.join(candidateRoot, "dist", "benchmark", "java-index-idle.js")
  );
  const { MAX_REQUEST_DEADLINE_MS } = await import(
    path.join(candidateRoot, "dist", "runtime", "request-context.js")
  );
  const argsSchema = z.object(impactSchema);

  await mkdir(cli.outputDir, { recursive: true });
  const results = [];
  for (const project of MATRIX_PROJECTS) {
    for (let iteration = 1; iteration <= cli.iterations; iteration += 1) {
      for (const mode of ["quiet", "storm"]) {
        console.log(`storm-gate: ${project} iter${iteration} ${mode}`);
        const cell = await runCell({
          project,
          mode,
          iteration,
          candidateRoot,
          repositories: cli.repositories,
          RepoRuntimeManager,
          RepoResolver,
          AliasRegistry,
          javaImpact,
          argsSchema,
          probeLayout,
          isJavaIndexCompleteAt,
          isJavaIndexSnapshotDurableAt,
          deadlineMs: MAX_REQUEST_DEADLINE_MS
        });
        results.push(cell);
        await writeFile(
          path.join(cli.outputDir, `${project}-iter${iteration}-${mode}.json`),
          `${JSON.stringify(cell, null, 2)}\n`
        );
      }
    }
  }

  const summary = summarize(results);
  await writeFile(path.join(cli.outputDir, "storm-gate-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.passed ? 0 : 1;
}

async function runCell({
  project,
  mode,
  iteration,
  candidateRoot,
  repositories,
  RepoRuntimeManager,
  RepoResolver,
  AliasRegistry,
  javaImpact,
  argsSchema,
  probeLayout,
  isJavaIndexCompleteAt,
  isJavaIndexSnapshotDurableAt,
  deadlineMs
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `storm-gate-${project}-${mode}-${iteration}-`));
  const repoRoot = path.join(root, "repo");
  const restoreEnv = applyIsolatedEnv(root);
  try {
    const source = path.resolve(repositories[project]);
    const head = (await capture("git", ["-C", source, "rev-parse", "HEAD"])).trim();
    await createDetachedLocalClone(source, repoRoot, head, run);

    const anchors = await loadScenarioAnchors(candidateRoot, project, SAMPLES_PER_WINDOW);
    if (anchors.length === 0) throw new Error(`${project}: no scenario anchors available for the storm gate`);

    const registry = new AliasRegistry(path.join(root, ".nonexistent-aliases.json"));
    const resolver = new RepoResolver(registry);
    const runtimes = new RepoRuntimeManager(resolver);
    await runtimes.initialize();
    try {
      const call = anchor => callImpact(runtimes, javaImpact, argsSchema, repoRoot, anchor, deadlineMs);

      // Warm-open and drive to a steady COMPLETE + DURABLE baseline before
      // either the quiet or storm window is measured, so both modes start
      // from the same settled state.
      await call(anchors[0]);
      const baseline = await pollUntilSettled(runtimes, repoRoot, isJavaIndexCompleteAt, isJavaIndexSnapshotDurableAt);
      if (!baseline.settled) throw new Error(`${project}: baseline never reached COMPLETE + DURABLE`);
      const generationBefore = baseline.generation;

      let stormObserved;
      if (mode === "storm") {
        const layout = probeLayout(repoRoot);
        const files = await discoverJavaFiles(repoRoot, layout, STORM_FILE_COUNT);
        if (files.length < STORM_FILE_COUNT) {
          throw new Error(`${project}: only found ${files.length} main .java files, need ${STORM_FILE_COUNT} for the storm burst`);
        }
        await identicalByteBurst(files);
      }

      const windowSamples = [];
      for (let index = 0; index < SAMPLES_PER_WINDOW; index += 1) {
        windowSamples.push(await call(anchors[index % anchors.length]));
      }

      const settled = await pollUntilSettled(runtimes, repoRoot, isJavaIndexCompleteAt, isJavaIndexSnapshotDurableAt, mode === "storm");
      if (!settled.settled) {
        throw new Error(
          `${project}/${mode}: did not settle to COMPLETE + DURABLE after the window\n`
          + `trail (last ${settled.trail.length} of up to 40 samples):\n${JSON.stringify(settled.trail, null, 2)}`
        );
      }
      const generationAfter = settled.generation;
      if (mode === "storm") {
        stormObserved = settled.lastStorm;
        // No total-count floor: a 500-file concurrent burst is not
        // guaranteed atomic delivery, and the fragments below
        // isStormBatch's absolute floor (repo-generation.ts, changeCount
        // >= 100) are not lost - they are delivered as ordinary REFRESH
        // batches instead of storm-classified RECONCILE ones, so they
        // simply don't contribute to stormTotalChangeCount even though the
        // index still converges on them. Measured across real runs, one
        // burst landed as [498], another as [158] with the rest fragmented
        // under 100 - a >3x spread that no fixed floor distinguishes from a
        // genuine regression (burst never classified as a storm at all, or
        // the index left stale). The gate's actual correctness signal is
        // "at least one storm-classified batch happened, and the index
        // still converged to COMPLETE + DURABLE with zero stale samples" -
        // the latter two are already asserted below/via coverageOk.
        // stormBatches/stormTotalChangeCount are still recorded as
        // observations, not thresholds.
        if (!stormObserved) {
          throw new Error(`${project}: storm burst was never classified as a storm batch`);
        }
      }

      // A confirmation round taken strictly after settling: every sample must
      // report the final settled generation as COMPLETE. Any other value is
      // counted as stale - the answer would be authoritative-but-wrong.
      const confirmSamples = [];
      for (const anchor of anchors) confirmSamples.push({ anchor, sample: await call(anchor) });
      const staleCount = confirmSamples.filter(({ sample }) =>
        sample.coverage !== "COMPLETE" || sample.indexedGeneration !== generationAfter
      ).length;

      const { digest, rows: confirmDetail } = digestOfConfirmation(confirmSamples);
      const latencies = windowSamples.map(sample => sample.elapsedMs).sort((left, right) => left - right);

      return {
        project,
        mode,
        iteration,
        generationBefore,
        generationAfter,
        generationDelta: generationAfter - generationBefore,
        stormObserved,
        stormBatches: mode === "storm" ? settled.stormBatches : undefined,
        stormTotalChangeCount: mode === "storm" ? settled.stormTotalChangeCount : undefined,
        latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), samples: latencies },
        staleCount,
        digest,
        // Per-anchor detail behind the digest, so a digest mismatch between a
        // quiet and storm cell can be diagnosed from the evidence file
        // directly instead of requiring a re-run with ad-hoc instrumentation.
        confirmDetail,
        coverageFinal: settled.coverage,
        snapshotDurableFinal: settled.durable
      };
    } finally {
      await runtimes.shutdownAll();
    }
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function callImpact(runtimes, javaImpact, argsSchema, repoRoot, anchor, deadlineMs) {
  const args = argsSchema.parse({
    file: anchor.file,
    line: anchor.line,
    column: anchor.column,
    mode: "recall",
    semanticPolicy: "fast",
    profile: anchor.profile
  });
  const startedAt = performance.now();
  // The production default (~2s for recall/fast) assumes a warm runtime; a
  // cold-open benchmark request against an unindexed repo needs the same
  // production ceiling (MAX_REQUEST_DEADLINE_MS) the request layer already
  // allows via requestOptions.deadlineMs, not an invented harness constant.
  const result = await runtimes.withContext(
    { repoRoot },
    (context, request) => javaImpact(context, args, request),
    { mayStartLsp: false, requestOptions: { mode: "recall", semanticPolicy: "fast", deadlineMs } }
  );
  return {
    anchorId: anchor.id,
    elapsedMs: performance.now() - startedAt,
    requestGeneration: result.freshness.requestGeneration,
    indexedGeneration: result.freshness.indexedGeneration,
    coverage: result.freshness.coverage,
    changedDuringRequest: result.freshness.changedDuringRequest,
    files: result.files.map(file => String(file.path)).sort(),
    readPlanFileIds: [...new Set(result.readPlan.map(item => String(item.fileId)))].sort()
  };
}

async function pollUntilSettled(runtimes, repoRoot, isJavaIndexCompleteAt, isJavaIndexSnapshotDurableAt, expectStorm = false) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  const startedAt = Date.now();
  let lastStorm;
  // A single write burst can arrive at the coordinator as more than one
  // storm-classified batch (chokidar does not guarantee atomic delivery of a
  // large concurrent burst); `context.watcher.lastStorm` only ever holds the
  // most recent one. Accumulate every distinct batch seen during this poll
  // (deduped by the coordinator's own observedAt stamp) so the caller can
  // assert on the burst's total size instead of one batch's.
  const stormBatchesByObservedAt = new Map();
  // Diagnostic trail: on timeout the caller previously got nothing to explain
  // why. Keep a bounded rolling window instead of the full poll history.
  const trail = [];
  while (Date.now() < deadline) {
    // This is a cheap local status read (no JavaIndex RPC), but it still goes
    // through the production request budget path (createRequestBudget's
    // "balanced"/"auto" default is 3000ms) meant for full request processing.
    // Under real host contention (observed: a concurrent Time Machine backup
    // driving load average >14) that budget can be missed even for a local
    // read while the repo's own initial cold sweep is competing for the same
    // worker thread. A transient DEADLINE_EXCEEDED here is not evidence the
    // repo failed to settle - retry immediately, bounded by the same outer
    // poll deadline, instead of letting one slow tick crash the whole matrix.
    let observed;
    for (;;) {
      try {
        observed = await runtimes.withContext(
          { repoRoot },
          context => ({
            status: context.javaIndexClient?.localStatus(),
            watcherReady: context.watcher?.ready === true,
            watcherPending: context.watcher?.pending ?? 0,
            lastStorm: context.watcher?.lastStorm
          }),
          { mayStartLsp: false }
        );
        break;
      } catch (error) {
        if (error?.code !== "DEADLINE_EXCEEDED" || Date.now() >= deadline) throw error;
      }
    }
    if (observed.lastStorm) {
      lastStorm = observed.lastStorm;
      stormBatchesByObservedAt.set(observed.lastStorm.observedAt, observed.lastStorm);
    }
    const status = observed.status;
    const complete = status ? isJavaIndexCompleteAt(status, status.indexedGeneration) : false;
    const incompleteRoots = status
      ? status.coverage.filter(entry => entry.generation !== status.indexedGeneration || entry.state !== "COMPLETE")
      : [];
    // Three distinct failure modes (generation lag, still-BUILDING/DEGRADED
    // state, and a nonzero failedFiles count) were previously collapsed into
    // one count, which can't tell a stuck-on-generation root from a
    // permanently-DEGRADED one. Keep the filtered entries themselves so a
    // timeout's trail shows which mode actually applies.
    const resourceCoverageIncompleteEntries = status?.resourceCoverage.filter(entry =>
      entry.generation !== status.indexedGeneration || entry.state !== "COMPLETE" || entry.failedFiles !== 0
    ) ?? [];
    trail.push({
      elapsedMs: Date.now() - startedAt,
      state: status?.state,
      indexedGeneration: status?.indexedGeneration,
      lastError: status?.lastError,
      snapshotVerificationPending: status?.snapshotVerificationPending,
      pendingForeground: status?.pendingForeground,
      pendingBackground: status?.pendingBackground,
      incompleteRootCount: incompleteRoots.length,
      incompleteRootsSample: incompleteRoots.slice(0, 3),
      resourceCoverageIncomplete: resourceCoverageIncompleteEntries.length,
      resourceCoverageIncompleteSample: resourceCoverageIncompleteEntries.slice(0, 4),
      snapshotState: status?.snapshot?.state,
      snapshotDurableGeneration: status?.snapshot?.durableGeneration,
      watcherReady: observed.watcherReady,
      watcherPending: observed.watcherPending,
      complete,
      durable: status ? isJavaIndexSnapshotDurableAt(status, status.indexedGeneration) : false,
      stormChangeCount: lastStorm?.changeCount
    });
    if (trail.length > 40) trail.shift();
    if (
      status
      && observed.watcherReady
      && observed.watcherPending === 0
      && complete
      && (!expectStorm || lastStorm !== undefined)
    ) {
      const stormBatches = [...stormBatchesByObservedAt.values()];
      return {
        settled: true,
        generation: status.indexedGeneration,
        coverage: "COMPLETE",
        durable: isJavaIndexSnapshotDurableAt(status, status.indexedGeneration),
        lastStorm,
        stormBatches,
        stormTotalChangeCount: stormBatches.reduce((sum, batch) => sum + batch.changeCount, 0),
        trail
      };
    }
    await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return { settled: false, lastStorm, stormBatches: [...stormBatchesByObservedAt.values()], trail };
}

async function loadScenarioAnchors(candidateRoot, project, limit) {
  const file = path.join(candidateRoot, "golden", `${project}.scenarios.jsonl`);
  const lines = (await readFile(file, "utf8")).split("\n").filter(line => line.trim().length > 0);
  return lines.slice(0, limit).map(line => {
    const row = JSON.parse(line);
    return {
      id: row.id,
      file: row.anchor.file,
      line: row.anchor.line,
      column: row.anchor.column,
      profile: row.anchor.profile
    };
  });
}

async function discoverJavaFiles(repoRoot, layout, limit) {
  const files = [];
  async function walk(dir) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".java")) files.push(full);
    }
  }
  // Prefer main roots (a real storm is more often production code), but a
  // repository whose main tree alone falls short of `limit` still needs a
  // genuine `limit`-file burst, so test roots fill the remainder rather than
  // silently shrinking the gate's file count.
  const bySourceSet = sourceSet => layout.sourceRoots
    .filter(entry => entry.sourceSet === sourceSet)
    .map(entry => path.join(repoRoot, entry.relativePath));
  for (const root of [...bySourceSet("main"), ...bySourceSet("test")]) {
    await walk(root);
    if (files.length >= limit) break;
  }
  return files.slice(0, limit);
}

async function identicalByteBurst(files) {
  // Read-then-write-back the exact same bytes: a real edit event through the
  // production watcher/coordinator path, not a synthetic queueForTest() call
  // or a bare mtime touch, with content deliberately unchanged so a settled
  // digest match between quiet and storm is a meaningful invariant. Writes
  // run concurrently so the whole burst lands well inside the coordinator's
  // 150ms debounce window - a sequential pass risks splitting into more than
  // one batch, which is a different, untested shape than a real storm.
  await Promise.all(files.map(async file => {
    const bytes = await readFile(file);
    await writeFile(file, bytes);
  }));
}

function digestOfConfirmation(confirmSamples) {
  const rows = confirmSamples
    .map(({ anchor, sample }) => ({
      anchorId: anchor.id,
      files: sample.files,
      readPlanFileIds: sample.readPlanFileIds
    }))
    .sort((left, right) => left.anchorId.localeCompare(right.anchorId));
  // readPlanFileIds is not a stable identity: agent-router/index.ts:388
  // assigns it as F${rank + 1} off that request's own ranked candidate
  // array, so it is a per-response label, not a content-addressed id, and
  // can legitimately differ between two structurally independent index
  // builds (quiet's clone vs storm's clone) even when they hold byte-
  // identical content and produce the identical file set/order - a ranking
  // tie broken differently is not a correctness divergence. Hash on `files`
  // only, which is the actual invariant this gate exists to check: kept in
  // full (including readPlanFileIds) as `rows` for evidence.
  const digestRows = rows.map(({ anchorId, files }) => ({ anchorId, files }));
  return { digest: sha256(stableJson(digestRows)), rows };
}

function summarize(results) {
  const byProject = new Map();
  for (const result of results) {
    const bucket = byProject.get(result.project) ?? { quiet: [], storm: [] };
    bucket[result.mode].push(result);
    byProject.set(result.project, bucket);
  }
  const projects = {};
  let passed = true;
  for (const [project, bucket] of byProject) {
    const quietP95 = percentile(bucket.quiet.map(cell => cell.latencyMs.p95).sort((left, right) => left - right), 50);
    const stormP95 = percentile(bucket.storm.map(cell => cell.latencyMs.p95).sort((left, right) => left - right), 50);
    const ratio = quietP95 && quietP95 > 0 ? stormP95 / quietP95 : undefined;
    const staleCount = [...bucket.quiet, ...bucket.storm].reduce((sum, cell) => sum + cell.staleCount, 0);
    const digests = new Set([...bucket.quiet, ...bucket.storm].map(cell => cell.digest));
    // A storm cell's total advance is not always exactly 1: a burst that
    // splits into more than one flush() iteration (see stormBatches) can mix
    // a storm-classified batch with a smaller non-storm straggler batch, and
    // each independently calls clock.markDirty()/advance() - see
    // GenerationClock.markDirty in repo-generation.ts, which always
    // increments regardless of how many batches contributed. Require "some
    // advance happened", not an exact count the product doesn't guarantee.
    const generationDeltasOk = bucket.storm.every(cell => cell.generationDelta >= 1)
      && bucket.quiet.every(cell => cell.generationDelta === 0);
    const coverageOk = [...bucket.quiet, ...bucket.storm].every(cell => cell.coverageFinal === "COMPLETE" && cell.snapshotDurableFinal);
    const projectPassed = ratio !== undefined
      && ratio <= STORM_P95_RATIO_LIMIT
      && staleCount === 0
      && digests.size === 1
      && generationDeltasOk
      && coverageOk
      && bucket.quiet.length > 0
      && bucket.storm.length > 0;
    passed = passed && projectPassed;
    projects[project] = {
      quietAnchorP95MedianMs: quietP95,
      stormAnchorP95MedianMs: stormP95,
      stormOverQuietRatio: ratio,
      staleCount,
      digestCount: digests.size,
      digests: [...digests],
      generationDeltasOk,
      coverageOk,
      quietCells: bucket.quiet.length,
      stormCells: bucket.storm.length,
      passed: projectPassed
    };
  }
  return {
    schemaVersion: 1,
    stormFileCount: STORM_FILE_COUNT,
    samplesPerWindow: SAMPLES_PER_WINDOW,
    ratioLimit: STORM_P95_RATIO_LIMIT,
    projects,
    passed
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return undefined;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function applyIsolatedEnv(root) {
  const previous = { ...process.env };
  const isolated = scrubHostNodeRuntimeState(process.env);
  Object.assign(process.env, isolated, {
    HOME: path.join(root, "home"),
    JAVA_LSP_CACHE_ROOT: path.join(root, "cache"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    TMPDIR: path.join(root, "tmp"),
    JDTLS_DATA_DIR: path.join(root, "cache", "jdt-workspace"),
    JDTLS_LOG_DIR: path.join(root, "cache", "jdt-logs"),
    JAVA_LSP_PROJECTS_JSON: path.join(root, "projects.json"),
    GRADLE_USER_HOME: path.join(root, "gradle-home"),
    MAVEN_USER_HOME: path.join(root, "maven-home"),
    JAVA_LSP_ISOLATED_VALIDATION: "1",
    JDTLS_BIN: "/usr/bin/false"
  });
  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

function parseCli(args) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  if (flags.has("--help")) return { help: true };
  return {
    candidateRoot: options.get("--candidate-root") || scriptRoot,
    outputDir: required(options.get("--output-dir"), "--output-dir"),
    iterations: positiveInteger(options.get("--iterations") || "10", "--iterations"),
    repositories: {
      lishuedu: required(options.get("--lishuedu"), "--lishuedu"),
      cipherlink: required(options.get("--cipherlink"), "--cipherlink"),
      "exam-parent-v3": required(options.get("--exam-parent-v3"), "--exam-parent-v3")
    }
  };
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function printUsage() {
  console.log("Usage: node scripts/run-storm-gate.mjs --output-dir DIR --lishuedu DIR --cipherlink DIR --exam-parent-v3 DIR [--candidate-root DIR] [--iterations N]");
}

await main();
