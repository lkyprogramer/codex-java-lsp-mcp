// input: java_impact MCP request.
// output: V6 analysis, or additive V7 when retrieval continuation is enabled.
// pos: Public recommended impact tool handler. No java_context.
import { z } from "zod";
import { readRuntimeBuild } from "../build-info.js";
import { withConvergedCostV6 } from "../agent-router/output-v6.js";
import { toAnalysisResultV7, toContinuationResultV7 } from "../agent-router/output-v7.js";
import { createAnalysisSession, continueSession } from "../agent-router/retrieval/retrieval-session-service.js";
import type { FrontierShadowReport } from "../agent-router/retrieval/retrieval-types.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { defaultDeadlineMs, MAX_REQUEST_DEADLINE_MS, type RequestContext } from "../runtime/request-context.js";
import type { ToolContext } from "./context.js";
import type { ImpactAnchorInput, ImpactOptions, ImpactResult, ImpactResultV6, ImpactVerbosity } from "../agent-types.js";

// Iteration A adapter: JDT calls still take a plain timeout, so the request-level
// absolute deadline is projected onto the single legacy stage timeout. Task 7
// replaces this by passing the budget itself down to every JDT call.
const SEMANTIC_STAGE_CAP_MS = 1500;

export const impactSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  action: z.enum(["analyze", "continue"]).optional().default("analyze"),
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
  verbosity: z.enum(["compact", "standard", "diagnostic"]).default("standard"),
  retrieval: z.object({
    enabled: z.boolean().default(false),
    maxSteps: z.number().int().min(1).max(3).optional(),
    frontierMaxItems: z.number().int().positive().max(16).optional(),
    additionalReadBytes: z.number().int().positive().max(65536).optional()
  }).optional(),
  continuation: z.object({
    sessionId: z.string().min(16).max(128),
    ids: z.array(z.string().min(1).max(16)).min(1).max(8),
    maxAdditionalReadBytes: z.number().int().positive().max(65536).optional()
  }).optional()
};

type ImpactArgs = Omit<z.infer<z.ZodObject<typeof impactSchema>>, "action"> & {
  action?: "analyze" | "continue";
};

export async function javaImpact(
  context: ToolContext,
  args: ImpactArgs,
  request?: RequestContext
): Promise<unknown> {
  const action = args.action ?? "analyze";
  if (action === "continue") {
    return continueImpact(context, args, request);
  }
  if (args.continuation) {
    throw new Error("java_impact action=analyze forbids continuation.");
  }
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
  let frontierShadow: FrontierShadowReport | undefined;
  const result = await context.router.impact(options, request, {
    frontierShadow(report) {
      frontierShadow = report;
    }
  }) as ImpactResultV6;
  mergePhaseMs(phaseMs, context.session.drainPhaseMetrics());
  const withMetrics = withPhaseMs(result, phaseMs, args.verbosity) as ImpactResultV6;
  if (!args.retrieval?.enabled || !context.retrievalSessions || !request || !frontierShadow) {
    return withMetrics;
  }
  const session = createAnalysisSession({
    store: context.retrievalSessions,
    frontier: frontierShadow,
    selectedPaths: withMetrics.readPlan.map(item => withMetrics.files.find(file => file.id === item.fileId)?.path ?? item.fileId),
    target: withMetrics.target,
    request,
    runtimeBuildSha: readRuntimeBuild().gitSha,
    maxSteps: args.retrieval.maxSteps ?? 2,
    firstCost: withMetrics.cost
  });
  if (!session) return withMetrics;
  return toAnalysisResultV7(withMetrics, {
    sessionId: session.sessionId,
    generation: session.generation,
    step: session.step,
    maxSteps: session.maxSteps,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    frontier: session.frontier,
    stopReason: frontierShadow.stopReason
  });
}

async function continueImpact(
  context: ToolContext,
  args: ImpactArgs,
  request?: RequestContext
): Promise<unknown> {
  if (args.anchors || args.file || args.line || args.column) {
    throw new Error("java_impact action=continue forbids anchors/file/line/column.");
  }
  if (!args.continuation) {
    throw new Error("java_impact action=continue requires continuation.");
  }
  if (!context.retrievalSessions) {
    throw new Error("SESSION_EXPIRED: Retrieval session store is not available; run a new java_impact analysis.");
  }
  if (!request) {
    throw new Error("CONTINUATION_STALE: Continuation requires a freshness barrier; run a new java_impact analysis.");
  }
  const { session, snapshot } = await continueSession({
    store: context.retrievalSessions,
    sessionId: args.continuation.sessionId,
    ids: args.continuation.ids,
    maxAdditionalReadBytes: args.continuation.maxAdditionalReadBytes ?? 8192,
    request,
    runtimeBuildSha: readRuntimeBuild().gitSha
  });
  const result = toContinuationResultV7({
    analysis: {
      target: session.target,
      freshness: {
        requestGeneration: request.generation,
        indexedGeneration: request.generation,
        coverage: "COMPLETE",
        changedDuringRequest: false
      },
      semantic: { policy: args.semanticPolicy, used: false, completion: "COMPLETE" }
    },
    files: snapshot.files,
    readPlan: snapshot.readPlan,
    readBytes: snapshot.cost.readBytes,
    retrieval: {
      sessionId: session.sessionId,
      generation: session.generation,
      step: session.step,
      maxSteps: session.maxSteps,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      frontier: session.frontier,
      consumed: snapshot.ids,
      stopReason: session.frontier.length === 0 ? "NO_HIGH_VALUE_FRONTIER" : snapshot.stopReason
    }
  });
  return args.verbosity === "diagnostic" ? result : withConvergedCostV6(result, result.cost.readBytes, result.cost.suppressedRawBytes);
}

function normalizeAnchors(args: ImpactArgs): ImpactAnchorInput[] {
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
