// input: Representative Java snippets and lishuedu source files.
// output: Assertions for source-index facts and method ranges.
// pos: Node test coverage for the lightweight Java source index.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SourceIndex, parseJavaSource } from "./source-index.js";
import { repoCacheRoot } from "./repo-layout.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoRoot = process.env.LISHUEDU_ROOT || path.resolve(projectDir, "..", "..");
const hasLishueduFixture = process.env.LISHUEDU_ROOT !== undefined;

test("parseJavaSource extracts type, implements, annotations, and method ranges", () => {
  const facts = parseJavaSource(repoRoot, path.join(repoRoot, "modules/sample/src/main/java/demo/SampleController.java"), `
package demo;

@RestController
public class SampleController implements DemoPort {
  @GetMapping("/demo")
  public String confirm(String value) {
    if (value == null) {
      return "";
    }
    return value;
  }
}
`);
  assert.equal(facts.packageName, "demo");
  assert.equal(facts.typeName, "SampleController");
  assert.equal(facts.kind, "class");
  assert.deepEqual(facts.implementsTypes, ["DemoPort"]);
  assert.ok(facts.annotations.includes("@RestController"));
  assert.equal(facts.methods[0].name, "confirm");
  assert.equal(facts.methods[0].line, 7);
  assert.equal(facts.methods[0].endLine, 12);
  assert.equal(facts.factSource, "regex");
});

test("SourceIndex can replace regex facts with documentSymbol facts", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-index-"));
  const file = path.join(root, "src/main/java/demo/SampleController.java");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `
package demo;

public class SampleController {
  public String regexName() {
    return "";
  }
}
`);

  const index = new SourceIndex(root);
  assert.equal(index.factsFor(file).methods[0].name, "regexName");
  const facts = index.upsertDocumentSymbols(file, [{
    name: "SampleController",
    kind: 5,
    range: { start: { line: 3, character: 0 }, end: { line: 6, character: 1 } },
    children: [{
      name: "documentName",
      kind: 6,
      range: { start: { line: 4, character: 2 }, end: { line: 6, character: 3 } }
    }]
  }]);

  assert.equal(facts.factSource, "documentSymbol");
  assert.equal(facts.typeName, "SampleController");
  assert.equal(facts.methods[0].name, "documentName");
  assert.equal(facts.methods[0].line, 5);
  assert.equal(facts.methods[0].endLine, 7);
  assert.equal(index.methodAt(file, 6)?.name, "documentName");
  assert.equal(index.status().documentSymbolFacts, 1);
});

test("SourceIndex reloads snapshot and discards corrupt snapshot", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-snapshot-"));
  const file = path.join(root, "src/main/java/demo/Sample.java");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `
package demo;

public class Sample {
  public void saved() {
  }
}
`);

  const index = new SourceIndex(root);
  assert.equal(index.factsFor(file).methods[0].name, "saved");
  const reloaded = new SourceIndex(root);
  assert.equal(reloaded.status().entries, 1);
  assert.equal(reloaded.factsFor(file).methods[0].name, "saved");
  assert.equal(reloaded.status().hits, 1);

  const filesPath = path.join(repoCacheRoot(root), "source-index.files.jsonl");
  assert.equal(existsSync(filesPath), true);
  writeFileSync(filesPath, "{broken\n");
  const rebuilt = new SourceIndex(root);
  assert.equal(rebuilt.status().entries, 0);
  assert.equal(rebuilt.factsFor(file).methods[0].name, "saved");
});

test("SourceIndex compacts duplicate snapshot records", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-compact-"));
  const file = path.join(root, "src/main/java/demo/Compact.java");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "package demo; public class Compact { public void saved() {} }\n");

  const index = new SourceIndex(root);
  for (let i = 0; i < 12; i += 1) {
    index.upsertDocumentSymbols(file, [{
      name: "Compact",
      kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 60 } },
      children: [{
        name: "saved",
        kind: 6,
        range: { start: { line: 0, character: 37 }, end: { line: 0, character: 59 } }
      }]
    }]);
  }

  const filesPath = path.join(repoCacheRoot(root), "source-index.files.jsonl");
  assert.equal(readFileSync(filesPath, "utf8").trim().split(/\r?\n/).length, 1);
});

test("SourceIndex finds the nearest method around a real repo line", { skip: !hasLishueduFixture }, () => {
  const index = new SourceIndex(repoRoot);
  const file = "modules/school/src/main/java/com/lishu/edu/school/interfaces/web/SchoolTemplateImportController.java";
  const method = index.methodAt(file, 109);
  assert.equal(method?.name.replace(/\(.*/, ""), "confirm");
  const firstStatus = index.status();
  assert.ok(firstStatus.hits + firstStatus.misses >= 1);
  index.factsFor(file);
  assert.ok(index.status().hits >= 1);
});
