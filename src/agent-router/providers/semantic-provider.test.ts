import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImpactOptions, ResolvedAnchor } from "../../agent-types.js";
import { resolveRoutingPolicy } from "../../routing-policy.js";
import { toFileUri } from "../../repo-layout.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import { FileSemanticEdgeStoreV2, mapSemanticEdgeForPersistence } from "../../semantic-edge-store.js";
import type { ProviderInput } from "../evidence.js";
import { collectLiveSemanticEvidence, collectPersistedSemanticEvidence } from "./semantic-provider.js";

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

function semanticMetrics() {
  return {
    used: false,
    skipped: false,
    timeout: false,
    verifyUsed: false,
    verifySkipped: false,
    policy: "auto" as const,
    timeoutMs: 1_500,
    externalLocationsSuppressed: 0,
    referenceRawLocations: 0,
    referenceCollapsedFiles: 0,
    referenceReturnedFiles: 0,
    referenceTruncatedByLimit: false,
    referenceRankingMs: 0
  };
}

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

test("persisted semantic evidence keeps distinct anchor origins for a shared candidate", async () => {
  const first: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/FirstPort.java",
    path: "src/main/java/demo/FirstPort.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "port",
    symbolName: "FirstPort",
    kind: "interface"
  };
  const second: ResolvedAnchor = {
    ...first,
    id: "A2",
    absolutePath: "/repo/src/main/java/demo/SecondPort.java",
    path: "src/main/java/demo/SecondPort.java",
    symbolName: "SecondPort"
  };
  const target = "/repo/src/main/java/demo/SharedAdapter.java";
  const input = {
    repoRoot: "/repo",
    anchors: [first, second],
    options,
    javaIndex: {
      queryAnchor: async (file: string) => ({ symbolId: file === first.absolutePath ? "sym:first" : "sym:second" })
    },
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {
      findFrom: (symbolId: string) => [{
        edgeId: `edge:${symbolId}`,
        sourceSymbolId: symbolId,
        targetSymbolId: "sym:shared",
        sourceFile: symbolId === "sym:first" ? first.absolutePath : second.absolutePath,
        targetFile: target,
        relation: symbolId === "sym:first" ? "JDT_REFERENCE" : "JDT_IMPLEMENTATION",
        targetRanges: [{ start: { line: 5, column: 3 }, end: { line: 5, column: 3 } }],
        provenance: "PERSISTED_JDT",
        confidence: 1,
        completion: "COMPLETE",
        dependencies: [],
        buildFingerprint: "bf",
        validatedGeneration: 0,
        createdAt: "2026-08-10T00:00:00.000Z"
      }]
    },
    metrics: { persistedSemantic: { edgesSeen: 0, addedCandidates: 0, elapsedMs: 0 } }
  } as unknown as ProviderInput;

  const result = await collectPersistedSemanticEvidence(input);

  assert.deepEqual(
    result.evidence.map(signal => [signal.anchorId, signal.kind, signal.candidateFile]),
    [["A1", "REFERENCE", target], ["A2", "IMPLEMENTATION", target]]
  );
});

test("persisted semantic evidence retains every kind for one anchor and one candidate", async () => {
  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/Port.java",
    path: "src/main/java/demo/Port.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "port",
    symbolName: "Port",
    kind: "interface"
  };
  const target = "/repo/src/main/java/demo/SharedAdapter.java";
  const result = await collectPersistedSemanticEvidence({
    repoRoot: "/repo",
    anchors: [anchor],
    options,
    javaIndex: { queryAnchor: async () => ({ symbolId: "sym:port" }) },
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {
      findFrom: () => ["JDT_REFERENCE", "JDT_IMPLEMENTATION"].map((relation, index) => ({
        edgeId: `edge:${index}`,
        sourceSymbolId: "sym:port",
        targetSymbolId: "sym:shared",
        sourceFile: anchor.absolutePath,
        targetFile: target,
        relation,
        targetRanges: [{ start: { line: 5, column: 3 }, end: { line: 5, column: 3 } }],
        provenance: "PERSISTED_JDT",
        confidence: 1,
        completion: "COMPLETE",
        dependencies: [],
        buildFingerprint: "bf",
        validatedGeneration: 0,
        createdAt: "2026-08-10T00:00:00.000Z"
      }))
    },
    metrics: { persistedSemantic: { edgesSeen: 0, addedCandidates: 0, elapsedMs: 0 } }
  } as unknown as ProviderInput);

  assert.deepEqual(result.evidence.map(signal => [signal.anchorId, signal.kind]), [
    ["A1", "REFERENCE"],
    ["A1", "IMPLEMENTATION"]
  ]);
});

test("an A2 persisted-semantic lookup failure retains A1 evidence and degrades the outcome", async () => {
  const first: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/FirstPort.java",
    path: "src/main/java/demo/FirstPort.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "port",
    symbolName: "FirstPort",
    kind: "interface"
  };
  const second = {
    ...first,
    id: "A2",
    absolutePath: "/repo/src/main/java/demo/SecondPort.java",
    path: "src/main/java/demo/SecondPort.java",
    symbolName: "SecondPort"
  };
  const target = "/repo/src/main/java/demo/FirstAdapter.java";
  const result = await collectPersistedSemanticEvidence({
    repoRoot: "/repo",
    anchors: [first, second],
    options,
    javaIndex: {
      queryAnchor: async (file: string) => {
        if (file === second.absolutePath) throw new Error("A2 index failure");
        return { symbolId: "sym:first" };
      }
    },
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {
      findFrom: () => [{
        targetFile: target,
        relation: "JDT_REFERENCE",
        targetRanges: [{ start: { line: 5, column: 3 }, end: { line: 5, column: 3 } }]
      }]
    },
    metrics: { persistedSemantic: { edgesSeen: 0, addedCandidates: 0, elapsedMs: 0 } }
  } as unknown as ProviderInput);

  assert.deepEqual(result.evidence.map(signal => [signal.anchorId, signal.candidateFile]), [["A1", target]]);
  assert.equal(result.completion, "FAILED");
  assert.equal(result.degradation, "persisted semantic failed for anchors: A2");
});

test("an A2 semantic failure retains A1 evidence and degrades the provider outcome", async () => {
  const first: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/FirstService.java",
    path: "src/main/java/demo/FirstService.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "FirstService",
    kind: "class"
  };
  const second: ResolvedAnchor = {
    ...first,
    id: "A2",
    absolutePath: "/repo/src/main/java/demo/SecondService.java",
    path: "src/main/java/demo/SecondService.java",
    symbolName: "SecondService"
  };
  const target = "/repo/src/main/java/demo/SharedDependency.java";
  const semantic = semanticMetrics();
  const input = {
    repoRoot: "/repo",
    anchors: [first, second],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async (file: string) => {
        if (file === second.absolutePath) throw new JavaIntelligenceError("JDT_NOT_READY", "A2 JDT failure");
        const location = {
          uri: toFileUri(target),
          range: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } }
        };
        return { definitions: [location], implementations: [] };
      },
      status: () => ({ started: false })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(5_000),
    metrics: { semantic }
  } as unknown as ProviderInput;

  const result = await collectLiveSemanticEvidence(input);

  assert.deepEqual(result.evidence.map(signal => [signal.anchorId, signal.candidateFile]), [["A1", target]]);
  assert.equal(result.completion, "FAILED");
  assert.equal(result.degradation, "semantic failed for anchors: A2");
});

test("live semantic evidence retains every kind for one anchor and one candidate", async () => {
  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/Port.java",
    path: "src/main/java/demo/Port.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Port",
    kind: "interface"
  };
  const target = "/repo/src/main/java/demo/SharedAdapter.java";
  const location = () => ({
    uri: toFileUri(target),
    range: { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } }
  });
  const result = await collectLiveSemanticEvidence({
    repoRoot: "/repo",
    anchors: [anchor],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async () => ({ definitions: [location()], implementations: [location()] }),
      status: () => ({ started: false })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(5_000),
    metrics: { semantic: semanticMetrics() }
  } as unknown as ProviderInput);

  assert.deepEqual(result.evidence.map(signal => [signal.anchorId, signal.kind]), [
    ["A1", "DEFINITION"],
    ["A1", "IMPLEMENTATION"]
  ]);
  assert.equal(result.completion, "COMPLETE");
});

test("a single-anchor semantic failure is FAILED", async () => {
  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/Service.java",
    path: "src/main/java/demo/Service.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Service",
    kind: "class"
  };
  const semantic = semanticMetrics();
  const result = await collectLiveSemanticEvidence({
    repoRoot: "/repo",
    anchors: [anchor],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async () => {
        throw new JavaIntelligenceError("JDT_NOT_READY", "semantic backend unavailable");
      },
      status: () => ({ started: false })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(5_000),
    metrics: { semantic }
  } as unknown as ProviderInput);

  assert.equal(semantic.timeout, false);
  assert.equal(result.completion, "FAILED");
  assert.equal(result.degradation, "semantic failed for anchors: A1");
});

test("a single-anchor semantic deadline is PARTIAL_TIMEOUT without failure degradation", async () => {
  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/Service.java",
    path: "src/main/java/demo/Service.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Service",
    kind: "class"
  };
  const semantic = semanticMetrics();
  const result = await collectLiveSemanticEvidence({
    repoRoot: "/repo",
    anchors: [anchor],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async () => {
        throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "semantic request timed out");
      },
      status: () => ({ started: false })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(5_000),
    metrics: { semantic }
  } as unknown as ProviderInput);

  assert.equal(semantic.timeout, true);
  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.equal(result.degradation, undefined);
});

test("a single-anchor semantic cancellation is CANCELLED without failure degradation", async () => {
  const anchor: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/Service.java",
    path: "src/main/java/demo/Service.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Service",
    kind: "class"
  };
  const semantic = semanticMetrics();
  const result = await collectLiveSemanticEvidence({
    repoRoot: "/repo",
    anchors: [anchor],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async () => {
        throw new JavaIntelligenceError("CANCELLED", "semantic request cancelled");
      },
      status: () => ({ started: false })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(5_000),
    metrics: { semantic }
  } as unknown as ProviderInput);

  assert.equal(semantic.timeout, false);
  assert.equal(result.completion, "CANCELLED");
  assert.equal(result.degradation, undefined);
});

test("an A2 deadline does not downgrade completed A1 semantic evidence", async () => {
  const first: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/FirstService.java",
    path: "src/main/java/demo/FirstService.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "FirstService",
    kind: "class"
  };
  const second: ResolvedAnchor = {
    ...first,
    id: "A2",
    absolutePath: "/repo/src/main/java/demo/SecondService.java",
    path: "src/main/java/demo/SecondService.java",
    symbolName: "SecondService"
  };
  const target = "/repo/src/main/java/demo/FirstCollaborator.java";
  const semantic = semanticMetrics();
  const result = await collectLiveSemanticEvidence({
    repoRoot: "/repo",
    anchors: [first, second],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async (file: string) => {
        if (file === second.absolutePath) {
          throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "A2 semantic request timed out");
        }
        return {
          definitions: [{
            uri: toFileUri(target),
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } }
          }],
          implementations: []
        };
      },
      status: () => ({ started: false })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(5_000),
    metrics: { semantic }
  } as unknown as ProviderInput);

  assert.deepEqual(result.evidence.map(signal => [signal.anchorId, signal.kind, signal.completeness]), [
    ["A1", "DEFINITION", "COMPLETE"]
  ]);
  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.equal(result.degradation, undefined);
});

test("a shared budget exhausted by A2 before verify does not downgrade completed A1 evidence", async () => {
  const first: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/FirstService.java",
    path: "src/main/java/demo/FirstService.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "FirstService",
    kind: "class"
  };
  const second: ResolvedAnchor = {
    ...first,
    id: "A2",
    absolutePath: "/repo/src/main/java/demo/SecondService.java",
    path: "src/main/java/demo/SecondService.java",
    symbolName: "SecondService"
  };
  const target = "/repo/src/main/java/demo/FirstCollaborator.java";
  const semantic = semanticMetrics();
  let now = 0;
  const result = await collectLiveSemanticEvidence({
    repoRoot: "/repo",
    anchors: [first, second],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async (file: string) => {
        if (file === second.absolutePath) {
          now = 10;
          throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "A2 consumed the shared budget");
        }
        return {
          definitions: [{
            uri: toFileUri(target),
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } }
          }],
          implementations: []
        };
      },
      references: async () => {
        throw new Error("semantic verify must not start after the shared budget expires");
      },
      status: () => ({ started: true, progress: { active: 0 } })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(10, () => now),
    metrics: { semantic }
  } as unknown as ProviderInput);

  assert.deepEqual(result.evidence.map(signal => [signal.anchorId, signal.kind, signal.completeness]), [
    ["A1", "DEFINITION", "COMPLETE"]
  ]);
  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.equal(result.degradation, undefined);
  assert.equal(semantic.verifySkipped, true);
});

test("an unexpected semantic failure is not hidden when another anchor times out", async () => {
  const first: ResolvedAnchor = {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/FirstService.java",
    path: "src/main/java/demo/FirstService.java",
    sourceSet: "main",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "FirstService",
    kind: "class"
  };
  const second: ResolvedAnchor = {
    ...first,
    id: "A2",
    absolutePath: "/repo/src/main/java/demo/SecondService.java",
    path: "src/main/java/demo/SecondService.java",
    symbolName: "SecondService"
  };
  const semantic = semanticMetrics();
  const result = await collectLiveSemanticEvidence({
    repoRoot: "/repo",
    anchors: [first, second],
    options: { ...options, semanticPolicy: "auto" },
    session: {
      semanticLocations: async (file: string) => {
        if (file === first.absolutePath) {
          throw new JavaIntelligenceError("JDT_NOT_READY", "semantic backend unavailable");
        }
        throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "semantic request timed out");
      },
      status: () => ({ started: false })
    },
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStoreV2: {},
    buildFingerprint: "bf",
    budget: DeadlineBudget.fromTimeout(5_000),
    metrics: { semantic }
  } as unknown as ProviderInput);

  assert.equal(semantic.timeout, true);
  assert.equal(result.completion, "FAILED");
  assert.equal(result.degradation, "semantic failed for anchors: A1");
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
