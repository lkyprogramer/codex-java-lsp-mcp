// input: Planned EvidenceBundles plus session tuple.
// output: §11.3 context contract types and fail-closed session store.
// pos: JIN N4-03. Inherits V5R sessionId+generation+repoHash+plannerVersion. No score on the wire.
export const PLANNER_VERSION = "jin-n4-1";
export const CONTEXT_CONTRACT_VERSION = 3 as const;
export const SESSION_TTL_MS = 180_000;
export const SESSION_LRU = 128;

export type ContextSpan = {
  start: number;
  end: number;
  text?: string;
};

export type ContextItem = {
  role: string;
  path: string;
  proof?: string[];
  ranges: string;
  spans?: ContextSpan[];
};

export type ContextCandidate = {
  path: string;
  role: string;
  hop: number;
  reason: string;
};

export type ContextNext = {
  action: string;
  file: string;
  line: number;
  direction?: "callers" | "callees";
  closure?: "persistence" | "framework";
  reason: string;
};

export type ResolvedAnchor = {
  path: string;
  symbol: string;
  layer: string;
};

export type ContextContract = {
  version: typeof CONTEXT_CONTRACT_VERSION;
  generation: number;
  coverage: "COMPLETE" | "PARTIAL";
  resolvedIntent?: string;
  resolvedAnchors?: ResolvedAnchor[];
  anchor?: { path: string; symbol: string };
  evidence: ContextItem[];
  candidates: ContextCandidate[];
  contexts?: ContextItem[];
  unresolved: Array<{ path?: string; id?: string; role: string }>;
  next: ContextNext[];
  cost: { modelTokens: number; serviceMs: number };
  session?: { sessionId: string; generation: number; repoHash: string; plannerVersion: string };
};

export class StaleSessionError extends Error {
  readonly code = "STALE_SESSION";
  constructor(message = "STALE_SESSION") {
    super(message);
    this.name = "StaleSessionError";
  }
}

export type SessionKey = {
  sessionId: string;
  generation: number;
  repoHash: string;
  plannerVersion: string;
};

type SessionRecord = {
  key: SessionKey;
  contract: ContextContract;
  savedAt: number;
};

function sameKey(left: SessionKey, right: SessionKey): boolean {
  return left.sessionId === right.sessionId
    && left.generation === right.generation
    && left.repoHash === right.repoHash
    && left.plannerVersion === right.plannerVersion;
}

export class ContextSessionStore {
  private readonly records: SessionRecord[] = [];

  save(key: SessionKey, contract: ContextContract, now = Date.now()): void {
    if (contract.coverage !== "COMPLETE") return;
    this.prune(now);
    this.records.splice(0, this.records.length, ...this.records.filter(record => record.key.sessionId !== key.sessionId));
    this.records.push({ key, contract, savedAt: now });
    if (this.records.length > SESSION_LRU) this.records.shift();
  }

  lookup(key: SessionKey, now = Date.now()): ContextContract | "STALE" | undefined {
    this.prune(now);
    const hit = this.records.find(record => record.key.sessionId === key.sessionId);
    if (!hit) return undefined;
    if (!sameKey(hit.key, key)) return "STALE";
    return hit.contract;
  }

  consume(key: SessionKey, now = Date.now()): ContextContract {
    const hit = this.lookup(key, now);
    if (hit === undefined || hit === "STALE") throw new StaleSessionError("STALE_SESSION");
    return hit;
  }

  private prune(now: number): void {
    const cutoff = now - SESSION_TTL_MS;
    const kept = this.records.filter(record => record.savedAt >= cutoff);
    this.records.splice(0, this.records.length, ...kept);
  }
}

export const contextSessions = new ContextSessionStore();
