// input: One shared JavaLspApplication and transport policy.
// output: A fresh MCP protocol server exposing the public read-only Java tools.
// pos: Protocol-instance factory; never owns or closes the shared application lifecycle.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JavaLspApplication } from "./application.js";
import { readRuntimeBuild } from "./build-info.js";
import type { ManagedToolContext, RequestOptionsInput } from "./repo-runtime-manager.js";
import type { RepoSelector } from "./repo-resolver.js";
import type { RequestContext } from "./runtime/request-context.js";
import { diagnosticsSchema, javaDiagnostics } from "./tools/diagnostics.js";
import { JAVA_IMPACT_TOOL_DESCRIPTION, impactSchema, javaImpact } from "./tools/impact.js";
import { javaRuntime, runtimeSchema } from "./tools/runtime.js";
import { isDiagnosticDetail } from "./tools/shared.js";
import { javaStatus, statusSchema, summarizeResourceStatus } from "./tools/status.js";
import { javaSymbol, symbolSchema } from "./tools/symbol.js";
import { noteTelemetryRepoHash, recordToolInvocation, withTelemetryRequestScope } from "./telemetry/impact-telemetry.js";

export type McpTransportMode = "stdio" | "streamable_http";

/** Public MCP tool surface. java_impact is the current compact chain. java_context stays on the branch but is not registered after L1 FAIL. */
export const PUBLIC_JAVA_TOOLS = [
  "java_status",
  "java_impact",
  "java_symbol",
  "java_diagnostics",
  "java_runtime"
] as const;

export type PublicJavaTool = (typeof PUBLIC_JAVA_TOOLS)[number];

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
    instructions: "java_impact is the compact Java impact plan. Tools are read-only. Default semanticPolicy=auto uses live JDT only for service-profile anchors; pass required or use java_symbol for exact implementations/references."
  });

  const registered: string[] = [];
  const track = (name: string): string => {
    registered.push(name);
    return name;
  };

  register(track("java_status"), {
    title: "Java Status",
    description: "Return repo, JDT LS, watcher, JavaIndex, and router cache status; pass start=true to start JDT LS.",
    inputSchema: statusSchema
  }, args => javaStatusFor(args));

  register(track("java_impact"), {
    title: "Java Impact",
    description: JAVA_IMPACT_TOOL_DESCRIPTION,
    inputSchema: impactSchema
  }, args => withContext(args, (context, request) => javaImpact(context, args, request), {
    mayStartLsp: args.semanticPolicy !== "fast",
    requireLspEnabled: args.semanticPolicy === "required",
    requestOptions: {
      mode: args.mode,
      semanticPolicy: args.semanticPolicy,
      deadlineMs: args.deadlineMs
    }
  }).catch(rethrowUnlessIdleWarming));

  register(track("java_symbol"), {
    title: "Java Symbol",
    description: "operation=query (default): search workspace symbols. operation=position (default with file/line/column): hover/definition/implementation at a position. operation=references: summary-only references. Always live JDT; cheaper than java_impact semanticPolicy=required for one symbol.",
    inputSchema: symbolSchema
  }, args => withContext(args, (context, request) => javaSymbol(context, args, request), {
    mayStartLsp: true,
    requireLspEnabled: true,
    requestOptions: {
      mode: "balanced",
      semanticPolicy: "required",
      deadlineMs: args.semanticTimeoutMs
    }
  }));

  register(track("java_diagnostics"), {
    title: "Java Diagnostics",
    description: "Open Java files and return JDT LS diagnostics after a short wait.",
    inputSchema: diagnosticsSchema
  }, args => withContext(args, (context, request) => javaDiagnostics(context, args, request), {
    mayStartLsp: true,
    requireLspEnabled: true,
    requestOptions: {
      mode: "balanced",
      semanticPolicy: "required",
      deadlineMs: Math.min(15000, Math.max(10000, args.waitMs + 5000))
    }
  }));

  register(track("java_runtime"), {
    title: "Java Runtime",
    description: "action=restart: restart JDT LS (clearCache=true also clears cache). action=shutdown: stop JDT LS (all=true stops every active repo).",
    inputSchema: runtimeSchema
  }, args => runtimeFor(args));

  if (registered.join("\0") !== PUBLIC_JAVA_TOOLS.join("\0")) {
    throw new Error(`MCP registration drifted from PUBLIC_JAVA_TOOLS: ${registered.join(",")}`);
  }
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
    return withContext(args, async (context, request) => {
      const resource = application.runtimes.resourceStatus();
      return {
        ...await javaStatus(context, args, request),
        resource: isDiagnosticDetail(args.detail) ? resource : summarizeResourceStatus(resource)
      };
    }, {
      mayStartLsp: args.start,
      // start:false still has to create the per-repo runtime (JDK probe, session,
      // JavaIndex OPEN). The query default of ~2–3s expires before that finishes
      // after a daemon restart, which is exactly "Deadline exceeded before runtime.create".
      requestOptions: {
        mode: "balanced",
        semanticPolicy: args.start ? "required" : "auto",
        deadlineMs: 15000
      }
    }).catch(rethrowUnlessIdleWarming);
  }

  async function runtimeFor(args: z.infer<z.ZodObject<typeof runtimeSchema>>): Promise<unknown> {
    if (args.action === "shutdown" && args.all) {
      if (transportMode === "streamable_http") {
        throw new Error("java_runtime(all=true) is not available on the shared daemon; select one worktree.");
      }
      const activeRepos = application.runtimes.activeRepos();
      await application.runtimes.shutdownAll();
      return { stoppedRepos: activeRepos };
    }
    return withContext(args, context => javaRuntime(context, args), {
      mayStartLsp: args.action === "restart",
      requireLspEnabled: args.action === "restart"
    });
  }

  async function withContext<T>(
    args: RepoSelector,
    handler: (context: ManagedToolContext, request: RequestContext) => Promise<T>,
    contextOptions: {
      mayStartLsp?: boolean;
      requireLspEnabled?: boolean;
      requestOptions?: RequestOptionsInput;
    } = {}
  ): Promise<T> {
    return application.runtimes.withContext(args, async (context, request) => {
      noteTelemetryRepoHash(context.repoHash);
      if (contextOptions.requireLspEnabled && !context.lsp.enabled) {
        throw new Error(context.lsp.enableHint || "This repo is not LSP-enabled.");
      }
      return handler(context, request);
    }, { mayStartLsp: contextOptions.mayStartLsp, requestOptions: contextOptions.requestOptions });
  }

  function register<T extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: T },
    handler: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>
  ): void {
    const callback = async (args: unknown, extra: { signal?: AbortSignal }): Promise<ToolResult> => {
      const operation = application.runRequest(() => withTelemetryRequestScope(async () => {
        const started = performance.now();
        try {
          const value = await handler(args as z.infer<z.ZodObject<T>>);
          recordToolInvocation({
            tool: name,
            args,
            value,
            elapsedMs: performance.now() - started,
            error: false
          });
          return jsonResult(value);
        } catch (error) {
          recordToolInvocation({
            tool: name,
            args,
            value: undefined,
            elapsedMs: performance.now() - started,
            error: true
          });
          throw error;
        }
      }));
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

const IDLE_WARMING_BEFORE =
  /Deadline exceeded before (?:java-index\.status|runtime\.request-context|runtime\.create)\b/;

/** S5: idle-close first query may still miss 15s; return a retryable plan, not isError. */
function idleWarmingPayload(error: unknown): { evidenceGaps: string[] } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!IDLE_WARMING_BEFORE.test(message)) return undefined;
  return {
    evidenceGaps: ["Index runtime is warming after idle close; retry the same request."]
  };
}

function rethrowUnlessIdleWarming(error: unknown): { evidenceGaps: string[] } {
  const payload = idleWarmingPayload(error);
  if (payload) return payload;
  throw error;
}
