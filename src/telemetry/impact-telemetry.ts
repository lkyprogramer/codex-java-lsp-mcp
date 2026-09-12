// input: Public MCP tool name, args, handler result, and elapsed time.
// output: Local JSONL usage metadata under cache-base/telemetry (or an override dir).
// pos: Fail-open recorder; never throws into the tool path and never writes source text.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { repoCacheBase } from "../repo-layout.js";
import { repoHash } from "../path-utils.js";

type TelemetryRequestScope = { repoHash?: string; hydratePhases?: Record<string, number> };
const requestScope = new AsyncLocalStorage<TelemetryRequestScope>();

export function withTelemetryRequestScope<T>(fn: () => T): T {
  return requestScope.run({}, fn);
}

export function noteTelemetryRepoHash(repoHashValue: string): void {
  const store = requestScope.getStore();
  if (store && repoHashValue) store.repoHash = repoHashValue;
}

export function noteTelemetryHydratePhases(phases: Record<string, number>): void {
  const store = requestScope.getStore();
  if (!store || !phases) return;
  store.hydratePhases = { ...store.hydratePhases, ...phases };
}

const DAY_MS = 86400000;
const COLD_MS = 2000;

export type ToolCounterRecord = {
  ts: string; tool: string; elapsedMs: number; ok: boolean;
  repoHash?: string; start?: boolean; errorCode?: string;
};
export type ImpactDetailRecord = {
  ts: string; tool: string; repoHash: string; mode?: string; verbosity?: string;
  anchorsCount: number; readPlanItems: number; plannedSourceBytes: number; estimatedTokens: number;
  elapsedMs: number; coldPath: boolean; coldPathHeuristic?: boolean; error: boolean;
  errorCode?: string;
};
export type TelemetrySink = { record(row: Record<string, unknown>): void; flush(): void };
export type ImpactTelemetryOptions = {
  dir?: string; now?: () => Date; appendFile?: (file: string, data: string) => void;
  enabled?: boolean; maxBuffer?: number; flushEveryMs?: number; env?: NodeJS.ProcessEnv;
};

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JAVA_LSP_TELEMETRY !== "0";
}

export function telemetryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.JAVA_LSP_TELEMETRY_DIR?.trim();
  return override ? path.resolve(override) : path.join(repoCacheBase(env), "telemetry");
}

export function buildToolCounter(input: {
  tool: string; elapsedMs: number; ok: boolean; now?: Date;
  repoHash?: string; start?: boolean; errorCode?: string;
}): ToolCounterRecord {
  return {
    ts: (input.now ?? new Date()).toISOString(),
    tool: input.tool,
    elapsedMs: ms(input.elapsedMs),
    ok: input.ok,
    ...(input.repoHash ? { repoHash: input.repoHash } : {}),
    ...(input.start !== undefined ? { start: input.start } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {})
  };
}

export function buildImpactDetail(input: {
  args: unknown; value: unknown; elapsedMs: number; error: boolean; now?: Date; errorCode?: string;
}): ImpactDetailRecord {
  const args = obj(input.args);
  const value = obj(input.value);
  const cost = obj(value.cost);
  const phaseMs = {
    ...obj(obj(value.metrics).phaseMs),
    ...(requestScope.getStore()?.hydratePhases ?? {})
  };
  const elapsedMs = ms(input.elapsedMs);
  const phaseCold = Object.keys(phaseMs).some(key =>
    /hydrate|coldbuild|cold-build|cold_build|siblingcopy|reconcilewait/i.test(key)
  );
  const coldPathHeuristic = !phaseCold && elapsedMs > COLD_MS;
  return {
    ts: (input.now ?? new Date()).toISOString(),
    tool: "java_impact",
    repoHash: resolveRepoHash(args, value),
    mode: str(args.mode),
    verbosity: str(args.verbosity),
    anchorsCount: Array.isArray(args.anchors) ? args.anchors.length : typeof args.file === "string" && args.line != null ? 1 : 0,
    readPlanItems: readPlanItemCount(value),
    plannedSourceBytes: num(cost.readBytes ?? cost.plannedSourceBytes),
    estimatedTokens: num(cost.estimatedTokens),
    elapsedMs,
    coldPath: phaseCold || coldPathHeuristic,
    ...(coldPathHeuristic ? { coldPathHeuristic: true } : {}),
    error: input.error,
    ...(input.errorCode ? { errorCode: input.errorCode } : {})
  };
}

export function createImpactTelemetry(options: ImpactTelemetryOptions = {}): TelemetrySink {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? telemetryEnabled(env);
  const dir = options.dir ?? telemetryDir(env);
  const now = options.now ?? (() => new Date());
  const append = options.appendFile ?? ((file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, data);
  });
  const maxBuffer = options.maxBuffer ?? 50;
  const buffer: string[] = [];
  if (enabled) gcOldFiles(dir, now());
  const flush = (): void => {
    if (!enabled || buffer.length === 0) return;
    const stamp = now();
    const file = path.join(dir, `impact-${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}.jsonl`);
    try { append(file, `${buffer.splice(0).join("\n")}\n`); } catch { /* drop */ }
  };
  const flushMs = options.flushEveryMs ?? 5000;
  if (enabled && flushMs > 0) setInterval(flush, flushMs).unref();
  return {
    record(row: Record<string, unknown>): void {
      if (!enabled) return;
      try {
        buffer.push(JSON.stringify(row));
        if (buffer.length >= maxBuffer) flush();
      } catch { /* drop */ }
    },
    flush
  };
}

let defaultSink: TelemetrySink | undefined;
let beforeExitBound = false;

export function resetImpactTelemetryForTests(): void {
  defaultSink?.flush();
  defaultSink = undefined;
}

export function recordToolInvocation(input: {
  tool: string; args: unknown; value: unknown; elapsedMs: number; error: boolean;
  sink?: TelemetrySink; env?: NodeJS.ProcessEnv; now?: Date; failure?: unknown;
}): void {
  try {
    const env = input.env ?? process.env;
    if (!telemetryEnabled(env)) return;
    const sink = input.sink ?? defaultSinkFor(env);
    const errorCode = input.error ? toolErrorCode(input.failure, input.value) : undefined;
    const args = obj(input.args);
    sink.record(input.tool === "java_impact"
      ? buildImpactDetail({ ...input, errorCode })
      : buildToolCounter({
        tool: input.tool,
        elapsedMs: input.elapsedMs,
        ok: !input.error,
        now: input.now,
        repoHash: requestScope.getStore()?.repoHash,
        ...(input.tool === "java_status" ? { start: args.start === true } : {}),
        errorCode
      }));
  } catch { /* drop */ }
}

function defaultSinkFor(env: NodeJS.ProcessEnv): TelemetrySink {
  if (!defaultSink) {
    defaultSink = createImpactTelemetry({ env });
    if (!beforeExitBound) {
      beforeExitBound = true;
      process.once("beforeExit", () => defaultSink?.flush());
    }
  }
  return defaultSink;
}

function gcOldFiles(dir: string, now: Date): void {
  try {
    mkdirSync(dir, { recursive: true });
    const cutoff = now.getTime() - 30 * DAY_MS;
    for (const name of readdirSync(dir)) {
      const match = name.match(/^impact-(\d{8})\.jsonl$/);
      if (!match) continue;
      const stamp = match[1]!;
      const fileTime = Date.UTC(Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)));
      if (fileTime < cutoff) unlinkSync(path.join(dir, name));
    }
  } catch { /* drop */ }
}

function resolveRepoHash(args: Record<string, unknown>, value: Record<string, unknown>): string {
  if (typeof value.repoHash === "string" && value.repoHash) return value.repoHash;
  const repoRoot = typeof args.repoRoot === "string" ? args.repoRoot : "";
  if (repoRoot) return repoHash(repoRoot);
  return requestScope.getStore()?.repoHash ?? "";
}

function readPlanItemCount(value: Record<string, unknown>): number {
  if (Array.isArray(value.readPlan)) return value.readPlan.length;
  const contexts = value.contexts;
  if (!Array.isArray(contexts)) return 0;
  let count = 0;
  for (const item of contexts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const spans = (item as { spans?: unknown }).spans;
    if (Array.isArray(spans) && spans.length > 0) count += 1;
  }
  return count;
}

function toolErrorCode(failure: unknown, value: unknown): string | undefined {
  if (failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string" && failure.code) {
    return failure.code;
  }
  const message = failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  if (/requires anchors|file\/line\/column/i.test(message)) return "INVALID_INPUT";
  if (/deadline exceeded|timed out/i.test(message)) return "DEADLINE_EXCEEDED";
  if (/INDEX_PARTIAL|VACUUM INTO|Java index client is not open/i.test(message)) return "INDEX_PARTIAL";
  const record = obj(value);
  if (typeof record.errorCode === "string" && record.errorCode) return record.errorCode;
  return message ? "QUERY_FAILED" : undefined;
}

function pad(value: number): string { return String(value).padStart(2, "0"); }
function ms(value: number): number { return Math.max(0, Math.round(value)); }
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function str(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function num(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
