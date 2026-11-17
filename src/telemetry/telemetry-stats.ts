// input: The tool telemetry directory (impact-YYYYMMDD.jsonl written by impact-telemetry.ts) and a window.
// output: Per tool/operation call counts, success rate, latency percentiles, error codes, index states,
//         java_impact cold-path share and token cost, and the slowest calls; as text or JSON.
// pos: Read-only owner diagnostics behind `daemonctl.sh stats`. Never touches the daemon or the index.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 86400000;
const FILE_PATTERN = /^impact-(\d{4})(\d{2})(\d{2})\.jsonl$/;
const SLOWEST = 10;

export type TelemetryRow = {
  ts: number; tool: string; operation: string; elapsedMs: number; ok: boolean;
  errorCode?: string; indexState?: string; start?: boolean; coldPath?: boolean; estimatedTokens?: number;
};
export type GroupStats = {
  tool: string; operation: string; calls: number; ok: number; okRate: number;
  p50Ms: number; p95Ms: number; maxMs: number;
  errorCodes: Record<string, number>; indexStates: Record<string, number>;
  startCalls?: number; coldPath?: number; tokensP50?: number;
};
export type TelemetrySummary = {
  since: string; until: string; rows: number; malformed: number; firstTs?: string; lastTs?: string;
  groups: GroupStats[];
  slowest: Array<{ ts: string; tool: string; operation: string; elapsedMs: number; errorCode?: string }>;
};

/** Older rows have no operation: java_symbol becomes "unknown", other tools have none ("-"). */
export function parseTelemetryRow(line: string): TelemetryRow | undefined {
  let value: unknown;
  // A torn or foreign line is counted as malformed by the caller, never fatal.
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const ts = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
  const elapsedMs = row.elapsedMs;
  if (!Number.isFinite(ts) || typeof row.tool !== "string" || !row.tool
    || typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return undefined;
  // Counter rows carry ok; java_impact detail rows carry error.
  const ok = typeof row.ok === "boolean" ? row.ok : typeof row.error === "boolean" ? !row.error : undefined;
  if (ok === undefined) return undefined;
  const text = (key: string): string | undefined => {
    const field = row[key];
    return typeof field === "string" && field ? field : undefined;
  };
  return {
    ts, tool: row.tool, elapsedMs, ok,
    operation: text("operation") ?? (row.tool === "java_symbol" ? "unknown" : "-"),
    ...(text("errorCode") ? { errorCode: text("errorCode") } : {}),
    ...(text("indexState") ? { indexState: text("indexState") } : {}),
    ...(typeof row.start === "boolean" ? { start: row.start } : {}),
    ...(typeof row.coldPath === "boolean" ? { coldPath: row.coldPath } : {}),
    ...(typeof row.estimatedTokens === "number" && Number.isFinite(row.estimatedTokens) ? { estimatedTokens: row.estimatedTokens } : {})
  };
}

/** Nearest-rank percentile of an ascending array; 0 for an empty one. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

export function summarizeTelemetry(rows: readonly TelemetryRow[], window: { since: number; until: number }, malformed = 0): TelemetrySummary {
  const inWindow = rows.filter(row => row.ts >= window.since && row.ts <= window.until).sort((a, b) => a.ts - b.ts);
  const byGroup = new Map<string, TelemetryRow[]>();
  for (const row of inWindow) {
    const key = `${row.tool}\u0000${row.operation}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(row); else byGroup.set(key, [row]);
  }
  const groups = [...byGroup.values()].map(groupStats).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool) || a.operation.localeCompare(b.operation));
  const slowest = [...inWindow].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, SLOWEST)
    .map(row => ({ ts: new Date(row.ts).toISOString(), tool: row.tool, operation: row.operation, elapsedMs: row.elapsedMs, ...(row.errorCode ? { errorCode: row.errorCode } : {}) }));
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  return {
    since: new Date(window.since).toISOString(), until: new Date(window.until).toISOString(),
    rows: inWindow.length, malformed,
    ...(first ? { firstTs: new Date(first.ts).toISOString() } : {}),
    ...(last ? { lastTs: new Date(last.ts).toISOString() } : {}),
    groups, slowest
  };
}

function groupStats(rows: TelemetryRow[]): GroupStats {
  const first = rows[0];
  const latencies = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  const ok = rows.filter(row => row.ok).length;
  const stats: GroupStats = {
    tool: first?.tool ?? "", operation: first?.operation ?? "",
    calls: rows.length, ok, okRate: rows.length === 0 ? 0 : ok / rows.length,
    p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), maxMs: latencies[latencies.length - 1] ?? 0,
    errorCodes: count(rows.map(row => row.errorCode)), indexStates: count(rows.map(row => row.indexState))
  };
  const starts = rows.filter(row => row.start === true).length;
  if (starts > 0) stats.startCalls = starts;
  if (rows.some(row => row.coldPath !== undefined)) stats.coldPath = rows.filter(row => row.coldPath === true).length;
  const tokens = rows.flatMap(row => row.estimatedTokens === undefined ? [] : [row.estimatedTokens]).sort((a, b) => a - b);
  if (tokens.length > 0) stats.tokensP50 = percentile(tokens, 0.5);
  return stats;
}

function count(values: ReadonlyArray<string | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) if (value) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** Reads only day files that can hold rows at or after `since` (file days are UTC, as written). */
export async function readTelemetryDir(dir: string, since: number): Promise<{ rows: TelemetryRow[]; malformed: number; files: number }> {
  const sinceDay = Math.floor(since / DAY_MS) * DAY_MS;
  const names = (await readdir(dir)).filter(name => {
    const match = FILE_PATTERN.exec(name);
    return match !== null && Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) >= sinceDay;
  }).sort();
  const rows: TelemetryRow[] = [];
  let malformed = 0;
  for (const name of names) {
    for (const line of (await readFile(path.join(dir, name), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const row = parseTelemetryRow(line);
      if (row) rows.push(row); else malformed += 1;
    }
  }
  return { rows, malformed, files: names.length };
}

export function formatSummary(summary: TelemetrySummary): string {
  const lines = [
    `window ${summary.since} .. ${summary.until}; ${summary.rows} calls${summary.firstTs ? ` (first ${summary.firstTs}, last ${summary.lastTs})` : ""}; malformed lines ${summary.malformed}`,
    "",
    ["tool", "operation", "calls", "ok%", "p50ms", "p95ms", "maxms", "errors", "indexState", "extra"].join("\t")
  ];
  for (const group of summary.groups) {
    const extra = [
      group.startCalls !== undefined ? `start=${group.startCalls}` : "",
      group.coldPath !== undefined ? `cold=${group.coldPath}` : "",
      group.tokensP50 !== undefined ? `tokensP50=${group.tokensP50}` : ""
    ].filter(Boolean).join(" ");
    lines.push([group.tool, group.operation, group.calls, (group.okRate * 100).toFixed(1), group.p50Ms, group.p95Ms, group.maxMs,
      pairs(group.errorCodes), pairs(group.indexStates), extra || "-"].join("\t"));
  }
  lines.push("", `slowest ${summary.slowest.length}:`);
  for (const row of summary.slowest) lines.push(`  ${row.ts}\t${row.tool}\t${row.operation}\t${row.elapsedMs}ms${row.errorCode ? `\t${row.errorCode}` : ""}`);
  return `${lines.join("\n")}\n`;
}

function pairs(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length === 0 ? "-" : entries.map(([key, value]) => `${key}=${value}`).join(",");
}

export function parseStatsArgs(argv: readonly string[]): { dir: string; sinceDays: number; json: boolean } {
  let dir: string | undefined;
  let sinceDays = 7;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--dir") dir = argv[++index];
    else if (arg === "--since") {
      const match = /^(\d{1,3})d$/.exec(argv[++index] ?? "");
      const days = match ? Number(match[1]) : 0;
      if (days < 1 || days > 365) throw new Error("--since must be 1d..365d");
      sinceDays = days;
    } else throw new Error(`unknown argument: ${arg ?? ""}`);
  }
  if (!dir || !path.isAbsolute(dir)) throw new Error("--dir <absolute telemetry directory> is required");
  return { dir, sinceDays, json };
}

export async function runStats(argv: readonly string[], now = Date.now()): Promise<string> {
  const options = parseStatsArgs(argv);
  const since = now - options.sinceDays * DAY_MS;
  const { rows, malformed } = await readTelemetryDir(options.dir, since);
  const summary = summarizeTelemetry(rows, { since, until: now }, malformed);
  return options.json ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary);
}

if (process.argv[1]?.endsWith("/telemetry-stats.js")) {
  runStats(process.argv.slice(2)).then(output => { process.stdout.write(output); }, (error: unknown) => {
    console.error(`[codex-java-lsp] stats failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
