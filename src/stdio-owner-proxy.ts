// input: MCP JSON-RPC messages on stdio and the owner daemon's loopback endpoint.
// output: the same messages relayed to the owner's Streamable HTTP /mcp; its replies on stdout.
// pos: D05 stdio entry (contract §1): stdio only forwards. It never builds a runtime, an index,
//      a scheduler or a JDT session; with no reachable owner every request fails explicitly.
import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { repoCacheBase } from "./repo-layout.js";

/** Where the owner daemon advertises its MCP endpoint (beside the cache it owns). */
export function ownerEndpointFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(repoCacheBase(env), "owner-endpoint.json");
}

export type OwnerEndpointRecord = { url: string; pid: number; startedAt: string };

/** Daemon side: publish the endpoint after listen (atomic rename) and return its remover. */
export async function advertiseOwnerEndpoint(url: string, env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const file = ownerEndpointFile(env);
  const record: OwnerEndpointRecord = { url, pid: process.pid, startedAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return async () => {
    // Only our own record is removed: a successor may already have advertised itself.
    if (readEndpointRecord(file)?.pid === process.pid) await rm(file, { force: true });
  };
}

function readEndpointRecord(file: string): OwnerEndpointRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<OwnerEndpointRecord>;
    return typeof value.url === "string" && typeof value.pid === "number" ? value as OwnerEndpointRecord : undefined;
  } catch {
    return undefined;
  }
}

/** JAVA_LSP_OWNER_ENDPOINT wins; otherwise the advertised record, re-read per request so a restarted owner is found. */
export function resolveOwnerEndpoint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.JAVA_LSP_OWNER_ENDPOINT?.trim();
  const url = explicit || readEndpointRecord(ownerEndpointFile(env))?.url;
  if (!url) return undefined;
  const parsed = new URL(url);
  // Loopback only: the relay never sends a request off this machine.
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`owner endpoint must be a loopback http URL: ${url}`);
  }
  return parsed.href;
}

type Sink = (message: JSONRPCMessage) => Promise<void> | void;
type RelayOptions = {
  send: Sink;
  endpoint?: () => string | undefined;
  /** The stdio client's working directory: selectors without a root are resolved against it here. */
  cwd?: string;
  fetchImpl?: typeof fetch;
  /** Upper bound for one relayed call; the owner bounds its own requests well below this. */
  maxRequestMs?: number;
};

const DEFAULT_MAX_REQUEST_MS = 120_000;
const SELECTOR_FREE_STATUS = new Set(["java_status"]);

/**
 * stdio's local context becomes explicit selectors: the daemon rejects cwd fallback and relative
 * paths, so files are made absolute against the client's cwd, and a call without any root or file
 * gets repoRoot=cwd. Server-wide calls (status without a selector, runtime shutdown all) are kept.
 */
export function withLocalSelector(message: JSONRPCMessage, cwd: string): JSONRPCMessage {
  if (!("method" in message) || message.method !== "tools/call" || !("id" in message)) return message;
  const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const args = { ...(params.arguments ?? {}) };
  const absolute = (file: unknown) => typeof file === "string" && !path.isAbsolute(file) ? path.resolve(cwd, file) : file;
  if (args.file !== undefined) args.file = absolute(args.file);
  if (Array.isArray(args.files)) args.files = args.files.map(absolute);
  if (Array.isArray(args.anchors)) {
    args.anchors = args.anchors.map(anchor => anchor && typeof anchor === "object" ? { ...anchor, file: absolute((anchor as { file?: unknown }).file) } : anchor);
  }
  if (typeof args.repoRoot === "string" && !path.isAbsolute(args.repoRoot)) args.repoRoot = path.resolve(cwd, args.repoRoot);
  const hasRoot = args.repoRoot !== undefined || args.projectId !== undefined;
  const hasFile = args.file !== undefined || (Array.isArray(args.files) && args.files.length > 0) || (Array.isArray(args.anchors) && args.anchors.length > 0);
  const serverWide = (SELECTOR_FREE_STATUS.has(params.name ?? "") && args.start !== true)
    || (params.name === "java_runtime" && args.all === true);
  if (!hasRoot && !hasFile && !serverWide) args.repoRoot = cwd;
  return { ...message, params: { ...params, arguments: args } } as JSONRPCMessage;
}

/** One relay per stdio connection. Each request is its own POST; a cancel aborts that POST. */
export class OwnerRelay {
  private readonly inFlight = new Map<string | number, AbortController>();
  private protocolVersion?: string;
  private lastUrl?: string;
  private closed = false;

  constructor(private readonly options: RelayOptions) {}

  async handle(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    if ("method" in message && message.method === "notifications/cancelled") {
      const requestId = (message.params as { requestId?: string | number } | undefined)?.requestId;
      if (requestId !== undefined) this.inFlight.get(requestId)?.abort();
      return;
    }
    const isRequest = "method" in message && "id" in message;
    // Replies to server-initiated requests have nowhere to go: the owner answers in JSON response mode.
    if (!("method" in message)) return;
    const outgoing = this.options.cwd ? withLocalSelector(message, this.options.cwd) : message;
    const controller = new AbortController();
    const id = isRequest ? (message as { id: string | number }).id : undefined;
    if (id !== undefined) this.inFlight.set(id, controller);
    const maxRequestMs = this.options.maxRequestMs ?? DEFAULT_MAX_REQUEST_MS;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, maxRequestMs);
    try {
      const replies = await this.post(outgoing, controller.signal);
      for (const reply of replies) {
        if (id !== undefined && "result" in reply && message.method === "initialize") {
          const version = (reply.result as { protocolVersion?: unknown }).protocolVersion;
          if (typeof version === "string") this.protocolVersion = version;
        }
        await this.options.send(id !== undefined && "error" in reply && (reply as { id?: unknown }).id === null ? { ...reply, id } as JSONRPCMessage : reply);
      }
    } catch (error) {
      if (id === undefined || this.closed) return;
      // A relay timeout is not the client's cancel: the two are reported apart.
      const reason = timedOut ? `no reply within ${maxRequestMs} ms` : controller.signal.aborted ? "request cancelled" : describe(error);
      const at = this.lastUrl ? ` at ${this.lastUrl}` : "";
      await this.options.send({ jsonrpc: "2.0", id, error: { code: -32000, message: `codex-java-lsp owner unavailable${at}: ${reason}` } });
    } finally {
      clearTimeout(timer);
      if (id !== undefined && this.inFlight.get(id) === controller) this.inFlight.delete(id);
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  private async post(message: JSONRPCMessage, signal: AbortSignal): Promise<JSONRPCMessage[]> {
    const url = (this.options.endpoint ?? resolveOwnerEndpoint)();
    this.lastUrl = url;
    if (!url) throw new Error(`no owner endpoint (set JAVA_LSP_OWNER_ENDPOINT or start the daemon that writes ${ownerEndpointFile()})`);
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {})
      },
      body: JSON.stringify(message)
    });
    const text = await response.text();
    if (response.status === 202 || text.trim() === "") {
      if (!response.ok) throw new Error(`owner HTTP ${response.status}`);
      return [];
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`owner HTTP ${response.status}: non-JSON reply`); }
    const replies = (Array.isArray(body) ? body : [body]) as JSONRPCMessage[];
    if (!response.ok && !replies.every(reply => reply && typeof reply === "object" && "error" in reply)) throw new Error(`owner HTTP ${response.status}`);
    return replies;
  }
}

/** fetch reports "fetch failed" and hides the socket error in `cause`; both are shown. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  return cause ? `${error.message} (${cause.code ?? cause.message ?? String(cause)})` : error.message;
}
