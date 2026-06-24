// input: java_impact MCP request.
// output: v5 source-index plus rg plus optional LSP impact result.
// pos: Public recommended impact tool handler.
import { z } from "zod";
import { documentSymbolLimiter } from "../document-symbol-limiter.js";
import { normalizeRepoFile } from "../repo-layout.js";
import type { ToolContext } from "./context.js";
import type { ImpactAnchorInput, ImpactOptions, ImpactResult, ImpactVerbosity } from "../agent-types.js";

export const impactSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  anchors: z.array(z.object({
    file: z.string(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    role: z.string().optional(),
    anchorRole: z.string().optional()
  })).min(1).max(5).optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  mode: z.enum(["minimal", "balanced", "precision", "recall"]).default("balanced"),
  profile: z.enum(["auto", "controller", "service", "port", "repository", "parser", "dto", "entity", "mapper", "vo", "job", "listener"]).default("auto"),
  anchorRole: z.enum(["auto", "controller", "service", "port", "repository", "parser", "dto", "entity", "mapper", "vo", "job", "listener"]).optional(),
  semanticPolicy: z.enum(["auto", "fast", "required"]).default("auto"),
  semanticTimeoutMs: z.number().int().positive().max(10000).default(1500),
  readPlanMaxItems: z.number().int().positive().max(30).optional(),
  testReadMode: z.enum(["defer", "include", "priority"]).default("defer"),
  focusModules: z.array(z.string().min(1)).max(10).default([]),
  excludeModules: z.array(z.string().min(1)).max(20).default([]),
  taskKeywords: z.array(z.string().min(1)).max(20).default([]),
  crossModulePolicy: z.enum(["auto", "focused", "all"]).default("auto"),
  verbosity: z.enum(["compact", "standard", "diagnostic"]).default("standard")
};

export async function javaImpact(context: ToolContext, args: z.infer<z.ZodObject<typeof impactSchema>>): Promise<unknown> {
  if (args.semanticPolicy === "required" && context.lsp && !context.lsp.enabled) {
    throw new Error(context.lsp.enableHint || "This repo is not LSP-enabled.");
  }
  const semanticPolicy = context.lsp?.enabled ? args.semanticPolicy : "fast";
  const anchors = normalizeAnchors(args);
  const phaseMs: Record<string, number> = {};
  if (semanticPolicy === "required" && context.lsp?.enabled) {
    await timed(phaseMs, "warmDocumentSymbol", async () => warmDocumentSymbols(context, anchors, semanticPolicy));
  } else {
    warmDocumentSymbols(context, anchors, semanticPolicy).catch(() => undefined);
  }
  mergePhaseMs(phaseMs, context.session.drainPhaseMetrics());
  const options: ImpactOptions = {
    anchors,
    mode: args.mode,
    profile: args.anchorRole || args.profile,
    semanticPolicy,
    semanticTimeoutMs: args.semanticTimeoutMs,
    readPlanMaxItems: args.readPlanMaxItems,
    testReadMode: args.testReadMode,
    focusModules: args.focusModules,
    excludeModules: args.excludeModules,
    taskKeywords: args.taskKeywords,
    crossModulePolicy: args.crossModulePolicy,
    verbosity: args.verbosity
  };
  const result = await context.router.impact(options);
  mergePhaseMs(phaseMs, context.session.drainPhaseMetrics());
  return withPhaseMs(result, phaseMs);
}

async function warmDocumentSymbols(
  context: ToolContext,
  anchors: ImpactAnchorInput[],
  semanticPolicy: "auto" | "fast" | "required"
): Promise<void> {
  if (!context.lsp?.enabled || semanticPolicy === "fast") {
    return;
  }
  const timeoutMs = Number(process.env.JAVA_LSP_DOCUMENT_SYMBOL_TIMEOUT_MS || (semanticPolicy === "required" ? 45000 : 2000));
  const warmed = new Set<string>();
  for (const anchor of anchors) {
    if (warmed.has(anchor.file)) {
      continue;
    }
    warmed.add(anchor.file);
    const file = normalizeRepoFile(context.repoRoot, anchor.file);
    context.sourceIndex.beginWarmIndex();
    let success = false;
    try {
      await documentSymbolLimiter.withSlot(context.repoRoot, async () => {
        const symbols = semanticPolicy === "required"
          ? await context.session.documentSymbolsWithRetry(file, timeoutMs)
          : await context.session.documentSymbols(file, timeoutMs);
        context.sourceIndex.upsertDocumentSymbols(file, symbols);
      });
      success = true;
    } catch {
      // documentSymbol is a warm-index upgrade; semantic routing still has its own bounded LSP calls.
    } finally {
      context.sourceIndex.finishWarmIndex(success);
    }
  }
}

function normalizeAnchors(args: z.infer<z.ZodObject<typeof impactSchema>>): ImpactAnchorInput[] {
  if (args.anchors && args.anchors.length > 0) {
    return args.anchors.map(anchor => ({
      ...anchor,
      role: anchor.anchorRole || anchor.role
    }));
  }
  if (args.file && args.line && args.column) {
    return [{ file: args.file, line: args.line, column: args.column, role: args.anchorRole }];
  }
  throw new Error("java_impact requires anchors[] or file/line/column.");
}

async function timed<T>(phases: Record<string, number>, name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    phases[name] = (phases[name] || 0) + Date.now() - startedAt;
  }
}

function mergePhaseMs(target: Record<string, number>, source: Record<string, number>): void {
  for (const [name, elapsedMs] of Object.entries(source)) {
    target[name] = (target[name] || 0) + elapsedMs;
  }
}

function withPhaseMs(result: unknown, phases: Record<string, number>): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const payload = result as ImpactResult;
  if (impactVerbosity(payload) !== "diagnostic") {
    updateOutputBytes(payload);
    return payload;
  }
  if (Object.keys(phases).length === 0) {
    return result;
  }
  const metrics = payload.metrics || {};
  const phaseMs = metrics.phaseMs && typeof metrics.phaseMs === "object" ? metrics.phaseMs as Record<string, number> : {};
  payload.metrics = {
    ...metrics,
    phaseMs: {
      ...phases,
      ...phaseMs
    }
  };
  updateOutputBytes(payload);
  return payload;
}

function impactVerbosity(result: ImpactResult): ImpactVerbosity {
  const value = result.options?.verbosity;
  return value === "compact" || value === "diagnostic" ? value : "standard";
}

function updateOutputBytes(payload: ImpactResult): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outputBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (payload.metrics.outputBytes === outputBytes) {
      return;
    }
    payload.metrics.outputBytes = outputBytes;
  }
}
