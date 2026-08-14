// input: One shared JavaLspApplication and transport policy.
// output: A fresh MCP protocol server exposing the seven read-only Java tools.
// pos: Protocol-instance factory; never owns or closes the shared application lifecycle.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JavaLspApplication } from "./application.js";
import { readRuntimeBuild } from "./build-info.js";
import type { ManagedToolContext } from "./repo-runtime-manager.js";
import type { RepoSelector } from "./repo-resolver.js";
import { diagnosticsSchema, javaDiagnostics } from "./tools/diagnostics.js";
import { impactSchema, javaImpact } from "./tools/impact.js";
import { javaReferences, referencesSchema } from "./tools/references.js";
import { javaRestart, restartSchema } from "./tools/restart.js";
import { isDiagnosticDetail } from "./tools/shared.js";
import { javaShutdown, shutdownSchema } from "./tools/shutdown.js";
import { javaStatus, statusSchema, summarizeResourceStatus } from "./tools/status.js";
import { javaSymbol, symbolSchema } from "./tools/symbol.js";

export type McpTransportMode = "stdio" | "streamable_http";

export type McpServerFactoryOptions = {
  transportMode: McpTransportMode;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function createMcpServer(
  application: JavaLspApplication,
  options: Partial<McpServerFactoryOptions> = {}
): McpServer {
  const transportMode = options.transportMode ?? application.transportMode;
  if (transportMode !== application.transportMode) {
    throw new Error(`MCP transport (${transportMode}) does not match application ownership mode (${application.transportMode}).`);
  }
  if (transportMode === "streamable_http" && application.resolver.cwdFallbackPolicy() !== "reject") {
    throw new Error("Streamable HTTP requires a RepoResolver with cwdFallback=reject.");
  }
  const server = new McpServer({
    name: "codex-java-lsp",
    version: "0.1.0"
  }, {
    instructions: "Use java_impact first for Java navigation. Tools are read-only and optimized for low-token impact analysis."
  });

  register("java_status", {
    title: "Java Status",
    description: "Return repo, JDT LS, watcher, source index, and router cache status; pass start=true to start JDT LS.",
    inputSchema: statusSchema
  }, args => javaStatusFor(args));

  register("java_impact", {
    title: "Java Impact",
    description: "Build a compact Java impact plan with source-index routing, internal rg summary, optional bounded LSP enrichment, and read plan.",
    inputSchema: impactSchema
  }, args => withQuery(args, context => javaImpact(context, args), {
    mayStartLsp: args.semanticPolicy !== "fast",
    requireLspEnabled: args.semanticPolicy === "required"
  }));

  register("java_symbol", {
    title: "Java Symbol",
    description: "Search workspace symbols by query or inspect hover/definition/implementation at a file position.",
    inputSchema: symbolSchema
  }, args => withQuery(args, context => javaSymbol(context, args), { mayStartLsp: true, requireLspEnabled: true }));

  register("java_references", {
    title: "Java References",
    description: "Return summary-only references for a precise Java symbol position.",
    inputSchema: referencesSchema
  }, args => withQuery(args, context => javaReferences(context, args), { mayStartLsp: true, requireLspEnabled: true }));

  register("java_diagnostics", {
    title: "Java Diagnostics",
    description: "Open Java files and return JDT LS diagnostics after a short wait.",
    inputSchema: diagnosticsSchema
  }, args => withQuery(args, context => javaDiagnostics(context, args), { mayStartLsp: true, requireLspEnabled: true }));

  register("java_restart", {
    title: "Java Restart",
    description: "Restart the current worktree JDT LS session; clear cache only when explicitly requested.",
    inputSchema: restartSchema
  }, args => withControl(args, context => javaRestart(context, args), { mayStartLsp: true, requireLspEnabled: true }));

  register("java_shutdown", {
    title: "Java Shutdown",
    description: "Stop one worktree JDT LS child process while keeping the MCP server alive.",
    inputSchema: shutdownSchema
  }, args => shutdownFor(args));

  return server;

  async function javaStatusFor(args: z.infer<z.ZodObject<typeof statusSchema>>): Promise<unknown> {
    const hasSelector = Boolean(args.projectId || args.repoRoot || args.file);
    if (!hasSelector && !args.start) {
      if (transportMode === "streamable_http") {
        return daemonStatus(application);
      }
      await application.registry.reloadIfChanged();
      return {
        server: {
          name: "codex-java-lsp",
          transport: transportMode,
          activeRepos: application.runtimes.activeRepos().length
        },
        resource: application.runtimes.resourceStatus(),
        aliases: application.registry.aliases(),
        activeRepos: application.runtimes.activeRepos()
      };
    }
    return withQuery(args, async context => {
      const resource = application.runtimes.resourceStatus();
      return {
        ...await javaStatus(context, args),
        resource: isDiagnosticDetail(args.detail) ? resource : summarizeResourceStatus(resource)
      };
    }, { mayStartLsp: args.start });
  }

  async function shutdownFor(args: z.infer<z.ZodObject<typeof shutdownSchema>>): Promise<unknown> {
    if (args.all) {
      if (transportMode === "streamable_http") {
        throw new Error("java_shutdown(all=true) is not available on the shared daemon; select one worktree.");
      }
      const activeRepos = application.runtimes.activeRepos();
      await application.runtimes.shutdownAll();
      return { stoppedRepos: activeRepos };
    }
    return withControl(args, context => javaShutdown(context, args));
  }

  async function withQuery<T>(
    args: RepoSelector,
    handler: (context: ManagedToolContext) => Promise<T>,
    contextOptions: { mayStartLsp?: boolean; requireLspEnabled?: boolean } = {}
  ): Promise<T> {
    return application.runtimes.withQuery(args, async context => {
      if (contextOptions.requireLspEnabled && !context.lsp.enabled) {
        throw new Error(context.lsp.enableHint || "This repo is not LSP-enabled.");
      }
      return handler(context);
    }, { mayStartLsp: contextOptions.mayStartLsp });
  }

  async function withControl<T>(
    args: RepoSelector,
    handler: (context: ManagedToolContext) => Promise<T>,
    contextOptions: { mayStartLsp?: boolean; requireLspEnabled?: boolean } = {}
  ): Promise<T> {
    return application.runtimes.withControl(args, async context => {
      if (contextOptions.requireLspEnabled && !context.lsp.enabled) {
        throw new Error(context.lsp.enableHint || "This repo is not LSP-enabled.");
      }
      return handler(context);
    }, { mayStartLsp: contextOptions.mayStartLsp });
  }

  function register<T extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: T },
    handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>
  ): void {
    const callback = async (args: unknown, extra: { signal?: AbortSignal }): Promise<ToolResult> => {
      const operation = application.runRequest(async () => jsonResult(await handler(args as z.infer<z.ZodObject<T>>)));
      // Closing a stateless protocol aborts its request scope, not the shared application.
      // Keep the real operation tracked until it settles; forced daemon shutdown separately
      // terminally stops JDT and retains leases instead of releasing an uncertain owner.
      void operation.catch(() => undefined);
      try {
        return await raceRequestAbort(operation, extra.signal);
      } catch (error) {
        return errorResult(error);
      }
    };
    server.registerTool(name, config as any, callback as any);
  }
}

function raceRequestAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("MCP request was cancelled."));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function daemonStatus(application: JavaLspApplication): Record<string, unknown> {
  const state = application.state();
  const resource = application.runtimes.resourceStatus();
  const build = readRuntimeBuild();
  return {
    server: {
      name: "codex-java-lsp",
      transport: "streamable_http",
      state: state.state,
      uptimeMs: state.uptimeMs,
      activeRequests: state.activeRequests,
      runtimeCount: resource.activeRepos,
      activeJdtlsCount: resource.activeJdtlsPids.length,
      buildSha: build.gitSha
    },
    resource: {
      maxActiveRepos: resource.maxActiveRepos,
      idleTtlMs: resource.idleTtlMs,
      importConcurrency: resource.importConcurrency,
      workspaceRetainedOnShutdown: resource.workspaceRetainedOnShutdown
    }
  };
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
