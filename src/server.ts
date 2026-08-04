// input: Codex MCP stdio tool calls for Java analysis.
// output: Five read-only Java navigation tools backed by source index, rg, and bounded JDT LS.
// pos: Thin MCP server registration entrypoint.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AliasRegistry } from "./alias-registry.js";
import { RepoResolver, type RepoSelector } from "./repo-resolver.js";
import { RepoRuntimeManager, type RequestOptionsInput } from "./repo-runtime-manager.js";
import type { RequestContext } from "./runtime/request-context.js";
import { diagnosticsSchema, javaDiagnostics } from "./tools/diagnostics.js";
import { impactSchema, javaImpact } from "./tools/impact.js";
import { javaRuntime, runtimeSchema } from "./tools/runtime.js";
import { javaStatus, statusSchema, summarizeResourceStatus } from "./tools/status.js";
import { isDiagnosticDetail } from "./tools/shared.js";
import { javaSymbol, symbolSchema } from "./tools/symbol.js";
import { cleanupStaleWorktreeCaches, type WorktreeCacheCleanupResult } from "./worktree-cache-cleanup.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const registry = new AliasRegistry();
const resolver = new RepoResolver(registry);
const runtimes = new RepoRuntimeManager(resolver);

const server = new McpServer({
  name: "codex-java-lsp",
  version: "0.1.0"
}, {
  instructions: "Use java_impact first for Java navigation. Tools are read-only and optimized for low-token impact analysis."
});

register("java_status", {
  title: "Java Status",
  description: "Return repo, JDT LS, watcher, JavaIndex, and router cache status; pass start=true to start JDT LS.",
  inputSchema: statusSchema
}, args => javaStatusFor(args));

register("java_impact", {
  title: "Java Impact",
  description: "Build a compact Java impact plan with JavaIndex routing, internal rg summary, optional bounded LSP enrichment, and read plan.",
  inputSchema: impactSchema
}, args => withContext(args, (context, request) => javaImpact(context, args, request), {
  mayStartLsp: args.semanticPolicy !== "fast",
  requireLspEnabled: args.semanticPolicy === "required",
  requestOptions: {
    mode: args.mode,
    semanticPolicy: args.semanticPolicy,
    deadlineMs: args.deadlineMs
  }
}));

register("java_symbol", {
  title: "Java Symbol",
  description: "operation=query (default): search workspace symbols. operation=position (default with file/line/column): hover/definition/implementation at a position. operation=references: summary-only references.",
  inputSchema: symbolSchema
}, args => withContext(args, context => javaSymbol(context, args), { mayStartLsp: true, requireLspEnabled: true }));

register("java_diagnostics", {
  title: "Java Diagnostics",
  description: "Open Java files and return JDT LS diagnostics after a short wait.",
  inputSchema: diagnosticsSchema
}, args => withContext(args, context => javaDiagnostics(context, args), { mayStartLsp: true, requireLspEnabled: true }));

register("java_runtime", {
  title: "Java Runtime",
  description: "action=restart: restart JDT LS (clearCache=true also clears cache). action=shutdown: stop JDT LS (all=true stops every active repo).",
  inputSchema: runtimeSchema
}, args => runtimeFor(args));

let startupCleanup: WorktreeCacheCleanupResult | undefined;

async function main(): Promise<void> {
  const cleanup = cleanupStaleWorktreeCaches();
  startupCleanup = cleanup;
  if (cleanup.removed > 0) {
    console.error(`[codex-java-lsp] cleaned ${cleanup.removed} stale worktree cache(s)`);
  }
  // Bounded local filesystem work (capacityLockTimeoutMs caps the worst case);
  // a degraded lease store never blocks startup, only cross-process JDT admission.
  await runtimes.initialize();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[codex-java-lsp] MCP server ready");
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

main().catch(error => {
  console.error("[codex-java-lsp] fatal startup error", error);
  process.exit(1);
});

async function shutdown(): Promise<void> {
  await runtimes.shutdownAll();
  await server.close();
  process.exit(0);
}

async function javaStatusFor(args: z.infer<z.ZodObject<typeof statusSchema>>): Promise<unknown> {
  const hasSelector = Boolean(args.projectId || args.repoRoot || args.file);
  if (!hasSelector && !args.start) {
    await registry.reloadIfChanged();
    return {
      server: {
        name: "codex-java-lsp",
        activeRepos: runtimes.activeRepos().length
      },
      resource: runtimes.resourceStatus(),
      leases: await runtimes.leaseStatus(),
      // Counts only; removedDirs is never surfaced here (it is a raw path list).
      janitor: startupCleanup && {
        scanned: startupCleanup.scanned,
        removed: startupCleanup.removed,
        skipped: startupCleanup.skipped
      },
      aliases: registry.aliases(),
      aliasRegistry: registry.status(),
      activeRepos: runtimes.activeRepos()
    };
  }
  return withContext(args, async context => {
    const resource = runtimes.resourceStatus();
    return {
      ...await javaStatus(context, args),
      resource: isDiagnosticDetail(args.detail) ? resource : summarizeResourceStatus(resource)
    };
  }, { mayStartLsp: args.start });
}

async function runtimeFor(args: z.infer<z.ZodObject<typeof runtimeSchema>>): Promise<unknown> {
  if (args.action === "shutdown") {
    if (args.all) {
      const activeRepos = runtimes.activeRepos();
      await runtimes.shutdownAll();
      return { stoppedRepos: activeRepos };
    }
    return withContext(args, context => javaRuntime(context, args));
  }
  return withContext(args, context => javaRuntime(context, args), { mayStartLsp: true, requireLspEnabled: true });
}

async function withContext<T>(
  args: RepoSelector,
  handler: (
    context: Awaited<ReturnType<RepoRuntimeManager["contextFor"]>>,
    request: RequestContext
  ) => Promise<T>,
  options: {
    mayStartLsp?: boolean;
    requireLspEnabled?: boolean;
    requestOptions?: RequestOptionsInput;
  } = {}
): Promise<T> {
  return runtimes.withContext(args, async (context, request) => {
    if (options.requireLspEnabled && !context.lsp.enabled) {
      throw new Error(context.lsp.enableHint || "This repo is not LSP-enabled.");
    }
    return handler(context, request);
  }, { mayStartLsp: options.mayStartLsp, requestOptions: options.requestOptions });
}

function register<T extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: T },
  handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>
): void {
  const callback = async (args: unknown): Promise<ToolResult> => {
    try {
      return jsonResult(await handler(args as z.infer<z.ZodObject<T>>));
    } catch (error) {
      return errorResult(error);
    }
  };
  server.registerTool(name, config as any, callback as any);
}

function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }]
  };
}

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}
