// input: Loopback HTTP requests, daemon configuration, and process shutdown signals.
// output: Stateless Streamable HTTP MCP service backed by one shared JavaLspApplication.
// pos: Production HTTP daemon entrypoint; never changes Codex MCP registration itself.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type ErrorRequestHandler, type RequestHandler, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JavaLspApplication } from "./application.js";
import { readRuntimeBuild } from "./build-info.js";
import { HttpServerLifecycle, type HttpServerLifecycleSnapshot } from "./http-server-lifecycle.js";
import { createMcpServer } from "./mcp-server-factory.js";

export const HTTP_LOOPBACK_HOST = "127.0.0.1";
export const HTTP_BODY_LIMIT_BYTES = 100 * 1024;
export const DEFAULT_HTTP_SHUTDOWN_GRACE_MS = 30_000;

type ProtocolFactory = (application: JavaLspApplication) => McpServer;

export type JavaLspHttpServerOptions = {
  application?: JavaLspApplication;
  port?: number;
  instanceId?: string;
  allowedOrigins?: readonly string[];
  shutdownGraceMs?: number;
  protocolFactory?: ProtocolFactory;
  reportError?: (message: string, error?: unknown) => void;
};

export type JavaLspHttpServerAddress = {
  host: typeof HTTP_LOOPBACK_HOST;
  port: number;
  url: string;
};

type ActiveProtocol = {
  protocol: McpServer;
  transport: StreamableHTTPServerTransport;
};

type DaemonSignalSource = Pick<NodeJS.Process, "on" | "off">;

export type DaemonSignalHandlingOptions = {
  signalSource?: DaemonSignalSource;
  exit?: (code: number) => void;
  shutdownGraceMs?: number;
  reportError?: (message: string, error?: unknown) => void;
};

export class JavaLspHttpServer {
  readonly application: JavaLspApplication;

  private readonly configuredPort: number;
  private readonly instanceId?: string;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly shutdownGraceMs: number;
  private readonly protocolFactory: ProtocolFactory;
  private readonly reportError: (message: string, error?: unknown) => void;
  private readonly lifecycle = new HttpServerLifecycle();
  private readonly activeProtocols = new Set<ActiveProtocol>();
  private nodeServer?: Server;
  private startPromise?: Promise<JavaLspHttpServerAddress>;
  private shutdownPromise?: Promise<void>;

  constructor(options: JavaLspHttpServerOptions = {}) {
    this.configuredPort = normalizePort(options.port ?? httpPortFromEnvironment(), options.port !== undefined);
    this.instanceId = normalizeInstanceId(options.instanceId ?? httpInstanceIdFromEnvironment());
    this.allowedOrigins = new Set((options.allowedOrigins ?? httpAllowedOriginsFromEnvironment()).map(normalizeLocalOrigin));
    this.shutdownGraceMs = normalizeDeadline(options.shutdownGraceMs ?? DEFAULT_HTTP_SHUTDOWN_GRACE_MS);
    this.application = options.application ?? new JavaLspApplication({
      transportMode: "streamable_http",
      resolverOptions: { cwdFallback: "reject" }
    });
    if (this.application.transportMode !== "streamable_http") {
      throw new Error("HTTP daemon requires a streamable_http JavaLspApplication.");
    }
    this.protocolFactory = options.protocolFactory
      ?? (application => createMcpServer(application, { transportMode: "streamable_http" }));
    this.reportError = options.reportError ?? ((message, error) => console.error(message, error ?? ""));
  }

  state(): HttpServerLifecycleSnapshot {
    return this.lifecycle.snapshot();
  }

  start(): Promise<JavaLspHttpServerAddress> {
    if (this.shutdownPromise) {
      return Promise.reject(new Error("HTTP daemon is shutting down."));
    }
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
    }
    return this.startPromise;
  }

  shutdown(deadlineMs = this.shutdownGraceMs): Promise<void> {
    if (!this.shutdownPromise) {
      const normalizedDeadline = normalizeDeadline(deadlineMs);
      this.shutdownPromise = (async () => {
        if (this.startPromise) {
          await this.startPromise.catch(() => undefined);
        }
        await this.shutdownInternal(normalizedDeadline);
      })();
    }
    return this.shutdownPromise;
  }

  drain(deadlineMs = this.shutdownGraceMs): Promise<void> {
    return this.lifecycle.drain(normalizeDeadline(deadlineMs));
  }

  private async startInternal(): Promise<JavaLspHttpServerAddress> {
    await this.application.initialize();
    const app = this.createExpressApp();
    try {
      this.nodeServer = await listen(app, this.configuredPort);
      this.lifecycle.markReady();
      const address = this.nodeServer.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP daemon did not receive a TCP address.");
      }
      const port = (address as AddressInfo).port;
      return { host: HTTP_LOOPBACK_HOST, port, url: `http://${HTTP_LOOPBACK_HOST}:${port}/mcp` };
    } catch (error) {
      await this.application.close({ releaseOwnership: true }).catch(closeError => {
        this.reportError("[codex-java-lsp] failed to close application after HTTP startup failure", closeError);
      });
      throw error;
    }
  }

  private createExpressApp(): express.Express {
    const outer = express();
    outer.enable("strict routing");
    outer.enable("case sensitive routing");
    outer.disable("x-powered-by");
    outer.use(closeConnectionMiddleware);
    outer.use(hostHeaderValidation(["127.0.0.1", "localhost", "[::1]"]));
    outer.use(originValidation(this.allowedOrigins));
    outer.use(contentLengthValidation);
    outer.use(express.json({ limit: HTTP_BODY_LIMIT_BYTES, strict: true }));
    outer.use(exactRouteValidation);

    outer.post("/mcp", (request, response) => {
      void this.handleMcpPost(request, response);
    });
    outer.all("/mcp", (_request, response) => methodNotAllowed(response));
    outer.get("/healthz", (_request, response) => this.health(response, false));
    outer.get("/readyz", (_request, response) => this.health(response, true));
    outer.use((_request, response) => jsonRpcError(response, 404, -32004, "Not found."));
    outer.use(httpErrorHandler(this.reportError));
    return outer;
  }

  private async handleMcpPost(request: express.Request, response: express.Response): Promise<void> {
    const leaveRequest = this.lifecycle.enterRequest();
    if (!leaveRequest) {
      jsonRpcError(response, 503, -32001, "codex-java-lsp daemon is draining.");
      return;
    }

    let active: ActiveProtocol | undefined;
    try {
      const protocol = this.protocolFactory(this.application);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      active = { protocol, transport };
      this.activeProtocols.add(active);
      await protocol.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      this.reportError("[codex-java-lsp] HTTP MCP request failed", error);
      if (!response.headersSent) {
        jsonRpcError(response, 500, -32603, "Internal server error.");
      }
    } finally {
      if (active) {
        this.activeProtocols.delete(active);
        await active.protocol.close().catch(error => {
          this.reportError("[codex-java-lsp] HTTP protocol close failed", error);
        });
      }
      leaveRequest();
    }
  }

  private health(response: Response, readiness: boolean): void {
    const snapshot = this.lifecycle.snapshot();
    const ready = snapshot.state === "ready" && this.application.state().state === "ready";
    const healthy = snapshot.state !== "closed" && this.application.state().state !== "closed";
    const ok = readiness ? ready : healthy;
    const build = readRuntimeBuild();
    response.status(ok ? 200 : 503).json({
      status: ok ? "ok" : readiness ? "not_ready" : "unhealthy",
      state: snapshot.state,
      activeRequests: snapshot.activeRequests,
      uptimeMs: snapshot.uptimeMs,
      buildSha: build.gitSha,
      ...(this.instanceId ? { instanceId: this.instanceId } : {})
    });
  }

  private async shutdownInternal(deadlineMs: number): Promise<void> {
    const server = this.nodeServer;
    if (!server) {
      this.lifecycle.close();
      await this.application.close({ releaseOwnership: true });
      return;
    }

    const drain = this.lifecycle.drain(deadlineMs);
    const serverClosed = closeServer(server);
    server.closeIdleConnections?.();
    let forced = false;
    try {
      await drain;
    } catch (error) {
      forced = true;
      this.reportError("[codex-java-lsp] HTTP drain deadline exceeded; aborting request transports", error);
      server.closeAllConnections?.();
      await Promise.allSettled([...this.activeProtocols].map(active => active.protocol.close()));
    }

    let applicationFailure: unknown;
    try {
      if (forced) {
        await this.application.forceClose(Math.min(1000, deadlineMs));
      } else {
        await this.application.shutdown(deadlineMs);
      }
    } catch (error) {
      applicationFailure = error;
    }

    if (forced) server.closeAllConnections?.();
    await serverClosed.catch(error => {
      this.reportError("[codex-java-lsp] HTTP listener close failed", error);
    });
    this.lifecycle.close();
    this.nodeServer = undefined;
    if (applicationFailure !== undefined) throw applicationFailure;
  }
}

function closeConnectionMiddleware(_request: express.Request, response: express.Response, next: express.NextFunction): void {
  response.setHeader("Connection", "close");
  next();
}

function originValidation(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (!origin || allowedOrigins.has(origin)) {
      next();
      return;
    }
    jsonRpcError(response, 403, -32000, "Origin is not allowed.");
  };
}

const contentLengthValidation: RequestHandler = (request, response, next) => {
  const value = request.get("content-length");
  if (value !== undefined) {
    const length = Number(value);
    if (!Number.isSafeInteger(length) || length < 0 || length > HTTP_BODY_LIMIT_BYTES) {
      jsonRpcError(response, 413, -32000, "Request body is too large.");
      return;
    }
  }
  next();
};

const exactRouteValidation: RequestHandler = (request, response, next) => {
  if (["/mcp", "/healthz", "/readyz"].includes(request.path) && request.originalUrl !== request.path) {
    jsonRpcError(response, 404, -32004, "Not found.");
    return;
  }
  next();
};

function methodNotAllowed(response: Response): void {
  response.setHeader("Allow", "POST");
  jsonRpcError(response, 405, -32000, "Method not allowed.");
}

function jsonRpcError(response: Response, status: number, code: number, message: string): void {
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function httpErrorHandler(reportError: (message: string, error?: unknown) => void): ErrorRequestHandler {
  return (error, _request, response, _next) => {
    const status = (error as { status?: unknown; type?: unknown }).status;
    if (status === 413 || (error as { type?: unknown }).type === "entity.too.large") {
      jsonRpcError(response, 413, -32000, "Request body is too large.");
      return;
    }
    reportError("[codex-java-lsp] rejected malformed HTTP request", error);
    jsonRpcError(response, 400, -32700, "Invalid JSON request body.");
  };
}

function normalizeLocalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid JAVA_LSP_HTTP_ALLOWED_ORIGINS entry: ${value}`);
  }
  if (parsed.origin !== value
    || parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`HTTP Origin allowlist entries must be exact loopback origins: ${value}`);
  }
  return parsed.origin;
}

function httpAllowedOriginsFromEnvironment(): string[] {
  const raw = process.env.JAVA_LSP_HTTP_ALLOWED_ORIGINS;
  return raw ? raw.split(",").map(value => value.trim()).filter(Boolean) : [];
}

function httpPortFromEnvironment(): number {
  const raw = process.env.JAVA_LSP_HTTP_PORT;
  if (!raw) {
    throw new Error("JAVA_LSP_HTTP_PORT is required for the HTTP daemon.");
  }
  return Number(raw);
}

function normalizePort(value: number, allowEphemeral: boolean): number {
  if (!Number.isInteger(value) || value < (allowEphemeral ? 0 : 1) || value > 65_535) {
    throw new Error(`Invalid HTTP daemon port: ${value}`);
  }
  return value;
}

function httpInstanceIdFromEnvironment(): string | undefined {
  return process.env.JAVA_LSP_HTTP_INSTANCE_ID;
}

function normalizeInstanceId(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error("JAVA_LSP_HTTP_INSTANCE_ID must use up to 160 letters, numbers, dot, underscore, colon, or hyphen.");
  }
  return value;
}

function normalizeDeadline(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new Error(`Invalid HTTP shutdown deadline: ${value}`);
  }
  return Math.floor(value);
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HTTP_LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function main(): Promise<void> {
  const daemon = new JavaLspHttpServer();
  const address = await daemon.start();
  console.error(`[codex-java-lsp] HTTP daemon ready at ${address.url}`);

  installDaemonSignalHandling(daemon);
}

/**
 * Keeps signal handling at the process boundary. A failed bounded shutdown must
 * still terminate this Node owner: retaining its lease until process exit is
 * safer than leaving a failed launchd service resident forever.
 */
export function installDaemonSignalHandling(
  daemon: Pick<JavaLspHttpServer, "shutdown">,
  options: DaemonSignalHandlingOptions = {}
): () => void {
  const signalSource = options.signalSource ?? process;
  const exit = options.exit ?? process.exit;
  const shutdownGraceMs = normalizeDeadline(options.shutdownGraceMs ?? DEFAULT_HTTP_SHUTDOWN_GRACE_MS);
  const reportError = options.reportError ?? ((message: string, error?: unknown) => console.error(message, error ?? ""));
  let stopping = false;
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    console.error(`[codex-java-lsp] HTTP daemon shutting down (${signal})`);
    const failSafe = setTimeout(() => {
      console.error("[codex-java-lsp] HTTP daemon forced exit after shutdown deadline");
      exit(1);
    }, shutdownGraceMs + 1_000);
    failSafe.unref?.();
    void daemon.shutdown(shutdownGraceMs).then(() => {
      clearTimeout(failSafe);
      // Requests may have ignored protocol cancellation and still hold Node handles.
      // The daemon has already completed its bounded JDT shutdown, so exit now to
      // release the cross-process lease and let launchd perform a clean restart.
      exit(0);
    }, error => {
      reportError("[codex-java-lsp] HTTP daemon shutdown failed", error);
      process.exitCode = 1;
      // Keep the hard-exit timer armed: an uncertain JDT child or non-cooperative request
      // must not leave a failed daemon resident forever and prevent launchd recovery.
    });
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);
  return () => {
    signalSource.off("SIGINT", onSigint);
    signalSource.off("SIGTERM", onSigterm);
  };
}

// `current` is a release symlink in the managed runtime. Node resolves the imported module
// to its release path while process.argv[1] retains the stable symlink path, so URL equality
// would make a launchd-started daemon silently exit 0.
if (process.argv[1]?.endsWith("/http-server.js")) {
  main().catch(error => {
    console.error("[codex-java-lsp] HTTP daemon startup failed", error);
    process.exitCode = 1;
  });
}
