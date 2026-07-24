// input: Lifecycle test scenarios (deferred initialize, spawn failure, child exit).
// output: A JdtlsTransportFactory that behaves deterministically without a JVM.
// pos: The single shared JDT fake; do not create per-test duplicates.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  JdtlsChild,
  JdtlsConnection,
  JdtlsSpawnInput,
  JdtlsTransportAttempt,
  JdtlsTransportFactory
} from "../jdtls-transport.js";

export type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: boolean;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  const state = { settled: false };
  return {
    promise,
    resolve(value) {
      if (state.settled) return;
      state.settled = true;
      resolve(value);
    },
    reject(error) {
      if (state.settled) return;
      state.settled = true;
      reject(error);
    },
    get settled() {
      return state.settled;
    }
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class FakeJdtlsChild implements JdtlsChild {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stderr = new PassThrough();
  killCalls = 0;
  killSignals: Array<NodeJS.Signals | undefined> = [];
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** When false, kill() records the call but the process never exits (hung child). */
  exitsOnKill = true;

  private readonly events = new EventEmitter();

  constructor(pid: number) {
    this.pid = pid;
    this.events.setMaxListeners(0);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls += 1;
    this.killSignals.push(signal);
    this.killed = true;
    if (this.exitsOnKill && this.exitCode === null && this.signalCode === null) {
      this.exit(null, signal ?? "SIGTERM");
    }
    return true;
  }

  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this {
    this.events.once(event, listener);
    return this;
  }

  /** Simulate the OS process terminating. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.events.emit("exit", code, signal);
    this.events.emit("close", code, signal);
  }
}

export class FakeJdtlsConnection implements JdtlsConnection {
  requests: string[] = [];
  notifications: string[] = [];
  responses = new Map<string, unknown>();
  /** Methods whose response resolves only when the test says so. */
  pending = new Map<string, Deferred<unknown>>();
  errors = new Map<string, unknown>();
  disposed = false;
  listening = false;

  private readonly requestHandlers = new Map<string, (...args: any[]) => unknown>();
  private readonly notificationHandlers = new Map<string, (...args: any[]) => void>();

  /** Per-call responses; takes precedence over the static `responses` map. */
  handlers = new Map<string, (params: unknown) => unknown>();

  async sendRequest<R>(method: string, params?: unknown): Promise<R> {
    this.requests.push(method);
    const failure = this.errors.get(method);
    if (failure !== undefined) {
      throw failure;
    }
    const waiting = this.pending.get(method);
    if (waiting) {
      return await waiting.promise as R;
    }
    const handler = this.handlers.get(method);
    if (handler) {
      return await Promise.resolve(handler(params) as R);
    }
    if (!this.responses.has(method)) {
      throw new Error(`No fake response for ${method}`);
    }
    return await Promise.resolve(this.responses.get(method) as R);
  }

  sendNotification(method: string): void {
    this.notifications.push(method);
  }

  onRequest(method: string, handler: (...args: any[]) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: (...args: any[]) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  onError(): void {}

  listen(): void {
    this.listening = true;
  }

  dispose(): void {
    this.disposed = true;
    // vscode-jsonrpc rejects in-flight requests when the connection is disposed;
    // the fake must do the same or startup waiters would hang forever.
    for (const waiting of this.pending.values()) {
      waiting.reject(new Error("The JSON-RPC connection was disposed"));
    }
  }

  count(method: string): number {
    return this.requests.filter(item => item === method).length;
  }

  /** Drive a server-to-client notification, e.g. textDocument/publishDiagnostics. */
  emitNotification(method: string, params: unknown): void {
    this.notificationHandlers.get(method)?.(params);
  }
}

export type FakeAttemptOptions = {
  /** Resolve/reject to control when `initialize` settles. */
  initialize?: Deferred<unknown>;
  initializeResult?: unknown;
  initializeError?: unknown;
  /** Extra canned responses keyed by LSP method. */
  responses?: Record<string, unknown>;
  /** Per-call response functions keyed by LSP method; win over `responses`. */
  handlers?: Record<string, (params: unknown) => unknown>;
  /** Errors keyed by LSP method. */
  errors?: Record<string, unknown>;
  /** Throw from spawn() itself, simulating a missing binary. */
  spawnError?: unknown;
};

export class FakeJdtlsTransportFactory implements JdtlsTransportFactory {
  spawnCalls = 0;
  spawnInputs: JdtlsSpawnInput[] = [];
  children: FakeJdtlsChild[] = [];
  connections: FakeJdtlsConnection[] = [];

  constructor(private readonly attempts: FakeAttemptOptions[]) {}

  spawn(input: JdtlsSpawnInput): JdtlsTransportAttempt {
    const options = this.attempts[Math.min(this.spawnCalls, this.attempts.length - 1)] ?? {};
    this.spawnCalls += 1;
    this.spawnInputs.push(input);
    if (options.spawnError) {
      throw options.spawnError;
    }
    const child = new FakeJdtlsChild(40000 + this.spawnCalls);
    const connection = new FakeJdtlsConnection();
    if (options.initialize) {
      connection.pending.set("initialize", options.initialize);
    } else if (options.initializeError) {
      connection.errors.set("initialize", options.initializeError);
    } else {
      connection.responses.set("initialize", options.initializeResult ?? { capabilities: {} });
    }
    connection.responses.set("shutdown", null);
    for (const [method, value] of Object.entries(options.responses ?? {})) {
      connection.responses.set(method, value);
    }
    for (const [method, value] of Object.entries(options.handlers ?? {})) {
      connection.handlers.set(method, value);
    }
    for (const [method, value] of Object.entries(options.errors ?? {})) {
      connection.errors.set(method, value);
    }
    this.children.push(child);
    this.connections.push(connection);
    return { child, connection };
  }
}

/** Every spawn behaves the same way. */
export function fakeTransportFactory(options: FakeAttemptOptions = {}): FakeJdtlsTransportFactory {
  return new FakeJdtlsTransportFactory([options]);
}

/** The nth spawn uses the nth entry; the last entry repeats. */
export function sequenceTransportFactory(attempts: FakeAttemptOptions[]): FakeJdtlsTransportFactory {
  return new FakeJdtlsTransportFactory(attempts);
}
