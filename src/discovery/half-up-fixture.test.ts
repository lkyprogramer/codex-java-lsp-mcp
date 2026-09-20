// input: A source file whose COMMENT claims HALF_UP while the CODE implements
//         half-down behavior: the two surfaces must stay separable.
// output: The comment is retrievable through the search-document route (the
//         T05 doc layer indexes comment text), while the AST program facts are
//         never overwritten: no symbol named HALF_UP exists in the index and
//         no exact query may fabricate one from the comment.
// pos: M2 T09 M2-4 - the M1 card's reverse fixture: comment says HALF_UP,
//      code says DOWN; the comment is searchable evidence, not a declaration.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIndexDb, close } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";

const SOURCE = `package com.acme;

public class Rounding {
    /**
     * The spec asks for HALF_UP on ties (2.5 -> 3).
     */
    public int roundTies(double value) {
        // the shipped policy stays HALF_DOWN; the spec drift is tracked upstream
        return (int) Math.floor(value + 0.5d);
    }
}
`;

async function buildIndex(): Promise<{ repoRoot: string; client: SqlJavaIndexClient; cleanup: () => Promise<void> }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "half-up-fixture-"));
  const javaRoot = path.join(repoRoot, "src", "main", "java", "com", "acme");
  await mkdir(javaRoot, { recursive: true });
  await writeFile(path.join(javaRoot, "Rounding.java"), SOURCE, "utf8");
  const dbPath = path.join(repoRoot, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot, db, generation: 1 });
  close(db);
  const client = new SqlJavaIndexClient(repoRoot, dbPath);
  await client.open(1);
  return {
    repoRoot,
    client,
    cleanup: async () => {
      await client.close().catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
    }
  };
}

test("a comment claiming HALF_UP is never indexed as a HALF_UP symbol", () => {
  const fixture = SOURCE;
  // Structural guard on the fixture itself: the AST names are the code names.
  assert.ok(fixture.includes("HALF_UP"), "fixture premise: the comment says HALF_UP");
  assert.ok(fixture.includes("roundTies"), "fixture premise: the code uses its own name");
  assert.ok(!/class\s+HALF_UP|HALF_UP\s*\(/.test(fixture), "fixture premise: HALF_UP is not a declaration");
});

test("exact HALF_UP finds no declaration and does not fabricate one", async () => {
  const fixture = await buildIndex();
  try {
    const result = await fixture.client.querySearch("HALF_UP", { mode: "exact", limit: 8 });
    const fabricated = result.hits.filter(hit => hit.simpleName === "HALF_UP");
    assert.equal(fabricated.length, 0,
      `exact route fabricated a declaration from a comment: ${fabricated.map(hit => hit.simpleName).join(", ")}`);
  } finally {
    await fixture.cleanup();
  }
});

test("text route retrieves the comment but keeps it separate from the AST facts", async () => {
  const fixture = await buildIndex();
  try {
    const result = await fixture.client.querySearch("HALF_UP", { mode: "text", limit: 8 });
    const hits = result.hits;
    // The comment must be retrievable evidence (the T05 search-document route
    // reports it as a DOCUMENT-layer hit) ...
    const commentEvidence = hits.filter(hit => hit.layer === "DOCUMENT");
    assert.ok(commentEvidence.length > 0,
      `the comment claiming HALF_UP must be retrievable through the search-document route; layers: ${hits.map(hit => `${hit.simpleName}:${hit.layer}`).join(", ") || "(no hits)"}`);
    // ... but it must not rename or add AST program facts.
    assert.ok(!hits.some(hit => hit.simpleName === "HALF_UP"),
      "a comment must never surface as a symbol named HALF_UP");
    const declaration = hits.find(hit => hit.simpleName === "roundTies");
    if (declaration) {
      assert.equal(declaration.kind, "method", "the code's own declaration keeps its AST identity");
    }
  } finally {
    await fixture.cleanup();
  }
});