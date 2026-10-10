// An empty discovery result says WHY when the query shares no token with the
// index vocabulary (e.g. an all-CJK question over an English code base), so an
// agent rephrases with code identifiers instead of concluding the code does
// not exist. Never a fuzzy fallback (R07); the result stays complete (READY).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import { runStaticDiscovery, type StaticDiscoveryArgs } from "./query.js";

type EmptyReason = { kind: string; queryTokens: number; knownTokens: number; queryScripts: string[]; hint: string };
const reasonOf = (result: unknown): EmptyReason | undefined => (result as { emptyReason?: EmptyReason }).emptyReason;

const FILES: Record<string, string> = {
  "src/main/java/demo/PetValidator.java": [
    "package demo;",
    "public class PetValidator {",
    "    public void validate(Object target) {",
    "    }",
    "}",
    ""
  ].join("\n"),
  "src/main/java/demo/RefundService.java": [
    "package demo;",
    "public class RefundService {",
    "    /** 退款前先冻结订单 */",
    "    public void refund(String orderId) {",
    "    }",
    "}",
    ""
  ].join("\n")
};

async function withIndex(fn: (discover: (args: Omit<StaticDiscoveryArgs, "repoRoot">) => ReturnType<typeof runStaticDiscovery>) => Promise<void>) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "vocabulary-"));
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(path.join(repoRoot, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(repoRoot, rel), text, "utf8");
  }
  const dbPath = path.join(repoRoot, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot, db, generation: 1 });
  close(db);
  const client = new SqlJavaIndexClient(repoRoot, dbPath);
  await client.open(1);
  try {
    await fn(args => runStaticDiscovery(client as unknown as JavaIndexClientApi, { repoRoot, searchMode: "text", ...args }));
  } finally {
    await client.close().catch(() => undefined);
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("an all-CJK question over English code gets an explicit no-vocabulary-overlap diagnosis", async () => {
  await withIndex(async discover => {
    const result = await discover({ query: "宠物名称为空或超长分别会如何拒绝？" });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.scopeState, "READY", "an empty answer from a complete index is not PARTIAL");
    assert.equal(reasonOf(result)?.kind, "no_vocabulary_overlap");
    assert.equal(reasonOf(result)?.knownTokens, 0);
    assert.ok((reasonOf(result)?.queryTokens ?? 0) > 0);
    assert.deepEqual(reasonOf(result)?.queryScripts, ["Han"]);
    assert.match(reasonOf(result)?.hint ?? "", /identifier/i);

    const latin = await discover({ query: "zzqxv wqpmk" });
    assert.equal(reasonOf(latin)?.kind, "no_vocabulary_overlap", "unknown Latin words are diagnosed the same way");
    assert.deepEqual(reasonOf(latin)?.queryScripts, ["Latin"]);
  });
});

test("no diagnosis when the vocabulary overlaps: mixed query, CJK comment, or an empty scope", async () => {
  await withIndex(async discover => {
    const mixed = await discover({ query: "宠物 validate 怎么拒绝" });
    assert.ok(mixed.candidates.some(candidate => candidate.declaration.name === "validate"));
    assert.equal(reasonOf(mixed), undefined);

    const comment = await discover({ query: "冻结订单" });
    assert.ok(comment.candidates.some(candidate => candidate.declaration.name === "refund"), "CJK comments are indexed (bigrams)");
    assert.equal(reasonOf(comment), undefined);

    // Known words, nothing in scope: the scope explains it, not the vocabulary.
    const scoped = await discover({ query: "validate", sourceSet: "test" });
    assert.deepEqual(scoped.candidates, []);
    assert.notEqual(reasonOf(scoped)?.kind, "no_vocabulary_overlap");
  });
});
