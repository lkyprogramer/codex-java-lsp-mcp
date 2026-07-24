// input: A resolved jdtls binary, launch args, cwd and environment.
// output: A spawned child plus its JSON-RPC connection, as one replaceable unit.
// pos: The only place JdtlsSession touches node:child_process or vscode-jsonrpc,
//      so lifecycle tests can inject failures without spawning a real JVM.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
  type MessageConnection
} from "vscode-jsonrpc/node.js";

export interface JdtlsConnection {
  sendRequest<R>(method: string, params?: unknown, token?: CancellationToken): Promise<R>;
  sendNotification(method: string, params?: unknown): void;
  // `any` stops here: JSON-RPC payloads are untyped on the wire and every caller
  // narrows them immediately. It must not leak into domain types.
  onRequest(method: string, handler: (...args: any[]) => unknown): void;
  onNotification(method: string, handler: (...args: any[]) => void): void;
  onError(handler: (error: unknown) => void): void;
  listen(): void;
  dispose(): void;
}

export interface JdtlsChild {
  readonly pid?: number;
  readonly killed: boolean; // diagnostic only; never use as proof that the OS process exited
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
}

export type JdtlsTransportAttempt = {
  child: JdtlsChild;
  connection: JdtlsConnection;
};

export type JdtlsSpawnInput = {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export interface JdtlsTransportFactory {
  spawn(input: JdtlsSpawnInput): JdtlsTransportAttempt;
}

export const defaultJdtlsTransportFactory: JdtlsTransportFactory = {
  spawn(input) {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin)
    ) as MessageConnection;
    return { child, connection: adaptMessageConnection(connection) };
  }
};

function adaptMessageConnection(connection: MessageConnection): JdtlsConnection {
  return {
    sendRequest: (method, params, token) => token === undefined
      ? connection.sendRequest(method, params)
      : connection.sendRequest(method, params, token),
    sendNotification: (method, params) => { void connection.sendNotification(method, params); },
    onRequest: (method, handler) => { connection.onRequest(method, handler); },
    onNotification: (method, handler) => { connection.onNotification(method, handler); },
    onError: handler => { connection.onError(handler); },
    listen: () => connection.listen(),
    dispose: () => connection.dispose()
  };
}
