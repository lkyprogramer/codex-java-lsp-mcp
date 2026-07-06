import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CandidateFile, ImpactOptions, ResolvedAnchor, RgPlanSection, RgSectionSummary } from "../agent-types.js";
import type { RoutingPolicy } from "../routing-policy.js";
import { mergeCandidate } from "./candidate-helpers.js";
import { parseRgOutput, type RgCommandSummary } from "./rg-plan.js";

export type RgExecutionResult = {
  files: CandidateFile[];
  sections: RgSectionSummary[];
  rawBytes: number;
  totalMatches: number;
  commandCount: number;
  suppressed: Record<string, unknown>;
};

type ExecuteRgPlanInput = {
  readonly plan: readonly RgPlanSection[];
  readonly options: ImpactOptions;
  readonly anchors: readonly ResolvedAnchor[];
  readonly concurrency: number;
  readonly loadSummary: (
    section: RgPlanSection,
    options: ImpactOptions,
    anchors: readonly ResolvedAnchor[]
  ) => Promise<RgCommandSummary>;
};

type LoadRgCommandSummaryInput = {
  readonly repoRoot: string;
  readonly routingPolicy: RoutingPolicy;
  readonly section: RgPlanSection;
  readonly options: ImpactOptions;
  readonly anchors: readonly ResolvedAnchor[];
};

export async function executeRgPlan(input: ExecuteRgPlanInput): Promise<RgExecutionResult> {
  const fileMap = new Map<string, CandidateFile>();
  const sections: RgSectionSummary[] = [];
  let rawBytes = 0;
  let totalMatches = 0;
  let commandCount = 0;
  const results = await mapConcurrent(input.plan, input.concurrency, async item => ({
    item,
    summary: await input.loadSummary(item, input.options, input.anchors)
  }));
  for (const { item, summary } of results) {
    commandCount += 1;
    rawBytes += summary.rawBytes;
    totalMatches += summary.totalMatches;
    for (const file of summary.files) {
      mergeCandidate(fileMap, file);
    }
    sections.push({
      category: item.category,
      reason: item.reason,
      commandCount: 1,
      matchedFiles: summary.files.length,
      totalMatches: summary.totalMatches,
      rawBytes: summary.rawBytes,
      cacheHits: summary.cacheHit ? 1 : 0,
      files: summary.files
        .sort((left, right) => right.score - left.score)
        .slice(0, 6)
        .map(file => ({
          path: file.path,
          module: file.module,
          layer: file.layer,
          sourceSet: file.sourceSet,
          score: Math.round(file.score),
          matchCount: file.matchCount
        }))
    });
  }
  return {
    files: [...fileMap.values()],
    sections,
    rawBytes,
    totalMatches,
    commandCount,
    suppressed: {
      rawBytes,
      note: "raw rg stdout is summarized inside MCP and not returned to the agent"
    }
  };
}

export async function loadRgCommandSummary(input: LoadRgCommandSummaryInput): Promise<RgCommandSummary> {
  const startedAt = Date.now();
  const paths = input.section.paths.filter(item => existsSync(path.resolve(input.repoRoot, item)));
  if (paths.length === 0) {
    return {
      rawBytes: 0,
      totalMatches: 0,
      elapsedMs: 0,
      files: [],
      cacheHit: false
    };
  }
  const args = [
    "-n",
    input.section.pattern,
    ...paths,
    ...input.section.globs.flatMap(glob => ["-g", glob]),
    "-g",
    "!**/README.md",
    "-g",
    "!docs/superpowers/plans/**",
    "-g",
    "!**/{build,.gradle,node_modules,dist}/**"
  ];
  const result = await runRg(args, {
    cwd: input.repoRoot,
    maxBuffer: 12 * 1024 * 1024,
    timeoutMs: 15000
  });
  if (result.error && result.error.code !== "ETIMEDOUT") {
    throw result.error;
  }
  if (result.status && result.status !== 1) {
    throw new Error(`rg failed for ${input.section.category}: ${(result.stderr || "").trim()}`);
  }
  return parseRgOutput({
    policy: input.routingPolicy,
    repoRoot: input.repoRoot,
    section: input.section,
    stdout: result.stdout || "",
    elapsedMs: Date.now() - startedAt,
    anchors: input.anchors,
    options: input.options
  });
}

export type RgRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

export function runRg(args: string[], options: { cwd: string; maxBuffer: number; timeoutMs: number }): Promise<RgRunResult> {
  return new Promise(resolve => {
    const child = spawn("rg", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (result: RgRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (message: string, code: string) => {
      const error = new Error(message) as NodeJS.ErrnoException;
      error.code = code;
      child.kill("SIGTERM");
      finish({ status: null, stdout, stderr, error });
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const nextBytes = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
      if (nextBytes > options.maxBuffer) {
        fail("rg output exceeded maxBuffer", "ENOBUFS");
        return;
      }
      if (stream === "stdout") {
        stdoutBytes = nextBytes;
        stdout += chunk.toString("utf8");
      } else {
        stderrBytes = nextBytes;
        stderr += chunk.toString("utf8");
      }
    };
    const timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for rg after ${options.timeoutMs}ms`) as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      child.kill("SIGTERM");
      finish({ status: null, stdout, stderr, error });
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => append("stdout", chunk));
    child.stderr.on("data", chunk => append("stderr", chunk));
    child.on("error", error => finish({ status: null, stdout, stderr, error: error as NodeJS.ErrnoException }));
    child.on("close", code => finish({ status: code, stdout, stderr }));
  });
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}
