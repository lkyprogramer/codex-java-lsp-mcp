// input: java_impact MCP request.
// output: v5 JavaIndex plus rg plus optional LSP impact result.
// pos: Public recommended impact tool handler.
import { z } from "zod";
import { withConvergedCostV6 } from "../agent-router/output-v6.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { defaultDeadlineMs, MAX_REQUEST_DEADLINE_MS, type RequestContext } from "../runtime/request-context.js";
import type { ToolContext } from "./context.js";
import type { ImpactAnchorInput, ImpactOptions, ImpactResult, ImpactVerbosity } from "../agent-types.js";

// Iteration A adapter: JDT calls still take a plain timeout, so the request-level
// absolute deadline is projected onto the single legacy stage timeout. Task 7
// replaces this by passing the budget itself down to every JDT call.
const SEMANTIC_STAGE_CAP_MS = 1500;

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
  deadlineMs: z.number().int().positive().max(15000).optional(),
  readPlanMaxItems: z.number().int().positive().max(30).optional(),
  testReadMode: z.enum(["defer", "include", "priority"]).default("defer"),
  focusModules: z.array(z.string().min(1)).max(10).default([]),
  excludeModules: z.array(z.string().min(1)).max(20).default([]),
  taskKeywords: z.array(z.string().min(1)).max(20).default([]),
  crossModulePolicy: z.enum(["auto", "focused", "all"]).default("auto"),
  verbosity: z.enum(["compact", "standard", "diagnostic"]).default("standard")
};

export async function javaImpact(
  context: ToolContext,
  args: z.infer<z.ZodObject<typeof impactSchema>>,
  request?: RequestContext
): Promise<unknown> {
  if (args.semanticPolicy === "required" && context.lsp && !context.lsp.enabled) {
    throw new Error(context.lsp.enableHint || "This repo is not LSP-enabled.");
  }
  const semanticPolicy = context.lsp?.enabled ? args.semanticPolicy : "fast";
  const anchors = normalizeAnchors(args);
  // The runtime manager's freshness barrier owns the request budget and
  // generation. Fall back to a local budget only when called without one.
  const budget = request?.budget ?? DeadlineBudget.fromTimeout(Math.min(
    MAX_REQUEST_DEADLINE_MS,
    args.deadlineMs ?? defaultDeadlineMs(args.mode, semanticPolicy)
  ));
  const phaseMs: Record<string, number> = {};
  mergePhaseMs(phaseMs, context.session.drainPhaseMetrics());
  const options: ImpactOptions = {
    anchors,
    mode: args.mode,
    profile: args.anchorRole || args.profile,
    semanticPolicy,
    semanticTimeoutMs: budget.remainingMs(SEMANTIC_STAGE_CAP_MS),
    readPlanMaxItems: args.readPlanMaxItems,
    testReadMode: args.testReadMode,
    focusModules: args.focusModules,
    excludeModules: args.excludeModules,
    taskKeywords: args.taskKeywords,
    crossModulePolicy: args.crossModulePolicy,
    verbosity: args.verbosity
  };
  const result = await context.router.impact(options, request);
  mergePhaseMs(phaseMs, context.session.drainPhaseMetrics());
  return withPhaseMs(result, phaseMs, args.verbosity);
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

function mergePhaseMs(target: Record<string, number>, source: Record<string, number>): void {
  for (const [name, elapsedMs] of Object.entries(source)) {
    target[name] = (target[name] || 0) + elapsedMs;
  }
}

/**
 * V6 has no top-level `options`, so verbosity is threaded through explicitly
 * from the same args the caller already validated, rather than read back out
 * of the result the way the pre-V6 wrapper did.
 */
function withPhaseMs(result: unknown, phases: Record<string, number>, verbosity: ImpactVerbosity): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const payload = result as ImpactResult;
  if (verbosity === "diagnostic" && payload.metrics && Object.keys(phases).length > 0) {
    const existingPhaseMs = payload.metrics.phaseMs ?? {};
    payload.metrics = {
      ...payload.metrics,
      phaseMs: { ...phases, ...existingPhaseMs }
    };
  }
  return withConvergedCostV6(payload, payload.cost.readBytes, payload.cost.suppressedRawBytes);
}
