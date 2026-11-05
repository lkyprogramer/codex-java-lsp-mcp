// input: the compiled product and tiny temporary Java repositories.
// output: public MCP/watcher acceptance; no fake index, watcher or transport.
// pos: R12 K03/K05/K06/K11/K12/K15/K17/K19/K25/K27. MAC-08B: stdio only relays, so each contract runs
//      the stdio entry against one isolated owner daemon (real FSEvents tracker, sealed snapshots).
//      MAC-14: watcher contracts wait for the correct answer at the new hash and name the workspace and
//      capture (snapshot, content manifest) they observed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startOwner, stdioClient, withDaemonLog } from "./ilv2-mac-mcp-owner-fixture.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const pom = name => `<project><modelVersion>4.0.0</modelVersion><groupId>contract</groupId><artifactId>${name}</artifactId><version>1</version></project>`;

/**
 * The two answers come from the same workspace, each from a FRESH view of a different capture: the
 * later one names a new snapshot and content manifest, so the wait ended on the edit's own capture.
 */
function observedCapture(contract, before, after) {
  const [a, b] = [before.indexView, after.indexView];
  assert.ok(a?.workspaceId && a.snapshotId && a.contentManifestId, JSON.stringify(a));
  assert.equal(b?.workspaceId, a.workspaceId, "the same workspace answered");
  assert.equal(b.state, "FRESH");
  assert.notEqual(b.snapshotId, a.snapshotId, "the answer comes from the edit's capture");
  assert.notEqual(b.contentManifestId, a.contentManifestId);
  console.log(JSON.stringify({ contract, workspaceId: b.workspaceId, before: { snapshotId: a.snapshotId, contentManifestId: a.contentManifestId }, after: { snapshotId: b.snapshotId, contentManifestId: b.contentManifestId, coveredThroughSeq: b.coveredThroughSeq } }));
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
async function writeTree(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
}
/** MCP calls of one stdio client for one root. */
function tools(client, repo) {
  const raw = (name, args = {}) => client.callTool({ name, arguments: { repoRoot: repo, ...args } }, undefined, { timeout: 30000 });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("") ?? "";
    assert.notEqual(result.isError, true, text);
    return JSON.parse(text);
  };
  const query = args => call("java_symbol", { preview: "none", ...args });
  const wait = async (action, accepts, label, boundMs = 30000) => {
    const deadline = Date.now() + boundMs;
    let result;
    do {
      result = await action();
      if (accepts(result)) return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.fail(label + ": " + JSON.stringify(result));
  };
  return { raw, call, query, wait };
}
/**
 * One isolated owner over named roots. With linked, the first root is a git repository and every
 * other root is a linked worktree of it whose listed files then replace the committed ones.
 */
async function owned(t, name, { roots, linked = false }, body) {
  const ids = Object.keys(roots);
  const dirs = {};
  const owner = await startOwner(t, name, {
    async prepare(root) {
      for (const [i, id] of ids.entries()) {
        dirs[id] = path.join(root, id);
        if (linked && i > 0) git(dirs[ids[0]], "worktree", "add", "-q", "--detach", dirs[id]);
        await writeTree(dirs[id], roots[id]);
        if (linked && i === 0) {
          git(dirs[id], "init", "-q"); git(dirs[id], "add", ".");
          git(dirs[id], "-c", "user.name=Contract", "-c", "user.email=contract@example.invalid", "commit", "-qm", "fixture");
        }
      }
      return ids.map(id => dirs[id]);
    },
    projects: list => ({ aliases: list.map((root, i) => ({ id: ids[i], root, lspEnabled: false })), defaults: {} })
  });
  return withDaemonLog(owner, async () => {
    const byRoot = {};
    for (const id of ids) byRoot[id] = { root: dirs[id], ...tools((await stdioClient(owner, dirs[id])).client, dirs[id]) };
    await body({ owner, roots: byRoot });
  });
}
const snapshotDbOf = (owner, view) => new DatabaseSync(path.join(owner.cache, "mac1", "snapshots", view.snapshotId, "index.sqlite"), { readOnly: true });

async function fixture(t, body) {
  let repo, put, launched, providerCalls;
  const a = "m1/src/main/java/demo/Shared.java";
  const b = "m2/src/main/java/demo/Shared.java";
  const wordFile = "m2/src/main/java/demo/WordService.java";
  const target = "m2/src/test/java/demo/ScopedRefund.java";
  let bText;
  const prepare = async root => {
    repo = path.join(root, "repo");
    put = async (relative, text) => {
      await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
      await writeFile(path.join(repo, relative), text);
      return text;
    };
    await put("pom.xml", pom("root"));
    await put("m1/pom.xml", pom("m1"));
    await put("m2/pom.xml", pom("m2"));
    await put(a, "package demo; public class Shared { public void alpha() { helper(); } private void helper() {} }\n");
    bText = await put(b, "package demo; public class Shared { public void beta() {} }\n");
    await put(wordFile, "package demo;\n/** 琥珀结算 */\npublic class WordService {}\n");
    for (let i = 0; i < 25; i++) {
      await put(`m1/src/main/java/noise/Refund${i}.java`, `package noise; /** refund ledger refund ledger */ public class Refund${i} {}\n`);
    }
    await put(target, "package demo; /** refund ledger */ public class ScopedRefund {}\n");
    await put("m2/src/main/java/demo/OtherRefund.java", "package demo; /** refund ledger */ public class OtherRefund {}\n");
    launched = path.join(root, "jdt-launches");
    providerCalls = path.join(root, "provider-calls");
    const jdt = path.join(root, "jdt-forbidden.sh");
    await writeFile(jdt, '#!/bin/sh\nprintf "launched\\n" >> "$RELEASE_JDT_LAUNCH_FILE"\nexit 97\n');
    await chmod(jdt, 0o700);
    return [repo];
  };
  const owner = await startOwner(t, "release", {
    prepare,
    projects: repos => ({ aliases: [{ id: "fixture", root: repos[0], lspEnabled: true }], defaults: {} }),
    env: root => ({ JDTLS_BIN: path.join(root, "jdt-forbidden.sh"), RELEASE_JDT_LAUNCH_FILE: path.join(root, "jdt-launches"), RELEASE_PROVIDER_CALL_FILE: path.join(root, "provider-calls") }),
    // Any provider fetch in the owner is recorded and refused (K27).
    preload: 'import {appendFileSync} from "node:fs"; globalThis.fetch=async()=>{appendFileSync(process.env.RELEASE_PROVIDER_CALL_FILE,"fetch\\n");throw new Error("provider disabled");};'
  });
  return withDaemonLog(owner, async () => {
    const { client } = await stdioClient(owner, repo);
    const raw = (name, args = {}) => client.callTool({ name, arguments: { repoRoot: repo, ...args } }, undefined, { timeout: 30000 });
    const call = async (name, args = {}) => {
      const result = await raw(name, args);
      const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("") ?? "";
      assert.notEqual(result.isError, true, text);
      return JSON.parse(text);
    };
    const query = args => call("java_symbol", { preview: "none", ...args });
    const wait = async (action, accepts, label) => {
      const deadline = Date.now() + 15000;
      let result;
      do {
        result = await action();
        if (accepts(result)) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      assert.fail(label + ": " + JSON.stringify(result));
    };
    // The bound snapshot's sealed database: what a request at that snapshot read.
    const snapshotDb = async () => {
      const status = await call("java_status", {});
      const snapshotId = status.indexView?.snapshotId;
      assert.ok(snapshotId, JSON.stringify(status.indexView));
      return new DatabaseSync(path.join(owner.cache, "mac1", "snapshots", snapshotId, "index.sqlite"), { readOnly: true });
    };
    await query({ query: "Shared", searchMode: "exact" });
    const status = await wait(() => call("java_status", { detail: "diagnostic", start: false }), value => value.indexView?.state === "FRESH", "tracked snapshot fresh");
    await body({ root: owner.root, repo, put, a, b, bText, wordFile, target, raw, call, query, wait, status, launched, providerCalls, snapshotDb });
  });
}

test("K05: the real watcher deletes one duplicate declaration without deleting its sibling", { timeout: 45000 }, async t => {
  await fixture(t, async ({ repo, a, b, bText, query, wait, snapshotDb }) => {
    const before = await query({ query: "Shared", searchMode: "exact" });
    assert.equal(before.exact, "ambiguous");
    assert.equal(before.candidates.length, 2);
    const beforeDb = await snapshotDb();
    let removedFileId, removedSymbols;
    try {
      removedFileId = beforeDb.prepare("SELECT id FROM file WHERE path=?").get(a).id;
      removedSymbols = beforeDb.prepare("SELECT sym FROM type WHERE file_id=? UNION SELECT sym FROM method WHERE file_id=?").all(removedFileId, removedFileId).map(row => row.sym);
      assert.ok(removedSymbols.length >= 3);
      const edges = beforeDb.prepare("SELECT count(*) AS n FROM edge WHERE file_id=?").get(removedFileId).n;
      assert.ok(edges > 0, "deletion must begin with a real call edge");
      console.log(JSON.stringify({ contract: "K05", before: { declarations: removedSymbols.length, edges } }));
    } finally { beforeDb.close(); }
    await rm(path.join(repo, a));
    const after = await wait(() => query({ query: "Shared", searchMode: "exact" }), value => value.generation > before.generation && value.scopeState === "READY" && value.candidates.length === 1, "delete generation");
    assert.equal(after.candidates[0].declaration.relativePath, b);
    assert.equal(after.candidates[0].declaration.contentHash, digest(bText));
    observedCapture("K05", before, after);
    const db = await snapshotDb();
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM file WHERE path=?").get(a).n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM file WHERE path=?").get(b).n, 1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM search_doc d JOIN sym s ON d.path_sym=s.id WHERE s.text=?").get(a).n, 0);
      for (const table of ["type", "method", "edge"]) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE file_id=?`).get(removedFileId).n, 0);
      for (const sym of removedSymbols) assert.equal(db.prepare("SELECT count(*) AS n FROM edge WHERE from_sym=? OR to_sym=?").get(sym, sym).n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM edge e LEFT JOIN file f ON e.file_id=f.id WHERE f.id IS NULL").get().n, 0);
    } finally { db.close(); }
  });
});

test("K12: public MCP rejects a zero deadline explicitly and settles the request", { timeout: 45000 }, async t => {
  await fixture(t, async ({ raw }) => {
    const began = performance.now();
    const result = await raw("java_impact", { file: "m2/src/main/java/demo/WordService.java", line: 3, column: 14, semanticPolicy: "fast", deadlineMs: 0 });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /deadlineMs|greater|positive|>=1/);
    assert.ok(performance.now() - began < 5000);
  });
});

test("K15: a Chinese JavaDoc-only edit becomes visible through the real watcher at its new hash", { timeout: 45000 }, async t => {
  await fixture(t, async ({ put, wordFile, query, wait }) => {
    const before = await query({ query: "琥珀结算", searchMode: "text" });
    assert.ok(before.candidates.some(item => item.declaration.relativePath === wordFile));
    const content = await put(wordFile, "package demo;\n/** 翡翠核销 */\npublic class WordService {}\n");
    const after = await wait(() => query({ query: "翡翠核销", searchMode: "text" }), value => value.scopeState === "READY" && value.generation > before.generation && value.candidates.some(item => item.declaration.contentHash === digest(content)), "comment generation");
    assert.ok(after.candidates.every(item => item.declaration.contentHash === digest(content)));
    observedCapture("K15", before, after);
    const old = await query({ query: "琥珀结算", searchMode: "text" });
    assert.equal(old.scopeState, "READY");
    assert.equal(old.candidates.length, 0);
  });
});

test("K17: public MCP applies module AND source-set before the candidate limit", { timeout: 45000 }, async t => {
  await fixture(t, async ({ target, query, snapshotDb }) => {
    const result = await query({ query: "refund ledger", searchMode: "text", module: "m2", sourceSet: "test", limit: 1 });
    assert.equal(result.scopeState, "READY");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].declaration.relativePath, target);
    const unknown = await query({ query: "refund ledger", searchMode: "text", module: "missing", limit: 1 });
    assert.equal(unknown.candidates.length, 0);
    assert.equal(unknown.scope.reason, "UNKNOWN_MODULE");
    const broad = await query({ query: "refund", searchMode: "text", module: "m1", limit: 1, detail: "diagnostic" });
    assert.equal(broad.scopeState, "READY");
    assert.equal(broad.candidates.length, 1);
    assert.ok(broad.candidates.every(item => item.declaration.relativePath.startsWith("m1/")));
    assert.equal(broad.selectionLimited, true);
    assert.equal(broad.truncated, false, "ranked top-K must not be mislabeled as budget truncation");
    assert.equal(broad.stopReason, undefined);
    // Public MCP deliberately omits internal work counters. Read the same live
    // database through the production search layer for supplementary measurement.
    const { SqlEntitySearch } = await import("../dist/java-index/sql/entity-search.js");
    const db = await snapshotDb();
    try {
      const search = new SqlEntitySearch(db);
      const options = { scope: { sourceRoots: ["m1/src/main/java"] }, budget: { maxPostings: 20_000, remainingMs: () => 10_000 } };
      const measured = search.searchDetailed("refund", 1, "text", options);
      assert.ok(Number.isFinite(measured.work.postings) && measured.work.postings > 0 && measured.work.postings <= 20_000);
      assert.ok(Number.isFinite(measured.work.examined) && measured.work.examined >= measured.work.postings && measured.work.examined <= 1000);
      assert.equal(measured.hits[0].relativePath, broad.candidates[0].declaration.relativePath);
      const bounded = search.searchDetailed("refund", 1, "text", { ...options, budget: { maxPostings: 2, remainingMs: () => 10_000 } });
      assert.equal(bounded.truncated, true);
      assert.equal(bounded.stopReason, "postings");
      assert.equal(bounded.work.postings, 2);
      console.log(JSON.stringify({ contract: "K17", broad, supplementarySql: { measured, bounded } }));
    } finally { db.close(); }
  });
});

test("K19: real watcher add rename and delete invalidate negative and positive lookups", { timeout: 45000 }, async t => {
  await fixture(t, async ({ repo, put, query, wait }) => {
    const initial = await query({ query: "demo.Later", searchMode: "exact" });
    assert.equal(initial.exact, "miss");
    const old = "m2/src/main/java/demo/Later.java";
    await put(old, "package demo; public class Later {}\n");
    const added = await wait(() => query({ query: "demo.Later", searchMode: "exact" }), value => value.generation > initial.generation && value.scopeState === "READY" && value.exact === "match", "add");
    const next = "m2/src/main/java/demo/Renamed.java";
    await rename(path.join(repo, old), path.join(repo, next));
    await put(next, "package demo; public class Renamed {}\n");
    const renamed = await wait(() => query({ query: "demo.Renamed", searchMode: "exact" }), value => value.generation > added.generation && value.scopeState === "READY" && value.exact === "match", "rename");
    assert.equal(renamed.candidates[0].declaration.relativePath, next);
    assert.equal((await query({ query: "demo.Later", searchMode: "exact" })).exact, "miss");
    await rm(path.join(repo, next));
    const deleted = await wait(() => query({ query: "demo.Renamed", searchMode: "exact" }), value => value.generation > renamed.generation && value.scopeState === "READY" && value.exact === "miss", "delete");
    assert.equal(deleted.candidates.length, 0);
    observedCapture("K19", initial, added); observedCapture("K19", added, renamed); observedCapture("K19", renamed, deleted);
  });
});

test("K25: static queries use the real MCP protocol with zero JDT launches", { timeout: 45000 }, async t => {
  await fixture(t, async ({ call, query, launched }) => {
    assert.equal((await query({ query: "demo.WordService", searchMode: "exact" })).exact, "match");
    const status = await call("java_status", { detail: "diagnostic", start: false });
    assert.equal(status.started, false);
    assert.equal(status.javaIndex.state, "READY");
    assert.equal(existsSync(launched), false, "the forbidden JDT executable must never run");
  });
});

test("K27: the shipped disabled provider boundary keeps lexical MCP queries usable with zero fetches", { timeout: 45000 }, async t => {
  await fixture(t, async ({ query, providerCalls }) => {
    const known = await query({ query: "demo.WordService", searchMode: "exact" });
    assert.equal(known.scopeState, "READY");
    assert.equal(known.exact, "match");
    const missing = await query({ query: "demo.NoSuchClass", searchMode: "exact" });
    assert.equal(missing.exact, "miss");
    assert.equal(existsSync(providerCalls), false);
  });
});

test("K03: a main/test duplicate FQN stays ambiguous until the sourceSet scope selects one", { timeout: 45000 }, async t => {
  const main = "src/main/java/demo/Shared.java", testPath = "src/test/java/demo/Shared.java";
  await owned(t, "k03", { roots: { repo: { "pom.xml": pom("k03"), [main]: "package demo; public class Shared { void production() {} }\n", [testPath]: "package demo; public class Shared { void fixtureOnly() {} }\n" } } }, async ({ roots: { repo } }) => {
    const all = await repo.wait(() => repo.query({ query: "demo.Shared", searchMode: "exact" }), value => value.indexView?.state === "FRESH" && value.scopeState === "READY", "fresh");
    assert.equal(all.exact, "ambiguous");
    assert.deepEqual(new Set(all.candidates.map(c => c.declaration.relativePath)), new Set([main, testPath]));
    for (const [sourceSet, expected] of [["main", main], ["test", testPath]]) {
      const selected = await repo.query({ query: "demo.Shared", searchMode: "exact", sourceSet });
      assert.equal(selected.scopeState, "READY");
      assert.deepEqual(selected.candidates.map(c => c.declaration.relativePath), [expected]);
    }
    console.log(JSON.stringify({ contract: "K03", indexView: all.indexView }));
  });
});

test("K06: six linked worktrees answer concurrently, each only from its own Java and XML content", { timeout: 120000 }, async t => {
  const java = "src/main/java/demo/Shared.java", xml = "src/main/resources/mapper/SharedMapper.xml";
  const content = i => ({
    [java]: `package demo; public class Shared { void only${i}() {} }\n`,
    [xml]: `<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="demo.Shared"><select id="find${i}">select ${i}</select></mapper>\n`
  });
  const roots = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`wt${i}`, i === 0 ? { "pom.xml": pom("k06"), ...content(i) } : content(i)]));
  await owned(t, "k06", { roots, linked: true }, async ({ owner, roots: clients }) => {
    const ids = Object.keys(clients);
    const own = id => digest(content(ids.indexOf(id))[java]);
    const foreign = id => new Set(ids.filter(other => other !== id).map(own));
    const observations = [];
    // All six start together: no worktree waits on a sibling's round, and until its own binding is
    // verified a worktree answers NOT_READY, never from a sibling's (or a building) snapshot.
    const started = performance.now();
    const fresh = await Promise.all(ids.map(id => clients[id].wait(async () => {
      const result = await clients[id].raw("java_symbol", { query: "demo.Shared", searchMode: "exact", preview: "none" });
      const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("") ?? "";
      if (result.isError) {
        // Before its own verified binding, the static query refuses explicitly instead of answering.
        assert.match(text, /not ready/i, `${id}: ${text}`);
        observations.push({ id, state: "NOT_READY", refused: true, atMs: performance.now() - started });
        return undefined;
      }
      const value = JSON.parse(text);
      observations.push({ id, state: value.indexView?.state, scopeState: value.scopeState, hashes: value.candidates.map(c => c.declaration.contentHash), atMs: performance.now() - started });
      for (const c of value.candidates) assert.ok(!foreign(id).has(c.declaration.contentHash), `${id} answered with a sibling's content`);
      if (value.indexView?.state === "NOT_READY") assert.equal(value.scopeState === "READY" && value.candidates.length > 0, false, "an unverified view is not READY");
      return value;
    }, value => value?.indexView?.state === "FRESH" && value.scopeState === "READY", `${id} fresh`, 90000)));
    for (const [i, id] of ids.entries()) {
      const value = fresh[i];
      assert.deepEqual(value.candidates.map(c => [c.declaration.relativePath, c.declaration.contentHash]), [[java, own(id)]]);
      const db = snapshotDbOf(owner, value.indexView);
      try {
        const methods = db.prepare("SELECT name FROM method").all().map(row => row.name);
        assert.deepEqual(methods, [`only${i}`], `${id} snapshot holds only its own Java`);
        const resource = db.prepare("SELECT content_hash AS hash FROM mybatis_resource WHERE path=?").get(xml);
        assert.equal(resource?.hash, digest(content(i)[xml]), `${id} snapshot holds its own XML`);
      } finally { db.close(); }
    }
    assert.equal(new Set(fresh.map(value => value.indexView.workspaceId)).size, 6, "one workspace per worktree");
    assert.equal(new Set(fresh.map(value => value.indexView.contentManifestId)).size, 6, "one capture per worktree content");
    console.log(JSON.stringify({ contract: "K06", worktrees: ids.map((id, i) => ({ id, indexView: fresh[i].indexView })), observations: observations.length,
      notReadyObservations: observations.filter(o => o.state === "NOT_READY").length }));
  });
});

test("K11: a real refresh keeps the call fact and moves the helper's evidence to its new range", { timeout: 45000 }, async t => {
  const main = "src/main/java/demo/Shared.java";
  const before = "package demo;\npublic class Shared {\n  void caller() { helper(); }\n  void helper() {}\n}\n";
  const after = "package demo;\npublic class Shared {\n  void helper() {}\n  void caller() { helper(); }\n}\n";
  await owned(t, "k11", { roots: { repo: { "pom.xml": pom("k11"), [main]: before } } }, async ({ owner, roots: { repo } }) => {
    const helper = () => repo.query({ query: "demo.Shared#helper", searchMode: "exact", preview: "window" });
    const first = await repo.wait(helper, value => value.indexView?.state === "FRESH" && value.scopeState === "READY" && value.candidates.length === 1, "fresh");
    assert.equal(first.candidates[0].declaration.selection.line, 4);
    const callFact = view => {
      const db = snapshotDbOf(owner, view);
      try {
        return db.prepare("SELECT e.sl AS line, s.text AS helper FROM edge e JOIN method f ON e.from_sym=f.sym JOIN method g ON e.to_sym=g.sym JOIN sym s ON s.id=g.sym WHERE f.name='caller' AND g.name='helper'").all();
      } finally { db.close(); }
    };
    const [old] = callFact(first.indexView);
    assert.equal(old?.line, 3);
    await writeFile(path.join(repo.root, main), after);
    const moved = await repo.wait(helper, value => value.scopeState === "READY" && value.candidates[0]?.declaration.contentHash === digest(after), "moved helper at its new hash");
    const candidate = moved.candidates[0];
    assert.equal(candidate.declaration.symbolId, first.candidates[0].declaration.symbolId, "the named method ID survives the move");
    assert.equal(candidate.declaration.selection.line, 3);
    assert.equal(candidate.evidenceRange?.startLine, 3);
    assert.ok(candidate.preview?.startsWith("  void helper()"), candidate.preview);
    const [now, ...extra] = callFact(moved.indexView);
    assert.deepEqual([now?.line, now?.helper, extra.length], [4, old.helper, 0], "the explicit call fact stays and moves with its caller");
    observedCapture("K11", first, moved);
  });
});
