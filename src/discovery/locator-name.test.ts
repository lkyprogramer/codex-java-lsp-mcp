// A discovery locator points at the declaration NAME (what an LSP
// selectionRange and the frozen gold targets use), not at the first
// annotation of the declaration; the preview still starts at the declaration
// head so annotations such as routes stay visible. Real cold build, real SQL
// client, real static discovery.
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
import { runStaticDiscovery, type DiscoveryCandidate } from "./query.js";

const REL = "src/main/java/demo/PetValidator.java";
const SOURCE = [
  "package demo;",
  "",
  "@Service",
  "@Deprecated(",
  "    since = \"2\")",
  "public class PetValidator implements Validator {",
  "    @Override",
  "    public void validate(Object target) {",
  "    }",
  "",
  "    @Override public boolean supports(Class<?> clazz) { return true; }",
  "",
  "    /** emoji 😀 */ public <T> T convert(T value) { return value; }",
  "",
  "    public PetValidator() {}",
  "}",
  ""
].join("\n");
const LINES = SOURCE.split("\n");

/** Independent oracle: 1-based line, 1-based UTF-16 column of `needle` on that line. */
function at(line: number, needle: string): { line: number; column: number } {
  const index = LINES[line - 1]!.indexOf(needle);
  assert.ok(index >= 0, `${needle} on line ${line}`);
  return { line, column: index + 1 };
}

type Find = (query: string, kind: "type" | "method", name: string, preview?: "none" | "head" | "window") => Promise<DiscoveryCandidate>;

async function withDiscovery(fn: (find: Find) => Promise<void>) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "locator-name-"));
  await mkdir(path.join(repoRoot, path.dirname(REL)), { recursive: true });
  await writeFile(path.join(repoRoot, REL), SOURCE, "utf8");
  const dbPath = path.join(repoRoot, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot, db, generation: 1 });
  close(db);
  const client = new SqlJavaIndexClient(repoRoot, dbPath);
  await client.open(1);
  try {
    await fn(async (query, kind, name, preview) => {
      const result = await runStaticDiscovery(client as unknown as JavaIndexClientApi, { repoRoot, query, searchMode: "text", ...(preview ? { preview } : {}) });
      const candidate = result.candidates.find(entry => entry.declaration.kind === kind && entry.declaration.name === name);
      assert.ok(candidate, `${kind} ${name} for "${query}": ${JSON.stringify(result.candidates.map(entry => entry.declaration.name))}`);
      return candidate!;
    });
  } finally {
    await client.close().catch(() => undefined);
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("locator selection is the declaration name, past multi-line and same-line annotations", async () => {
  await withDiscovery(async find => {
    const type = await find("PetValidator", "type", "PetValidator");
    assert.deepEqual(type.declaration.selection, at(6, "PetValidator"), "type: the class name, not @Service on line 3");

    const validate = await find("validate", "method", "validate");
    assert.deepEqual(validate.declaration.selection, at(8, "validate"), "method: the name, not @Override on line 7");

    const supports = await find("supports", "method", "supports");
    assert.deepEqual(supports.declaration.selection, at(11, "supports"), "annotation on the same line: the name column");

    const convert = await find("convert", "method", "convert");
    assert.deepEqual(convert.declaration.selection, at(13, "convert"), "UTF-16 column after a surrogate pair");
  });
});

test("the preview of an identifier hit still starts at the declaration head, annotations included", async () => {
  await withDiscovery(async find => {
    const type = await find("PetValidator", "type", "PetValidator");
    assert.equal(type.evidenceRange?.startLine, 3, "the class preview keeps @Service");
    assert.ok(type.preview?.startsWith("@Service"), type.preview);

    const validate = await find("validate", "method", "validate");
    assert.equal(validate.evidenceRange?.startLine, 7, "the method preview keeps @Override");
  });
});

// The preview is a short head, not the evidence: the locator also says which
// lines the whole declaration spans (annotations to the closing brace), so an
// agent can read exactly what it needs, or see that the body is longer than
// its remaining budget and search inside it instead.
test("the locator carries the whole declaration's line range in every preview mode", async () => {
  await withDiscovery(async find => {
    for (const preview of [undefined, "none", "window"] as const) {
      const type = await find("PetValidator", "type", "PetValidator", preview);
      assert.deepEqual(type.declaration.range, { startLine: 3, endLine: 16 }, `type (${preview ?? "default"})`);
      const validate = await find("validate", "method", "validate", preview);
      assert.deepEqual(validate.declaration.range, { startLine: 7, endLine: 9 }, `method body (${preview ?? "default"})`);
      const supports = await find("supports", "method", "supports", preview);
      assert.deepEqual(supports.declaration.range, { startLine: 11, endLine: 11 }, "one-line method");
    }
  });
});
