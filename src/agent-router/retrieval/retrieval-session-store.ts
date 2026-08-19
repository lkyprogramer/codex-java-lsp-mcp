// input: Frozen retrieval sessions keyed by opaque ids.
// output: Bounded in-memory store. Complete records only; no disk.
// pos: V5R Phase 5. Application-owned. stdio dies with the process; HTTP dies with the daemon.
import { randomBytes } from "node:crypto";
import type { FrontierItemV1, RetrievalStopReason } from "./retrieval-types.js";
import type { ImpactCostV6, ImpactFileV6, ImpactTargetV6, ReadPlanItemV6, RetrievalCostVectorV1 } from "../../agent-types.js";

export const RETRIEVAL_PLANNER_VERSION = 1;
export const DEFAULT_SESSION_TTL_MS = 180_000;
export const DEFAULT_MAX_SESSIONS = 128;
export const DEFAULT_MAX_SESSIONS_PER_REPO = 32;

export type ContinuationSnapshot = {
  ids: string[];
  files: ImpactFileV6[];
  readPlan: ReadPlanItemV6[];
  stopReason: RetrievalStopReason;
  cost: ImpactCostV6;
};

export type RetrievalSessionRecord = {
  sessionId: string;
  repoHash: string;
  worktreeFamilyHash?: string;
  generation: number;
  plannerVersion: number;
  runtimeBuildSha: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastAccessMs: number;
  step: number;
  maxSteps: number;
  selectedPaths: string[];
  consumedIds: string[];
  frontier: FrontierItemV1[];
  lastContinuation?: ContinuationSnapshot;
  cumulative: RetrievalCostVectorV1;
  target: ImpactTargetV6;
};

export type SessionStoreMetrics = {
  active: number;
  created: number;
  continued: number;
  expired: number;
  stale: number;
  evicted: number;
  rejectedWrites: number;
};

export class RetrievalSessionStore {
  readonly metrics: SessionStoreMetrics = {
    active: 0,
    created: 0,
    continued: 0,
    expired: 0,
    stale: 0,
    evicted: 0,
    rejectedWrites: 0
  };

  private readonly sessions = new Map<string, RetrievalSessionRecord>();

  constructor(
    readonly maxSessions = DEFAULT_MAX_SESSIONS,
    readonly maxPerRepo = DEFAULT_MAX_SESSIONS_PER_REPO,
    readonly ttlMs = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  create(input: Omit<RetrievalSessionRecord, "sessionId" | "createdAtMs" | "expiresAtMs" | "lastAccessMs" | "consumedIds" | "step"> & {
    sessionId?: string;
    consumedIds?: string[];
    step?: number;
  }): RetrievalSessionRecord {
    this.purgeExpired();
    const repoCount = [...this.sessions.values()].filter(session => session.repoHash === input.repoHash).length;
    if (this.sessions.size >= this.maxSessions || repoCount >= this.maxPerRepo) {
      this.evictOldest();
    }
    const now = this.now();
    const record: RetrievalSessionRecord = {
      ...input,
      sessionId: input.sessionId ?? opaqueSessionId(),
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      lastAccessMs: now,
      step: input.step ?? 0,
      consumedIds: input.consumedIds ? [...input.consumedIds] : [],
      frontier: input.frontier.map(item => ({ ...item, ranges: item.ranges.map(range => ({ ...range })) })),
      selectedPaths: [...input.selectedPaths]
    };
    this.sessions.set(record.sessionId, record);
    this.metrics.created += 1;
    this.metrics.active = this.sessions.size;
    return cloneSession(record);
  }

  get(sessionId: string): RetrievalSessionRecord | undefined {
    this.purgeExpired();
    const record = this.sessions.get(sessionId);
    if (!record) return undefined;
    if (record.expiresAtMs <= this.now()) {
      this.sessions.delete(sessionId);
      this.metrics.expired += 1;
      this.metrics.active = this.sessions.size;
      return undefined;
    }
    record.lastAccessMs = this.now();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, record);
    return cloneSession(record);
  }

  /** Complete-only replace. Callers must pass a fully built record. */
  put(record: RetrievalSessionRecord): void {
    if (!this.sessions.has(record.sessionId)) {
      this.metrics.rejectedWrites += 1;
      throw new Error("SESSION_UNKNOWN: Retrieval session is no longer stored.");
    }
    const next = cloneSession(record);
    next.lastAccessMs = this.now();
    this.sessions.delete(record.sessionId);
    this.sessions.set(record.sessionId, next);
    this.metrics.active = this.sessions.size;
  }

  invalidateRepo(repoHash: string): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.repoHash === repoHash) {
        this.sessions.delete(id);
        removed += 1;
        this.metrics.stale += 1;
      }
    }
    this.metrics.active = this.sessions.size;
    return removed;
  }

  clear(): void {
    this.sessions.clear();
    this.metrics.active = 0;
  }

  size(): number {
    this.purgeExpired();
    return this.sessions.size;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(id);
        this.metrics.expired += 1;
      }
    }
    this.metrics.active = this.sessions.size;
  }

  private evictOldest(): void {
    const first = this.sessions.keys().next().value;
    if (first === undefined) return;
    this.sessions.delete(first);
    this.metrics.evicted += 1;
    this.metrics.active = this.sessions.size;
  }
}

export function opaqueSessionId(): string {
  return randomBytes(16).toString("hex");
}

export function cloneSession(record: RetrievalSessionRecord): RetrievalSessionRecord {
  return {
    ...record,
    selectedPaths: [...record.selectedPaths],
    consumedIds: [...record.consumedIds],
    frontier: record.frontier.map(item => ({ ...item, ranges: item.ranges.map(range => ({ ...range })) })),
    lastContinuation: record.lastContinuation
      ? {
          ids: [...record.lastContinuation.ids],
          files: record.lastContinuation.files.map(file => ({ ...file })),
          readPlan: record.lastContinuation.readPlan.map(item => ({
            ...item,
            ranges: item.ranges.map(range => ({ ...range }))
          })),
          stopReason: record.lastContinuation.stopReason,
          cost: { ...record.lastContinuation.cost }
        }
      : undefined,
    cumulative: { ...record.cumulative }
  };
}
