// input: Representative Java snippets and lishuedu source files.
// output: Assertions for source-index facts and method ranges.
// pos: Node test coverage for the lightweight Java source index.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

test("parseJavaSource extracts signature referenced types", () => {
  const facts = parseJavaSource(repoRoot, path.join(repoRoot, "modules/sample/src/main/java/demo/ApplyInfoService.java"), `
package demo;

public class ApplyInfoService {
  private static final String ORDER_CREATE = "create";
  private ApplyInfoRepository repository;

  public ApplyInfo save(ApplyInfoUpdateDTO command, List<PositionTemplate> templates) {
    BodyOnlyBuilder builder = new BodyOnlyBuilder();
    return repository.save(command);
  }
}
`);

  assert.deepEqual([...facts.referencedTypes].sort(), [
    "ApplyInfo",
    "ApplyInfoRepository",
    "ApplyInfoUpdateDTO",
    "List",
    "PositionTemplate"
  ]);
  assert.equal(facts.referencedTypes.includes("BodyOnlyBuilder"), false);
  assert.equal(facts.referencedTypes.includes("ORDER_CREATE"), false);
});

test("parseJavaSource extracts import declarations as dependency facts", () => {
  const facts = parseJavaSource(repoRoot, path.join(repoRoot, "modules/sample/src/main/java/demo/ApplyInfoServiceImpl.java"), `
package demo;

import com.demo.dto.ApplyInfoUpdateDTO;
import static com.demo.util.Checks.requireNonBlank;
import java.util.List;
import com.demo.legacy.*;

public class ApplyInfoServiceImpl {
  public void save() {
    ApplyInfoUpdateDTO dto = null;
  }
}
`);
  assert.deepEqual(facts.imports, [
    "com.demo.dto.ApplyInfoUpdateDTO",
    "com.demo.util.Checks",
    "java.util.List"
  ]);
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

test("SourceIndex skips legacy snapshots without referenced types", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-legacy-"));
  const file = path.join(root, "src/main/java/demo/Legacy.java");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    "package demo;",
    "public class Legacy {",
    "  private DemoRepository repository;",
    "}",
    ""
  ].join("\n"));

  const cacheDir = repoCacheRoot(root);
  await mkdir(cacheDir, { recursive: true });
  const stat = statSync(file);
  writeFileSync(path.join(cacheDir, "source-index.files.jsonl"), `${JSON.stringify({
    absolutePath: file,
    path: "src/main/java/demo/Legacy.java",
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    packageName: "demo",
    typeName: "Legacy",
    kind: "class",
    implementsTypes: [],
    annotations: [],
    factSource: "regex",
    batchId: "legacy"
  })}\n`);
  writeFileSync(path.join(cacheDir, "source-index.symbols.jsonl"), "");

  const index = new SourceIndex(root);
  assert.equal(index.status().entries, 0);
  assert.deepEqual(index.factsFor(file).referencedTypes, ["DemoRepository"]);
});

test("SourceIndex skips legacy snapshots without imports", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-legacy-imports-"));
  const file = path.join(root, "src/main/java/demo/Legacy.java");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    "package demo;",
    "import demo.dto.LegacyDTO;",
    "public class Legacy {",
    "}",
    ""
  ].join("\n"));

  const cacheDir = repoCacheRoot(root);
  await mkdir(cacheDir, { recursive: true });
  const stat = statSync(file);
  writeFileSync(path.join(cacheDir, "source-index.files.jsonl"), `${JSON.stringify({
    absolutePath: file,
    path: "src/main/java/demo/Legacy.java",
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    packageName: "demo",
    typeName: "Legacy",
    kind: "class",
    implementsTypes: [],
    referencedTypes: [],
    annotations: [],
    factSource: "regex",
    batchId: "legacy"
  })}\n`);
  writeFileSync(path.join(cacheDir, "source-index.symbols.jsonl"), "");

  const index = new SourceIndex(root);
  assert.equal(index.status().entries, 0);
  assert.deepEqual(index.factsFor(file).imports, ["demo.dto.LegacyDTO"]);
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

test("SourceIndex status throttles dirtyCount stat scans", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-dirty-"));
  const file = path.join(root, "src/main/java/demo/Dirty.java");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "package demo; public class Dirty { public void saved() {} }\n");

  const index = new SourceIndex(root);
  index.factsFor(file);
  assert.equal(index.status().dirtyCount, 0);
  await writeFile(file, "package demo; public class Dirty { public void changed() {} }\n");
  assert.equal(index.status().dirtyCount, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(index.status().dirtyCount, 1);
});

test("SourceIndex finds cached implementers for a type", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-typegraph-"));
  const port = path.join(root, "src/main/java/demo/PaymentGateway.java");
  const impl = path.join(root, "src/main/java/demo/StripeGateway.java");
  await mkdir(path.dirname(port), { recursive: true });
  await writeFile(port, "package demo; public interface PaymentGateway { void pay(); }\n");
  await writeFile(impl, "package demo; public class StripeGateway implements PaymentGateway { public void pay() {} }\n");

  const index = new SourceIndex(root);
  index.factsFor(port);
  index.factsFor(impl);

  assert.deepEqual(index.findImplementers("PaymentGateway").map(item => item.typeName), ["StripeGateway"]);
});

test("SourceIndex finds cached signature type references", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-type-reference-"));
  const request = path.join(root, "src/main/java/demo/CebOrderRequest.java");
  const service = path.join(root, "src/main/java/demo/CebPayServiceImpl.java");
  await mkdir(path.dirname(request), { recursive: true });
  await writeFile(request, "package demo; public record CebOrderRequest(String id) {}\n");
  await writeFile(service, [
    "package demo;",
    "public class CebPayServiceImpl {",
    "  public CebOrderCreateResponse create(CebOrderRequest request) {",
    "    BodyOnlyBuilder builder = new BodyOnlyBuilder();",
    "    return null;",
    "  }",
    "}",
    ""
  ].join("\n"));

  const index = new SourceIndex(root);
  index.factsFor(request);
  index.factsFor(service);

  assert.deepEqual(index.findTypeReferences("CebOrderRequest").map(item => item.typeName), ["CebPayServiceImpl"]);
  const afterFirstLookup = index.status();
  assert.equal(afterFirstLookup.typeLookupIndexHits, 1);
  assert.equal(afterFirstLookup.scanCacheMisses, 0);
  assert.deepEqual(index.findTypeReferences("CebOrderRequest").map(item => item.typeName), ["CebPayServiceImpl"]);
  assert.equal(index.status().typeLookupIndexHits, afterFirstLookup.typeLookupIndexHits + 1);
  assert.deepEqual(index.findTypeDefinitions(["MissingType"]).map(item => item.typeName), []);
  const afterMissingLookup = index.status();
  assert.equal(afterMissingLookup.scanCacheMisses, 1);
  assert.deepEqual(index.findTypeDefinitions(["MissingType"]).map(item => item.typeName), []);
  assert.equal(index.status().scanCacheHits, afterMissingLookup.scanCacheHits + 1);
});

test("SourceIndex answers loaded type lookups without rg scans", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-type-reference-index-"));
  const request = path.join(root, "src/main/java/demo/CebOrderRequest.java");
  const response = path.join(root, "src/main/java/demo/CebOrderCreateResponse.java");
  const service = path.join(root, "src/main/java/demo/CebPayServiceImpl.java");
  await mkdir(path.dirname(request), { recursive: true });
  await writeFile(request, "package demo; public record CebOrderRequest(String id) {}\n");
  await writeFile(response, "package demo; public record CebOrderCreateResponse(String id) {}\n");
  await writeFile(service, [
    "package demo;",
    "public class CebPayServiceImpl {",
    "  public CebOrderCreateResponse create(CebOrderRequest request) {",
    "    return null;",
    "  }",
    "}",
    ""
  ].join("\n"));

  const index = new SourceIndex(root);
  index.factsFor(request);
  index.factsFor(response);
  index.factsFor(service);

  assert.deepEqual(index.findTypeReferences("CebOrderRequest").map(item => item.typeName), ["CebPayServiceImpl"]);
  assert.deepEqual(index.findTypeDefinitions(["CebOrderCreateResponse"]).map(item => item.typeName), ["CebOrderCreateResponse"]);
  const status = index.status();
  assert.equal(status.typeLookupIndexHits, 2);
  assert.equal(status.scanCacheMisses, 0);
});

test("SourceIndex finds importers via the imported type index", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-importers-"));
  const dto = path.join(root, "src/main/java/demo/dto/ApplyInfoUpdateDTO.java");
  const importer = path.join(root, "src/main/java/demo/application/ApplyInfoServiceImpl.java");
  const unrelated = path.join(root, "src/main/java/demo/Other.java");
  await mkdir(path.dirname(dto), { recursive: true });
  await mkdir(path.dirname(importer), { recursive: true });
  await writeFile(dto, "package demo.dto;\npublic class ApplyInfoUpdateDTO {}\n");
  await writeFile(importer, [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "  public void save() { ApplyInfoUpdateDTO dto = null; }",
    "}",
    ""
  ].join("\n"));
  await writeFile(unrelated, "package demo;\npublic class Other {}\n");

  const index = new SourceIndex(root);
  index.factsFor(dto);
  index.factsFor(importer);
  index.factsFor(unrelated);

  assert.deepEqual(index.findImporters("ApplyInfoUpdateDTO").map(item => item.typeName), ["ApplyInfoServiceImpl"]);
  const status = index.status();
  assert.equal(status.typeLookupIndexHits, 1);
  assert.equal(status.scanCacheMisses, 0);
});

test("SourceIndex falls back to rg scan for importers not yet cached", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-importers-scan-"));
  const importer = path.join(root, "src/main/java/demo/application/ApplyInfoServiceImpl.java");
  await mkdir(path.dirname(importer), { recursive: true });
  await writeFile(importer, [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "}",
    ""
  ].join("\n"));

  const index = new SourceIndex(root);
  assert.deepEqual(index.findImporters("ApplyInfoUpdateDTO").map(item => item.typeName), ["ApplyInfoServiceImpl"]);
  assert.equal(index.status().typeLookupIndexMisses, 1);
  assert.equal(index.status().scanCacheMisses, 1);
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
