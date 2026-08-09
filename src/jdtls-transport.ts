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
  type MessageWriter,
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
    let connection: MessageConnection | undefined;
    const writer = guardMessageWriter(new StreamMessageWriter(child.stdin), () => {
      // vscode-jsonrpc 8.x/9.x uses an async Promise executor in sendRequest.
      // If MessageWriter.write rejects, that executor both rejects the public
      // request and throws an unreachable second rejection. Disposing here
      // rejects every public pending request, while guardMessageWriter consumes
      // only that duplicate writer rejection.
      try {
        connection?.dispose();
      } catch {
        // The transport is already broken; disposal is best effort.
      }
    });
    connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      writer
    ) as MessageConnection;
    return { child, connection: adaptMessageConnection(connection) };
  }
};

/**
 * Prevents vscode-jsonrpc's async Promise executor from leaking an orphan
 * rejection when the underlying stream write fails. The failure callback must
 * close/dispose the owning connection so its public requests still reject.
 */
export function guardMessageWriter(
  writer: MessageWriter,
  onFailure: (error: unknown) => void
): MessageWriter {
  return {
    onError: writer.onError,
    onClose: writer.onClose,
    async write(message) {
      try {
        await writer.write(message);
      } catch (error) {
        try {
          onFailure(error);
        } catch {
          // Never replace a transport failure with cleanup failure.
        }
      }
    },
    end: () => writer.end(),
    dispose: () => writer.dispose()
  };
}

export function adaptMessageConnection(connection: MessageConnection): JdtlsConnection {
  return {
    sendRequest: (method, params, token) => token === undefined
      ? connection.sendRequest(method, params)
      : connection.sendRequest(method, params, token),
    sendNotification: (method, params) => {
      // vscode-jsonrpc returns a writer promise even for notifications. The
      // session-facing interface is intentionally fire-and-forget, so observe
      // the rejection here; otherwise a normal JDT exit can turn queued
      // didOpen/cancel/exit writes into process-fatal unhandled EPIPEs.
      try {
        void connection.sendNotification(method, params).catch(() => undefined);
      } catch {
        // A connection that was synchronously closed/disposed has no writer
        // promise to observe. Notifications are intentionally best effort.
      }
    },
    onRequest: (method, handler) => { connection.onRequest(method, handler); },
    onNotification: (method, handler) => { connection.onNotification(method, handler); },
    onError: handler => { connection.onError(handler); },
    listen: () => connection.listen(),
    dispose: () => connection.dispose()
  };
}
