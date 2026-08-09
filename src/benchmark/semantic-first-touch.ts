// input: A real Java repo root plus CLI flags choosing workspace state, prepare mode and operation.
// output: One SemanticFirstTouchAttempt per run, printed as JSON, for Task 35's warm-default decision.
// pos: A decision-experiment tool, not a benchmark product (plan Task 35 Step 4) - the matrix run
//      backing docs/phase-v3/phase5-semantic-first-touch-decision.md deliberately runs a small,
//      targeted subset of cells, not the full Cartesian product, once the fresh-workspace result
//      is already decisive. `fresh` attempts each get their own isolated JDTLS_DATA_DIR/LOG_DIR
//      under a fresh JAVA_LSP_CACHE_ROOT and their own JdtlsSession - never the caller's live
//      cache. `--repo-root` must be an isolated worktree the caller created (see
//      scripts/run-three-repo-cold-matrix.mjs's worktree pattern), not a real active checkout:
//      this tool starts a real jdtls process against it.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { JdtlsSession, type LspLocation, type LspLocationLink } from "../jdtls-session.js";
import { canonicalPotentialPath, isPotentiallyWithin } from "../path-utils.js";
import { fromFileUri } from "../repo-layout.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { Completion } from "../runtime/completion.js";
import { classifySemanticError, type JavaIntelligenceErrorCode } from "../runtime/intelligence-error.js";

export type WorkspaceState = "fresh" | "reused";
export type PrepareMode = "none" | "progress-idle" | "document-symbol";
export type FirstTouchOperation = "definition" | "implementation" | "references" | "type-hierarchy";
export type ObservedBoolean = boolean | "unavailable";
export type BackendSettlementBucket =
  | "within_250ms"
  | "within_1s"
  | "within_5s"
  | "after_5s"
  | "never_before_session_stop"
  | "unavailable";

export type SemanticFirstTouchAttempt = {
  projectId: string;
  repoCommit: string;
  workspaceState: WorkspaceState;
  prepare: PrepareMode;
  operation: FirstTouchOperation;
  scenarioId: string;
  ensureStartedMs: number;
  prepareMs: number;
  requestMs: number;
  totalMs: number;
  completion: Completion;
  resultFiles: number;
  repoContainedFiles: number;
  outsideRepoFiles: number;
  suppressedLocations: number;
  /** Raw JdtlsSession calls do not expose SemanticGateway cache telemetry. */
  cacheHit: ObservedBoolean;
  /** Raw JdtlsSession calls do not expose SemanticGateway singleflight telemetry. */
  shared: ObservedBoolean;
  /** Cancellation settlement is only available when JdtlsSession has already recorded it. */
  backendSettlement: BackendSettlementBucket;
  errorCode?: JavaIntelligenceErrorCode;
  sessionPhaseMs: Record<string, number>;
  /** Preserved JDT cache/log root for a non-complete fresh attempt. */
  retainedWorkspace?: string;
};

export type SemanticFirstTouchCli = {
  repoRoot: string;
  projectId: string;
  workspaceState: WorkspaceState;
  prepare: PrepareMode;
  operation: FirstTouchOperation;
  runs: number;
  timeoutMs: number;
  output?: string;
};

const WORKSPACE_STATES: readonly WorkspaceState[] = ["fresh", "reused"];
const PREPARE_MODES: readonly PrepareMode[] = ["none", "progress-idle", "document-symbol"];
const OPERATIONS: readonly FirstTouchOperation[] = ["definition", "implementation", "references", "type-hierarchy"];

export function parseCli(args: string[]): SemanticFirstTouchCli {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key.startsWith("--")) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${key} requires a value`);
      }
      values.set(key, value);
      index += 1;
    }
  }
  return {
    repoRoot: required(values.get("--repo-root"), "--repo-root"),
    projectId: required(values.get("--project-id"), "--project-id"),
    workspaceState: enumArg(required(values.get("--workspace-state"), "--workspace-state"), WORKSPACE_STATES, "--workspace-state"),
    prepare: enumArg(values.get("--prepare") ?? "none", PREPARE_MODES, "--prepare"),
    operation: enumArg(required(values.get("--operation"), "--operation"), OPERATIONS, "--operation"),
    runs: positiveInt(values.get("--runs") ?? "10", "--runs"),
    timeoutMs: positiveInt(values.get("--timeout-ms") ?? "60000", "--timeout-ms"),
    output: values.get("--output")
  };
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function enumArg<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

function positiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${value}")`);
  }
  return parsed;
}

function completionForError(code: JavaIntelligenceErrorCode): Completion {
  if (code === "DEADLINE_EXCEEDED") return "PARTIAL_TIMEOUT";
  if (code === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

export type FirstTouchAnchor = { file: string; line: number; column: number; scenarioId: string };

/**
 * Runs one attempt against an already-started session. Uses the raw (non-gateway) session
 * primitives deliberately: a first-touch/cold-start measurement must see the real JDT round trip,
 * not the SemanticGateway's completed-at cache short-circuiting a second identical query. Raw
 * calls bypass that gateway, so cache/singleflight telemetry is explicitly unavailable here.
 */
export async function runAttempt(
  session: JdtlsSession,
  cli: Pick<SemanticFirstTouchCli, "repoRoot" | "operation" | "workspaceState" | "prepare" | "projectId" | "timeoutMs">,
  anchor: FirstTouchAnchor,
  repoCommit: string,
  ensureStartedMs: number
): Promise<SemanticFirstTouchAttempt> {
  let prepareMs = 0;
  if (cli.prepare === "progress-idle") {
    const prepareStartedAt = performance.now();
    await session.waitForProgressIdle(cli.timeoutMs);
    prepareMs = performance.now() - prepareStartedAt;
  } else if (cli.prepare === "document-symbol") {
    const prepareStartedAt = performance.now();
    await session.documentSymbolsWithRetry(anchor.file, cli.timeoutMs).catch(() => undefined);
    prepareMs = performance.now() - prepareStartedAt;
  }

  // Drain preparation and any preceding lifecycle timings before the raw
  // operation. A delayed cancellation settlement from a prior request must
  // never be attributed to this attempt's backend call.
  const beforeOperationPhaseMs = session.drainPhaseMetrics();
  const requestStartedAt = performance.now();
  let completion: Completion = "COMPLETE";
  let operationResult: OperationResult = { resultFiles: 0, locations: [] };
  let errorCode: JavaIntelligenceErrorCode | undefined;
  try {
    operationResult = await runOperation(session, cli.operation, anchor, cli.timeoutMs);
  } catch (error) {
    const classified = classifySemanticError(error);
    completion = completionForError(classified.code);
    errorCode = classified.code;
  }
  const requestMs = performance.now() - requestStartedAt;
  const containment = summarizeContainment(cli.repoRoot, operationResult.locations);
  const operationPhaseMs = session.drainPhaseMetrics();
  const sessionPhaseMs = mergePhaseMetrics(beforeOperationPhaseMs, operationPhaseMs);

  return {
    projectId: cli.projectId,
    repoCommit,
    workspaceState: cli.workspaceState,
    prepare: cli.prepare,
    operation: cli.operation,
    scenarioId: anchor.scenarioId,
    ensureStartedMs,
    prepareMs: Math.round(prepareMs),
    requestMs: Math.round(requestMs),
    totalMs: Math.round(ensureStartedMs + prepareMs + requestMs),
    completion,
    resultFiles: operationResult.resultFiles,
    repoContainedFiles: containment.repoContainedFiles,
    outsideRepoFiles: containment.outsideRepoFiles,
    suppressedLocations: containment.suppressedLocations,
    cacheHit: "unavailable",
    shared: "unavailable",
    backendSettlement: settlementBucket(operationPhaseMs.cancelBackendSettlementMs),
    errorCode,
    sessionPhaseMs
  };
}

function settlementBucket(settlementMs: number | undefined): BackendSettlementBucket {
  if (!Number.isFinite(settlementMs)) return "unavailable";
  if (settlementMs! <= 250) return "within_250ms";
  if (settlementMs! <= 1_000) return "within_1s";
  if (settlementMs! <= 5_000) return "within_5s";
  return "after_5s";
}

function mergePhaseMetrics(...parts: ReadonlyArray<Record<string, number>>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const part of parts) {
    for (const [name, durationMs] of Object.entries(part)) {
      merged[name] = (merged[name] ?? 0) + durationMs;
    }
  }
  return merged;
}

type OperationResult = {
  resultFiles: number;
  locations: Array<LspLocation | LspLocationLink>;
};

async function runOperation(session: JdtlsSession, operation: FirstTouchOperation, anchor: FirstTouchAnchor, timeoutMs: number): Promise<OperationResult> {
  if (operation === "definition") {
    const locations = await session.rawDefinition(anchor.file, anchor.line, anchor.column, timeoutMs);
    return { resultFiles: locations.length, locations };
  }
  if (operation === "implementation") {
    const locations = await session.rawImplementation(anchor.file, anchor.line, anchor.column, timeoutMs);
    return { resultFiles: locations.length, locations };
  }
  if (operation === "references") {
    const locations = await session.rawReferences(anchor.file, anchor.line, anchor.column, false, timeoutMs);
    return { resultFiles: locations.length, locations };
  }
  const result = await session.rawTypeHierarchy(anchor.file, anchor.line, anchor.column, "subtypes", 2, 20, DeadlineBudget.fromTimeout(timeoutMs));
  return {
    resultFiles: result.edges.length,
    locations: result.edges.flatMap(edge => [locationFromHierarchyItem(edge.from), locationFromHierarchyItem(edge.to)].filter(isLocation))
  };
}

function locationFromHierarchyItem(item: unknown): LspLocation | undefined {
  if (!item || typeof item !== "object") return undefined;
  const candidate = item as Partial<LspLocation>;
  return typeof candidate.uri === "string" && candidate.range ? candidate as LspLocation : undefined;
}

function isLocation(value: LspLocation | undefined): value is LspLocation {
  return value !== undefined;
}

function summarizeContainment(repoRoot: string, locations: readonly (LspLocation | LspLocationLink)[]): {
  repoContainedFiles: number;
  outsideRepoFiles: number;
  suppressedLocations: number;
} {
  const contained = new Set<string>();
  const outside = new Set<string>();
  let suppressedLocations = 0;
  for (const location of locations) {
    const uri = "targetUri" in location ? location.targetUri : location.uri;
    let file: string | undefined;
    try {
      file = fromFileUri(uri);
    } catch {
      suppressedLocations += 1;
      continue;
    }
    if (!file) {
      suppressedLocations += 1;
    } else if (isPotentiallyWithin(repoRoot, file)) {
      contained.add(canonicalPotentialPath(file));
    } else {
      outside.add(canonicalPotentialPath(file));
    }
  }
  return {
    repoContainedFiles: contained.size,
    outsideRepoFiles: outside.size,
    suppressedLocations
  };
}

/**
 * Fresh-workspace isolation (plan Step 3): a temporary JDTLS_DATA_DIR/LOG_DIR under a temporary
 * JAVA_LSP_CACHE_ROOT, removed after unless the attempt failed/timed out - never the caller's
 * live cache. Each call is one throwaway workspace; callers loop this once per fresh attempt so
 * "fresh P95" reflects N independent cold starts, not 1 cold + (N-1) warm reuses of the same JDT.
 * A non-complete attempt retains that workspace as its JDT/log evidence.
 */
export async function withFreshWorkspace<T>(action: (cacheRoot: string) => Promise<T>): Promise<{ result: T; failed: boolean; cacheRoot: string }> {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "semantic-first-touch-fresh-"));
  let failed = false;
  try {
    const result = await action(cacheRoot);
    failed = hasNonCompleteCompletion(result);
    return { result, failed, cacheRoot };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!failed) rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function hasNonCompleteCompletion(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const completion = (value as { completion?: unknown }).completion;
  return typeof completion === "string" && completion !== "COMPLETE";
}

/** Ensures a throwaway session is stopped even when startup or the operation fails. */
export async function runStartedAttempt(
  session: JdtlsSession,
  cli: Parameters<typeof runAttempt>[1],
  anchor: FirstTouchAnchor,
  repoCommit: string
): Promise<SemanticFirstTouchAttempt> {
  let attempt: SemanticFirstTouchAttempt | undefined;
  try {
    const startedAt = performance.now();
    await session.ensureStarted(DeadlineBudget.fromTimeout(180_000));
    attempt = await runAttempt(session, cli, anchor, repoCommit, performance.now() - startedAt);
  } finally {
    await session.stop();
    if (attempt) {
      const afterStopPhaseMs = session.drainPhaseMetrics();
      attempt.sessionPhaseMs = mergePhaseMetrics(attempt.sessionPhaseMs, afterStopPhaseMs);
      if (
        (attempt.completion === "PARTIAL_TIMEOUT" || attempt.completion === "CANCELLED")
        && attempt.backendSettlement === "unavailable"
      ) {
        const afterStopSettlement = settlementBucket(afterStopPhaseMs.cancelBackendSettlementMs);
        attempt.backendSettlement = afterStopSettlement === "unavailable"
          ? "never_before_session_stop"
          : afterStopSettlement;
      }
    }
  }
  return attempt!;
}

function printUsage(): void {
  console.log(`Usage: semantic-first-touch.js --repo-root <path> --project-id <id> --workspace-state fresh|reused --operation definition|implementation|references|type-hierarchy [--prepare none|progress-idle|document-symbol] [--runs 10] [--timeout-ms 60000] [--output <file>]

Anchor position (required, no golden-scenario loader of its own):
  JAVA_LSP_BENCH_ANCHOR_FILE, JAVA_LSP_BENCH_ANCHOR_LINE, JAVA_LSP_BENCH_ANCHOR_COLUMN

--repo-root must be an isolated worktree - this starts a real jdtls process against it.`);
}

/** Writes an artifact through a same-directory temporary file so readers never see partial JSON. */
export async function writeJsonAtomically(target: string, payload: string): Promise<void> {
  const output = path.resolve(target);
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const cli = parseCli(process.argv.slice(2));
  const repoCommit = execFileSync("git", ["-C", cli.repoRoot, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  const attempts: SemanticFirstTouchAttempt[] = [];

  if (cli.workspaceState === "fresh") {
    for (let run = 0; run < cli.runs; run += 1) {
      const previousCacheRoot = process.env.JAVA_LSP_CACHE_ROOT;
      try {
        const workspace = await withFreshWorkspace(async cacheRoot => {
          process.env.JAVA_LSP_CACHE_ROOT = cacheRoot;
          const session = new JdtlsSession(cli.repoRoot);
          return runStartedAttempt(session, cli, anchorFor(cli), repoCommit);
        });
        const attempt = workspace.result;
        if (workspace.failed) attempt.retainedWorkspace = workspace.cacheRoot;
        attempts.push(attempt);
      } finally {
        if (previousCacheRoot === undefined) delete process.env.JAVA_LSP_CACHE_ROOT;
        else process.env.JAVA_LSP_CACHE_ROOT = previousCacheRoot;
      }
    }
  } else {
    const session = new JdtlsSession(cli.repoRoot);
    try {
      const startedAt = performance.now();
      await session.ensureStarted(DeadlineBudget.fromTimeout(180_000));
      const ensureStartedMs = performance.now() - startedAt;
      for (let run = 0; run < cli.runs; run += 1) {
        attempts.push(await runAttempt(session, cli, anchorFor(cli), repoCommit, run === 0 ? ensureStartedMs : 0));
      }
    } finally {
      await session.stop();
    }
  }

  const payload = { metadata: { ...cli, repoCommit }, attempts };
  const serialized = JSON.stringify(payload, null, 2);
  if (cli.output) await writeJsonAtomically(cli.output, serialized);
  console.log(serialized);
}

function anchorFor(cli: SemanticFirstTouchCli): FirstTouchAnchor {
  const anchorFile = process.env.JAVA_LSP_BENCH_ANCHOR_FILE;
  const anchorLine = process.env.JAVA_LSP_BENCH_ANCHOR_LINE;
  const anchorColumn = process.env.JAVA_LSP_BENCH_ANCHOR_COLUMN;
  if (!anchorFile || !anchorLine || !anchorColumn) {
    throw new Error("JAVA_LSP_BENCH_ANCHOR_FILE, _LINE and _COLUMN must be set - this tool has no golden-scenario loader of its own (plan Step 4 picks one representative real anchor per repo).");
  }
  return {
    file: path.join(cli.repoRoot, anchorFile),
    line: Number.parseInt(anchorLine, 10),
    column: Number.parseInt(anchorColumn, 10),
    scenarioId: `${cli.projectId}-${cli.operation}`
  };
}

export function isMainModule(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  const canonicalPath = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonicalPath(argvPath) === canonicalPath(fileURLToPath(moduleUrl));
}

const isMain = isMainModule(process.argv[1], import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
