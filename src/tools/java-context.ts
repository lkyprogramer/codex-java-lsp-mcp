// input: java_context MCP request.
// output: §11.3 ContextContract. Graph query only; no benchmark engine switch.
// pos: JIN N5-01 public tool. Handler lives here because tools/context.ts is ToolContext.
import { z } from "zod";
import { DEFAULT_TOKEN_BUDGET } from "../context-engine/context-planner.js";
import { CONTEXT_CONTRACT_VERSION, type ContextContract } from "../context-engine/context-contract.js";
import type { EntityHit } from "../java-index/entity-search.js";
import type { RequestContext } from "../runtime/request-context.js";
import type { ToolContext } from "./context.js";

export const JAVA_CONTEXT_INTENTS = [
  "IMPLEMENTATION_CHANGE",
  "DOWNSTREAM_BEHAVIOR",
  "UPSTREAM_IMPACT",
  "CONTRACT_CHANGE",
  "PERSISTENCE_FLOW",
  "DATAFLOW_TRACE",
  "FRAMEWORK_WIRING",
  "TEST_PLANNING",
  "DIAGNOSTIC_ONLY",
  "auto"
] as const;

export const JAVA_CONTEXT_DESCRIPTION = [
  "Plan Java context as a candidate frontier, evidence spans, unresolved gaps, and next tool-call parameters. Pass intent. Anchors optional: omit them and pass task to resolve up to 3 entry entities. Copy next[] to continue (callers, callees, or a persistence/framework closure).",
  "IMPLEMENTATION_CHANGE: edit a method; pack callees, implementations, and contracts.",
  "DOWNSTREAM_BEHAVIOR: follow callees and dispatch.",
  "UPSTREAM_IMPACT: find callers and reachable controllers.",
  "CONTRACT_CHANGE: DTO, API, request/response types.",
  "PERSISTENCE_FLOW: mapper, XML, entity, SQL.",
  "DATAFLOW_TRACE: data from source to sink.",
  "FRAMEWORK_WIRING: Spring inject, events, beans.",
  "TEST_PLANNING: highest-value tests.",
  "DIAGNOSTIC_ONLY: error or exception path.",
  "auto: infer intent from task and echo resolvedIntent."
].join("\n");

export const javaContextSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  intent: z.enum(JAVA_CONTEXT_INTENTS),
  task: z.string().min(1).max(500).optional(),
  anchors: z.array(z.object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive()
  })).max(5).optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  mode: z.enum(["search", "navigate"]).default("search"),
  direction: z.enum(["auto", "callers", "callees"]).default("auto"),
  closure: z.enum(["persistence", "framework"]).optional(),
  tokenBudget: z.number().int().positive().max(8000).optional(),
  includeSource: z.boolean().optional().default(false),
  sessionId: z.string().min(1).optional(),
  generation: z.number().int().nonnegative().optional()
};

type JavaContextArgs = z.input<z.ZodObject<typeof javaContextSchema>>;
type Anchor = { file: string; line: number; column: number };

export async function javaContext(
  context: ToolContext,
  args: JavaContextArgs,
  _request?: RequestContext
): Promise<ContextContract> {
  const parsed = z.object(javaContextSchema).parse(args);
  const graph = context.javaIndex;
  if (!graph.queryContextGraph || !graph.queryEntitySearch) {
    throw new Error("java_context requires the JavaIndex graph query surface");
  }
  const anchors = normalizeAnchors(parsed);
  if (anchors.length === 0 && !parsed.task) {
    throw new Error("java_context requires anchors[] or task.");
  }
  if (parsed.mode === "navigate" && parsed.direction === "auto" && !parsed.closure) {
    throw new Error("java_context mode=navigate requires direction=callers|callees or closure=persistence|framework.");
  }
  let resolvedHits: EntityHit[] = [];
  let start = anchors[0];
  const noAnchor = anchors.length === 0;
  if (!start) {
    resolvedHits = await graph.queryEntitySearch(parsed.task!, 3);
    if (resolvedHits.length === 0) {
      return emptyContract(parsed.intent, parsed.task);
    }
    start = { file: resolvedHits[0]!.relativePath, line: 1, column: 1 };
  }
  const navigate = parsed.mode === "navigate";
  const result = await graph.queryContextGraph({
    fromRelativePath: start.file,
    intent: parsed.intent,
    mode: navigate ? "navigate" : "search",
    direction: parsed.direction === "auto" ? undefined : parsed.direction,
    closure: parsed.closure,
    maxHops: navigate ? 2 : noAnchor ? 1 : 4,
    maxExpansions: noAnchor ? 256 : 4096,
    tokenBudget: parsed.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    taskText: parsed.task,
    plan: true,
    includeSource: parsed.includeSource === true,
    anchorLine: start.line,
    anchorColumn: start.column,
    sessionId: parsed.sessionId,
    generation: parsed.generation,
    repoHash: context.repoHash
  });
  if (!result.contract) {
    throw new Error("java_context expected a planned context contract");
  }
  return result.contract;
}

function normalizeAnchors(args: Pick<JavaContextArgs, "anchors" | "file" | "line" | "column">): Anchor[] {
  if (args.anchors && args.anchors.length > 0) {
    return args.anchors.map(anchor => ({ file: anchor.file, line: anchor.line, column: anchor.column }));
  }
  if (args.file && args.line && args.column) {
    return [{ file: args.file, line: args.line, column: args.column }];
  }
  return [];
}

function emptyContract(_requested: string, _task?: string): ContextContract {
  return {
    version: CONTEXT_CONTRACT_VERSION,
    generation: 0,
    coverage: "PARTIAL",
    evidence: [],
    candidates: [],
    unresolved: [],
    next: [{ action: "expand", file: "", line: 1, reason: "unresolved-entry" }],
    cost: { modelTokens: 0, serviceMs: 0 }
  };
}
