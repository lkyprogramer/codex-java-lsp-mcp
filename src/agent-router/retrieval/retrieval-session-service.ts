// input: First-plan frontier shadow plus continue ids, or a stored session.
// output: Consumable in-pool continuation. No extra worker query. No discovery-gap files.
// pos: V5R Phase 5. Fail-closed on stale/expired. Complete-only session writes.
import type { ContinuationRelation, FrontierItemV1, FrontierShadowReport, RetrievalStopReason } from "./retrieval-types.js";
import { accumulateCostSteps, retrievalCostFromV6 } from "./cost-model.js";
import {
  cloneSession,
  RETRIEVAL_PLANNER_VERSION,
  type ContinuationSnapshot,
  type RetrievalSessionRecord,
  type RetrievalSessionStore
} from "./retrieval-session-store.js";
import type { ImpactCostV6, ImpactFileV6, ImpactTargetV6, ReadPlanItemV6 } from "../../agent-types.js";
import type { RequestContext } from "../../runtime/request-context.js";

export const CONSUMABLE_FRONTIER_RELATIONS: ReadonlySet<ContinuationRelation> = new Set([
  "BUDGET_EVICTED",
  "CLOSED_PORT_IMPLEMENTATION",
  "SECOND_HOP_EXACT",
  "SIGNATURE_COLLABORATOR",
  "CROSS_MODULE_ALTERNATIVE"
]);

export class ContinuationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ContinuationError";
  }
}

const sessionLocks = new WeakMap<RetrievalSessionStore, Map<string, Promise<unknown>>>();

export function consumableFrontierItems(items: readonly FrontierItemV1[]): FrontierItemV1[] {
  return items.filter(item => CONSUMABLE_FRONTIER_RELATIONS.has(item.relation));
}

export const DEFAULT_CONTINUE_MAX_ADDITIONAL_READ_BYTES = 8192;

export function inPoolFifoContinuationIds(
  frontier: readonly FrontierItemV1[],
  maxAdditionalReadBytes = DEFAULT_CONTINUE_MAX_ADDITIONAL_READ_BYTES
): string[] {
  const ids: string[] = [];
  let used = 0;
  for (const item of consumableFrontierItems(frontier)) {
    if (used + item.estimatedReadBytes > maxAdditionalReadBytes) break;
    ids.push(item.id);
    used += item.estimatedReadBytes;
  }
  return ids;
}

export function createAnalysisSession(input: {
  store: RetrievalSessionStore;
  frontier: FrontierShadowReport;
  selectedPaths: readonly string[];
  target: ImpactTargetV6;
  request: Pick<RequestContext, "repoHash" | "familyHash" | "generation">;
  runtimeBuildSha: string;
  maxSteps: number;
  firstCost: ImpactCostV6;
}): RetrievalSessionRecord | undefined {
  const frontier = consumableFrontierItems(input.frontier.items);
  if (frontier.length === 0) return undefined;
  return input.store.create({
    repoHash: input.request.repoHash,
    worktreeFamilyHash: input.request.familyHash,
    generation: input.request.generation,
    plannerVersion: RETRIEVAL_PLANNER_VERSION,
    runtimeBuildSha: input.runtimeBuildSha,
    maxSteps: Math.max(1, input.maxSteps),
    selectedPaths: [...input.selectedPaths],
    frontier,
    cumulative: retrievalCostFromV6(input.firstCost, { toolCalls: 1 }),
    target: input.target
  });
}

export async function continueSession(input: {
  store: RetrievalSessionStore;
  sessionId: string;
  ids: readonly string[];
  maxAdditionalReadBytes: number;
  request: Pick<RequestContext, "repoHash" | "familyHash" | "generation">;
  runtimeBuildSha: string;
}): Promise<{ session: RetrievalSessionRecord; snapshot: ContinuationSnapshot }> {
  return withSessionLock(input.store, input.sessionId, () => {
    const current = input.store.get(input.sessionId);
    if (!current) {
      throw new ContinuationError("SESSION_EXPIRED", "Retrieval session expired or was never created; run a new java_impact analysis.");
    }
    assertFresh(current, input.request, input.runtimeBuildSha);
    const requested = [...input.ids];
    if (current.lastContinuation && sameIds(current.lastContinuation.ids, requested)) {
      input.store.metrics.continued += 1;
      return { session: current, snapshot: current.lastContinuation };
    }
    if (current.step >= current.maxSteps) {
      throw new ContinuationError("MAX_STEPS_REACHED", "Retrieval session already used its maxSteps; run a new java_impact analysis.");
    }
    const remaining = new Map(current.frontier.map(item => [item.id, item]));
    const consumed: FrontierItemV1[] = [];
    let usedBytes = 0;
    for (const id of requested) {
      if (current.consumedIds.includes(id) && remaining.size === current.frontier.length) {
        throw new ContinuationError("ALREADY_CONSUMED", `Continuation id ${id} was already consumed with a different id set.`);
      }
      const item = remaining.get(id);
      if (!item) {
        throw new ContinuationError("INVALID_CONTINUATION_ID", `Continuation id ${id} is not in this session frontier.`);
      }
      if (!CONSUMABLE_FRONTIER_RELATIONS.has(item.relation)) {
        throw new ContinuationError("INVALID_CONTINUATION_ID", `Continuation id ${id} is not a consumable in-pool unit.`);
      }
      if (usedBytes + item.estimatedReadBytes > input.maxAdditionalReadBytes) break;
      consumed.push(item);
      remaining.delete(id);
      usedBytes += item.estimatedReadBytes;
    }
    if (consumed.length === 0) {
      throw new ContinuationError("FRONTIER_BYTE_CAP", "No requested continuation unit fit maxAdditionalReadBytes.");
    }
    const snapshot = snapshotFromConsumed(consumed, usedBytes);
    const next = cloneSession(current);
    next.step += 1;
    next.consumedIds = [...next.consumedIds, ...consumed.map(item => item.id)];
    next.frontier = [...remaining.values()];
    next.lastContinuation = snapshot;
    next.cumulative = accumulateCostSteps([
      next.cumulative,
      retrievalCostFromV6(snapshot.cost, { toolCalls: 1, sourceReadCalls: consumed.length, additionalSourceBytes: usedBytes })
    ]);
    input.store.put(next);
    input.store.metrics.continued += 1;
    return { session: next, snapshot };
  });
}

export function assertFresh(
  session: RetrievalSessionRecord,
  request: Pick<RequestContext, "repoHash" | "familyHash" | "generation">,
  runtimeBuildSha: string
): void {
  if (session.repoHash !== request.repoHash) {
    throw new ContinuationError("CONTINUATION_STALE", "Repository identity changed; run a new java_impact analysis.");
  }
  if (session.generation !== request.generation) {
    throw new ContinuationError("CONTINUATION_STALE", "Repository generation changed; run a new java_impact analysis.");
  }
  if (session.plannerVersion !== RETRIEVAL_PLANNER_VERSION) {
    throw new ContinuationError("CONTINUATION_STALE", "Planner version changed; run a new java_impact analysis.");
  }
  if (session.runtimeBuildSha !== runtimeBuildSha) {
    throw new ContinuationError("CONTINUATION_STALE", "Runtime build changed; run a new java_impact analysis.");
  }
}

function snapshotFromConsumed(consumed: readonly FrontierItemV1[], readBytes: number): ContinuationSnapshot {
  const files: ImpactFileV6[] = consumed.map(item => ({
    id: item.fileId,
    path: item.path,
    role: "support",
    confidence: item.confidence,
    evidence: item.expectedEvidence,
    locations: item.ranges.map(range => ({ line: range.startLine, column: 1 }))
  }));
  const readPlan: ReadPlanItemV6[] = consumed.map(item => ({
    priority: "P1",
    fileId: item.fileId,
    ranges: item.ranges.map(range => ({
      startLine: range.startLine,
      endLine: range.endLine,
      estimatedBytes: range.estimatedBytes
    })),
    reason: item.relation,
    expectedEvidence: item.expectedEvidence,
    estimatedBytes: item.estimatedReadBytes
  }));
  return {
    ids: consumed.map(item => item.id),
    files,
    readPlan,
    stopReason: "FRONTIER_AVAILABLE",
    cost: {
      resultBytes: 0,
      readBytes,
      estimatedTokens: 0,
      suppressedRawBytes: 0
    }
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function withSessionLock<T>(
  store: RetrievalSessionStore,
  sessionId: string,
  operation: () => T | Promise<T>
): Promise<T> {
  let locks = sessionLocks.get(store);
  if (!locks) {
    locks = new Map();
    sessionLocks.set(store, locks);
  }
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  locks.set(sessionId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(sessionId) === current) locks.delete(sessionId);
  }
}
