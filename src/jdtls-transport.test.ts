import assert from "node:assert/strict";
import test from "node:test";
import {
  deferred,
  fakeTransportFactory,
  FakeJdtlsConnection,
  sequenceTransportFactory
} from "./test-support/fake-jdtls.js";
import type { JdtlsSpawnInput } from "./jdtls-transport.js";

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
