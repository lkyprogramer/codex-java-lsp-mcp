import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AbstractMessageWriter,
  createMessageConnection,
  StreamMessageReader,
  type Message,
  type MessageConnection
} from "vscode-jsonrpc/node.js";
import {
  deferred,
  fakeTransportFactory,
  FakeJdtlsConnection,
  sequenceTransportFactory
} from "./test-support/fake-jdtls.js";
import {
  adaptMessageConnection,
  guardMessageWriter,
  type JdtlsSpawnInput
} from "./jdtls-transport.js";

class RejectingMessageWriter extends AbstractMessageWriter {
  async write(message: Message): Promise<void> {
    const error = new Error("write EPIPE");
    this.fireError(error, message, 1);
    throw error;
  }

  end(): void {}
}

test("guarded writer turns a JSON-RPC write failure into a handled connection failure", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  let connection: MessageConnection | undefined;
  let failures = 0;
  try {
    const writer = guardMessageWriter(new RejectingMessageWriter(), () => {
      failures += 1;
      connection?.dispose();
    });
    connection = createMessageConnection(new StreamMessageReader(new PassThrough()), writer);
    connection.listen();

    await assert.rejects(
      connection.sendRequest("will-fail"),
      /Pending response rejected since connection got disposed/
    );
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(failures, 1);
    assert.deepEqual(unhandled, [], "the dependency's async Promise executor must not leak an orphan rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    connection?.dispose();
  }
});

test("real transport adapter observes rejected fire-and-forget notifications", () => {
  let rejectionObserved = false;
  const rawConnection = {
    sendNotification() {
      return {
        catch(handler: (error: unknown) => unknown) {
          rejectionObserved = true;
          handler(new Error("write EPIPE"));
          return Promise.resolve();
        }
      };
    }
  };

  adaptMessageConnection(rawConnection as never).sendNotification("exit");

  assert.equal(rejectionObserved, true, "a rejected JSON-RPC writer promise must not become an unhandled rejection");
});

const spawnInput: JdtlsSpawnInput = {
  binary: "/opt/homebrew/bin/jdtls",
  args: ["-data", "/tmp/workspace"],
  cwd: "/tmp/repo",
  env: { PATH: "/usr/bin" }
};

test("fake transport exposes deterministic connection state", async () => {
  const connection = new FakeJdtlsConnection();
  connection.responses.set("initialize", { capabilities: {} });
  const result = await connection.sendRequest("initialize");
  assert.deepEqual(result, { capabilities: {} });
  assert.deepEqual(connection.requests, ["initialize"]);
});

test("fake transport records every spawn and its launch input", () => {
  const factory = fakeTransportFactory();
  const first = factory.spawn(spawnInput);
  const second = factory.spawn(spawnInput);

  assert.equal(factory.spawnCalls, 2);
  assert.notEqual(first.child, second.child);
  assert.notEqual(first.connection, second.connection);
  assert.deepEqual(factory.spawnInputs[0].args, ["-data", "/tmp/workspace"]);
  assert.equal(factory.spawnInputs[0].cwd, "/tmp/repo");
});

test("fake transport can defer initialize until the test resolves it", async () => {
  const initialize = deferred<unknown>();
  const factory = fakeTransportFactory({ initialize });
  const attempt = factory.spawn(spawnInput);

  let settled = false;
  const pending = attempt.connection
    .sendRequest("initialize")
    .then(value => { settled = true; return value; });

  await Promise.resolve();
  assert.equal(settled, false);

  initialize.resolve({ capabilities: { referencesProvider: true } });
  assert.deepEqual(await pending, { capabilities: { referencesProvider: true } });
});

test("fake transport can fail initialize and reports child termination", async () => {
  const factory = fakeTransportFactory({ initializeError: new Error("boom") });
  const attempt = factory.spawn(spawnInput);

  await assert.rejects(() => attempt.connection.sendRequest("initialize"), /boom/);

  assert.equal(factory.children[0].exitCode, null);
  attempt.child.kill("SIGTERM");
  assert.equal(factory.children[0].killCalls, 1);
  assert.equal(factory.children[0].signalCode, "SIGTERM");
  attempt.connection.dispose();
  assert.equal(factory.connections[0].disposed, true);
});

test("sequence transport factory returns a different attempt per spawn", async () => {
  const factory = sequenceTransportFactory([
    { initializeError: new Error("first attempt fails") },
    { initializeResult: { capabilities: { hoverProvider: true } } }
  ]);

  const failing = factory.spawn(spawnInput);
  await assert.rejects(() => failing.connection.sendRequest("initialize"), /first attempt fails/);

  const succeeding = factory.spawn(spawnInput);
  assert.deepEqual(
    await succeeding.connection.sendRequest("initialize"),
    { capabilities: { hoverProvider: true } }
  );
  assert.equal(factory.spawnCalls, 2);
});

test("fake child reports a hung process that ignores SIGTERM", () => {
  const factory = fakeTransportFactory();
  const attempt = factory.spawn(spawnInput);
  const child = factory.children[0];
  child.exitsOnKill = false;

  attempt.child.kill("SIGTERM");
  assert.equal(child.killCalls, 1);
  assert.equal(child.exitCode, null, "killed must not be treated as exited");
  assert.equal(child.killed, true);

  let closed = 0;
  child.once("close", () => { closed += 1; });
  child.exit(null, "SIGKILL");
  assert.equal(closed, 1);
  assert.equal(child.signalCode, "SIGKILL");
});
