import assert from "node:assert/strict";
import test from "node:test";
import { DocumentLru } from "./document-lru.js";

test("opening the sixty-fifth idle document closes the least recently used document", async () => {
  const notifications: Array<{ method: string; uri: string }> = [];
  const lru = new DocumentLru({
    maxOpen: 64,
    notify(method, params) {
      notifications.push({ method, uri: (params as { textDocument: { uri: string } }).textDocument.uri });
    }
  });

  for (let index = 0; index < 65; index += 1) {
    const lease = await lru.acquire(`/repo/F${index}.java`, `text-${index}`);
    lease.release();
  }

  assert.equal(lru.status().open, 64);
  assert.deepEqual(
    notifications.filter(item => item.method === "textDocument/didClose").map(item => item.uri),
    ["file:///repo/F0.java"]
  );
});

function recordingLru(maxOpen: number): {
  lru: DocumentLru;
  notifications: Array<{ method: string; uri: string; version?: number }>;
} {
  const notifications: Array<{ method: string; uri: string; version?: number }> = [];
  const lru = new DocumentLru({
    maxOpen,
    notify(method, params) {
      const textDocument = (params as { textDocument: { uri: string; version?: number } }).textDocument;
      notifications.push({
        method,
        uri: textDocument.uri,
        version: "version" in textDocument ? textDocument.version : undefined
      });
    }
  });
  return { lru, notifications };
}

test("an in-flight pinned document is not evicted", async () => {
  const { lru, notifications } = recordingLru(2);
  const pinned = await lru.acquire("/repo/A.java", "class A {}");
  const idle = await lru.acquire("/repo/B.java", "class B {}");
  idle.release();
  const newest = await lru.acquire("/repo/C.java", "class C {}");
  newest.release();

  const closes = notifications
    .filter(item => item.method === "textDocument/didClose")
    .map(item => item.uri);
  assert.deepEqual(closes, ["file:///repo/B.java"]);
  assert.equal(lru.has("/repo/A.java"), true);
  pinned.release();
});

test("delete sends didClose and removes cached text", async () => {
  const { lru, notifications } = recordingLru(2);
  const lease = await lru.acquire("/repo/A.java", "class A {}");
  lease.release();
  lru.delete("/repo/A.java");

  assert.equal(lru.has("/repo/A.java"), false);
  assert.equal(lru.status().retainedTextBytes, 0);
  assert.equal(
    notifications.filter(item => item.method === "textDocument/didClose").length,
    1
  );
});

test("changed text sends one monotonically versioned didChange", async () => {
  const { lru, notifications } = recordingLru(2);
  const first = await lru.acquire("/repo/A.java", "class A {}");
  first.release();
  const second = await lru.acquire("/repo/A.java", "class A { int value; }");
  second.release();
  const third = await lru.acquire("/repo/A.java", "class A { int value; }");
  third.release();

  const changes = notifications.filter(item => item.method === "textDocument/didChange");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].version, 2);
});

test("closeAll sends didClose for every open document and clears state", async () => {
  const { lru, notifications } = recordingLru(3);
  for (const file of ["A.java", "B.java", "C.java"]) {
    const lease = await lru.acquire(`/repo/${file}`, `class ${file[0]} {}`);
    lease.release();
  }
  lru.closeAll();

  assert.equal(lru.status().open, 0);
  assert.equal(lru.status().retainedTextBytes, 0);
  assert.equal(
    notifications.filter(item => item.method === "textDocument/didClose").length,
    3
  );
});

test("two concurrent acquires for the same uri share one didOpen and each get an independently-released pin", async () => {
  const { lru, notifications } = recordingLru(64);
  const [first, second] = await Promise.all([
    lru.acquire("/repo/A.java", "class A {}"),
    lru.acquire("/repo/A.java", "class A {}")
  ]);

  assert.equal(notifications.filter(item => item.method === "textDocument/didOpen").length, 1);
  assert.equal(lru.status().pinned, 1);
  first.release();
  assert.equal(lru.status().pinned, 1, "the second caller's pin must still hold the document open");
  second.release();
  assert.equal(lru.status().pinned, 0);
});

test("a document with all pins held exceeds maxOpen and records evictionDeferred until released", async () => {
  const { lru } = recordingLru(1);
  const first = await lru.acquire("/repo/A.java", "class A {}");
  const second = await lru.acquire("/repo/B.java", "class B {}");

  assert.equal(lru.status().open, 2, "both pinned documents must stay open past maxOpen");
  assert.ok(lru.status().evictionDeferred > 0);

  first.release();
  assert.equal(lru.status().open, 1, "releasing a pin retries eviction immediately");
  second.release();
});

test("retained text is bounded by the most recently used documents under maxOpen", async () => {
  const { lru } = recordingLru(8);
  const oneMiB = "x".repeat(1024 * 1024);
  for (let index = 0; index < 100; index += 1) {
    const lease = await lru.acquire(`/repo/F${index}.java`, oneMiB);
    lease.release();
  }

  const status = lru.status();
  assert.equal(status.open, 8);
  assert.ok(
    status.retainedTextBytes <= 9 * 1024 * 1024,
    `retainedTextBytes ${status.retainedTextBytes} must stay bounded by ~8 files, not all 100`
  );
});
