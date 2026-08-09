// input: Hand-written fake FrameworkAdapters - no real JavaIndex/worker needed, the runner is pure orchestration.
// output: Coverage for merge/fail-soft/deadline/traversal-cap behavior, and the empty-registry
//         (current production default) zero-evidence case Slice D's own zero-behavior-change test reuses.
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedAnchor } from "../../agent-types.js";
import type { FrameworkIndexView } from "../../java-index/framework-index-view.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { frameworkFactsForFiles, type FrameworkAdapter, type FrameworkAdapterContext, type FrameworkCollectResult } from "./adapter.js";
import { MAX_FRAMEWORK_TRAVERSAL_FILES, runFrameworkAdapters } from "./runner.js";

function anchor(): ResolvedAnchor {
  return {
    id: "A1",
    absolutePath: "/repo/module-a/src/main/java/demo/Anchor.java",
    line: 1,
    column: 1,
    profile: "service",
    symbolName: "Anchor",
    kind: "class"
  };
}

function context(overrides: Partial<FrameworkAdapterContext> = {}): FrameworkAdapterContext {
  return {
    repoRoot: "/repo",
    anchors: [anchor()],
    candidateFiles: ["/repo/module-a/src/main/java/demo/Service.java"],
    staticEvidence: [],
    frameworkIndex: {} as FrameworkIndexView,
    generation: 1,
    budget: DeadlineBudget.fromTimeout(5_000),
    ...overrides
  };
}

function emptyResult(): FrameworkCollectResult {
  return { outcome: { providerId: "x", providerVersion: "1", evidence: [], completion: "COMPLETE", elapsedMs: 0 }, metadata: {}, diagnostics: [] };
}

function fakeAdapter(overrides: Partial<FrameworkAdapter> & { id: string }): FrameworkAdapter {
  return {
    version: "1",
    isActive: async () => true,
    collect: async () => emptyResult(),
    ...overrides
  };
}

test("an empty adapter registry (the current production default) yields zero evidence and a COMPLETE outcome", async () => {
  const result = await runFrameworkAdapters([], context());

  assert.deepEqual(result.outcome.evidence, []);
  assert.equal(Object.hasOwn(result.outcome, "candidates"), false);
  assert.equal(result.outcome.completion, "COMPLETE");
  assert.deepEqual(result.metadata, {});
  assert.deepEqual(result.diagnostics, []);
});

test("merges evidence/metadata across active adapters and skips an inactive one entirely", async () => {
  const signal = {
    signalId: "s1", candidateFile: "/repo/A.java", anchorId: "A1", kind: "SPRING_INJECTION", family: "FRAMEWORK" as const,
    provenance: "FRAMEWORK_INFERRED" as const, confidence: 0.9, completeness: "COMPLETE" as const, weight: 80,
    sourceFile: "/repo/A.java", positions: [], providerId: "spring", providerVersion: "1", generation: 1
  };
  const activeAdapter = fakeAdapter({
    id: "active",
    collect: async () => ({
      outcome: { providerId: "x", providerVersion: "1", evidence: [signal], completion: "COMPLETE", elapsedMs: 1 },
      metadata: { beans: 3 },
      diagnostics: ["active adapter note"]
    })
  });
  const inactiveAdapter = fakeAdapter({
    id: "inactive",
    isActive: async () => false,
    collect: async () => { throw new Error("must not be called when inactive"); }
  });

  const result = await runFrameworkAdapters([activeAdapter, inactiveAdapter], context());

  assert.deepEqual(result.outcome.evidence, [signal]);
  assert.deepEqual(result.metadata, { active: { beans: 3 } });
  assert.deepEqual(result.diagnostics, ["active adapter note"]);
  assert.equal(result.outcome.completion, "COMPLETE");
});

test("an adapter whose isActive() throws runs conservatively, degrades, and does not stop later adapters", async () => {
  let conservativeCollectCalls = 0;
  const throwingIsActive = fakeAdapter({
    id: "broken-active",
    isActive: async () => { throw new Error("boom"); },
    collect: async () => {
      conservativeCollectCalls += 1;
      return { ...emptyResult(), metadata: { conservative: true } };
    }
  });
  const ranAfter = fakeAdapter({ id: "after", collect: async () => ({ ...emptyResult(), metadata: { ran: true } }) });

  const result = await runFrameworkAdapters([throwingIsActive, ranAfter], context());

  assert.ok(result.diagnostics.some(d => d.includes("broken-active") && d.includes("isActive")));
  assert.ok(result.diagnostics.some(d => d.includes("broken-active") && d.includes("conservatively")));
  assert.equal(conservativeCollectCalls, 1);
  assert.deepEqual(result.metadata, { "broken-active": { conservative: true }, after: { ran: true } });
  assert.equal(result.outcome.completion, "FAILED");
});

test("an adapter whose collect() throws is skipped, fail-soft, and degrades completion to FAILED", async () => {
  const throwingCollect = fakeAdapter({ id: "broken-collect", collect: async () => { throw new Error("boom"); } });
  const ranAfter = fakeAdapter({ id: "after", collect: async () => ({ ...emptyResult(), metadata: { ran: true } }) });

  const result = await runFrameworkAdapters([throwingCollect, ranAfter], context());

  assert.ok(result.diagnostics.some(d => d.includes("broken-collect") && d.includes("collect")));
  assert.deepEqual(result.metadata, { after: { ran: true } }, "one adapter's crash must not prevent a later adapter from running");
  assert.equal(result.outcome.completion, "FAILED");
});

test("an unavailable shared framework status runs conservatively and cannot report COMPLETE", async () => {
  const frameworkIndex = {
    frameworkStatus: async () => { throw new Error("worker unavailable"); }
  } as unknown as FrameworkIndexView;
  let collectCalls = 0;
  const statusConsumer = fakeAdapter({
    id: "status-consumer",
    isActive: async ctx => {
      assert.deepEqual(await ctx.preflight!.status(), { coverage: "degraded" });
      return true;
    },
    collect: async () => {
      collectCalls += 1;
      return emptyResult();
    }
  });

  const result = await runFrameworkAdapters([statusConsumer], context({ frameworkIndex }));

  assert.equal(collectCalls, 1);
  assert.equal(result.outcome.completion, "FAILED");
  assert.ok(result.diagnostics.some(message => message.includes("status unavailable")));
});

test("a deadline that is already expired stops the loop before the first adapter and marks PARTIAL_TIMEOUT", async () => {
  const neverRuns = fakeAdapter({ id: "never", isActive: async () => { throw new Error("must not be called past the deadline"); } });
  // Force expiry deterministically instead of a real sleep: fromTimeout's
  // first now() call sets the deadline, every later call (including the
  // runner's own expired() check) sees far past it.
  let calls = 0;
  const alreadyExpired = DeadlineBudget.fromTimeout(1_000, () => (calls++ === 0 ? 0 : 10_000));

  const result = await runFrameworkAdapters([neverRuns], context({ budget: alreadyExpired }));

  assert.equal(result.outcome.completion, "PARTIAL_TIMEOUT");
  assert.ok(result.diagnostics.some(d => d.includes("deadline exhausted")));
});

test("candidateFiles handed to an adapter is capped at MAX_FRAMEWORK_TRAVERSAL_FILES", async () => {
  const oversized = Array.from({ length: MAX_FRAMEWORK_TRAVERSAL_FILES + 50 }, (_, i) => `/repo/File${i}.java`);
  let seenLength = -1;
  const capturingAdapter = fakeAdapter({
    id: "capturing",
    collect: async ctx => {
      seenLength = ctx.candidateFiles.length;
      return emptyResult();
    }
  });

  await runFrameworkAdapters([capturingAdapter], context({ candidateFiles: oversized }));

  assert.equal(seenLength, MAX_FRAMEWORK_TRAVERSAL_FILES);
});

test("reuses one identical framework-facts query across adapters in a request", async () => {
  let queries = 0;
  const frameworkIndex = {
    frameworkFactsForFiles: async () => {
      queries += 1;
      return [];
    }
  } as unknown as FrameworkIndexView;
  const files = ["/repo/module-a/src/main/java/demo/Service.java"];
  const queryFacts = fakeAdapter({
    id: "first",
    isActive: async ctx => {
      await frameworkFactsForFiles(ctx, files);
      return false;
    }
  });
  const queryFactsAgain = fakeAdapter({
    id: "second",
    isActive: async ctx => {
      await frameworkFactsForFiles(ctx, files);
      return false;
    }
  });

  await runFrameworkAdapters([queryFacts, queryFactsAgain], context({ frameworkIndex }));

  assert.equal(queries, 1);
});

test("does not retain a failed framework-facts query for a later adapter", async () => {
  let queries = 0;
  const frameworkIndex = {
    frameworkFactsForFiles: async () => {
      queries += 1;
      if (queries === 1) throw new Error("transient worker failure");
      return [];
    }
  } as unknown as FrameworkIndexView;
  const files = ["/repo/module-a/src/main/java/demo/Service.java"];
  const failedQuery = fakeAdapter({
    id: "first",
    isActive: async ctx => {
      try {
        await frameworkFactsForFiles(ctx, files);
      } catch {
        return false;
      }
      return true;
    }
  });
  const retriedQuery = fakeAdapter({
    id: "second",
    isActive: async ctx => {
      await frameworkFactsForFiles(ctx, files);
      return false;
    }
  });

  await runFrameworkAdapters([failedQuery, retriedQuery], context({ frameworkIndex }));

  assert.equal(queries, 2);
});
