// input: MCP server process singletons.
// output: Shared tool context for v5 handlers.
// pos: Dependency bundle passed from server.ts into individual tools.
import { AgentRouter } from "../agent-router/index.js";
import type { JavaIndexClient } from "../java-index/java-index-client.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import { JdtlsSession } from "../jdtls-session.js";
import type { SourceIndex } from "../source-index.js";
import type { WorktreeIdentity } from "../worktree-identity.js";

export type ToolContext = {
  repoRoot: string;
  rootSource?: "explicit" | "projectId" | "cwd" | "inferred";
  repoHash?: string;
  aliases?: string[];
  layoutProfile?: string;
  worktree?: WorktreeIdentity;
  lsp?: {
    enabled: boolean;
    matchedBy: string;
    configuredRoot?: string;
    effectiveRepoRoot: string;
    reason?: string;
    enableHint?: string;
  };
  resource?: {
    machineMemoryGb: number;
    logicalCpu: number;
    maxActiveRepos: number;
    idleTtlMs: number;
    jdtlsXmx: string;
    activeRepos: number;
    reservedRepos: number;
    queuedRepos: number;
    activeJdtlsPids: number[];
    importConcurrency: number;
    workspaceRetainedOnShutdown: boolean;
  };
  watcher?: {
    ready: boolean;
    degraded: boolean;
    pending: number;
    lastStorm?: { observedAt: string; changeCount: number; affectedRoots: string[] };
  };
  session: JdtlsSession;
  /** V1 regex/documentSymbol index; still authoritative for warm-index refresh. */
  sourceIndex: SourceIndex;
  /**
   * Router-facing fact facade. Selected per JAVA_LSP_INDEX_BACKEND (Step 7):
   * `wrapSourceIndex(sourceIndex)` for "v1", `RouterJavaIndex` for "v2".
   */
  javaIndex: RouterIndex;
  /** Raw V2 worker client; present whenever the V2 index is running (independent of which backend answers requests). */
  javaIndexClient?: JavaIndexClient;
  router: AgentRouter;
};
