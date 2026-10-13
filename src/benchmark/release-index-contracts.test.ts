// Release contracts exercised through real parser, SQLite, query worker and builder.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runStaticDiscovery } from "../discovery/query.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { applyBuilderJob } from "../index-builder/incremental.js";
import { BuilderSupervisor } from "../java-index/builder-supervisor.js";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";
import { resolveWorktreeIdentity } from "../worktree-identity.js";

const exec = promisify(execFile);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const main = "src/main/java/demo/Shared.java";
const pom = '<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>contract</artifactId><version>1</version></project>';
async function put(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}
async function cold(root: string, dbPath: string) {
  const db = openIndexDb(dbPath);
  try { ensureSchema(db); await runSqlColdBuild({ repoRoot: root, db, generation: 1 }); }
  finally { close(db); }
}
async function fixture(files: Record<string, string>) {
  const home = await mkdtemp(path.join(tmpdir(), "release-index-contract-"));
  const root = path.join(home, "repo");
  await put(root, { "pom.xml": pom, ...files });
  const dbPath = path.join(home, "index.sqlite");
  await cold(root, dbPath);
  const client = new SqlJavaIndexClient(root, dbPath);
  await client.open(1);
  return { home, root, dbPath, client, async dispose() { await client.close(); await rm(home, { recursive: true, force: true }); } };
}
async function until(condition: () => boolean | Promise<boolean>, bound: number) {
  const deadline = Date.now() + bound;
  do { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  assert.fail(`condition did not converge within frozen ${bound}ms bound`);
}

test("K03: real main/test duplicate FQN remains ambiguous until sourceSet scope", { timeout: 30_000 }, async () => {
  const testPath = "src/test/java/demo/Shared.java";
  const f = await fixture({ [main]: "package demo; public class Shared { void production() {} }", [testPath]: "package demo; public class Shared { void fixtureOnly() {} }" });
  try {
    const all = await runStaticDiscovery(f.client, { repoRoot: f.root, query: "demo.Shared", searchMode: "exact" });
    assert.equal(all.candidates.length, 2);
    assert.ok(all.candidates.every(c => c.binding === "ambiguous"));
    assert.deepEqual(new Set(all.candidates.map(c => c.declaration.relativePath)), new Set([main, testPath]));
    for (const [sourceSet, expected] of [["main", main], ["test", testPath]] as const) {
      const selected = await runStaticDiscovery(f.client, { repoRoot: f.root, query: "demo.Shared", searchMode: "exact", sourceSet });
      assert.equal(selected.scopeState, "READY");
      assert.deepEqual(selected.candidates.map(c => c.declaration.relativePath), [expected]);
    }
    console.log(JSON.stringify({ contract: "K03", generation: all.generation, coverage: (await f.client.status()).coverage }));
  } finally { await f.dispose(); }
});

async function worktrees(files: Record<string, string>) {
  const home = await mkdtemp(path.join(tmpdir(), "release-worktrees-"));
  const repo = path.join(home, "base");
  await put(repo, { "pom.xml": pom, ...files });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args], { env });
  await git("init", "-q"); await git("add", ".");
  await git("-c", "user.name=Contract", "-c", "user.email=contract@example.invalid", "commit", "-qm", "fixture");
  const a = path.join(home, "a"), b = path.join(home, "b");
  await git("worktree", "add", "-q", "-b", "a", a);
  await git("worktree", "add", "-q", "-b", "b", b);
  return { home, a, b, env };
}

test("K06: linked worktree queries retain local identity and source hash", { timeout: 30_000 }, async () => {
  const w = await worktrees({ [main]: "package demo; public class Shared {}" });
  const clients: SqlJavaIndexClient[] = [];
  try {
    const ids = await Promise.all([resolveWorktreeIdentity(w.a), resolveWorktreeIdentity(w.b)]);
    assert.ok(ids.every(i => i.isLinkedWorktree));
    assert.equal(ids[0]!.familyHash, ids[1]!.familyHash);
    assert.notEqual(ids[0]!.repoHash, ids[1]!.repoHash);
    const entities: string[] = [];
    for (const [i, root] of [w.a, w.b].entries()) {
      const text = `package demo; public class Shared { void ${i === 0 ? "alphaOnly" : "betaOnly"}() {} }`;
      await put(root, { [main]: text });
      const dbPath = path.join(w.home, `index-${i}.sqlite`);
      await cold(root, dbPath);
      const client = new SqlJavaIndexClient(root, dbPath); clients.push(client); await client.open(1);
      const result = await runStaticDiscovery(client, { repoRoot: root, repoHash: ids[i]!.repoHash, query: "demo.Shared", searchMode: "exact", preview: "window" });
      assert.equal(result.repoHash, ids[i]!.repoHash);
      assert.equal(result.scopeState, "READY"); assert.equal(result.candidates.length, 1);
      const c = result.candidates[0]!; entities.push(c.declaration.id);
      assert.equal(c.declaration.contentHash, sha(text)); assert.equal(c.evidenceRange?.contentHash, sha(text));
      assert.ok(c.preview?.includes(i === 0 ? "alphaOnly" : "betaOnly"));
      assert.ok(!c.preview?.includes(i === 0 ? "betaOnly" : "alphaOnly"));
      console.log(JSON.stringify({ contract: "K06", repoHash: result.repoHash, sourceHash: c.declaration.contentHash, generation: result.generation }));
    }
    assert.equal(entities[0], entities[1], "named IDs may coincide across isolated repositories");
  } finally { for (const c of clients) await c.close(); await rm(w.home, { recursive: true, force: true }); }
});

test("K11: real builder refresh preserves call facts and relocates moved helper evidence", { timeout: 30_000 }, async () => {
  const before = "package demo;\npublic class Shared {\n  void caller() { helper(); }\n  void helper() {}\n}\n";
  const after = "package demo;\npublic class Shared {\n  void helper() {}\n  void caller() { helper(); }\n}\n";
  const f = await fixture({ [main]: before });
  await f.client.close();
  const supervisor = new BuilderSupervisor({ repoRoot: f.root, dbPath: f.dbPath, idleMs: 500, env: { HOME: f.home, XDG_CONFIG_HOME: path.join(f.home, "config") } });
  const client = new SqlJavaIndexClient(f.root, f.dbPath, supervisor);
  try {
    await client.open(1);
    const old = (await client.queryFiles([main]))[0]!;
    const helperId = old.methods.find(m => m.name === "helper")!.methodId;
    assert.equal(old.methods.find(m => m.name === "caller")!.callSites[0]!.name, "helper");
    await put(f.root, { [main]: after });
    const updated = await client.refresh(2, [main], []);
    assert.equal(updated.state, "READY"); assert.equal(updated.indexedGeneration, 2);
    const bundle = (await client.queryFiles([main]))[0]!;
    assert.equal(bundle.methods.find(m => m.name === "helper")!.methodId, helperId);
    assert.equal(bundle.methods.find(m => m.name === "caller")!.callSites[0]!.name, "helper");
    const result = await runStaticDiscovery(client, { repoRoot: f.root, query: "demo.Shared#helper", searchMode: "exact", preview: "window" });
    assert.equal(result.scopeState, "READY"); assert.equal(result.generation, 2);
    assert.equal(result.candidates[0]!.declaration.selection.line, 3);
    assert.equal(result.candidates[0]!.evidenceRange?.startLine, 3);
    assert.equal(result.candidates[0]!.declaration.contentHash, sha(after));
    assert.ok(result.candidates[0]!.preview?.startsWith("  void helper()"));
    console.log(JSON.stringify({ contract: "K11", generation: result.generation, sourceHash: sha(after), range: result.candidates[0]!.evidenceRange }));
  } finally { await client.close(); await supervisor.stop(); await f.dispose(); }
});

test("K20: real writer commit between query snapshot and preview cannot yield mixed READY evidence", { timeout: 30_000 }, async () => {
  const before = "package demo;\npublic class Shared { void refund() {} }\n";
  const after = "package demo;\n\npublic class Shared { void refund() {} }\n";
  const f = await fixture({ [main]: before });
  const writer = openIndexDb(f.dbPath);
  try {
    const original = f.client.querySearch.bind(f.client);
    let barrier = false;
    f.client.querySearch = async (...args) => {
      const snapshot = await original(...args);
      assert.equal(snapshot.generation, 1);
      assert.ok(snapshot.hits.length);
      await put(f.root, { [main]: after });
      const committed = await applyBuilderJob({ repoRoot: f.root, db: writer, job: { kind: "refresh", generation: 2, changed: [main] } });
      assert.equal(committed.ok, true, committed.error); assert.equal(committed.indexedGeneration, 2);
      barrier = true;
      return snapshot;
    };
    const result = await runStaticDiscovery(f.client, { repoRoot: f.root, query: "demo.Shared#refund", searchMode: "exact", preview: "window" });
    assert.equal(barrier, true);
    assert.equal(result.generation, 1);
    assert.equal(result.scopeState, "PARTIAL");
    assert.ok(["source_changed", "changed_during_request"].includes(result.stopReason!));
    assert.equal(result.candidates.length, 0, "old hash locator must not be coupled to the new file's preview");
    assert.equal((await f.client.status()).indexedGeneration, 2);
    console.log(JSON.stringify({ contract: "K20", hitsGeneration: result.generation, committedGeneration: 2, stopReason: result.stopReason }));
  } finally { close(writer); await f.dispose(); }
});

test("K21: real sibling copy reconciles changed XML before READY without Java changes", { timeout: 30_000 }, async () => {
  const xmlPath = "src/main/resources/Mapper.xml";
  const javaPath = "src/main/java/demo/Mapper.java";
  const java = "package demo; public interface Mapper { int load(); }";
  const xml = '<mapper namespace="demo.Mapper">\n<select id="load">SELECT oldledger FROM oldledger</select>\n</mapper>\n';
  const changed = xml.replaceAll("oldledger", "newledger");
  const w = await worktrees({ [javaPath]: java, [xmlPath]: xml });
  const sibling = path.join(w.home, "sibling.sqlite"), dest = path.join(w.home, "dest.sqlite");
  const supervisor = new BuilderSupervisor({ repoRoot: w.b, dbPath: dest, idleMs: 500, maxRestarts: 0, env: w.env });
  const client = new SqlJavaIndexClient(w.b, dest, supervisor);
  try {
    await cold(w.a, sibling);
    await put(w.b, { [xmlPath]: changed });
    const opened = await client.open(2, { siblingDbPath: sibling });
    assert.equal(opened.state, "READY"); assert.equal(opened.indexedGeneration, 2);
    assert.equal((await client.queryFiles([javaPath]))[0]!.file.contentHash, sha(java));
    const result = await runStaticDiscovery(client, { repoRoot: w.b, query: "mybatis", searchMode: "text", preview: "window" });
    assert.equal(result.scopeState, "READY"); assert.ok(result.candidates.length);
    const evidence = result.candidates.find(c => c.evidenceRange?.relativePath === xmlPath)!;
    assert.ok(evidence, "real parsed resource search document is reachable");
    assert.equal(evidence.declaration.contentHash, sha(java)); assert.equal(evidence.evidenceRange!.contentHash, sha(changed));
    assert.ok(evidence.preview?.includes("newledger")); assert.ok(!evidence.preview?.includes("oldledger"));
    const db = openIndexDb(dest, { readOnly: true });
    try {
      const docs = db.prepare("SELECT d.content_hash AS hash FROM search_doc d JOIN sym s ON s.id=d.source_path_sym WHERE s.text=?").all(xmlPath) as { hash: string }[];
      assert.ok(docs.length);
      assert.ok(docs.every(d => d.hash === sha(changed)), "all XML documents are reconciled; no stale sibling evidence survives");
    } finally { close(db); }
    console.log(JSON.stringify({ contract: "K21", generation: result.generation, javaHash: sha(java), xmlHash: evidence.evidenceRange!.contentHash }));
  } finally { await client.close(); await supervisor.stop(); await rm(w.home, { recursive: true, force: true }); }
});

test("K30: actual query readers release by idle TTL and checkpoint converges without deleting DB", { timeout: 30_000 }, async () => {
  const f = await fixture({ [main]: "package demo; public class Shared { void refund() {} }" });
  await f.client.close();
  const idleTtlMs = 80, checkpointGraceMs = 1500;
  const client = new SqlJavaIndexClient(f.root, f.dbPath, undefined, idleTtlMs);
  const writer = openIndexDb(f.dbPath);
  const wal = `${f.dbPath}-wal`;
  const walBytes = () => existsSync(wal) ? statSync(wal).size : 0;
  try {
    writer.exec("PRAGMA wal_autocheckpoint=0");
    await client.open(1);
    writer.exec("CREATE TABLE contract_wal(payload TEXT)");
    const insert = writer.prepare("INSERT INTO contract_wal VALUES (?)");
    for (let i = 0; i < 8; i++) {
      insert.run("x".repeat(2048));
      const result = await runStaticDiscovery(client, { repoRoot: f.root, query: "demo.Shared", searchMode: "exact" });
      assert.equal(result.scopeState, "READY");
    }
    const writtenBytes = walBytes(); assert.ok(writtenBytes > 0);
    const stoppedAt = Date.now();
    await until(() => (client as unknown as { db?: unknown }).db === undefined && walBytes() === 0, idleTtlMs + checkpointGraceMs);
    assert.ok(existsSync(f.dbPath), "database remains present");
    assert.equal((writer.prepare("SELECT count(*) AS n FROM contract_wal").get() as { n: number }).n, 8);
    console.log(JSON.stringify({ contract: "K30", idleTtlMs, checkpointGraceMs, writtenBytes, finalBytes: walBytes(), elapsedMs: Date.now() - stoppedAt }));
  } finally { close(writer); await client.close(); await f.dispose(); }
});

test("K23: parent self-call dispatch matches fresh cold after adding and deleting a child override", async () => {
  const { SqlFactsStore } = await import("../java-index/sql/facts-store.js");
  const { SqlKnowledgeGraph } = await import("../java-index/sql/knowledge-graph.js");
  const root = await mkdtemp(path.join(tmpdir(), "release-dispatch-self-call-"));
  const parentPath = "src/main/java/Parent.java", childPath = "src/main/java/Child.java";
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  const observe = (index: typeof db) => {
    const store = new SqlFactsStore(index), graph = new SqlKnowledgeGraph(index);
    const run = store.files([parentPath])[0]!.methods.find(method => method.name === "run")!;
    const id = graph.nodeIdForJavaIndexId(run.methodId)!;
    return (["CALLS_EXACT", "CALLS_VIRTUAL"] as const).flatMap(kind => graph.successors(id, kind).map(edge => ({
      kind, toId: edge.toId, dispatch: graph.successors(edge.toId, "DISPATCHES_TO").map(target => target.toId).sort()
    })));
  };
  try {
    await put(root, { [parentPath]: "class Parent { void save() {} void run() { save(); } }" });
    await runSqlColdBuild({ repoRoot: root, db });
    assert.equal(observe(db)[0]!.kind, "CALLS_EXACT");
    for (const [generation, add] of [[2, true], [3, false]] as const) {
      if (add) await put(root, { [childPath]: "class Child extends Parent { void save() {} }" });
      else await rm(path.join(root, childPath));
      const result = await applyBuilderJob({ repoRoot: root, db, job: { kind: "refresh", generation,
        changed: add ? [childPath] : [], deleted: add ? [] : [childPath] } });
      assert.equal(result.ok, true, result.error);
      const fresh = openIndexDb(":memory:"); ensureSchema(fresh);
      try {
        await runSqlColdBuild({ repoRoot: root, db: fresh });
        assert.deepEqual(observe(db), observe(fresh), `${add ? "add" : "delete"} override must update the parent's self-call`);
        assert.equal(observe(db)[0]!.kind, add ? "CALLS_VIRTUAL" : "CALLS_EXACT");
      } finally { close(fresh); }
    }
  } finally { close(db); await rm(root, { recursive: true, force: true }); }
});
