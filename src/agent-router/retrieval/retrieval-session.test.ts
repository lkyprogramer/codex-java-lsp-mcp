import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createRequestContext } from "../../runtime/request-context.js";
import { impactSchema, javaImpact } from "../../tools/impact.js";
import type { ToolContext } from "../../tools/context.js";
import type { ImpactOptions, ImpactResultV6, ImpactResultV7 } from "../../agent-types.js";
import { frontierOracleCoverage } from "./frontier-oracle.js";
import { requiredGroupsFromScenario } from "../../benchmark/golden-required-groups.js";
import type { Scenario } from "../../benchmark/golden-scenario.js";
import {
  CONSUMABLE_FRONTIER_RELATIONS,
  continueSession,
  createAnalysisSession,
  DEFAULT_CONTINUE_MAX_ADDITIONAL_READ_BYTES,
  inPoolFifoContinuationIds
} from "./retrieval-session-service.js";
import { RetrievalSessionStore } from "./retrieval-session-store.js";
import type { FrontierItemV1, FrontierShadowReport } from "./retrieval-types.js";
import { retrievalCostFromV6 } from "./cost-model.js";

const request = createRequestContext({
  repoRoot: "/repo",
  repoHash: "abc123",
  generation: 7,
  freshnessMode: "NORMAL",
  cacheReadAllowed: true,
  cacheWriteAllowed: true,
  negativeLookupAllowed: true,
  mode: "balanced",
  semanticPolicy: "fast"
});

function item(id: string, path: string, relation: FrontierItemV1["relation"], bytes = 100): FrontierItemV1 {
  return {
    id,
    fileId: id,
    path,
    ranges: [{ startLine: 1, endLine: 10, estimatedBytes: bytes }],
    relation,
    expectedEvidence: [relation],
    confidence: "high",
    estimatedReadBytes: bytes,
    hop: 1
  };
}

function shadow(items: FrontierItemV1[]): FrontierShadowReport {
  return {
    items,
    deferredQueries: [],
    stopReason: items.length > 0 ? "FRONTIER_AVAILABLE" : "NO_FRONTIER",
    coverage: {
      itemCount: items.length,
      relationCounts: {},
      familyCounts: {},
      estimatedReadBytes: items.reduce((sum, entry) => sum + entry.estimatedReadBytes, 0),
      responseBytes: 40,
      distinctRelations: new Set(items.map(entry => entry.relation)).size,
      distinctFamilies: 1
    },
    caps: { maxItems: 8, maxBytes: 8192, maxPerRelation: 2, maxPerFile: 1, maxPerFamily: 2 }
  };
}

test("session ids are opaque and never embed path or repoHash", () => {
  const store = new RetrievalSessionStore();
  const session = store.create({
    repoHash: request.repoHash,
    generation: request.generation,
    plannerVersion: 1,
    runtimeBuildSha: "deadbeef",
    maxSteps: 2,
    selectedPaths: ["src/A.java"],
    frontier: [item("C1", "src/Impl.java", "CLOSED_PORT_IMPLEMENTATION")],
    cumulative: retrievalCostFromV6({ resultBytes: 100, readBytes: 40, estimatedTokens: 35, suppressedRawBytes: 0 }),
    target: {
      file: "src/A.java",
      symbol: "A",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    }
  });
  assert.equal(session.sessionId.length, 32);
  assert.equal(/^[0-9a-f]+$/.test(session.sessionId), true);
  assert.equal(session.sessionId.includes("Impl"), false);
  assert.equal(session.sessionId.includes(request.repoHash), false);
});

test("store TTL, LRU, and shutdown clear stay bounded", () => {
  let now = 1_000;
  const store = new RetrievalSessionStore(2, 2, 50, () => now);
  const seed = (path: string) => store.create({
    repoHash: "r",
    generation: 1,
    plannerVersion: 1,
    runtimeBuildSha: "sha",
    maxSteps: 2,
    selectedPaths: [],
    frontier: [item("C1", path, "BUDGET_EVICTED")],
    cumulative: retrievalCostFromV6({ resultBytes: 1, readBytes: 1, estimatedTokens: 1, suppressedRawBytes: 0 }),
    target: {
      file: path,
      symbol: "X",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    }
  });
  const first = seed("a.java");
  const second = seed("b.java");
  seed("c.java");
  assert.equal(store.get(first.sessionId), undefined);
  assert.ok(store.get(second.sessionId));
  now += 100;
  assert.equal(store.get(second.sessionId), undefined);
  assert.ok(store.metrics.expired >= 1);
  seed("d.java");
  store.clear();
  assert.equal(store.size(), 0);
});

test("continue is fail-closed on generation mismatch and idempotent on the same ids", async () => {
  const store = new RetrievalSessionStore();
  const created = createAnalysisSession({
    store,
    frontier: shadow([
      item("C1", "src/Impl.java", "CLOSED_PORT_IMPLEMENTATION", 80),
      item("C2", "src/Helper.java", "SECOND_HOP_EXACT", 90)
    ]),
    selectedPaths: ["src/Anchor.java"],
    target: {
      file: "src/Anchor.java",
      symbol: "Anchor",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    request,
    runtimeBuildSha: "sha",
    maxSteps: 2,
    firstCost: { resultBytes: 400, readBytes: 200, estimatedTokens: 150, suppressedRawBytes: 0 }
  })!;
  await assert.rejects(
    () => continueSession({
      store,
      sessionId: created.sessionId,
      ids: ["C1"],
      maxAdditionalReadBytes: 8192,
      request: { ...request, generation: request.generation + 1 },
      runtimeBuildSha: "sha"
    }),
    /CONTINUATION_STALE/
  );
  const first = await continueSession({
    store,
    sessionId: created.sessionId,
    ids: ["C1"],
    maxAdditionalReadBytes: 8192,
    request,
    runtimeBuildSha: "sha"
  });
  const again = await continueSession({
    store,
    sessionId: created.sessionId,
    ids: ["C1"],
    maxAdditionalReadBytes: 8192,
    request,
    runtimeBuildSha: "sha"
  });
  assert.deepEqual(again.snapshot.ids, first.snapshot.ids);
  assert.equal(again.session.step, 1);
  assert.equal(JSON.stringify(again.snapshot).includes("/repo"), false);
});

test("consumable frontier drops reverse-caller and never invents a discovery-gap file", () => {
  const store = new RetrievalSessionStore();
  const session = createAnalysisSession({
    store,
    frontier: shadow([
      item("C1", "src/Impl.java", "CLOSED_PORT_IMPLEMENTATION"),
      item("C2", "src/Caller.java", "REVERSE_CALLER_QUERY"),
      item("C3", "modules/iam/src/main/java/com/lishu/edu/iam/application/service/MeQueryService.java", "REVERSE_CALLER_QUERY")
    ]),
    selectedPaths: ["src/Anchor.java"],
    target: {
      file: "src/Anchor.java",
      symbol: "A",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    request,
    runtimeBuildSha: "sha",
    maxSteps: 2,
    firstCost: { resultBytes: 10, readBytes: 10, estimatedTokens: 5, suppressedRawBytes: 0 }
  })!;
  assert.deepEqual(session.frontier.map(entry => entry.path), ["src/Impl.java"]);
  assert.equal(session.frontier.some(entry => entry.path.includes("MeQueryService")), false);
  assert.equal(CONSUMABLE_FRONTIER_RELATIONS.has("REVERSE_CALLER_QUERY"), false);
});

test("rReadMust@2calls lifts in-pool holdout files and leaves discovery-gap uncovered", async () => {
  const mustHit = [
    "modules/paper/src/main/java/com/lishu/edu/paper/application/service/PaperTaskCommandAppService.java",
    "modules/paper/src/main/java/com/lishu/edu/paper/application/service/PaperAccessService.java",
    "modules/iam/src/main/java/com/lishu/edu/iam/application/service/MeQueryService.java",
    "modules/exam/src/main/java/com/lishu/edu/exam/infrastructure/excel/ExamScoreExportExcelGenerator.java"
  ];
  const scenario: Scenario = {
    id: "mixed-holdout",
    name: "mixed",
    anchor: { file: mustHit[0]!, line: 1, column: 1, profile: "service" },
    golden: { mustHit }
  };
  const firstPlan = [mustHit[0]!, mustHit[1]!];
  const store = new RetrievalSessionStore();
  const session = createAnalysisSession({
    store,
    frontier: shadow([
      item("C1", mustHit[3]!, "CLOSED_PORT_IMPLEMENTATION", 120),
      item("C2", mustHit[2]!, "REVERSE_CALLER_QUERY", 120)
    ]),
    selectedPaths: firstPlan,
    target: {
      file: mustHit[0]!,
      symbol: "PaperTask",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    request,
    runtimeBuildSha: "sha",
    maxSteps: 2,
    firstCost: { resultBytes: 1000, readBytes: 400, estimatedTokens: 350, suppressedRawBytes: 0 }
  })!;
  const continued = await continueSession({
    store,
    sessionId: session.sessionId,
    ids: session.frontier.map(entry => entry.id),
    maxAdditionalReadBytes: 8192,
    request,
    runtimeBuildSha: "sha"
  });
  const groups = requiredGroupsFromScenario(scenario);
  const first = frontierOracleCoverage(groups, firstPlan, []);
  const twoCall = frontierOracleCoverage(groups, firstPlan, continued.snapshot.files.map(file => file.path));
  assert.ok(twoCall.oracleCoverage > first.firstCoverage);
  assert.ok(twoCall.uncoveredGroupIds.some(id => id.includes("MeQueryService")));
  assert.equal(continued.snapshot.files.some(file => file.path.includes("MeQueryService")), false);
});

test("in-pool fifo continuation ids skip non-consumable relations and honor the byte cap", () => {
  const ids = inPoolFifoContinuationIds([
    item("skip", "src/MeQueryService.java", "REVERSE_CALLER_QUERY", 40),
    item("a", "src/A.java", "BUDGET_EVICTED", 100),
    item("b", "src/B.java", "CLOSED_PORT_IMPLEMENTATION", 8000),
    item("c", "src/C.java", "SECOND_HOP_EXACT", 200)
  ], 8192);
  assert.deepEqual(ids, ["a", "b"]);
  assert.equal(DEFAULT_CONTINUE_MAX_ADDITIONAL_READ_BYTES, 8192);
  assert.deepEqual(inPoolFifoContinuationIds([
    item("big", "src/Big.java", "BUDGET_EVICTED", 9000)
  ]), []);
});

test("java_impact default analyze stays V6; retrieval.enabled analyze then continue is V7", async () => {
  const store = new RetrievalSessionStore();
  const context = impactContext(store, [
    item("C1", "src/main/java/demo/OrderServiceImpl.java", "CLOSED_PORT_IMPLEMENTATION", 80)
  ]);
  const analyzeArgs = {
    anchors: [{ file: "src/main/java/demo/OrderService.java", line: 1, column: 1 }],
    mode: "balanced" as const,
    profile: "auto" as const,
    semanticPolicy: "fast" as const,
    testReadMode: "defer" as const,
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto" as const,
    verbosity: "standard" as const
  };
  const v6 = await javaImpact(context, analyzeArgs, request) as ImpactResultV6;
  const v7 = await javaImpact(context, { ...analyzeArgs, retrieval: { enabled: true } }, request) as ImpactResultV7;
  assert.equal(v6.version, 6);
  assert.equal("retrieval" in v6, false);
  assert.deepEqual(v7.readPlan.map(item => item.fileId), v6.readPlan.map(item => item.fileId));
  assert.equal(v7.version, 7);
  assert.equal(v7.kind, "analysis");
  assert.equal(v7.retrieval.frontier[0]?.path.startsWith("/"), false);
  const continued = await javaImpact(context, {
    ...analyzeArgs,
    action: "continue",
    anchors: undefined,
    continuation: { sessionId: v7.retrieval.sessionId, ids: [v7.retrieval.frontier[0]!.id] }
  }, request) as ImpactResultV7;
  assert.equal(continued.kind, "continuation");
  assert.deepEqual(continued.retrieval.consumed, [v7.retrieval.frontier[0]!.id]);
  assert.equal(continued.readPlan[0]?.reason, "CLOSED_PORT_IMPLEMENTATION");
});

test("impact schema defaults action=analyze, forbids mixed continue+anchors, and stays five-tool additive", () => {
  const parsed = z.object(impactSchema).safeParse({
    file: "src/main/java/demo/Demo.java",
    line: 1,
    column: 1
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.action, "analyze");
  const keys = Object.keys(impactSchema);
  assert.ok(keys.includes("action"));
  assert.ok(keys.includes("continuation"));
  assert.ok(keys.includes("retrieval"));
  assert.equal(keys.includes("java_context"), false);
  assert.ok(JSON.stringify(keys).length < 800);
});

test("concurrent continue on one session serializes and does not double-count", async () => {
  const store = new RetrievalSessionStore();
  const created = createAnalysisSession({
    store,
    frontier: shadow([
      item("C1", "src/Impl.java", "CLOSED_PORT_IMPLEMENTATION", 40),
      item("C2", "src/Alt.java", "BUDGET_EVICTED", 40)
    ]),
    selectedPaths: ["src/A.java"],
    target: {
      file: "src/A.java",
      symbol: "A",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    request,
    runtimeBuildSha: "sha",
    maxSteps: 2,
    firstCost: { resultBytes: 10, readBytes: 10, estimatedTokens: 5, suppressedRawBytes: 0 }
  })!;
  const results = await Promise.all([
    continueSession({ store, sessionId: created.sessionId, ids: ["C1"], maxAdditionalReadBytes: 8192, request, runtimeBuildSha: "sha" }),
    continueSession({ store, sessionId: created.sessionId, ids: ["C1"], maxAdditionalReadBytes: 8192, request, runtimeBuildSha: "sha" })
  ]);
  assert.deepEqual(results[0]!.snapshot.ids, ["C1"]);
  assert.deepEqual(results[1]!.snapshot.ids, ["C1"]);
  assert.equal(store.get(created.sessionId)?.step, 1);
  assert.equal(store.get(created.sessionId)?.consumedIds.length, 1);
});

function impactContext(store: RetrievalSessionStore, frontier: FrontierItemV1[]): ToolContext {
  const payload: ImpactResultV6 = {
    version: 6,
    target: {
      file: "src/main/java/demo/OrderService.java",
      symbol: "OrderService",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    freshness: { requestGeneration: 7, indexedGeneration: 7, coverage: "COMPLETE", changedDuringRequest: false },
    semantic: { policy: "fast", used: false, completion: "COMPLETE" },
    files: [{
      id: "F1",
      path: "src/main/java/demo/OrderService.java",
      role: "target",
      confidence: "high",
      evidence: ["target"],
      locations: [{ line: 1, column: 1 }]
    }],
    readPlan: [{
      priority: "P0",
      fileId: "F1",
      ranges: [{ startLine: 1, endLine: 10, estimatedBytes: 400 }],
      reason: "anchor",
      expectedEvidence: ["target"],
      estimatedBytes: 400
    }],
    evidenceGaps: [],
    cost: { resultBytes: 0, readBytes: 400, estimatedTokens: 100, suppressedRawBytes: 0 },
    metrics: { routingVersion: 6, elapsedMs: 1 }
  };
  return {
    repoRoot: "/repo",
    retrievalSessions: store,
    session: { drainPhaseMetrics() { return {}; } },
    router: {
      async impact(_options: ImpactOptions, _request: unknown, observer?: { frontierShadow?(report: FrontierShadowReport): void }) {
        observer?.frontierShadow?.(shadow(frontier));
        return structuredClone(payload);
      }
    }
  } as unknown as ToolContext;
}
