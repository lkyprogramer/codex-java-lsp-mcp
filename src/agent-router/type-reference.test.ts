import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedAnchor } from "../agent-types.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import { normalizeEvidence } from "./evidence-normalizer.js";
import { genericFamilyRankPolicy, rankCandidates as rankByFamily } from "./family-ranker.js";
import {
  collectTypeReferenceSignals,
  type CollectTypeReferenceSignalsInput,
  type TypeReferenceMetrics
} from "./type-reference.js";

const anchor: ResolvedAnchor = {
  id: "A1",
  absolutePath: "/repo/src/main/java/demo/ConfirmController.java",
  path: "src/main/java/demo/ConfirmController.java",
  sourceSet: "main",
  line: 12,
  column: 1,
  profile: "controller",
  symbolName: "confirm",
  className: "ConfirmController",
  kind: "class"
};

function facts(absolutePath: string, overrides: Partial<JavaSourceFacts> = {}): JavaSourceFacts {
  return {
    absolutePath,
    path: absolutePath.slice("/repo/".length),
    sourceSet: "main",
    packageName: "demo",
    typeName: absolutePath.split("/").at(-1)!.replace(/\.java$/, ""),
    kind: "class",
    implementsTypes: [],
    referencedTypes: [],
    imports: [],
    wildcardImports: [],
    annotations: [],
    methods: [],
    factSource: "javaIndex",
    ...overrides
  };
}

function metrics(): TypeReferenceMetrics {
  return {
    scannedPatterns: 0,
    addedCandidates: 0,
    skippedExisting: 0,
    elapsedMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheMissElapsedMs: 0,
    indexHits: 0,
    indexMisses: 0
  };
}

async function collect(
  javaIndex: Record<string, unknown>,
  overrides: Partial<CollectTypeReferenceSignalsInput> = {}
) {
  let signal = 0;
  return collectTypeReferenceSignals({
    anchors: [anchor],
    options: { taskKeywords: [] },
    metrics: metrics(),
    javaIndex: javaIndex as never,
    generation: 7,
    existingCandidatePaths: [],
    providerId: "static",
    providerVersion: "1",
    nextSignalId: () => `static:${++signal}`,
    ...overrides
  });
}

test("collector emits a complete evidence-native direct declaration", async () => {
  const response = facts("/repo/src/main/java/demo/ConfirmResponse.java");
  const result = await collect({
    factsFor: async () => facts(anchor.absolutePath, { referencedTypes: ["demo.ConfirmResponse"] }),
    findTypeReferences: async () => [],
    findTypeDefinitions: async () => [response],
    methodAt: async () => undefined,
    findImplementers: async () => []
  });

  assert.deepEqual(result.failedAnchorIds, []);
  assert.deepEqual(result.evidence, [{
    signalId: "static:1",
    candidateFile: response.absolutePath,
    anchorId: "A1",
    kind: "REFERENCE",
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence: 0.8,
    completeness: "COMPLETE",
    weight: 55,
    sourceFile: anchor.absolutePath,
    positions: [{ line: 1, column: 1 }],
    providerId: "static",
    providerVersion: "1",
    generation: 7,
    detail: "typeReference",
    candidateMetadata: {
      categories: ["semantic"],
      reasons: ["typeReference"],
      verifiedBy: ["typeReference"],
      matchCount: 0
    }
  }]);
});

test("collector batches anchor facts while retaining per-anchor type priority", async () => {
  const second: ResolvedAnchor = {
    ...anchor,
    id: "A2",
    absolutePath: "/repo/src/main/java/demo/SecondService.java",
    path: "src/main/java/demo/SecondService.java",
    className: "SecondService",
    symbolName: "load",
    profile: "service"
  };
  const firstResponse = facts("/repo/src/main/java/demo/FirstResponse.java");
  const secondResponse = facts("/repo/src/main/java/demo/SecondResponse.java");
  const factBatches: string[][] = [];
  const definitionBatches: string[][] = [];
  const result = await collect({
    factsForFiles: async (paths: readonly string[]) => {
      factBatches.push([...paths]);
      return {
        generation: 7,
        completion: "COMPLETE",
        truncated: false,
        items: [
          { state: "FOUND", facts: facts(anchor.absolutePath, { referencedTypes: ["demo.FirstResponse"] }) },
          { state: "FOUND", facts: facts(second.absolutePath, { referencedTypes: ["demo.SecondResponse"] }) }
        ]
      };
    },
    findTypeReferences: async () => [],
    findTypeDefinitions: async (names: readonly string[]) => {
      definitionBatches.push([...names]);
      return names[0] === "demo.FirstResponse" ? [firstResponse] : [secondResponse];
    },
    methodAt: async () => undefined,
    findImplementers: async () => []
  }, { anchors: [anchor, second] });

  assert.deepEqual(factBatches, [[anchor.absolutePath, second.absolutePath]]);
  assert.deepEqual(definitionBatches, [["demo.FirstResponse"], ["demo.SecondResponse"]]);
  assert.deepEqual(result.evidence.map(signal => [signal.anchorId, signal.candidateFile]), [
    ["A1", firstResponse.absolutePath],
    ["A2", secondResponse.absolutePath]
  ]);
});

test("retired controller order bonuses do not leak into evidence family ranking", async () => {
  const zService = facts("/repo/src/main/java/demo/ZService.java", {
    typeName: "ZService",
    typeId: "type:demo.ZService"
  });
  const aService = facts("/repo/src/main/java/demo/AService.java", {
    typeName: "AService",
    typeId: "type:demo.AService"
  });
  const definitionCalls: Array<{ names: readonly string[]; hydrate: boolean | undefined }> = [];
  const result = await collect({
    factsFor: async () => facts(anchor.absolutePath, {
      typeId: "type:demo.ConfirmController",
      referencedTypes: ["demo.ZService", "demo.AService"]
    }),
    findTypeReferences: async () => [],
    findTypeDefinitions: async (names: readonly string[], _limit: number, hydrate: boolean | undefined) => {
      definitionCalls.push({ names: [...names], hydrate });
      return [zService, aService];
    },
    findImplementers: async () => []
  });

  assert.deepEqual(definitionCalls, [{
    names: ["demo.ZService", "demo.AService"],
    hydrate: false
  }]);
  assert.deepEqual(
    result.evidence.map(signal => [signal.candidateFile, signal.weight]),
    [[zService.absolutePath, 55], [aService.absolutePath, 55]]
  );
  const ranked = rankByFamily([...normalizeEvidence(result.evidence, "/repo").values()], {
    policy: genericFamilyRankPolicy
  });
  assert.deepEqual(ranked.map(candidate => candidate.file), [aService.absolutePath, zService.absolutePath]);
});

test("type-reference discovery reuses known type ids and hydrates only implementer bundles", async () => {
  const port = facts("/repo/src/main/java/demo/ConfirmGateway.java", {
    kind: "interface",
    typeName: "ConfirmGateway",
    typeId: "type:demo.ConfirmGateway"
  });
  const implementation = facts("/repo/src/main/java/demo/DefaultConfirmGateway.java", {
    typeId: "type:demo.DefaultConfirmGateway"
  });
  const referenceOptions: unknown[] = [];
  const implementerOptions: unknown[] = [];
  const result = await collect({
    factsFor: async () => facts(anchor.absolutePath, {
      typeId: "type:demo.ConfirmController",
      referencedTypes: ["demo.ConfirmGateway"]
    }),
    findTypeReferences: async (_name: string, _limit: number, options: unknown) => {
      referenceOptions.push(options);
      return [];
    },
    findTypeDefinitions: async () => [port],
    findImplementers: async (_name: string, _limit: number, _scope: string, options: unknown) => {
      implementerOptions.push(options);
      return [implementation];
    }
  });

  assert.deepEqual(referenceOptions, [{ typeId: "type:demo.ConfirmController", hydrate: false }]);
  assert.deepEqual(implementerOptions, [{ typeId: "type:demo.ConfirmGateway", hydrate: true }]);
  assert.deepEqual(result.evidence.map(signal => signal.candidateFile), [port.absolutePath, implementation.absolutePath]);
});

test("an already-expired request performs no JavaIndex work", async () => {
  let calls = 0;
  const result = await collect({
    factsForFiles: async () => { calls += 1; throw new Error("must not run"); },
    factsFor: async () => { calls += 1; throw new Error("must not run"); },
    findTypeReferences: async () => { calls += 1; return []; },
    findTypeDefinitions: async () => { calls += 1; return []; },
    findImplementers: async () => { calls += 1; return []; }
  }, {
    budget: { expired: () => true } as never
  });

  assert.equal(calls, 0);
  assert.deepEqual(result.deadlineExceededAnchorIds, ["A1"]);
  assert.deepEqual(result.evidence, []);
});

test("the same candidate keeps distinct evidence for each anchor", async () => {
  const second = { ...anchor, id: "A2", className: "SecondController" };
  const shared = facts("/repo/src/main/java/demo/SharedResponse.java");
  const result = await collect({
    factsForFiles: async () => ({
      generation: 7,
      completion: "COMPLETE",
      truncated: false,
      items: [
        { state: "FOUND", facts: facts(anchor.absolutePath, { referencedTypes: ["demo.SharedResponse"] }) },
        { state: "FOUND", facts: facts(second.absolutePath, { referencedTypes: ["demo.SharedResponse"] }) }
      ]
    }),
    findTypeReferences: async () => [],
    findTypeDefinitions: async () => [shared],
    methodAt: async () => undefined,
    findImplementers: async () => []
  }, { anchors: [anchor, second] });

  assert.deepEqual(result.evidence.map(signal => signal.anchorId), ["A1", "A2"]);
  assert.ok(result.evidence.every(signal => signal.candidateFile === shared.absolutePath));
});

test("an existing imported path emits exact metadata without parsing that candidate", async () => {
  const existing = "/repo/src/main/java/demo/ConfirmResponse.java";
  const factsCalls: string[] = [];
  const result = await collect({
    factsFor: async (file: string) => {
      factsCalls.push(file);
      return facts(anchor.absolutePath, { referencedTypes: ["demo.ConfirmResponse"] });
    },
    findTypeReferences: async () => [],
    findTypeDefinitions: async () => [],
    methodAt: async () => undefined,
    findImplementers: async () => []
  }, { existingCandidatePaths: [existing] });

  assert.deepEqual(factsCalls, [anchor.absolutePath]);
  assert.equal(result.evidence[0]?.candidateFile, existing);
  assert.deepEqual(result.evidence[0]?.positions, []);
  assert.deepEqual(result.evidence[0]?.candidateMetadata?.verifiedBy, ["typeReference"]);
});

test("interface implementer uses the unique caller-site callee instead of (1,1)", async () => {
  const deleteAnchor: ResolvedAnchor = {
    ...anchor,
    line: 62,
    methodName: "delete",
    symbolName: "delete",
    kind: "Method"
  };
  const port = facts("/repo/src/main/java/demo/PositionCheckPeopleService.java", {
    kind: "interface",
    typeName: "PositionCheckPeopleService"
  });
  const implementation = facts("/repo/src/main/java/demo/PositionCheckPeopleServiceImpl.java", {
    methods: [
      { name: "page", line: 69, endLine: 80, referencedTypes: [], relations: [] },
      { name: "deleteCheckPeople", line: 172, endLine: 189, referencedTypes: [], relations: [] }
    ]
  });
  const result = await collect({
    factsFor: async () => facts(deleteAnchor.absolutePath, {
      referencedTypes: ["demo.PositionCheckPeopleService"],
      methods: [{
        name: "delete",
        line: 60,
        endLine: 66,
        referencedTypes: [],
        relations: [
          {
            kind: "local-receiver",
            typeName: "PositionCheckPeopleService",
            name: "deleteCheckPeople",
            line: 64,
            confidence: "medium",
            source: "ast"
          },
          {
            kind: "local-receiver",
            typeName: "CommonResult",
            name: "success",
            line: 65,
            confidence: "medium",
            source: "ast"
          }
        ]
      }]
    }),
    findTypeReferences: async () => [],
    findTypeDefinitions: async () => [port],
    findImplementers: async () => [implementation]
  }, { anchors: [deleteAnchor] });

  const implementer = result.evidence.find(signal => signal.kind === "IMPLEMENTS");
  assert.deepEqual(implementer?.positions, [{ line: 172, column: 1 }]);
});

test("interface implementation evidence retains its own source and typeGraph attribution", async () => {
  const port = facts("/repo/src/main/java/demo/ConfirmGateway.java", {
    kind: "interface",
    typeName: "ConfirmGateway"
  });
  const implementation = facts("/repo/src/main/java/demo/DefaultConfirmGateway.java");
  const result = await collect({
    factsFor: async () => facts(anchor.absolutePath, { referencedTypes: ["demo.ConfirmGateway"] }),
    findTypeReferences: async () => [],
    findTypeDefinitions: async () => [port],
    methodAt: async () => undefined,
    findImplementers: async () => [implementation]
  });

  assert.deepEqual(result.evidence.map(signal => [signal.kind, signal.candidateFile]), [
    ["REFERENCE", port.absolutePath],
    ["IMPLEMENTS", implementation.absolutePath]
  ]);
  const implementer = result.evidence[1]!;
  assert.equal(implementer.sourceFile, implementation.absolutePath);
  assert.equal(implementer.weight, 70);
  assert.deepEqual(implementer.candidateMetadata?.reasons, ["typeGraph:implementation-lookup"]);
  assert.deepEqual(implementer.candidateMetadata?.verifiedBy, ["typeGraph"]);
});

test("direct and definition discovery deduplicate to one signal with resolved position", async () => {
  const response = facts("/repo/src/main/java/demo/ConfirmResponse.java");
  const result = await collect({
    factsFor: async () => facts(anchor.absolutePath, { referencedTypes: ["demo.ConfirmResponse"] }),
    findTypeReferences: async () => [response],
    findTypeDefinitions: async () => [response],
    methodAt: async () => undefined,
    findImplementers: async () => []
  }, { existingCandidatePaths: [response.absolutePath] });

  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.evidence[0]?.positions, [{ line: 1, column: 1 }]);
});

test("deadline and cancellation stop definition, implementer, and later-anchor work", async () => {
  const second = { ...anchor, id: "A2", className: "SecondController" };
  for (const code of ["DEADLINE_EXCEEDED", "CANCELLED"] as const) {
    const calls: string[] = [];
    const result = await collect({
      factsForFiles: async () => ({
        generation: 7,
        completion: "COMPLETE",
        truncated: false,
        items: [
          { state: "FOUND", facts: facts(anchor.absolutePath, { referencedTypes: ["demo.FirstResponse"] }) },
          { state: "FOUND", facts: facts(second.absolutePath, { referencedTypes: ["demo.SecondResponse"] }) }
        ]
      }),
      findTypeReferences: async (typeName: string) => {
        calls.push(`references:${typeName}`);
        throw new JavaIntelligenceError(code, `synthetic ${code}`);
      },
      findTypeDefinitions: async () => {
        calls.push("definitions");
        return [];
      },
      findImplementers: async () => {
        calls.push("implementers");
        return [];
      }
    }, { anchors: [anchor, second] });

    assert.deepEqual(calls, ["references:ConfirmController"]);
    assert.deepEqual(result.deadlineExceededAnchorIds, code === "DEADLINE_EXCEEDED" ? ["A1"] : []);
    assert.deepEqual(result.cancelledAnchorIds, code === "CANCELLED" ? ["A1"] : []);
  }
});
