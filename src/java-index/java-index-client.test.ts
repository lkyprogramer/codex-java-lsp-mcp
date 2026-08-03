import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type { JavaIndexStatus } from "./index-types.js";
import { JavaIndexClient, type WorkerLike } from "./java-index-client.js";
import { RouterJavaIndex } from "./router-java-index.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRepoRoot = path.resolve(dirname, "..", "..", "fixtures", "java-index-v2");

function validStatus(generation: number): JavaIndexStatus {
  return {
    state: "READY",
    indexedGeneration: generation,
    files: 0,
    types: 0,
    methods: 0,
    edges: 0,
    snapshotBytes: 0,
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [],
    resourceCoverage: []
  };
}

class FakeWorker implements WorkerLike {
  readonly posted: Array<{ id: number; type: string }> = [];
  private readonly listeners: {
    message: Array<(value: unknown) => void>;
    error: Array<(error: Error) => void>;
    exit: Array<(code: number) => void>;
  } = { message: [], error: [], exit: [] };

  postMessage(value: unknown): void {
    this.posted.push(value as { id: number; type: string });
  }

  on(event: "message" | "error" | "exit", listener: (value: never) => void): this {
    this.listeners[event].push(listener as never);
    return this;
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }

  emitMessage(value: unknown): void {
    for (const listener of this.listeners.message) listener(value);
  }

  emitExit(code: number): void {
    for (const listener of this.listeners.exit) listener(code);
  }
}

// ensureOpen()'s "already open" fast path still returns via a resolved
// promise, so a caller's next `await` step lands one or more microtask ticks
// later than the synchronous call that started it. Draining with setImmediate
// (a macrotask) guarantees every pending microtask in that chain has run
// before the test inspects what the fake worker received.
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function openedClient(): Promise<{ client: JavaIndexClient; worker: FakeWorker }> {
  const worker = new FakeWorker();
  const client = new JavaIndexClient("/repo", "/cache", () => worker);
  const openPromise = client.open(1);
  const openMessage = worker.posted[0];
  worker.emitMessage({ id: openMessage.id, ok: true, value: validStatus(1) });
  await openPromise;
  return { client, worker };
}

test("two out-of-order responses resolve correct promises", async () => {
  const { client, worker } = await openedClient();

  const statusPromise = client.status();
  const anchorPromise = client.queryAnchor("A.java", 1, 1);
  await flushMicrotasks();
  const statusMessage = worker.posted[1];
  const anchorMessage = worker.posted[2];

  worker.emitMessage({ id: anchorMessage.id, ok: true, value: undefined });
  worker.emitMessage({ id: statusMessage.id, ok: true, value: validStatus(1) });

  const [statusResult, anchorResult] = await Promise.all([statusPromise, anchorPromise]);
  assert.equal(statusResult.state, "READY");
  assert.equal(anchorResult, undefined);
});

test("QUERY_TYPES sends one worker command and validates ordered lookup results", async () => {
  const { client, worker } = await openedClient();
  const pending = client.queryTypes([{ typeText: "Gateway" }, { typeText: "Missing" }]);
  await flushMicrotasks();
  const message = worker.posted[1];
  assert.equal(message.type, "QUERY_TYPES");
  worker.emitMessage({
    id: message.id,
    ok: true,
    value: [
      { state: "UNRESOLVED", coverage: "COMPLETE" },
      { state: "UNRESOLVED", coverage: "DEGRADED" }
    ]
  });
  assert.deepEqual(await pending, [
    { state: "UNRESOLVED", coverage: "COMPLETE" },
    { state: "UNRESOLVED", coverage: "DEGRADED" }
  ]);
});

test("an invalid command payload is rejected by the validator and moves the client to DEGRADED", async () => {
  const { client, worker } = await openedClient();

  const statusPromise = client.status();
  await flushMicrotasks();
  const statusMessage = worker.posted[1];
  worker.emitMessage({ id: statusMessage.id, ok: true, value: { not: "a status" } });

  await assert.rejects(statusPromise, (error: unknown) => {
    assert.ok(error instanceof JavaIntelligenceError);
    assert.equal(error.code, "INDEX_CORRUPT");
    return true;
  });
  assert.equal(client.localStatus().state, "DEGRADED");
});

test("worker exit rejects all pending requests and marks the client DEGRADED", async () => {
  const { client, worker } = await openedClient();

  const statusPromise = client.status();
  await flushMicrotasks();
  assert.equal(worker.posted.length, 2, "the status request must have been sent before the exit");
  worker.emitExit(1);

  await assert.rejects(statusPromise, (error: unknown) => {
    assert.ok(error instanceof JavaIntelligenceError);
    assert.equal(error.code, "INDEX_PARTIAL");
    return true;
  });
  assert.equal(client.localStatus().state, "DEGRADED");
});

test("a failed OPEN clears the worker so the next request can still restart once", async () => {
  const workers: FakeWorker[] = [];
  const client = new JavaIndexClient("/repo", "/cache", () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });

  const openPromise = client.open(1);
  const firstWorker = workers[0];
  firstWorker.emitMessage({
    id: firstWorker.posted[0].id,
    ok: false,
    error: { code: "OPEN_FAILED", message: "boom" }
  });

  await assert.rejects(openPromise);
  assert.equal(client.localStatus().state, "DEGRADED");

  const statusPromise = client.status();
  assert.equal(workers.length, 2, "a failed OPEN must not wedge the client; the next request should restart");
  const secondWorker = workers[1];
  secondWorker.emitMessage({ id: secondWorker.posted[0].id, ok: true, value: validStatus(1) });
  await flushMicrotasks();
  secondWorker.emitMessage({ id: secondWorker.posted[1].id, ok: true, value: validStatus(1) });

  const status = await statusPromise;
  assert.equal(status.state, "READY");
});

test("after an unexpected exit, the next request restarts the worker exactly once", async () => {
  const workers: FakeWorker[] = [];
  const client = new JavaIndexClient("/repo", "/cache", () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });

  const openPromise = client.open(1);
  const firstWorker = workers[0];
  firstWorker.emitMessage({ id: firstWorker.posted[0].id, ok: true, value: validStatus(1) });
  await openPromise;

  firstWorker.emitExit(1);
  assert.equal(client.localStatus().state, "DEGRADED");

  const statusPromise = client.status();
  assert.equal(workers.length, 2, "the next request must spawn a replacement worker");
  const secondWorker = workers[1];
  secondWorker.emitMessage({ id: secondWorker.posted[0].id, ok: true, value: validStatus(1) });
  await flushMicrotasks();
  secondWorker.emitMessage({ id: secondWorker.posted[1].id, ok: true, value: validStatus(1) });

  const status = await statusPromise;
  assert.equal(status.state, "READY");

  secondWorker.emitExit(1);
  await assert.rejects(client.status(), (error: unknown) => {
    assert.ok(error instanceof JavaIntelligenceError);
    return true;
  });
  assert.equal(workers.length, 2, "a second exit must not spend a second restart");
});

test("client opens a real worker thread, reaches READY, and closes cleanly", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-client-smoke-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "java-index-client-smoke-cache-"));
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  assert.equal((await client.status()).state, "READY");
  await client.close();
  assert.equal(client.localStatus().state, "CLOSED");
});

test("REFRESH end-to-end through a real worker thread: reads, parses, extracts, and QUERY_FILES returns the facts; deletion clears them", async () => {
  const absolutePath = path.join(fixturesRepoRoot, "src/main/java/demo/ComplexJava.java");
  const client = new JavaIndexClient(fixturesRepoRoot, mkdtempSync(path.join(tmpdir(), "java-index-refresh-cache-")));
  await client.open(1);

  const afterRefresh = await client.refresh(2, [absolutePath], []);
  assert.equal(afterRefresh.files, 1);
  assert.equal(afterRefresh.types, 4);
  assert.ok(afterRefresh.methods >= 4);

  const bundles = await client.queryFiles([absolutePath]);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0]!.file.packageName, "demo");
  assert.deepEqual(bundles[0]!.types.map(t => t.simpleName).sort(), [
    "Child", "ComplexJava", "Helper", "SecondTopLevel"
  ]);
  // Task 18 wires real static edges into the worker's REFRESH pipeline:
  // packagePrivate()'s `new Helper()` resolves Helper via ENCLOSING_TYPE
  // (nested inside ComplexJava, same file), so a CONSTRUCTS edge must
  // appear even though most of this fixture's other types (BaseType,
  // DemoPort, DemoRepository, ...) have no repo source anywhere and stay
  // UNRESOLVED.
  const helperType = bundles[0]!.types.find(t => t.simpleName === "Helper")!;
  const packagePrivateMethod = bundles[0]!.methods.find(m => m.name === "packagePrivate")!;
  assert.ok(
    bundles[0]!.edges.some(
      e => e.kind === "CONSTRUCTS" && e.fromId === packagePrivateMethod.methodId && e.toId === helperType.typeId
    ),
    "expected a CONSTRUCTS edge from packagePrivate() to the nested Helper type"
  );

  const afterDelete = await client.refresh(3, [], [absolutePath]);
  assert.equal(afterDelete.files, 0);
  const bundlesAfterDelete = await client.queryFiles([absolutePath]);
  assert.equal(bundlesAfterDelete.length, 0);

  await client.close();
});

test("QUERY_READ_RANGES returns exact UTF-8 Java/XML/fallback windows in one worker batch", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-read-ranges-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "java-index-read-ranges-cache-"));
  const javaDir = path.join(repoRoot, "src/main/java/demo");
  const resourceDir = path.join(repoRoot, "src/main/resources/mapper");
  mkdirSync(javaDir, { recursive: true });
  mkdirSync(resourceDir, { recursive: true });
  const javaPath = path.join(javaDir, "UnicodeService.java");
  const secondMethodLine = 36;
  const javaSource = [
    "package demo;",
    "",
    "public class UnicodeService {",
    "  String first() { return \"汉字\"; }",
    ...Array.from({ length: 31 }, () => ""),
    "  String second() { return \"done\"; }",
    "}",
    ""
  ].join("\n");
  const xmlPath = path.join(resourceDir, "OrderMapper.xml");
  const xmlSource = [
    "<mapper namespace=\"demo.OrderMapper\">",
    "  <select id=\"find\" resultType=\"string\">",
    "    SELECT '汉字'",
    "  </select>",
    "</mapper>",
    ""
  ].join("\n");
  const fallbackPath = path.join(repoRoot, "notes.txt");
  const crlfFallbackPath = path.join(repoRoot, "notes-crlf.txt");
  writeFileSync(javaPath, javaSource);
  writeFileSync(xmlPath, xmlSource);
  writeFileSync(fallbackPath, "first\nsecond\nthird\n");
  const crlfFallbackSource = "first\r\nsecond\r\nthird";
  writeFileSync(crlfFallbackPath, crlfFallbackSource);

  const client = new JavaIndexClient(repoRoot, cacheDir);
  try {
    await client.open(1);
    await client.refresh(2, [javaPath], []);
    await client.refreshResources(2, [xmlPath]);
    const results = await client.queryReadRanges([
      { file: javaPath, positions: [{ line: 4, column: 3 }, { line: secondMethodLine, column: 3 }] },
      { file: xmlPath, positions: [{ line: 2, column: 3 }] },
      { file: fallbackPath, positions: [{ line: 2, column: 1 }] },
      { file: crlfFallbackPath, positions: [{ line: 2, column: 1 }] }
    ]);

    const javaRanges = results.find(result => result.file === javaPath)!.ranges;
    assert.ok(javaRanges.length >= 2, "distant Java methods remain separate read ranges");
    assert.ok(javaRanges.some(range => range.kind === "method"));
    const javaRangeWithCjk = javaRanges.find(range => range.startLine <= 4 && range.endLine >= 4)!;
    assert.deepEqual(
      new Set(javaRangeWithCjk.kinds),
      new Set(["method", "type"]),
      "merged method and owner-header windows must retain both reason kinds"
    );
    const lineStarts = [0];
    for (let index = 0; index < javaSource.length; index += 1) if (javaSource.charCodeAt(index) === 10) lineStarts.push(index + 1);
    const expectedBytes = Buffer.byteLength(javaSource.slice(lineStarts[javaRangeWithCjk.startLine - 1], lineStarts[javaRangeWithCjk.endLine] ?? javaSource.length), "utf8");
    assert.equal(javaRangeWithCjk.estimatedBytes, expectedBytes, "CJK source is accounted in UTF-8 bytes, not JS character count");

    const xmlRange = results.find(result => result.file === xmlPath)!.ranges[0]!;
    assert.equal(xmlRange.kind, "xml-statement");
    assert.ok(xmlRange.estimatedBytes > 0);
    assert.equal(results.find(result => result.file === fallbackPath)!.ranges[0]!.kind, "fallback");
    const crlfFallbackRange = results.find(result => result.file === crlfFallbackPath)!.ranges[0]!;
    assert.equal(crlfFallbackRange.kind, "fallback");
    assert.equal(
      crlfFallbackRange.estimatedBytes,
      Buffer.byteLength(crlfFallbackSource, "utf8"),
      "CRLF source without a terminal newline is priced in its exact UTF-8 byte representation"
    );
  } finally {
    await client.close();
  }
});

test("RouterJavaIndex rejects outside-repository range requests before forwarding to the worker", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-read-ranges-boundary-"));
  const forwarded: unknown[] = [];
  const client = {
    localStatus: () => validStatus(0),
    queryReadRanges: async (requests: unknown[]) => {
      forwarded.push(...requests);
      return [];
    }
  } as never;
  const router = new RouterJavaIndex(repoRoot, client);

  await assert.rejects(
    router.queryReadRanges([{
      file: path.resolve(repoRoot, "..", "outside", "Secret.java"),
      positions: [{ line: 1, column: 1 }]
    }]),
    /outside|repository|repo/i
  );
  assert.equal(forwarded.length, 0);
});

test("QUERY_READ_RANGES does not read an in-repository symlink whose target escapes the repository", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-read-ranges-symlink-root-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "java-index-read-ranges-symlink-outside-"));
  const outsideFile = path.join(outsideRoot, "Secret.java");
  const symlinkPath = path.join(repoRoot, "LinkedSecret.java");
  writeFileSync(outsideFile, "class Secret {}\n");
  symlinkSync(outsideFile, symlinkPath);
  const client = new JavaIndexClient(repoRoot, mkdtempSync(path.join(tmpdir(), "java-index-read-ranges-symlink-cache-")));
  const router = new RouterJavaIndex(repoRoot, client);
  try {
    await router.open(1);
    assert.deepEqual(
      await router.queryReadRanges([{ file: symlinkPath, positions: [{ line: 1, column: 1 }] }]),
      [{ file: symlinkPath, ranges: [] }]
    );
  } finally {
    await client.close();
  }
});

test("REFRESH does not parse an in-repository symlink whose target escapes the repository", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-refresh-symlink-root-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "java-index-refresh-symlink-outside-"));
  const sourceDir = path.join(repoRoot, "src/main/java/demo");
  const outsideFile = path.join(outsideRoot, "Secret.java");
  const symlinkPath = path.join(sourceDir, "Secret.java");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(outsideFile, "package demo; public class Secret {}\n");
  symlinkSync(outsideFile, symlinkPath);
  const client = new JavaIndexClient(repoRoot, mkdtempSync(path.join(tmpdir(), "java-index-refresh-symlink-cache-")));
  try {
    await client.open(1);
    await assert.doesNotReject(() => client.refresh(2, [symlinkPath], []));
    assert.deepEqual(await client.queryFiles([symlinkPath]), []);
    assert.equal((await client.status()).files, 0);
  } finally {
    await client.close();
  }
});

test("QUERY_READ_RANGES bounds an extreme Java method to first and last windows", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-extreme-range-"));
  const cacheDir = mkdtempSync(path.join(tmpdir(), "java-index-extreme-range-cache-"));
  const sourceDir = path.join(repoRoot, "src/main/java/demo");
  mkdirSync(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, "HugeService.java");
  writeFileSync(sourcePath, [
    "package demo;",
    "public class HugeService {",
    "  void huge() {",
    ...Array.from({ length: 305 }, () => "    System.out.println(\"x\");"),
    "  }",
    "}",
    ""
  ].join("\n"));
  const client = new JavaIndexClient(repoRoot, cacheDir);
  try {
    await client.open(1);
    await client.refresh(2, [sourcePath], []);
    const result = (await client.queryReadRanges([{ file: sourcePath, positions: [{ line: 3, column: 3 }] }]))[0]!;
    assert.equal(result.extremeMethod, true);
    assert.ok(result.ranges.length >= 2, "extreme method must not become one oversized body range");
    assert.ok(result.ranges.every(range => range.endLine - range.startLine + 1 <= 41));
  } finally {
    await client.close();
  }
});

test("deleting a type's sole source file drops the now-stale IMPLEMENTS edge from its implementer", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-dangling-edge-"));
  const packageDir = path.join(repoRoot, "src/main/java/demo");
  mkdirSync(packageDir, { recursive: true });
  const gatewayPath = path.join(packageDir, "Gateway.java");
  const implPath = path.join(packageDir, "Impl.java");
  writeFileSync(gatewayPath, "package demo;\n\ninterface Gateway {}\n");
  writeFileSync(implPath, "package demo;\n\nclass Impl implements Gateway {}\n");

  const client = new JavaIndexClient(repoRoot, mkdtempSync(path.join(tmpdir(), "java-index-dangling-edge-cache-")));
  await client.open(1);
  await client.refresh(2, [gatewayPath, implPath], []);

  const impl = (await client.queryFiles([implPath]))[0]!;
  const gateway = (await client.queryFiles([gatewayPath]))[0]!.types.find(t => t.simpleName === "Gateway")!;
  assert.ok(
    impl.edges.some(e => e.kind === "IMPLEMENTS" && e.toId === gateway.typeId),
    "expected Impl IMPLEMENTS Gateway before the delete"
  );

  await client.refresh(3, [], [gatewayPath]);
  const implAfterDelete = (await client.queryFiles([implPath]))[0]!;
  assert.equal(
    implAfterDelete.edges.some(e => e.kind === "IMPLEMENTS" && e.toId === gateway.typeId),
    false,
    "Gateway's sole source file was deleted; the stale IMPLEMENTS edge must not survive re-resolution"
  );

  await client.close();
});

test("refreshing a declaration preserves inbound implementation edges when its stable id is unchanged", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-refresh-inbound-edge-"));
  const packageDir = path.join(repoRoot, "src/main/java/demo");
  mkdirSync(packageDir, { recursive: true });
  const gatewayPath = path.join(packageDir, "Gateway.java");
  const implPath = path.join(packageDir, "Impl.java");
  writeFileSync(gatewayPath, "package demo;\n\ninterface Gateway { void run(); }\n");
  writeFileSync(implPath, "package demo;\n\nclass Impl implements Gateway { public void run() {} }\n");

  const client = new JavaIndexClient(repoRoot, mkdtempSync(path.join(tmpdir(), "java-index-refresh-inbound-cache-")));
  await client.open(1);
  await client.refresh(1, [gatewayPath, implPath], []);
  const before = (await client.queryFiles([gatewayPath]))[0]!.types.find(type => type.simpleName === "Gateway")!;
  assert.deepEqual((await client.queryImplementers(before.typeId, 10)).map(type => type.simpleName), ["Impl"]);

  await client.refresh(2, [gatewayPath], []);
  const after = (await client.queryFiles([gatewayPath]))[0]!.types.find(type => type.simpleName === "Gateway")!;
  assert.equal(after.typeId, before.typeId, "unchanged declaration must keep the same stable id");
  assert.deepEqual(
    (await client.queryImplementers(after.typeId, 10)).map(type => type.simpleName),
    ["Impl"],
    "refreshing the target declaration must not drop inbound implementation edges"
  );

  await client.close();
});

test("Task 19/27 query commands (anchor/type/implementers/referencers/callers/callees/batched parameter methods) answer through a real worker thread", async () => {
  const absolutePath = path.join(fixturesRepoRoot, "src/main/java/demo/PaymentGateway.java");
  const client = new JavaIndexClient(fixturesRepoRoot, mkdtempSync(path.join(tmpdir(), "java-index-query-cache-")));
  await client.open(1);
  await client.refresh(2, [absolutePath], []);

  const bundle = (await client.queryFiles([absolutePath]))[0]!;
  const paymentGateway = bundle.types.find(t => t.simpleName === "PaymentGateway")!;
  const aliyunGateway = bundle.types.find(t => t.simpleName === "AliyunGateway")!;
  const gatewayPayMethod = bundle.methods.find(m => m.ownerTypeId === paymentGateway.typeId && m.name === "pay")!;
  const servicePayMethod = bundle.methods.find(
    m => m.ownerTypeId === bundle.types.find(t => t.simpleName === "PaymentService")!.typeId && m.name === "pay"
  )!;

  const implementers = await client.queryImplementers(paymentGateway.typeId, 10);
  assert.deepEqual(implementers.map(t => t.typeId), [aliyunGateway.typeId]);

  const referencers = await client.queryTypeReferencers(paymentGateway.typeId, ["IMPLEMENTS"], 10);
  assert.equal(referencers.length, 1);
  assert.equal(referencers[0]!.sourceId, aliyunGateway.typeId);

  const callers = await client.queryCallers(gatewayPayMethod.methodId, 10);
  assert.deepEqual(callers.map(r => r.sourceId), [servicePayMethod.methodId]);

  const callees = await client.queryCallees(servicePayMethod.methodId, 10);
  assert.deepEqual(callees.map(r => r.targetId), [gatewayPayMethod.methodId]);

  const anchor = await client.queryAnchor(absolutePath, paymentGateway.range.start.line, paymentGateway.range.start.column);
  assert.equal(anchor?.symbolId, paymentGateway.typeId);

  const typeLookup = await client.queryType("PaymentGateway", absolutePath);
  assert.equal(typeLookup.state, "RESOLVED");
  assert.equal((typeLookup as { type: { typeId: string } }).type.typeId, paymentGateway.typeId);

  const commandLookup = await client.queryType("PaymentCommand", absolutePath);
  assert.equal(commandLookup.state, "RESOLVED");
  const parameterMethods = await client.queryMethodsWithParameterTypes([(commandLookup as { type: { typeId: string } }).type.typeId], 10);
  assert.ok(parameterMethods.includes(gatewayPayMethod.methodId));
  assert.ok(parameterMethods.includes(servicePayMethod.methodId));

  await client.close();
});
