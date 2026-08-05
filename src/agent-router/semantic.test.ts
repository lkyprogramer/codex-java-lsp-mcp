// input: A fake JdtlsSession's references() response.
// output: Coverage for semanticVerify's Task 26 wiring - value ranking, not slice(0, 40) server order,
//         and the maxRawLocations safety cap's edge-persistence suppression - neither of which
//         reference-ranking.test.ts's pure-function tests exercise on their own.
import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import type { EdgeStore, SemanticEdgeInput } from "../edge-store.js";
import type { LspLocation } from "../jdtls-session.js";
import { toFileUri } from "../repo-layout.js";
import { resolveRoutingPolicy } from "../routing-policy.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { semanticVerify } from "./semantic.js";

const repoRoot = "/repo";

function location(absolutePath: string, line = 1): LspLocation {
  return { uri: toFileUri(absolutePath), range: { start: { line, character: 1 }, end: { line, character: 1 } } };
}

function anchor(overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  return {
    id: "A1",
    absolutePath: `${repoRoot}/module-a/src/main/java/demo/Anchor.java`,
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Anchor",
    kind: "class",
    module: "module-a",
    ...overrides
  };
}

function options(overrides: Partial<ImpactOptions> = {}): ImpactOptions {
  return {
    anchors: [],
    mode: "balanced",
    profile: "auto",
    semanticPolicy: "required",
    semanticTimeoutMs: 5_000,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    ...overrides
  };
}

function semanticState() {
  return {
    used: true,
    verifyUsed: false,
    verifySkipped: false,
    timeout: false,
    externalLocationsSuppressed: 0,
    referenceRawLocations: 0,
    referenceCollapsedFiles: 0,
    referenceReturnedFiles: 0,
    referenceTruncatedByLimit: false,
    referenceRankingMs: 0
  };
}

function fakeSession(referenceItems: LspLocation[]) {
  return {
    status: () => ({ started: true, progress: { active: 0 } }),
    references: async () => ({ items: referenceItems, totalReferences: referenceItems.length, truncated: false }),
    typeHierarchy: async () => ({ roots: [], edges: [], completion: "COMPLETE" as const })
  };
}

function fakeEdgeStore(): { recordEdges: EdgeStore["recordEdges"]; calls: Array<{ fromFile: string; edges: SemanticEdgeInput[] }> } {
  const calls: Array<{ fromFile: string; edges: SemanticEdgeInput[] }> = [];
  return {
    calls,
    recordEdges: (fromFile: string, edges: SemanticEdgeInput[]) => {
      calls.push({ fromFile, edges });
    }
  };
}

/** No symbol ever resolves, so mapSemanticEdgeForPersistence always returns undefined and edgeStoreV2 never gets a real edge - these tests exercise the legacy edgeStore path only, matching their pre-Task-33-Step-8 assertions. */
function fakeJavaIndex(): { queryAnchor: (file: string, line: number, column: number) => Promise<undefined> } {
  return { queryAnchor: async () => undefined };
}

function fakeEdgeStoreV2(): { putComplete: (edges: readonly unknown[], generation: number) => Promise<void>; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    putComplete: async (edges: readonly unknown[]) => {
      calls.push([...edges]);
    }
  };
}

/** Every position resolves to a distinct symbol ID derived from its own coordinates - lets a test assert exactly which positions were (and were not) re-resolved. */
function resolvingJavaIndex(): { queryAnchor: (file: string, line: number, column: number) => Promise<{ symbolId: string }>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    queryAnchor: async (file: string, line: number, column: number) => {
      const key = `${file}:${line}:${column}`;
      calls.push(key);
      return { symbolId: key };
    }
  };
}

test("semanticVerify ranks reference candidates by value instead of JDT server order", async () => {
  const lowValueRefs = Array.from({ length: 60 }, (_, i) =>
    location(`${repoRoot}/module-x/src/test/java/T${i}.java`, 1));
  const highValueRef = location(`${repoRoot}/module-a/src/main/java/demo/OrderService.java`, 80);
  const candidates = new Map<string, CandidateFile>();
  const edgeStore = fakeEdgeStore();

  await semanticVerify({
    candidates,
    anchors: [anchor()],
    options: options({ taskKeywords: ["order"] }),
    semantic: semanticState(),
    phaseMs: {},
    repoRoot,
    session: fakeSession([...lowValueRefs, highValueRef]) as never,
    routingPolicy: resolveRoutingPolicy(repoRoot),
    edgeStore: edgeStore as unknown as EdgeStore,
    budget: DeadlineBudget.fromTimeout(5_000),
    javaIndex: fakeJavaIndex() as never,
    edgeStoreV2: fakeEdgeStoreV2() as never,
    buildFingerprint: "test-fingerprint",
    generation: 1
  });

  assert.ok(
    candidates.has(`${repoRoot}/module-a/src/main/java/demo/OrderService.java`),
    "the single same-module, task-keyword-matching main-source file must survive value-ranked truncation, not be pushed out by 60 unrelated test files"
  );
});

test("semanticVerify skips persisted-edge writes when raw reference locations hit the safety cap", async () => {
  const manyRefs = Array.from({ length: 5_001 }, (_, i) =>
    location(`${repoRoot}/module-a/src/main/java/demo/File${i}.java`, 1));
  const candidates = new Map<string, CandidateFile>();
  const edgeStore = fakeEdgeStore();
  const semantic = semanticState();

  await semanticVerify({
    candidates,
    anchors: [anchor()],
    options: options(),
    semantic,
    phaseMs: {},
    repoRoot,
    session: fakeSession(manyRefs) as never,
    routingPolicy: resolveRoutingPolicy(repoRoot),
    edgeStore: edgeStore as unknown as EdgeStore,
    budget: DeadlineBudget.fromTimeout(5_000),
    javaIndex: fakeJavaIndex() as never,
    edgeStoreV2: fakeEdgeStoreV2() as never,
    buildFingerprint: "test-fingerprint",
    generation: 1
  });

  assert.equal(semantic.referenceTruncatedByLimit, true);
  assert.equal(
    edgeStore.calls.some(call => call.edges.some(edge => edge.kind === "reference")),
    false,
    "a reference set built from a truncated raw location list must not be persisted as a complete edge"
  );
  assert.ok(candidates.size > 1, "truncation still yields ranked candidates - only edge persistence is suppressed");
});

test("semanticVerify caps returned reference files at referenceFileLimit(mode) and reports collapse metrics", async () => {
  const refs = Array.from({ length: 80 }, (_, i) =>
    location(`${repoRoot}/module-a/src/main/java/demo/Distinct${i}.java`, 1));
  const candidates = new Map<string, CandidateFile>();
  const semantic = semanticState();

  await semanticVerify({
    candidates,
    anchors: [anchor()],
    options: options({ mode: "minimal" }),
    semantic,
    phaseMs: {},
    repoRoot,
    session: fakeSession(refs) as never,
    routingPolicy: resolveRoutingPolicy(repoRoot),
    edgeStore: fakeEdgeStore() as unknown as EdgeStore,
    budget: DeadlineBudget.fromTimeout(5_000),
    javaIndex: fakeJavaIndex() as never,
    edgeStoreV2: fakeEdgeStoreV2() as never,
    buildFingerprint: "test-fingerprint",
    generation: 1
  });

  // referenceFileLimit("minimal") is 12 (reference-ranking.ts).
  assert.equal(semantic.referenceReturnedFiles, 12);
  assert.equal(semantic.referenceCollapsedFiles, 80);
  assert.equal(semantic.referenceRawLocations, 80);
});

test("semanticVerify dual-writes resolvable reference edges into edgeStoreV2, resolving the shared anchor source position only once", async () => {
  const refs = [
    location(`${repoRoot}/module-a/src/main/java/demo/One.java`, 10),
    location(`${repoRoot}/module-a/src/main/java/demo/Two.java`, 20),
    location(`${repoRoot}/module-a/src/main/java/demo/Three.java`, 30)
  ];
  const candidates = new Map<string, CandidateFile>();
  const javaIndex = resolvingJavaIndex();
  const edgeStoreV2 = fakeEdgeStoreV2();
  const theAnchor = anchor();

  await semanticVerify({
    candidates,
    anchors: [theAnchor],
    options: options(),
    semantic: semanticState(),
    phaseMs: {},
    repoRoot,
    session: fakeSession(refs) as never,
    routingPolicy: resolveRoutingPolicy(repoRoot),
    edgeStore: fakeEdgeStore() as unknown as EdgeStore,
    budget: DeadlineBudget.fromTimeout(5_000),
    javaIndex: javaIndex as never,
    edgeStoreV2: edgeStoreV2 as never,
    buildFingerprint: "test-fingerprint",
    generation: 7
  });

  assert.equal(edgeStoreV2.calls.length, 1, "one putComplete call for this anchor's batch");
  assert.equal(edgeStoreV2.calls[0]?.length, 3, "all three resolvable reference edges are persisted");
  const sourceKey = `${theAnchor.absolutePath}:${theAnchor.line}:${theAnchor.column}`;
  assert.equal(
    javaIndex.calls.filter(call => call === sourceKey).length,
    1,
    "the shared source anchor position is resolved exactly once across all three edges, not once per edge"
  );
});
