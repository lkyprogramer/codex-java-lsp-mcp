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
import { javaStatus, javaStatusFromMemory, statusSchema, summarizeResourceStatus } from "./tools/status.js";
import { javaSymbol, STATIC_QUERY_LIMIT_DESCRIPTION, symbolNeedsJdt, symbolSchema } from "./tools/symbol.js";
import { logToolFailure } from "./log.js";
import { noteTelemetryRepoHash, recordToolInvocation, withTelemetryRequestScope } from "./telemetry/impact-telemetry.js";

export type McpTransportMode = "stdio" | "streamable_http";

/** Public MCP tool surface. java_impact is the current compact chain. The legacy java_context handler was removed in M3 T12 (single main line). */
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
  }, (args, signal) => javaStatusFor(args, signal));

  register(track("java_impact"), {
    title: "Java Impact",
    description: JAVA_IMPACT_TOOL_DESCRIPTION,
    inputSchema: impactSchema
  }, (args, signal) => withContext(args, (context, request) => javaImpact(context, args, request), {
    observeStaticRead: true,
    mayStartLsp: args.semanticPolicy !== "fast",
    requireLspEnabled: args.semanticPolicy === "required",
    requestOptions: {
      mode: args.mode,
      semanticPolicy: args.semanticPolicy,
      deadlineMs: args.deadlineMs
    },
    signal
  }));

  register(track("java_symbol"), {
    title: "Java Symbol",
    description: "operation=query (default): static discovery over the on-disk index (no JDT); pass backend=jdt for legacy workspace symbols. Static query: " + STATIC_QUERY_LIMIT_DESCRIPTION + ", terms add words to the query, searchMode=exact never falls back to fuzzy search (exact=miss|ambiguous). Matching is lexical over code identifiers, comments and framework keys: write the query with likely code identifiers (usually English); a query sharing no word with the code returns emptyReason=no_vocabulary_overlap. preview=head (default: short declaration heads, small per-request cap) | window (12-line windows) | none; read the code for evidence. Static results name each declaration by symbolId (pass it back as symbolId instead of file/line/column, or as java_impact symbol) and carry indexView (workspaceId; state = index freshness); with scopeState PARTIAL or NOT_READY a miss is not proof of absence. operation=evidence (explicit): hash-verified source units for a located Java type/method (file/line/column or symbolId): its declaration (whole method, or head plus a window around the line when large) and linked MyBatis XML, max 8 units/80 lines/16000 bytes; complete describes a source unit, not task coverage; no JDT. operation=outline: file (+ optional nearLine, limit 1..20 default 8) returns that file's type/constructor/method/field declarations with symbolId, line range and a compact signature, nearest to nearLine first, in source order; no JDT. operation=position (default with file/line/column): hover/definition/implementation at a position. operation=references: summary-only references. position/references and query with backend=jdt use live JDT.",
    inputSchema: symbolSchema
  }, (args, signal) => withContext(args, (context, request) => javaSymbol(context, args, request), {
    observeStaticRead: true,
    // T06: the JDT admission predicate is computed per request and must match
    // the handler's own route, or a static query would be rejected by the
    // outer policy (or worse, start JDT the handler never uses).
    mayStartLsp: symbolNeedsJdt(args),
    requireLspEnabled: symbolNeedsJdt(args),
    requestOptions: {
      mode: "balanced",
      semanticPolicy: symbolNeedsJdt(args) ? "required" : "auto",
      deadlineMs: symbolNeedsJdt(args) ? args.semanticTimeoutMs : 15000
    },
    signal
  }));

  register(track("java_diagnostics"), {
    title: "Java Diagnostics",
    description: "Open Java files and return JDT LS diagnostics after a short wait.",
    inputSchema: diagnosticsSchema
  }, (args, signal) => withContext(args, (context, request) => javaDiagnostics(context, args, request), {
    mayStartLsp: true,
    requireLspEnabled: true,
    requestOptions: {
      mode: "balanced",
      semanticPolicy: "required",
      deadlineMs: Math.min(15000, Math.max(10000, args.waitMs + 5000))
    },
    signal
  }));

  register(track("java_runtime"), {
    title: "Java Runtime",
    description: "action=restart: restart JDT LS (clearCache=true also clears cache). action=shutdown: stop JDT LS (all=true stops every active repo).",
    inputSchema: runtimeSchema
  }, (args, signal) => runtimeFor(args, signal));

  if (registered.join("\0") !== PUBLIC_JAVA_TOOLS.join("\0")) {
    throw new Error(`MCP registration drifted from PUBLIC_JAVA_TOOLS: ${registered.join(",")}`);
  }
  return server;

  async function javaStatusFor(args: z.infer<z.ZodObject<typeof statusSchema>>, signal?: AbortSignal): Promise<unknown> {
    const hasSelector = Boolean(args.projectId || args.repoRoot || args.file);
    if (!hasSelector && !args.start) {
      if (transportMode === "streamable_http") {
        return daemonStatus(application, await application.runtimes.indexStatus());
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
    const resource = application.runtimes.resourceStatus();
    const resourceView = isDiagnosticDetail(args.detail) ? resource : summarizeResourceStatus(resource);
    if (!args.start) {
      // Contract §2.6: status without start reads memory only. It creates no runtime entry, starts no
      // workspace tracker, scans nothing and starts neither JDT nor a build.
      return application.runtimes.statusOnly(args, async state => ({ ...javaStatusFromMemory(state, args), resource: resourceView,
        ...semanticAdmission(application) }), { signal });
    }
    return withContext(args, async (context, request) => ({
      ...await javaStatus(context, args, request),
      resource: resourceView,
      ...semanticAdmission(application)
    }), {
      mayStartLsp: true,
      requestOptions: {
        mode: "balanced",
        semanticPolicy: "required",
        deadlineMs: 15000
      },
      signal
    });
  }

  async function runtimeFor(args: z.infer<z.ZodObject<typeof runtimeSchema>>, signal?: AbortSignal): Promise<unknown> {
    if (args.action === "shutdown" && args.all) {
      if (transportMode === "streamable_http") {
        throw new Error("java_runtime(all=true) is not available on the shared daemon; select one worktree.");
      }
      const activeRepos = application.runtimes.activeRepos();
      await application.runtimes.shutdownAll();
      return { stoppedRepos: activeRepos };
    }
    return withContext(args, context => javaRuntime(context, args), {
      control: true,
      mayStartLsp: args.action === "restart",
      requireLspEnabled: args.action === "restart",
      signal
    });
  }

  async function withContext<T>(
    args: RepoSelector,
    handler: (context: ManagedToolContext, request: RequestContext) => Promise<T>,
    contextOptions: {
      mayStartLsp?: boolean;
      requireLspEnabled?: boolean;
      control?: boolean;
      observeStaticRead?: boolean;
      requestOptions?: RequestOptionsInput;
      signal?: AbortSignal;
    } = {}
  ): Promise<T> {
    const route = contextOptions.control ? "withControl" : contextOptions.mayStartLsp ? "withQuery" : "withContext";
    return application.runtimes[route](args, async (context, request) => {
      noteTelemetryRepoHash(context.repoHash);
      if (contextOptions.requireLspEnabled && !context.lsp.enabled) {
        throw new Error(context.lsp.enableHint || "This repo is not LSP-enabled.");
      }
      return handler(context, request);
    }, { mayStartLsp: contextOptions.mayStartLsp, observeStaticRead: contextOptions.observeStaticRead,
      requestOptions: contextOptions.requestOptions, signal: contextOptions.signal });
  }

  function register<T extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: T },
    handler: (args: z.infer<z.ZodObject<T>>, signal?: AbortSignal) => Promise<unknown>
  ): void {
    const callback = async (args: unknown, extra: { signal?: AbortSignal }): Promise<ToolResult> => {
      const operation = application.runRequest(() => withTelemetryRequestScope(async () => {
        const started = performance.now();
        try {
          // The signal reaches the request view: cancelling stops its waits and kills its query worker.
          const value = await handler(args as z.infer<z.ZodObject<T>>, extra.signal);
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
            error: true,
            failure: error
          });
          logToolFailure(name, error);
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

/** Static/semantic admission (contract §2.1), kept apart from index freshness and coverage. */
function semanticAdmission(application: JavaLspApplication): { semantic?: ReturnType<JavaLspApplication["runtimes"]["semanticStatus"]> } {
  const semantic = application.runtimes.semanticStatus?.();
  return semantic ? { semantic } : {};
}

function daemonStatus(application: JavaLspApplication, index: Awaited<ReturnType<JavaLspApplication["runtimes"]["indexStatus"]>>): Record<string, unknown> {
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
    },
    ...semanticAdmission(application),
    index: index && ("unavailable" in index ? index : {
      workspaces: index.workspaces.map(workspace => ({ canonicalRoot: workspace.canonicalRoot, view: workspace.view, snapshotId: workspace.snapshotId,
        rounds: workspace.rounds, roundInFlight: workspace.roundInFlight })),
      builders: index.scheduler.builders,
      queued: index.scheduler.queued,
      queryWorkers: index.pool.workers,
      queryCounters: index.poolCounters
    })
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
