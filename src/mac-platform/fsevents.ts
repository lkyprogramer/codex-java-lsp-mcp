import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readMacNativeIdentity } from "./clonefile.js";
import { ownerCacheRoot, ownerChildStdio } from "./owner-lock.js";
import { MAC_NATIVE_PROTOCOL } from "./native-protocol.js";

export const FSEVENT_LINE_BYTES = 64 * 1024;
export type MacFsEvent = { volumeIdentity: string; epoch: string; seq: string; eventId: string; flags: number; path: string };
export type MacFsReady = { volumeIdentity: string; epoch: string; seq: string; pid: number; pgid: number; fd: 4; inode: string; power: "registered"; testHooks: boolean };
/** A raw system wake (IOKit kIOMessageSystemHasPoweredOn), or its test-hook replay; never inferred in Node. */
export type MacFsResume = { volumeIdentity: string; epoch: string; seq: string; source: "system-has-powered-on" | "test-hook" };
export type MacFsFence = { volumeIdentity: string; epoch: string; seq: string; requestId: string };
type Message = Record<string, unknown> & { epoch: string; seq: string; kind: string };
const uint64 = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 18446744073709551615n;

/** Strict decoding also provides the test seam. Injected messages are protocol
 * tests only; they do not establish that macOS generated a drop signal. */
export class FSEventDecoder {
  private buffered = Buffer.alloc(0);
  private epoch?: string;
  private volumeIdentity?: string;
  private seq = 0n;
  private stopped = false;
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  push(bytes: Buffer): Message[] {
    const messages: Message[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const part = bytes.subarray(offset, end < 0 ? bytes.length : end);
      if (this.buffered.length + part.length > FSEVENT_LINE_BYTES) throw new Error("FSEvents line exceeds byte limit");
      this.buffered = Buffer.concat([this.buffered, part]);
      if (end < 0) break;
      const row = JSON.parse(this.utf8.decode(this.buffered)) as Message;
      this.buffered = Buffer.alloc(0); offset = end + 1;
      if (!this.epoch && row && typeof row === "object" && row.kind === "startup-error") {
        if (row.protocol !== MAC_NATIVE_PROTOCOL || typeof row.code !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(row.code) ||
            !Number.isInteger(row.errno) || (row.errno as number) < 0 || (row.errno as number) > 0x7fffffff ||
            Object.keys(row).sort().join(",") !== "code,errno,kind,protocol" || this.stopped) throw new Error("invalid FSEvents startup error");
        this.stopped = true;
        throw new Error(`native FSEvents ${row.code} (errno ${row.errno})`);
      }
      if (!row || typeof row !== "object" || row.protocol !== MAC_NATIVE_PROTOCOL ||
          typeof row.epoch !== "string" || !/^[a-f0-9]{32}$/.test(row.epoch) || !uint64(row.seq) || BigInt(row.seq) !== this.seq + 1n || this.stopped) throw new Error("invalid FSEvents envelope/order");
      if (!this.epoch) {
        if (row.kind !== "ready") throw new Error("FSEvents ready required before events");
        this.epoch = row.epoch;
      } else if (row.epoch !== this.epoch || row.kind === "ready") throw new Error("FSEvents epoch changed within stream");
      if (row.kind === "ready") {
        if (!Number.isSafeInteger(row.pid) || (row.pid as number) <= 1 || !Number.isSafeInteger(row.pgid) || (row.pgid as number) <= 1 || row.fd !== 4 || !uint64(row.inode) || !uint64(row.volumeIdentity)) throw new Error("invalid FSEvents owner/volume metadata");
        if (row.power !== "registered" || typeof row.testHooks !== "boolean") throw new Error("invalid FSEvents power registration");
        this.volumeIdentity = row.volumeIdentity as string;
      } else if (row.kind === "event") {
        if (!uint64(row.eventId) || !Number.isInteger(row.flags) || (row.flags as number) < 0 || (row.flags as number) > 0xffffffff || typeof row.path !== "string" || row.path.includes("\0")) throw new Error("invalid FSEvents event");
      } else if (row.kind === "fence") {
        if (!uint64(row.requestId)) throw new Error("invalid FSEvents fence");
      } else if (row.kind === "resume") {
        if (row.source !== "system-has-powered-on" && row.source !== "test-hook") throw new Error("invalid FSEvents resume");
      } else if (row.kind === "stopped") this.stopped = true;
      else if (row.kind === "error") { if (typeof row.code !== "string") throw new Error("invalid FSEvents error"); }
      else throw new Error("unknown FSEvents message");
      // Root stat.dev identifies this stream volume; owner inode identifies a
      // separate lock file and must never be substituted for the root volume.
      row.volumeIdentity = this.volumeIdentity;
      this.seq = BigInt(row.seq); messages.push(row);
    }
    return messages;
  }
  finish(): void { if (this.buffered.length) throw new Error("truncated FSEvents line"); }
}

function timeoutBudget(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) throw new Error("FSEvents timeout must be 1..60000 ms");
  return value;
}

export class MacFSEvents {
  readonly ready: Promise<MacFsReady>;
  readonly closed: Promise<void>;
  private readonly decoder = new FSEventDecoder();
  private readonly pending = new Map<string, { resolve: (row: MacFsFence) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readyResolve!: (row: MacFsReady) => void;
  private readyReject!: (error: Error) => void;
  private closeResolve!: () => void;
  private closeReject!: (error: Error) => void;
  private readonly readyTimer: NodeJS.Timeout;
  private failure?: Error;
  private closing = false;
  private stopped = false;
  private exited = false;
  private nextRequest = 0n;
  private stderrBytes = 0;
  private constructor(private readonly child: ChildProcessWithoutNullStreams, onEvent: (event: MacFsEvent) => void, onResume: (resume: MacFsResume) => void) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.closed = new Promise((resolve, reject) => { this.closeResolve = resolve; this.closeReject = reject; });
    // Failure remains observable through ready/fence/stop/closed, without an
    // unhandled rejection when a caller is still awaiting another operation.
    void this.closed.catch(() => {}); void this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.fail(new Error("FSEvents ready timeout")), 5000);
    child.stdout.on("data", (bytes: Buffer) => {
      if (this.failure) return;
      try {
        for (const row of this.decoder.push(bytes)) {
          if (row.kind === "ready") { clearTimeout(this.readyTimer); this.readyResolve(row as unknown as MacFsReady); }
          else if (row.kind === "event") onEvent(row as unknown as MacFsEvent);
          else if (row.kind === "resume") onResume(row as unknown as MacFsResume);
          else if (row.kind === "fence") {
            const pending = this.pending.get(row.requestId as string);
            if (!pending) throw new Error("unsolicited FSEvents fence");
            clearTimeout(pending.timer); this.pending.delete(row.requestId as string); pending.resolve(row as unknown as MacFsFence);
          } else if (row.kind === "error") throw new Error(`native FSEvents ${row.code} (errno ${row.errno ?? 0})`);
          else if (row.kind === "stopped") { if (!this.closing) throw new Error("unexpected FSEvents stop"); this.stopped = true; }
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on("data", (bytes: Buffer) => { this.stderrBytes += bytes.length; if (this.stderrBytes > FSEVENT_LINE_BYTES) this.fail(new Error("FSEvents stderr exceeds byte limit")); });
    child.on("error", error => this.fail(error));
    child.stdin.on("error", error => this.fail(error));
    child.on("close", (code, signal) => {
      this.exited = true; clearTimeout(this.readyTimer);
      try { this.decoder.finish(); } catch (error) { this.failure ??= error as Error; }
      if (!this.failure && (!this.closing || !this.stopped || code !== 0 || signal !== null || this.pending.size)) this.failure = new Error("FSEvents exited without complete stop");
      const error = this.failure ?? new Error("FSEvents closed");
      this.readyReject(error);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      if (this.failure) this.closeReject(this.failure); else this.closeResolve();
    });
  }
  private fail(error: Error): void { this.failure ??= error; if (!this.exited) this.child.kill("SIGKILL"); }
  static async start(root: string, onEvent: (event: MacFsEvent) => void, onResume: (resume: MacFsResume) => void = () => {}): Promise<MacFSEvents> {
    const cache = ownerCacheRoot();
    if (!cache) throw new Error("FSEvents requires an owner binding");
    if (!root.startsWith("/") || await realpath(root) !== root) throw new Error("canonical FSEvents root required");
    await readMacNativeIdentity();
    const binary = fileURLToPath(new URL("../native/ilv2-mac", import.meta.url));
    const child = spawn(binary, ["watch", cache, root], { stdio: ownerChildStdio(["pipe", "pipe", "pipe"]), env: process.env });
    return new MacFSEvents(child as ChildProcessWithoutNullStreams, onEvent, onResume);
  }
  /** Covers the flushed prefix only. Events may arrive after this acknowledgement. */
  async fence(timeoutMs: number): Promise<MacFsFence> {
    timeoutBudget(timeoutMs);
    // One timer covers startup and acknowledgement; readiness cannot reset it.
    const timer = setTimeout(() => this.fail(new Error("FSEvents fence timeout")), timeoutMs);
    try {
      await this.ready;
      if (this.failure || this.closing || this.exited) throw this.failure ?? new Error("FSEvents is closing");
      if (this.pending.size >= 64) throw new Error("FSEvents fence queue full");
      const requestId = (++this.nextRequest).toString();
      return await new Promise<MacFsFence>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject, timer }); this.child.stdin.write(`fence ${requestId}\n`);
      });
    } finally { clearTimeout(timer); }
  }

  async stop(timeoutMs: number): Promise<void> {
    timeoutBudget(timeoutMs);
    if (this.exited) return this.closed;
    if (!this.closing) { this.closing = true; if (!this.failure) this.child.stdin.end("stop\n"); }
    const timer = setTimeout(() => this.fail(new Error("FSEvents stop timeout")), timeoutMs);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}
