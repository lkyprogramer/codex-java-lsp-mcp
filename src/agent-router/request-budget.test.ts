import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ImpactOptions } from "../agent-types.js";
import type { JavaIndexRequestOptions } from "../java-index/java-index-client.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { AgentRouter } from "./index.js";

class EmptyRgRunner extends RgRunner {
  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
}

test("AgentRouter binds the request's absolute budget around the complete JavaIndex call chain", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-router-budget-"));
  const requestBudget = DeadlineBudget.fromTimeout(500);
  let boundOptions: JavaIndexRequestOptions | undefined;
  const status = {
    entries: 0,
    hits: 0,
    misses: 0,
    typeLookupIndexHits: 0,
    typeLookupIndexMisses: 0,
    openSource: "cold",
    coverage: "partial",
    javaIndex: {
      state: "READY",
      indexedGeneration: 1,
      files: 0,
      types: 0,
      methods: 0,
      edges: 0,
      snapshotBytes: 0,
      pendingForeground: 0,
      pendingBackground: 0,
      coverage: [],
      resourceCoverage: []
    }
  };
  const javaIndex = {
    async withRequestOptions<T>(options: JavaIndexRequestOptions, _action: () => Promise<T>): Promise<T> {
      boundOptions = options;
      throw new Error("request-budget-bound");
    },
    async routerStatus() { return status; },
    async queryReadRanges() { return []; },
    async repositoryMarkers() { return new Map<string, string>(); },
    async repositoryFactMarkers() { return { importPrefixFound: false, annotationPrefixFound: false }; },
    async frameworkStatus() { return { coverage: "partial" }; }
  };
  const session = {
    cacheStatus() { return { invalidations: 0, entries: 0, hits: 0, misses: 0 }; },
    status() {
      return {
        state: "NEW",
        started: false,
        progress: { active: 0 },
        generatedCode: {
          lombok: { detected: false, agentEnabled: false, status: "not-detected" },
          annotationProcessing: { detectedProcessors: [], enabled: false, source: "auto" },
          generatedCodeSemantics: "complete"
        }
      };
    }
  };
  const options: ImpactOptions = {
    anchors: [],
    mode: "balanced",
    profile: "service",
    semanticPolicy: "fast",
    semanticTimeoutMs: 100,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto"
  };
  const router = new AgentRouter(root, session as never, javaIndex as never, undefined, undefined, new EmptyRgRunner());

  await assert.rejects(
    () => router.impact(options, {
      requestId: "request-budget-test",
      repoRoot: root,
      repoHash: "fixture",
      budget: requestBudget,
      generation: 1,
      cacheReadAllowed: true,
      cacheWriteAllowed: true,
      negativeLookupAllowed: false,
      freshnessMode: "NORMAL",
      mode: "balanced",
      startedAtMs: 0
    }),
    /request-budget-bound/
  );

  assert.equal(boundOptions?.budget, requestBudget, "AgentRouter must not snapshot remaining milliseconds into a new budget");
});

test("live semantic timeouts share one bounded stage budget and leave time for the read plan", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-router-finalization-budget-"));
  const file = path.join(root, "OrderService.java");
  writeFileSync(file, "public class OrderService { void place() {} }\n", "utf8");
  let readRangeCalls = 0;
  let boundBudget: DeadlineBudget | undefined;
  const status = {
    entries: 1,
    hits: 0,
    misses: 0,
    typeLookupIndexHits: 0,
    typeLookupIndexMisses: 0,
    openSource: "cold",
    coverage: "complete",
    javaIndex: {
      state: "READY",
      indexedGeneration: 1,
      files: 1,
      types: 1,
      methods: 1,
      edges: 0,
      snapshotBytes: 0,
      pendingForeground: 0,
      pendingBackground: 0,
      coverage: [],
      resourceCoverage: []
    }
  };
  const facts = {
    absolutePath: file,
    path: "OrderService.java",
    sourceSet: "main",
    typeName: "OrderService",
    kind: "class",
    implementsTypes: [],
    referencedTypes: [],
    imports: [],
    wildcardImports: [],
    annotations: [],
    methods: [],
    factSource: "javaIndex"
  };
  const emptyFrameworkFacts = {
    types: [], methods: [], fields: [], missingIds: [], truncated: false,
    relativePath: "OrderService.java", module: "", sourceSet: "main", packageName: "", imports: [], coverage: "COMPLETE"
  };
  const javaIndex = {
    async withRequestOptions<T>(options: JavaIndexRequestOptions, action: () => Promise<T>): Promise<T> {
      const previousBudget = boundBudget;
      boundBudget = options.budget;
      try {
        return await action();
      } finally {
        boundBudget = previousBudget;
      }
    },
    async ensureFresh() {},
    async queryAnchor() { return undefined; },
    async factsFor() { return facts; },
    async methodAt() { return undefined; },
    async findImplementers() { return []; },
    async findTypeReferences() { return []; },
    async findImporters() { return []; },
    async findTypeDefinitions() { return []; },
    async resolvedCallees() { return { callees: [], truncated: false }; },
    async routerStatus() { return status; },
    async queryReadRanges(requests: Array<{ file: string }>) {
      boundBudget?.throwIfExpired("test.queryReadRanges");
      readRangeCalls += 1;
      return requests.map(request => ({
        file: request.file,
        ranges: [{
          startLine: 1,
          endLine: 1,
          range: { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
          kind: "fallback",
          estimatedBytes: 48
        }]
      }));
    },
    async frameworkFactsFor() { return emptyFrameworkFacts; },
    async frameworkFactsForFiles() { return []; },
    async declarationsById() { return { types: [], methods: [], fields: [], missingIds: [], truncated: false }; },
    async resolvedCalleesFor() { return new Map(); },
    async repositoryMarkers() { return new Map<string, string>(); },
    async repositoryFactMarkers() { return { importPrefixFound: false, annotationPrefixFound: false }; },
    async methodsWithParameterTypes() { return []; },
    async myBatisResourcesByNamespaces() { return new Map(); },
    async frameworkStatus() { return { coverage: "complete" }; }
  };
  const waitUntilDeadline = async (timeoutOrBudget: number | DeadlineBudget, stage: string): Promise<void> => {
    const operationBudget = typeof timeoutOrBudget === "number"
      ? DeadlineBudget.fromTimeout(timeoutOrBudget)
      : timeoutOrBudget;
    await operationBudget.race(stage, new Promise<void>(() => undefined));
  };
  const session = {
    cacheStatus() { return { invalidations: 0, entries: 0, hits: 0, misses: 0 }; },
    status() {
      return {
        state: "READY",
        started: true,
        progress: { active: 0 },
        generatedCode: {
          lombok: { detected: false, agentEnabled: false, status: "not-detected" },
          annotationProcessing: { detectedProcessors: [], enabled: false, source: "auto" },
          generatedCodeSemantics: "complete"
        }
      };
    },
    async semanticLocations(_file: string, _line: number, _column: number, timeoutOrBudget: number | DeadlineBudget) {
      await waitUntilDeadline(timeoutOrBudget, "test.semanticLocations");
      return { definitions: [], implementations: [] };
    },
    async references(_file: string, _line: number, _column: number, _includeDeclaration: boolean, timeoutOrBudget: number | DeadlineBudget) {
      await waitUntilDeadline(timeoutOrBudget, "test.references");
      return { items: [], totalReferences: 0, truncated: false };
    }
  };
  const router = new AgentRouter(root, session as never, javaIndex as never, undefined, undefined, new EmptyRgRunner());
  const requestBudget = DeadlineBudget.fromTimeout(700);

  const result = await router.impact({
    anchors: [{ file, line: 1, column: 14 }],
    mode: "balanced",
    profile: "service",
    semanticPolicy: "auto",
    semanticTimeoutMs: 400,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    verbosity: "diagnostic"
  }, {
    requestId: "finalization-budget-test",
    repoRoot: root,
    repoHash: "fixture",
    budget: requestBudget,
    generation: 1,
    cacheReadAllowed: true,
    cacheWriteAllowed: true,
    negativeLookupAllowed: false,
    freshnessMode: "NORMAL",
    mode: "balanced",
    startedAtMs: 0
  });

  assert.equal(readRangeCalls, 1, "the read-plan range batch must still run before the absolute deadline");
  assert.equal(result.semantic.completion, "PARTIAL_TIMEOUT");
  assert.ok(result.readPlan.length > 0, "deadline degradation must return a usable bounded read plan");
  assert.equal(JSON.stringify(result).includes("selectedCoordinateRangesByPath"), false, "exact benchmark coordinates must not leak into ImpactResultV6");
  assert.equal(requestBudget.expired(), false, "the router must retain a bounded finalization reserve");
});
