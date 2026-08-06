import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImpactOptions, ResolvedAnchor } from "../../agent-types.js";
import { resolveRoutingPolicy } from "../../routing-policy.js";
import { FileSemanticEdgeStoreV2, mapSemanticEdgeForPersistence } from "../../semantic-edge-store.js";
import type { ProviderInput } from "../evidence.js";
import { collectPersistedSemanticEvidence } from "./semantic-provider.js";

const options: ImpactOptions = {
  anchors: [],
  mode: "balanced",
  profile: "auto",
  semanticPolicy: "fast",
  semanticTimeoutMs: 1_500,
  testReadMode: "defer",
  focusModules: [],
  excludeModules: [],
  taskKeywords: [],
  crossModulePolicy: "auto"
};

test("a complete persisted reference emits high-confidence exact-semantic weight", async () => {
  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/OrderRepository.java",
    path: "src/main/java/demo/OrderRepository.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "repository",
    symbolName: "OrderRepository",
    className: "OrderRepository",
    kind: "interface"
  };
  const target = "/repo/src/main/java/demo/OrderCommandService.java";
  const anchorSymbolId = "sym:OrderRepository";
  const input = {
    repoRoot: "/repo",
    anchors: [anchor],
    options,
    javaIndex: {
      queryAnchor: async (file: string, line: number, column: number) =>
        file === anchor.absolutePath && line === anchor.line && column === anchor.column
          ? { symbolId: anchorSymbolId }
          : undefined
    },
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {
      findFrom: (sourceSymbolId: string) => sourceSymbolId === anchorSymbolId
        ? [{
            edgeId: "e1",
            sourceSymbolId: anchorSymbolId,
            targetSymbolId: "sym:OrderCommandService",
            sourceFile: anchor.absolutePath,
            targetFile: target,
            relation: "JDT_REFERENCE",
            targetRanges: [{ start: { line: 4, column: 7 }, end: { line: 4, column: 7 } }],
            provenance: "PERSISTED_JDT",
            confidence: 1,
            completion: "COMPLETE",
            dependencies: [],
            buildFingerprint: "bf",
            validatedGeneration: 0,
            createdAt: "2026-07-30T00:00:00.000Z"
          }]
        : []
    },
    metrics: { persistedSemantic: { edgesSeen: 0, addedCandidates: 0, elapsedMs: 0 } }
  } as unknown as ProviderInput;

  const result = await collectPersistedSemanticEvidence(input);
  const signal = result.evidence.find(item => item.candidateFile === target);

  assert.ok(signal, "the persisted reference must remain an exact-semantic signal");
  assert.equal(signal!.family, "EXACT_SEMANTIC");
  assert.equal(signal!.confidence, 0.9);
  assert.equal(
    signal!.weight,
    80,
    "a complete persisted reference must reach the exact-semantic high-confidence threshold after the 0.9 factor"
  );
  assert.deepEqual(
    signal!.positions[0],
    { line: 4, column: 7 },
    "the read side must recover the edge's real position from targetRanges, not fall back to {1,1}"
  );
});

test("an anchor position that does not resolve to any symbol yields no persisted candidates and does not throw", async () => {
  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/Unresolved.java",
    path: "src/main/java/demo/Unresolved.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Unresolved",
    kind: "class"
  };
  const input = {
    repoRoot: "/repo",
    anchors: [anchor],
    options,
    javaIndex: { queryAnchor: async () => undefined },
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: { findFrom: () => { throw new Error("findFrom must never be called when the anchor position does not resolve"); } },
    metrics: { persistedSemantic: { edgesSeen: 0, addedCandidates: 0, elapsedMs: 0 } }
  } as unknown as ProviderInput;

  const result = await collectPersistedSemanticEvidence(input);

  assert.equal(result.evidence.length, 0);
  assert.equal(result.completion, "COMPLETE");
});

test("an edge written by putComplete() is found by a later request whose anchor resolves to the same source symbol", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "semantic-provider-readpath-"));
  const sourceFile = path.join(repoRoot, "OrderRepository.java");
  const targetFile = path.join(repoRoot, "OrderCommandService.java");
  writeFileSync(sourceFile, "class OrderRepository {}\n");
  writeFileSync(targetFile, "class OrderCommandService {}\n");

  const resolver = async (file: string, line: number, column: number) => ({ symbolId: `${path.basename(file)}:${line}:${column}` });
  const edge = await mapSemanticEdgeForPersistence({
    sourceFile,
    sourceLine: 1,
    sourceColumn: 1,
    targetFile,
    targetLine: 5,
    targetColumn: 9,
    targetRanges: [{ start: { line: 5, column: 9 }, end: { line: 5, column: 9 } }],
    relation: "JDT_REFERENCE",
    completion: "COMPLETE",
    buildFingerprint: "bf-1",
    generation: 1
  }, repoRoot, resolver);
  assert.ok(edge);

  const store = new FileSemanticEdgeStoreV2(repoRoot);
  await store.load();
  await store.putComplete([edge!], 1);

  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: sourceFile,
    path: "OrderRepository.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "repository",
    symbolName: "OrderRepository",
    kind: "class"
  };
  const input = {
    repoRoot,
    anchors: [anchor],
    options,
    javaIndex: { queryAnchor: (file: string, line: number, column: number) => resolver(file, line, column) },
    routingPolicy: resolveRoutingPolicy(repoRoot),
    existingCandidatePaths: [],
    generation: 1,
    phaseMs: {},
    edgeStoreV2: store,
    metrics: { persistedSemantic: { edgesSeen: 0, addedCandidates: 0, elapsedMs: 0 } }
  } as unknown as ProviderInput;

  const result = await collectPersistedSemanticEvidence(input);
  const signal = result.evidence.find(item => item.candidateFile === targetFile);

  assert.ok(signal, "an edge persisted by a prior request's putComplete() must be readable by a later request's anchor");
  assert.deepEqual(signal!.positions[0], { line: 5, column: 9 });
});
