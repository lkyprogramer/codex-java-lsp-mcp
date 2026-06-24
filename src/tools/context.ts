// input: MCP server process singletons.
// output: Shared tool context for v5 handlers.
// pos: Dependency bundle passed from server.ts into individual tools.
import { AgentRouter } from "../agent-router/index.js";
import { JdtlsSession } from "../jdtls-session.js";
import { SourceIndex } from "../source-index.js";

export type ToolContext = {
  repoRoot: string;
  rootSource?: "explicit" | "projectId" | "cwd" | "inferred";
  repoHash?: string;
  aliases?: string[];
  layoutProfile?: string;
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
    activeJdtlsPids: number[];
    importConcurrency: number;
    workspaceRetainedOnShutdown: boolean;
  };
  session: JdtlsSession;
  sourceIndex: SourceIndex;
  router: AgentRouter;
};
