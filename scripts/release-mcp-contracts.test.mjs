// input: the compiled product and tiny temporary Java repositories.
// output: public MCP/watcher acceptance; no fake index, watcher or transport.
// pos: R12 K05/K12/K15/K17/K19/K25/K27.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isolatedValidationEnvironment } from "./run-isolated-validation.mjs";

const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = value => createHash("sha256").update(value).digest("hex");
const pom = name => `<project><modelVersion>4.0.0</modelVersion><groupId>contract</groupId><artifactId>${name}</artifactId><version>1</version></project>`;

async function fixture(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-mcp-contract-"));
  const repo = path.join(root, "repo");
  const put = async (relative, text) => {
    await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
    await writeFile(path.join(repo, relative), text);
    return text;
  };
  const env = isolatedValidationEnvironment(root);
  for (const name of ["home", "tmp", "cache", "xdg-cache", "xdg-config", "xdg-data", "xdg-state"]) {
    await mkdir(path.join(root, name), { recursive: true });
  }
  await put("pom.xml", pom("root"));
  const a = "m1/src/main/java/demo/Shared.java";
  const b = "m2/src/main/java/demo/Shared.java";
  await put("m1/pom.xml", pom("m1"));
  await put("m2/pom.xml", pom("m2"));
  await put(a, "package demo; public class Shared { public void alpha() { helper(); } private void helper() {} }\n");
  const bText = await put(b, "package demo; public class Shared { public void beta() {} }\n");
  const wordFile = "m2/src/main/java/demo/WordService.java";
  await put(wordFile, "package demo;\n/** 琥珀结算 */\npublic class WordService {}\n");
  for (let i = 0; i < 25; i++) {
    await put(`m1/src/main/java/noise/Refund${i}.java`, `package noise; /** refund ledger refund ledger */ public class Refund${i} {}\n`);
  }
  const target = "m2/src/test/java/demo/ScopedRefund.java";
  await put(target, "package demo; /** refund ledger */ public class ScopedRefund {}\n");
  await put("m2/src/main/java/demo/OtherRefund.java", "package demo; /** refund ledger */ public class OtherRefund {}\n");
  const launched = path.join(root, "jdt-launches");
  const jdt = path.join(root, "jdt-forbidden.sh");
  await writeFile(jdt, '#!/bin/sh\nprintf "launched\\n" >> "$RELEASE_JDT_LAUNCH_FILE"\nexit 97\n');
  await chmod(jdt, 0o700);
  await writeFile(env.JAVA_LSP_PROJECTS_JSON, JSON.stringify({ aliases: [{ id: "fixture", root: repo, lspEnabled: true }], defaults: {} }));
  const noProvider = path.join(root, "no-provider.mjs");
  const providerCalls = path.join(root, "provider-calls");
  await writeFile(noProvider, 'import {appendFileSync} from "node:fs"; globalThis.fetch=async()=>{appendFileSync(process.env.RELEASE_PROVIDER_CALL_FILE,"fetch\\n");throw new Error("provider disabled");};\n');
  const client = new Client({ name: "release-mcp-contracts", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", noProvider, path.join(product, "dist/server.js")],
    cwd: product,
    env: { ...env, JAVA_LSP_REPO_ROOT: repo, JDTLS_BIN: jdt, RELEASE_JDT_LAUNCH_FILE: launched, RELEASE_PROVIDER_CALL_FILE: providerCalls },
    stderr: "pipe"
  });
  let stderr = "";
  transport.stderr?.on("data", data => { stderr = (stderr + data).slice(-8000); });
  const raw = (name, args = {}) => client.callTool({ name, arguments: { repoRoot: repo, ...args } }, undefined, { timeout: 30000 });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("") ?? "";
    assert.notEqual(result.isError, true, text + "\n" + stderr);
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
    assert.fail(label + ": " + JSON.stringify(result) + "\n" + stderr);
  };
  try {
    await client.connect(transport);
    await query({ query: "Shared", searchMode: "exact" });
    const status = await wait(() => call("java_status", { detail: "diagnostic", start: false }), value => value.watcher?.ready === true && value.javaIndex?.state === "READY", "watcher/index ready");
    assert.equal(status.watcher.degraded, false, "native watcher must be usable; run isolated filesystem watcher acceptance outside restrictive sandboxing");
    await body({ root, repo, put, a, b, bText, wordFile, target, raw, call, query, wait, status, launched, providerCalls });
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("K05: the real watcher deletes one duplicate declaration without deleting its sibling", { timeout: 45000 }, async () => {
  await fixture(async ({ root, repo, a, b, bText, query, wait }) => {
    const before = await query({ query: "Shared", searchMode: "exact" });
    assert.equal(before.exact, "ambiguous");
    assert.equal(before.candidates.length, 2);
    const beforeDb = new DatabaseSync(path.join(root, "cache", before.repoHash, "index.sqlite"), { readOnly: true });
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
    const db = new DatabaseSync(path.join(root, "cache", before.repoHash, "index.sqlite"), { readOnly: true });
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

test("K12: public MCP rejects a zero deadline explicitly and settles the request", { timeout: 45000 }, async () => {
  await fixture(async ({ raw }) => {
    const began = performance.now();
    const result = await raw("java_impact", { file: "m2/src/main/java/demo/WordService.java", line: 3, column: 14, semanticPolicy: "fast", deadlineMs: 0 });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /deadlineMs|greater|positive|>=1/);
    assert.ok(performance.now() - began < 5000);
  });
});

test("K15: a Chinese JavaDoc-only edit becomes visible through the real watcher at its new hash", { timeout: 45000 }, async () => {
  await fixture(async ({ put, wordFile, query, wait }) => {
    const before = await query({ query: "琥珀结算", searchMode: "text" });
    assert.ok(before.candidates.some(item => item.declaration.relativePath === wordFile));
    const content = await put(wordFile, "package demo;\n/** 翡翠核销 */\npublic class WordService {}\n");
    const after = await wait(() => query({ query: "翡翠核销", searchMode: "text" }), value => value.scopeState === "READY" && value.generation > before.generation && value.candidates.some(item => item.declaration.contentHash === digest(content)), "comment generation");
    assert.ok(after.candidates.every(item => item.declaration.contentHash === digest(content)));
    const old = await query({ query: "琥珀结算", searchMode: "text" });
    assert.equal(old.scopeState, "READY");
    assert.equal(old.candidates.length, 0);
  });
});

test("K17: public MCP applies module AND source-set before the candidate limit", { timeout: 45000 }, async () => {
  await fixture(async ({ root, target, query }) => {
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
    const db = new DatabaseSync(path.join(root, "cache", broad.repoHash, "index.sqlite"), { readOnly: true });
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

test("K19: real watcher add rename and delete invalidate negative and positive lookups", { timeout: 45000 }, async () => {
  await fixture(async ({ repo, put, query, wait }) => {
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
  });
});

test("K25: static queries use the real MCP protocol with zero JDT launches", { timeout: 45000 }, async () => {
  await fixture(async ({ call, query, launched }) => {
    assert.equal((await query({ query: "demo.WordService", searchMode: "exact" })).exact, "match");
    const status = await call("java_status", { detail: "diagnostic", start: false });
    assert.equal(status.started, false);
    assert.equal(status.javaIndex.state, "READY");
    assert.equal(existsSync(launched), false, "the forbidden JDT executable must never run");
  });
});

test("K27: the shipped disabled provider boundary keeps lexical MCP queries usable with zero fetches", { timeout: 45000 }, async () => {
  await fixture(async ({ query, providerCalls }) => {
    const known = await query({ query: "demo.WordService", searchMode: "exact" });
    assert.equal(known.scopeState, "READY");
    assert.equal(known.exact, "match");
    const missing = await query({ query: "demo.NoSuchClass", searchMode: "exact" });
    assert.equal(missing.exact, "miss");
    assert.equal(existsSync(providerCalls), false);
  });
});
