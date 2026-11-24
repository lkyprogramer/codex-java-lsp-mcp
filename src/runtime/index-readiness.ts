// input: The owner's in-memory workspace round state and a static-index failure.
// output: Preparation state and explicit recovery instructions for MCP callers.
// pos: Shared readiness contract for java_status and cold static-query errors.
import type { JavaIndexStatus } from "../java-index/index-types.js";
import type { IndexOwner } from "../java-index/snapshot/index-owner.js";
import { withRequestView, type ViewLabels } from "../java-index/snapshot/request-view.js";
import type { LayoutContext } from "../layout-probe.js";
import type { ManagedToolContext } from "../repo-runtime-manager.js";
import type { ResolvedRepo } from "../repo-resolver.js";
import type { DeadlineBudget } from "./deadline-budget.js";
import { JavaIntelligenceError, rethrowIfTerminal } from "./intelligence-error.js";

export type IndexPreparation = {
  state: "NOT_STARTED" | "SCHEDULED" | "BUILDING" | "RETRYING" | "UNAVAILABLE";
  lastError?: string;
  retryInMs?: number;
};

export function describeIndexPreparation(
  workspace?: { roundInFlight: boolean; lastError?: string; retryInMs?: number },
  unavailable?: string
): IndexPreparation {
  if (unavailable !== undefined) return { state: "UNAVAILABLE", lastError: unavailable };
  if (!workspace) return { state: "NOT_STARTED" };
  return {
    state: workspace.roundInFlight ? "BUILDING" : workspace.lastError ? "RETRYING" : "SCHEDULED",
    ...(workspace.lastError !== undefined ? { lastError: workspace.lastError } : {}),
    ...(workspace.retryInMs !== undefined ? { retryInMs: workspace.retryInMs } : {})
  };
}

export type MemoryIndexState = {
  resolved: ResolvedRepo;
  context?: ManagedToolContext;
  labels: ViewLabels;
  javaIndex?: JavaIndexStatus;
  layout?: LayoutContext;
  indexPreparation?: IndexPreparation;
};

/** Status-only reads the existing owner and runtime; this path never opens or prepares a workspace. */
export async function readMemoryIndexStatus<T>(input: {
  resolved: ResolvedRepo;
  entry?: { context: ManagedToolContext; stoppedAt?: number; shared: { layout: LayoutContext }; snapshots: ReadonlyMap<string, { status: JavaIndexStatus }> };
  owner?: IndexOwner;
  budget: DeadlineBudget;
  signal?: AbortSignal;
  unavailable?: string;
  resource: ManagedToolContext["resource"];
}, handler: (state: MemoryIndexState) => Promise<T>): Promise<T> {
  const { resolved, entry, owner, budget, signal } = input;
  const workspace = owner?.peek(resolved.repoRoot);
  if (!entry || entry.stoppedAt !== undefined || !workspace || !owner) {
    return handler({ resolved, context: entry?.stoppedAt === undefined ? entry?.context : undefined, labels: { state: "NOT_READY" },
      indexPreparation: describeIndexPreparation(undefined, input.unavailable) });
  }
  entry.context.resource = input.resource;
  return withRequestView({ owner, budget, signal, start: false, resolve: async () => resolved.repoRoot,
    handler: async view => {
      const runtime = view.snapshotId ? entry.snapshots.get(view.snapshotId) : undefined;
      return handler({ resolved, context: entry.context, labels: view.labels, javaIndex: runtime?.status, layout: entry.shared.layout,
        ...(view.labels.state === "NOT_READY" ? { indexPreparation: describeIndexPreparation(workspace.status()) } : {}) });
    }
  });
}

export class IndexNotReadyError extends JavaIntelligenceError {
  readonly recovery: {
    status: "INDEX_NOT_READY";
    repoRoot: string;
    indexView: { state: "NOT_READY" };
    preparation: IndexPreparation;
    retryable: boolean;
    retryAfterMs?: number;
    nextAction: { tool: "java_status"; arguments: { repoRoot: string; start: false } };
    instructions: string;
  };

  constructor(repoRoot: string, preparation: IndexPreparation, cause: Error) {
    super("INDEX_PARTIAL", `Static Java index is not ready for ${repoRoot} (${preparation.state}).`, cause);
    const retryable = preparation.state !== "UNAVAILABLE" && preparation.state !== "NOT_STARTED";
    const instructions = retryable
      ? "Index preparation continues in the background. Use native search while waiting retryAfterMs before checking nextAction. "
        + "When indexView.snapshotId is present and indexView.state is FRESH or STALE, repeat the original tool call with its original arguments. "
        + "If it remains NOT_READY, inspect preparation.lastError/retryInMs and do useful work with native search instead of repeatedly calling the failing query. "
        + "java_status(start=false) checks memory only; it does not start JDT or an index. Do not restart the service or clear caches to wait for a build."
      : preparation.state === "UNAVAILABLE"
        ? "The static index owner is unavailable. Inspect nextAction and preparation.lastError; use native search while diagnosing it. Status polling alone cannot recover an unavailable owner."
        : "Index preparation has not started. java_status(start=false) does not start it; a static query starts preparation. Use native search while it prepares.";
    this.recovery = {
      status: "INDEX_NOT_READY", repoRoot, indexView: { state: "NOT_READY" }, preparation, retryable,
      ...(retryable ? { retryAfterMs: Math.max(1000, preparation.retryInMs ?? 0) } : {}),
      nextAction: { tool: "java_status", arguments: { repoRoot, start: false } },
      instructions
    };
  }
}

/** Add recovery only for a query that actually held a NOT_READY view. Other failures keep their classification. */
export async function withIndexReadiness<T>(
  context: { repoRoot: string; indexView?: Pick<ViewLabels, "state">; indexPreparation?: IndexPreparation },
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowIfTerminal(error);
    if (error instanceof JavaIntelligenceError && error.code === "INDEX_PARTIAL"
      && context.indexView?.state === "NOT_READY" && context.indexPreparation) {
      throw new IndexNotReadyError(context.repoRoot, context.indexPreparation, error);
    }
    throw error;
  }
}
