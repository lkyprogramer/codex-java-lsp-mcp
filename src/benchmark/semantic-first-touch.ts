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
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { JdtlsSession } from "../jdtls-session.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { Completion } from "../runtime/completion.js";
import { classifySemanticError, type JavaIntelligenceErrorCode } from "../runtime/intelligence-error.js";

export type WorkspaceState = "fresh" | "reused";
export type PrepareMode = "none" | "progress-idle" | "document-symbol";
export type FirstTouchOperation = "definition" | "implementation" | "references" | "type-hierarchy";

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
  cacheHit: boolean;
  shared: boolean;
  errorCode?: JavaIntelligenceErrorCode;
  sessionPhaseMs: Record<string, number>;
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
 * calls never touch that cache, so cacheHit/shared are always false here by construction.
 */
export async function runAttempt(
  session: JdtlsSession,
  cli: Pick<SemanticFirstTouchCli, "operation" | "workspaceState" | "prepare" | "projectId" | "timeoutMs">,
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

  const requestStartedAt = performance.now();
  let completion: Completion = "COMPLETE";
  let resultFiles = 0;
  let errorCode: JavaIntelligenceErrorCode | undefined;
  try {
    resultFiles = await runOperation(session, cli.operation, anchor, cli.timeoutMs);
  } catch (error) {
    const classified = classifySemanticError(error);
    completion = completionForError(classified.code);
    errorCode = classified.code;
  }
  const requestMs = performance.now() - requestStartedAt;

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
    resultFiles,
    repoContainedFiles: resultFiles,
    cacheHit: false,
    shared: false,
    errorCode,
    sessionPhaseMs: session.drainPhaseMetrics()
  };
}

async function runOperation(session: JdtlsSession, operation: FirstTouchOperation, anchor: FirstTouchAnchor, timeoutMs: number): Promise<number> {
  if (operation === "definition") {
    return (await session.rawDefinition(anchor.file, anchor.line, anchor.column, timeoutMs)).length;
  }
  if (operation === "implementation") {
    return (await session.rawImplementation(anchor.file, anchor.line, anchor.column, timeoutMs)).length;
  }
  if (operation === "references") {
    return (await session.rawReferences(anchor.file, anchor.line, anchor.column, false, timeoutMs)).length;
  }
  const result = await session.rawTypeHierarchy(anchor.file, anchor.line, anchor.column, "subtypes", 2, 20, DeadlineBudget.fromTimeout(timeoutMs));
  return result.edges.length;
}

/**
 * Fresh-workspace isolation (plan Step 3): a temporary JDTLS_DATA_DIR/LOG_DIR under a temporary
 * JAVA_LSP_CACHE_ROOT, removed after unless the attempt failed/timed out - never the caller's
 * live cache. Each call is one throwaway workspace; callers loop this once per fresh attempt so
 * "fresh P95" reflects N independent cold starts, not 1 cold + (N-1) warm reuses of the same JDT.
 */
export async function withFreshWorkspace<T>(action: (cacheRoot: string) => Promise<T>): Promise<{ result: T; failed: boolean; cacheRoot: string }> {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), "semantic-first-touch-fresh-"));
  let failed = false;
  try {
    const result = await action(cacheRoot);
    return { result, failed, cacheRoot };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!failed) rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function printUsage(): void {
  console.log(`Usage: semantic-first-touch.js --repo-root <path> --project-id <id> --workspace-state fresh|reused --operation definition|implementation|references|type-hierarchy [--prepare none|progress-idle|document-symbol] [--runs 10] [--timeout-ms 60000] [--output <file>]

Anchor position (required, no golden-scenario loader of its own):
  JAVA_LSP_BENCH_ANCHOR_FILE, JAVA_LSP_BENCH_ANCHOR_LINE, JAVA_LSP_BENCH_ANCHOR_COLUMN

--repo-root must be an isolated worktree - this starts a real jdtls process against it.`);
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
      const { result: attempt } = await withFreshWorkspace(async cacheRoot => {
        process.env.JAVA_LSP_CACHE_ROOT = cacheRoot;
        const session = new JdtlsSession(cli.repoRoot);
        const startedAt = performance.now();
        await session.ensureStarted(DeadlineBudget.fromTimeout(180_000));
        const ensureStartedMs = performance.now() - startedAt;
        const result = await runAttempt(session, cli, anchorFor(cli), repoCommit, ensureStartedMs);
        await session.stop();
        return result;
      });
      if (previousCacheRoot === undefined) delete process.env.JAVA_LSP_CACHE_ROOT;
      else process.env.JAVA_LSP_CACHE_ROOT = previousCacheRoot;
      attempts.push(attempt);
    }
  } else {
    const session = new JdtlsSession(cli.repoRoot);
    const startedAt = performance.now();
    await session.ensureStarted(DeadlineBudget.fromTimeout(180_000));
    const ensureStartedMs = performance.now() - startedAt;
    for (let run = 0; run < cli.runs; run += 1) {
      attempts.push(await runAttempt(session, cli, anchorFor(cli), repoCommit, run === 0 ? ensureStartedMs : 0));
    }
    await session.stop();
  }

  const payload = { metadata: { ...cli, repoCommit }, attempts };
  console.log(JSON.stringify(payload, null, 2));
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
