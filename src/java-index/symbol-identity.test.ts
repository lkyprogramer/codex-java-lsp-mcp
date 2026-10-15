import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { applyBuilderJob } from "../index-builder/incremental.js";
import { close, openIndexDb, type IndexDatabase } from "./sql/driver.js";
import { ensureSchema } from "./sql/schema.js";
import {
  captureEvidenceHandle,
  checkEvidenceHandle,
  declarationStability,
  formatEvidenceHandle,
  formatSymbolId,
  parseEvidenceHandle,
  resolveSymbolId
} from "./symbol-identity.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";
const localRel = "src/main/java/demospring/LocalHolder.java";
const WORKSPACE = "ws-alpha-0001";
const OTHER_WORKSPACE = "ws-beta-0002";

async function fixture(t: test.TestContext): Promise<{ repo: string; db: IndexDatabase }> {
  const repo = await mkdtemp(path.join(tmpdir(), "symbol-identity-"));
  await cp(fixturesRoot, repo, { recursive: true });
  await writeFile(path.join(repo, localRel), "package demospring;\n\nclass LocalHolder {\n  void run() {\n    class Inner {\n    }\n  }\n}\n");
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot: repo, db, generation: 1 });
  t.after(async () => {
    close(db);
    await rm(repo, { recursive: true, force: true });
  });
  return { repo, db };
}

function methodKey(db: IndexDatabase, relativePath: string, name: string): string {
  const row = db.prepare("SELECT s.text AS key FROM method m JOIN sym s ON s.id=m.sym JOIN file f ON f.id=m.file_id WHERE f.path=? AND m.name=?").get(relativePath, name) as { key: string } | undefined;
  assert.ok(row, `${relativePath} ${name}`);
  return row.key;
}

async function refresh(repo: string, db: IndexDatabase, generation: number, changed: string[], deleted: string[] = []): Promise<void> {
  const result = await applyBuilderJob({ repoRoot: repo, db, job: { id: generation, kind: "refresh", generation, changed, deleted } });
  assert.equal(result.ok, true, result.error);
}

test("a named symbolId survives body edits, line shifts and a full rebuild", async t => {
  const { repo, db } = await fixture(t);
  const key = methodKey(db, serviceRel, "create");
  const symbolId = formatSymbolId(WORKSPACE, key);
  assert.equal(resolveSymbolId(db, WORKSPACE, symbolId).status, "FOUND");

  const service = path.join(repo, serviceRel);
  const original = await readFile(service, "utf8");
  // Blank lines above the class and a body edit: every range moves, the signature does not.
  await writeFile(service, original.replace("@Service", "\n\n// moved down\n@Service").replace("repository.save", "repository.save /* body */"));
  await refresh(repo, db, 2, [serviceRel]);
  assert.equal(methodKey(db, serviceRel, "create"), key);
  assert.deepEqual(resolveSymbolId(db, WORKSPACE, symbolId), { status: "FOUND", declarationKey: key, kind: "method", relativePath: serviceRel });

  const rebuilt = openIndexDb(":memory:");
  try {
    ensureSchema(rebuilt);
    await runSqlColdBuild({ repoRoot: repo, db: rebuilt, generation: 9 });
    assert.equal(formatSymbolId(WORKSPACE, methodKey(rebuilt, serviceRel, "create")), symbolId);
    assert.equal(resolveSymbolId(rebuilt, WORKSPACE, symbolId).status, "FOUND");
  } finally {
    close(rebuilt);
  }
});

test("signature, path or deletion changes report NOT_FOUND with a hint and never rebind", async t => {
  const { repo, db } = await fixture(t);
  const symbolId = formatSymbolId(WORKSPACE, methodKey(db, serviceRel, "create"));
  const service = path.join(repo, serviceRel);
  const original = await readFile(service, "utf8");

  await writeFile(service, original.replace("OrderResponse create(OrderRequest request)", "OrderResponse create(OrderRequest request, int retries)"));
  await refresh(repo, db, 2, [serviceRel]);
  const signature = resolveSymbolId(db, WORKSPACE, symbolId);
  assert.equal(signature.status, "NOT_FOUND");
  assert.equal(signature.status === "NOT_FOUND" && signature.hint.name, "create");
  // The new overload is one of the same-name candidates the caller can re-query; none is bound.
  const sameName = Number((db.prepare("SELECT count(*) AS n FROM entity WHERE kind='method' AND simple_name='create'").get() as { n: number }).n);
  assert.ok(sameName >= 1);
  assert.equal(signature.status === "NOT_FOUND" && signature.hint.sameNameCandidates, sameName);

  await writeFile(service, original);
  await refresh(repo, db, 3, [serviceRel]);
  assert.equal(resolveSymbolId(db, WORKSPACE, symbolId).status, "FOUND");

  const moved = "src/main/java/demospring/OrderService2.java";
  await rename(service, path.join(repo, moved));
  await refresh(repo, db, 4, [moved], [serviceRel]);
  assert.equal(resolveSymbolId(db, WORKSPACE, symbolId).status, "NOT_FOUND");
  assert.notEqual(formatSymbolId(WORKSPACE, methodKey(db, moved, "create")), symbolId);

  await rm(path.join(repo, moved));
  await refresh(repo, db, 5, [], [moved]);
  assert.equal(resolveSymbolId(db, WORKSPACE, symbolId).status, "NOT_FOUND");
});

test("another workspace, pre-mac1 ids and forged encodings are rejected", async t => {
  const { db } = await fixture(t);
  const key = methodKey(db, serviceRel, "create");
  const symbolId = formatSymbolId(WORKSPACE, key);
  assert.deepEqual(resolveSymbolId(db, OTHER_WORKSPACE, symbolId), { status: "REJECTED", reason: "WORKSPACE_MISMATCH" });
  assert.deepEqual(resolveSymbolId(db, WORKSPACE, key), { status: "REJECTED", reason: "PRE_MAC1_FORMAT" });
  assert.deepEqual(resolveSymbolId(db, WORKSPACE, `jsym:mac0:${WORKSPACE}:abc`), { status: "REJECTED", reason: "PRE_MAC1_FORMAT" });
  assert.deepEqual(resolveSymbolId(db, WORKSPACE, `${symbolId}=`), { status: "REJECTED", reason: "MALFORMED" });
  assert.deepEqual(resolveSymbolId(db, WORKSPACE, "hello"), { status: "REJECTED", reason: "MALFORMED" });
  assert.throws(() => formatSymbolId("short", key), /invalid workspaceId/);
  // The shared facts database never carries the workspace.
  assert.equal(db.prepare("SELECT count(*) AS n FROM sym WHERE text LIKE ?").get(`%${WORKSPACE}%`)?.n, 0);
});

test("a local declaration only gets a snapshot evidence handle that goes stale with the source", async t => {
  const { repo, db } = await fixture(t);
  const local = db.prepare("SELECT s.text AS key FROM type t JOIN sym s ON s.id=t.sym JOIN file f ON f.id=t.file_id WHERE f.path=? AND t.simple_name='Inner'").get(localRel) as { key: string } | undefined;
  assert.ok(local);
  assert.equal(declarationStability(local.key), "SNAPSHOT");
  assert.throws(() => formatSymbolId(WORKSPACE, local.key), /evidence handle/);

  const handle = captureEvidenceHandle(db, { snapshotId: "snap-1", captureId: "cap-1", declarationKey: local.key });
  assert.ok(handle);
  assert.equal(handle.relativePath, localRel);
  const text = formatEvidenceHandle(handle);
  assert.deepEqual(parseEvidenceHandle(text), { ok: true, handle });
  assert.equal(checkEvidenceHandle(db, "snap-1", text).status, "VALID");
  assert.deepEqual(checkEvidenceHandle(db, "snap-2", text), { status: "STALE", reason: "SNAPSHOT_CHANGED", handle });

  const named = captureEvidenceHandle(db, { snapshotId: "snap-1", captureId: "cap-2", declarationKey: methodKey(db, serviceRel, "create") })!;
  const namedText = formatEvidenceHandle(named);
  const service = path.join(repo, serviceRel);
  await writeFile(service, (await readFile(service, "utf8")).replace("repository.save", "repository.save /* edit */"));
  await refresh(repo, db, 2, [serviceRel]);
  assert.deepEqual(checkEvidenceHandle(db, "snap-1", namedText), { status: "STALE", reason: "SOURCE_CHANGED", handle: named });

  // Shifting the local class moves its position key: the old handle's declaration is gone.
  const holder = path.join(repo, localRel);
  await writeFile(holder, (await readFile(holder, "utf8")).replace("  void run() {", "\n  void run() {"));
  await refresh(repo, db, 3, [localRel]);
  assert.deepEqual(checkEvidenceHandle(db, "snap-1", text), { status: "STALE", reason: "DECLARATION_GONE", handle });
  assert.deepEqual(checkEvidenceHandle(db, "snap-1", local.key), { status: "REJECTED", reason: "PRE_MAC1_FORMAT" });
});

test("forged keys and malformed evidence ranges are refused without throwing", async t => {
  const { db } = await fixture(t);
  const forged = `jsym:mac1:${WORKSPACE}:${Buffer.from("type:v2:x#%ZZ").toString("base64url")}`;
  assert.equal(resolveSymbolId(db, WORKSPACE, forged).status, "NOT_FOUND");
  const handle = captureEvidenceHandle(db, { snapshotId: "snap-1", captureId: "cap-1", declarationKey: methodKey(db, serviceRel, "create") })!;
  const bad = `jev:mac1:${Buffer.from(JSON.stringify({ ...handle, range: { start: { line: "x", column: 0 }, end: handle.range.end } })).toString("base64url")}`;
  assert.deepEqual(parseEvidenceHandle(bad), { ok: false, reason: "MALFORMED" });
  assert.throws(() => formatEvidenceHandle({ ...handle, range: { ...handle.range, start: { line: -1, column: 0 } } }), /non-negative/);
});
