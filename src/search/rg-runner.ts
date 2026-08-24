// input: An RgQuery plus the request's absolute deadline.
// output: A bounded SearchResult that reports whether the search actually finished.
// pos: Streams `rg --json` instead of buffering stdout, so a huge or slow search
//      degrades into an honest PARTIAL result rather than an ENOBUFS failure.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import type { Readable } from "node:stream";
import { isWithin } from "../path-utils.js";
import type { Completion } from "../runtime/completion.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import { BoundedLineDecoder } from "./bounded-line-decoder.js";
import type { RgQuery, SearchFileMatch, SearchResult } from "./search-types.js";

const DEFAULT_MAX_RAW_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MATCHES = 100_000;
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_KILL_GRACE_MS = 100;
const DEFAULT_MAX_POSITIONS_PER_FILE = 4;

type RgChild = ChildProcessByStdio<null, Readable, Readable>;

type RgMatchEvent = {
  type: "match";
  data: {
    path: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number }>;
  };
};

const MALFORMED = "MALFORMED";

export type RgRunnerOptions = {
  binary?: string;
  prefixArgs?: string[];
  maxPositionsPerFile?: number;
  maxRawBytes?: number;
  maxLineBytes?: number;
  maxMatches?: number;
  killGraceMs?: number;
};

export class RgRunner {
  constructor(private readonly options: RgRunnerOptions = {}) {}

  async run(query: RgQuery, budget: DeadlineBudget): Promise<SearchResult> {
    const startedAt = performance.now();
    const files = new Map<string, SearchFileMatch>();
    const decoder = new BoundedLineDecoder(
      this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    );
    const killGraceMs = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    let rawBytes = 0;
    let totalMatches = 0;
    let timedOut = false;
    let limited = false;
    let parseFailed = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let stderrTail = Buffer.alloc(0);

    const args = [
      ...(this.options.prefixArgs ?? []),
      "--json",
      "--line-number",
      "--color",
      "never",
      ...query.globs.flatMap(glob => ["-g", glob]),
      // `-e` keeps a pattern that starts with `-` from being read as a flag.
      "-e",
      query.pattern,
      "--",
      ...query.roots
    ];
    const child = spawn(this.options.binary ?? "rg", args, {
      cwd: query.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    }) as RgChild;
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));

    const consumeLine = (line: string): void => {
      const event = safeParseRgJson(line);
      if (event === MALFORMED) {
        parseFailed = true;
        void terminateChild(child, killGraceMs);
        return;
      }
      if (!event) return;
      const relative = event.data.path.text;
      if (!relative) return;
      const absolute = path.resolve(query.cwd, relative);
      // rg can follow a symlink out of the repo; such a hit is not our evidence.
      if (!isWithin(query.cwd, absolute)) return;
      const existing = files.get(absolute) ?? {
        absolutePath: absolute,
        matchCount: 0,
        positions: []
      };
      existing.matchCount += 1;
      totalMatches += 1;
      const first = event.data.submatches?.[0];
      if (existing.positions.length < (this.options.maxPositionsPerFile ?? DEFAULT_MAX_POSITIONS_PER_FILE)) {
        existing.positions.push({
          line: event.data.line_number ?? 1,
          column: (first?.start ?? 0) + 1
        });
      }
      files.set(absolute, existing);
      if (totalMatches >= (this.options.maxMatches ?? DEFAULT_MAX_MATCHES)) {
        limited = true;
        void terminateChild(child, killGraceMs);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      rawBytes += chunk.length;
      if (rawBytes > (this.options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES)) {
        limited = true;
        void terminateChild(child, killGraceMs);
        return;
      }
      try {
        for (const line of decoder.push(chunk)) consumeLine(line);
      } catch {
        limited = true;
        void terminateChild(child, killGraceMs);
      }
    });
    // stderr must be drained or a noisy child blocks on a full pipe.
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-DEFAULT_STDERR_TAIL_BYTES);
    });
    child.once("error", error => { spawnError = error as NodeJS.ErrnoException; });

    const timeoutMs = budget.remainingMs();
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateChild(child, killGraceMs);
    }, Math.max(1, timeoutMs));
    const status = await closed;
    clearTimeout(timeout);
    if (!timedOut && !limited && !parseFailed) {
      try {
        for (const line of decoder.finish()) consumeLine(line);
      } catch {
        parseFailed = true;
      }
    }

    // rg exits 1 when it simply found nothing; that is a complete search.
    const failed = Boolean(spawnError)
      || parseFailed
      || (!timedOut && !limited && status !== 0 && status !== 1);
    const completion: Completion = failed
      ? "FAILED"
      : timedOut
        ? "PARTIAL_TIMEOUT"
        : limited
          ? "PARTIAL_LIMIT"
          : "COMPLETE";
    return {
      files: [...files.values()],
      completion,
      rawBytes,
      totalMatches,
      elapsedMs: performance.now() - startedAt,
      stderrTail: stderrTail.toString("utf8") || undefined,
      errorCode: failed
        ? "SEARCH_FAILED"
        : timedOut
          ? "SEARCH_TIMEOUT"
          : undefined
    };
  }
}

function safeParseRgJson(line: string): RgMatchEvent | undefined | typeof MALFORMED {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return MALFORMED;
  }
  if (!parsed || typeof parsed !== "object") return MALFORMED;
  const record = parsed as { type?: unknown; data?: unknown };
  if (typeof record.type !== "string") return MALFORMED;
  if (record.type !== "match") return undefined;
  const data = record.data;
  if (!data || typeof data !== "object") return MALFORMED;
  const pathRecord = (data as { path?: unknown }).path;
  if (!pathRecord || typeof pathRecord !== "object") return MALFORMED;
  return parsed as RgMatchEvent;
}

const terminating = new WeakMap<RgChild, Promise<void>>();

function terminateChild(child: RgChild, graceMs: number): Promise<void> {
  const existing = terminating.get(child);
  if (existing) return existing;
  const operation = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.kill("SIGTERM");
    const hardKill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    hardKill.unref?.();
    child.once("close", () => {
      clearTimeout(hardKill);
      resolve();
    });
  });
  terminating.set(child, operation);
  return operation;
}
