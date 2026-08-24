import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import { resolveAnchor } from "./anchor.js";

const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 20 } };

test("anchor foreground warmup prioritizes a referenced interface over an earlier unrelated import", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "anchor-foreground-priority-"));
  const anchorFile = path.join(repoRoot, "src/main/java/demo/Controller.java");
  mkdirSync(path.dirname(anchorFile), { recursive: true });
  writeFileSync(anchorFile, "package demo; class Controller {}\n");
  const implementerLookups: string[] = [];
  const definitionLookups: string[][] = [];
  const refreshPriorities: unknown[] = [];
  const definitions = [
    interfaceFacts(repoRoot, "demo.UnrelatedPort"),
    interfaceFacts(repoRoot, "demo.RelatedPort")
  ];
  const javaIndex = {
    async ensureFresh(_files: string[], _generation: number, options?: unknown) { refreshPriorities.push(options); },
    async queryAnchor() {
      return {
        file: {
          fileId: "file:src/main/java/demo/Controller.java",
          relativePath: "src/main/java/demo/Controller.java",
          sourceRoot: "src/main/java",
          module: ".",
          sourceSet: "main",
          packageName: "demo",
          imports: [
            { qualifiedName: "demo.UnrelatedPort", wildcard: false, static: false, range },
            { qualifiedName: "demo.RelatedPort", wildcard: false, static: false, range },
            { qualifiedName: "demo.Constants.VALUE", wildcard: false, static: true, range },
            { qualifiedName: "demo.extra.*", wildcard: true, static: false, range }
          ],
          topLevelTypeIds: ["type:demo.Controller"],
          allTypeIds: ["type:demo.Controller"],
          contentHash: "hash",
          size: 1,
          mtimeMs: 1,
          parseState: "COMPLETE",
          parseErrorCount: 0,
          generation: 1
        },
        symbolId: "type:demo.Controller",
        symbolKind: "TYPE",
        symbolName: "Controller",
        range,
        type: {
          typeId: "type:demo.Controller",
          fqn: "demo.Controller",
          simpleName: "Controller",
          kind: "class",
          fileId: "file:src/main/java/demo/Controller.java",
          range,
          modifiers: [],
          annotations: [],
          typeParameters: [],
          extends: [],
          implements: [{
            text: "RelatedPort",
            simpleName: "RelatedPort",
            qualifiedName: "demo.RelatedPort",
            typeArguments: [],
            arrayDepth: 0,
            resolution: { state: "RESOLVED_REPO", typeId: "type:demo.RelatedPort", strategy: "EXPLICIT_IMPORT" }
          }],
          permits: [],
          fieldIds: [],
          methodIds: [],
          confidence: 1
        },
        coverage: "BUILDING",
        confidence: 1
      };
    },
    async findTypeDefinitions(names: readonly string[]) { definitionLookups.push([...names]); return definitions; },
    async findImplementers(typeName: string) { implementerLookups.push(typeName); return []; }
  };

  const anchor = await resolveAnchor({
    repoRoot,
    javaIndex: javaIndex as never,
    input: { file: anchorFile, line: 1, column: 22 },
    requested: "auto",
    id: "A1",
    primary: true,
    generation: 1
  });

  await resolveAnchor({
    repoRoot,
    javaIndex: javaIndex as never,
    input: { file: anchorFile, line: 1, column: 22 },
    requested: "auto",
    id: "A2",
    primary: true,
    generation: 1
  });

  assert.equal(anchor.className, "Controller");
  assert.deepEqual(refreshPriorities, [{ priority: "ACTIVE_ANCHOR" }, undefined]);
  assert.deepEqual(definitionLookups, [["demo.UnrelatedPort", "demo.RelatedPort"], ["demo.UnrelatedPort", "demo.RelatedPort"]]);
  assert.deepEqual(implementerLookups, ["demo.RelatedPort", "demo.RelatedPort"]);
});

function interfaceFacts(repoRoot: string, qualifiedName: string): JavaSourceFacts {
  const typeName = qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);
  return {
    absolutePath: path.join(repoRoot, `src/main/java/demo/${typeName}.java`),
    path: `src/main/java/demo/${typeName}.java`,
    module: ".",
    sourceSet: "main",
    typeName,
    qualifiedName,
    typeId: `type:${qualifiedName}`,
    kind: "interface",
    implementsTypes: [],
    referencedTypes: [],
    imports: [],
    wildcardImports: [],
    annotations: [],
    methods: [],
    factSource: "javaIndex"
  };
}
