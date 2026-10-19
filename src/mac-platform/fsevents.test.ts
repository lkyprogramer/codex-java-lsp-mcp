import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { FSEventDecoder, FSEVENT_LINE_BYTES, MacFSEvents } from "./fsevents.js";
import { MAC_NATIVE_PROTOCOL } from "./native-protocol.js";
const epoch = "0123456789abcdef0123456789abcdef";
const wire = (seq: number, kind: string, fields = {}, stream = epoch) => Buffer.from(JSON.stringify({ protocol: MAC_NATIVE_PROTOCOL, epoch: stream, seq: String(seq), kind, ...fields }) + "\n");
const POWER = { power: "registered", testHooks: false };
const ready = (decoder: FSEventDecoder, stream = epoch) => decoder.push(wire(1, "ready", { pid: 123, pgid: 122, fd: 4, inode: "9007199254740993", volumeIdentity: "16777234", ...POWER }, stream));

test("raw-flags-and-fence-order", () => {
  const decoder = new FSEventDecoder(); ready(decoder);
  const bytes = Buffer.concat([wire(2, "event", { path: "/fixture/中文.java", flags: 0x80000000, eventId: "18446744073709551615" }), wire(3, "fence", { requestId: "1" }), wire(4, "event", { path: "/fixture/late", flags: 0, eventId: "8" })]);
  const rows = [...decoder.push(bytes.subarray(0, 13)), ...decoder.push(bytes.subarray(13))];
  assert.deepEqual(rows.map(row => row.kind), ["event", "fence", "event"]);
  assert.equal(rows[0].flags, 0x80000000); assert.equal(rows[0].eventId, "18446744073709551615");
  assert.equal(rows[0].path, "/fixture/中文.java");
  assert.deepEqual(rows.map(row => row.seq), ["2", "3", "4"]);
  const fence = rows[1];
  const prefix = rows.filter(row => row.kind === "event" && BigInt(row.seq) < BigInt(fence.seq));
  const future = rows.filter(row => row.kind === "event" && BigInt(row.seq) > BigInt(fence.seq));
  assert.deepEqual(prefix.map(row => row.path), ["/fixture/中文.java"]);
  assert.deepEqual(future.map(row => row.path), ["/fixture/late"]);
  assert.ok(rows.every(row => row.volumeIdentity === "16777234")); decoder.finish();
});
test("drop-and-root-change-remain-observable", () => {
  // Synthetic protocol values; actual OS drops are not claimed here.
  const decoder = new FSEventDecoder(); ready(decoder);
  const flags = [1, 2, 4, 32, 0x80000027];
  const rows = decoder.push(Buffer.concat(flags.map((flag, index) => wire(index + 2, "event", { path: "", flags: flag, eventId: "0" }))));
  assert.deepEqual(rows.map(row => row.flags), flags);
  assert.ok(rows.every(row => row.path === ""));
});
test("stream-restart-creates-new-epoch", () => {
  const first = new FSEventDecoder(); ready(first); first.push(wire(2, "stopped")); first.finish();
  const next = "fedcba9876543210fedcba9876543210";
  const second = new FSEventDecoder(); const rows = ready(second, next);
  assert.notEqual(rows[0].epoch, epoch); assert.equal(rows[0].seq, "1");
  assert.throws(() => second.push(wire(2, "event", { flags: 0, eventId: "1", path: "/old" })), /epoch/);
});
test("protocol-failures-are-explicit", () => {
  for (const bad of [wire(1, "event", { flags: 0, eventId: "1", path: "/a" }), Buffer.from("invalid\n"), Buffer.from([255, 10]), Buffer.alloc(FSEVENT_LINE_BYTES + 1, 65)]) assert.throws(() => new FSEventDecoder().push(bad));
  const decoder = new FSEventDecoder(); ready(decoder);
  assert.throws(() => decoder.push(wire(3, "fence", { requestId: "1" })), /order/);
  const truncated = new FSEventDecoder(); truncated.push(Buffer.from("{")); assert.throws(() => truncated.finish(), /truncated/);
});

test("volume-identity-is-required-and-is-not-owner-inode", () => {
  for (const value of [undefined, "-1", 123, "18446744073709551616", "01"]) {
    assert.throws(() => new FSEventDecoder().push(wire(1, "ready", { pid: 123, pgid: 122, fd: 4, inode: "9", volumeIdentity: value, ...POWER })), /volume/);
  }
  const rows = ready(new FSEventDecoder());
  assert.equal(rows[0].volumeIdentity, "16777234"); assert.notEqual(rows[0].volumeIdentity, rows[0].inode);
});
test("a resume is a sequenced native signal; ready proves the power registration", () => {
  const decoder = new FSEventDecoder(); ready(decoder);
  const rows = decoder.push(Buffer.concat([wire(2, "resume", { source: "system-has-powered-on" }), wire(3, "event", { path: "/a", flags: 0, eventId: "9" }), wire(4, "resume", { source: "test-hook" })]));
  assert.deepEqual(rows.map(row => [row.kind, row.seq, row.source]), [["resume", "2", "system-has-powered-on"], ["event", "3", undefined], ["resume", "4", "test-hook"]]);
  assert.throws(() => decoder.push(wire(5, "resume", { source: "node-guess" })), /resume/);
  for (const power of [{}, { power: "registered" }, { power: "none", testHooks: false }, { power: "registered", testHooks: "0" }]) {
    assert.throws(() => new FSEventDecoder().push(wire(1, "ready", { pid: 123, pgid: 122, fd: 4, inode: "9", volumeIdentity: "7", ...power })), /power/);
  }
});
test("startup-errors-preserve-native-code-and-errno", () => {
  for (const code of ["INVALID_ROOT", "STREAM_START_FAILED"]) {
    const bytes = Buffer.from(JSON.stringify({ protocol: MAC_NATIVE_PROTOCOL, kind: "startup-error", code, errno: 2 }) + "\n");
    const decoder = new FSEventDecoder();
    assert.throws(() => decoder.push(bytes), new RegExp(`native FSEvents ${code} \\(errno 2\\)`)); decoder.finish();
  }
  for (const fields of [{ code: "", errno: 2 }, { code: "INVALID_ROOT", errno: -1 }, { code: "INVALID_ROOT", errno: "2" }, { code: "INVALID_ROOT", errno: 2, epoch }]) {
    assert.throws(() => new FSEventDecoder().push(Buffer.from(JSON.stringify({ protocol: MAC_NATIVE_PROTOCOL, kind: "startup-error", ...fields }) + "\n")), /startup error/);
  }
  assert.throws(() => new FSEventDecoder().push(wire(1, "event", { path: "", flags: 0, eventId: "0" })), /ready/);
});

for (const scenario of [
  { name: "fence-timeout-includes-delayed-ready", readyDelay: 1000, ackDelay: 0, timeout: 120, lower: 100, upper: 250 },
  { name: "fence-ready-consumes-acknowledgement-budget", readyDelay: 150, ackDelay: 180, timeout: 250, lower: 220, upper: 315 }
]) {
  test(scenario.name, { timeout: 5000 }, async t => {
    // A real short-lived Node child exercises pipe close and SIGKILL. This is
    // a protocol/lifecycle seam, not a native macOS FSEvents acceptance test.
    const readyLine = wire(1, "ready", { pid: 123, pgid: 122, fd: 4, inode: "9", volumeIdentity: "7", ...POWER }).toString();
    const program = `process.stderr.write('boot\\n'); process.stdin.once('data', () => {
      process.stdin.on('data', bytes => { const match = /^fence ([0-9]+)\\n$/.exec(bytes.toString());
        if (match) setTimeout(() => process.stdout.write(JSON.stringify({protocol:${JSON.stringify(MAC_NATIVE_PROTOCOL)},epoch:${JSON.stringify(epoch)},seq:'2',kind:'fence',requestId:match[1]})+'\\n'), ${scenario.ackDelay}); });
      setTimeout(() => process.stdout.write(${JSON.stringify(readyLine)}), ${scenario.readyDelay});
    });`;
    const child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"] });
    let actualClose = false;
    const closed = new Promise<void>(resolve => child.once("close", () => { actualClose = true; resolve(); }));
    t.after(async () => { if (!actualClose) child.kill("SIGKILL"); await closed; });
    await new Promise<void>((resolve, reject) => { child.stderr.once("data", () => resolve()); child.once("error", reject); });
    const stream = Reflect.construct(MacFSEvents, [child, () => {}]) as MacFSEvents;
    child.stdin.write("begin\n");
    const start = performance.now();
    await assert.rejects(stream.fence(scenario.timeout), /FSEvents fence timeout/);
    const elapsed = performance.now() - start;
    assert.equal(actualClose, true, "fence must settle only after actual child close");
    assert.ok(elapsed >= scenario.lower && elapsed < scenario.upper, `elapsed ${elapsed}ms`);
    assert.equal(child.signalCode, "SIGKILL"); await closed;
  });
}
