// input: A minimal ProviderInput fixture and a hand-written fake FrameworkAdapter.
// output: Coverage for collectFrameworkEvidence's own logic - the registered-adapters default
//         (current production state, since Slice D's registration commit) and ProviderInput ->
//         FrameworkAdapterContext field mapping. Merge/fail-soft/deadline/cap behavior itself is
//         covered by framework/runner.test.ts; Spring's own rules by framework/spring-adapter.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedAnchor } from "../../agent-types.js";
import type { FrameworkIndexView } from "../../java-index/framework-index-view.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { FrameworkAdapter, FrameworkAdapterContext } from "../framework/adapter.js";
import { mapstructAdapter } from "../framework/mapstruct-adapter.js";
import { mybatisAdapter } from "../framework/mybatis-adapter.js";
import { springAdapter } from "../framework/spring-adapter.js";
import type { ProviderInput } from "../evidence.js";
import { collectFrameworkEvidence, FRAMEWORK_ADAPTERS } from "./framework-provider.js";

/** A working, Spring-inactive FrameworkIndexView - lets springAdapter.isActive() genuinely evaluate to false instead of throwing on a mock with no methods at all. */
function fakeFrameworkIndex(): FrameworkIndexView {
  return {
    frameworkFactsFor: async () => ({
      types: [], methods: [], fields: [], missingIds: [], truncated: false,
      relativePath: "module-a/src/main/java/demo/Anchor.java", module: "module-a", sourceSet: "main", packageName: "demo", imports: [], coverage: "COMPLETE"
    }),
    frameworkFactsForFiles: async () => [],
    declarationsById: async () => ({ types: [], methods: [], fields: [], missingIds: [], truncated: false }),
    resolvedCallees: async () => ({ callees: [], truncated: false }),
    resolvedCalleesFor: async () => new Map(),
    repositoryMarkers: async () => new Map(),
    repositoryFactMarkers: async () => ({ importPrefixFound: false, annotationPrefixFound: false }),
    methodsWithParameterTypes: async () => [],
    myBatisResourcesByNamespaces: async () => new Map(),
    frameworkStatus: async () => ({ coverage: "complete" })
  };
}

function input(overrides: Partial<ProviderInput> = {}): ProviderInput {
  const anchor: ResolvedAnchor = {
    id: "A1", absolutePath: "/repo/module-a/src/main/java/demo/Anchor.java", line: 1, column: 1,
    profile: "service", symbolName: "Anchor", kind: "class"
  };
  return {
    repoRoot: "/repo",
    anchors: [anchor],
    existingCandidatePaths: ["/repo/module-a/src/main/java/demo/Service.java"],
    frameworkIndex: fakeFrameworkIndex(),
    generation: 3,
    budget: DeadlineBudget.fromTimeout(5_000),
    ...overrides
  } as unknown as ProviderInput;
}

test("the production framework registry includes MapStruct after its real-repository canary gate", () => {
  assert.deepEqual(FRAMEWORK_ADAPTERS, [springAdapter, mybatisAdapter, mapstructAdapter]);
});

test("collectFrameworkEvidence with an explicitly empty adapters list returns a zero-evidence COMPLETE outcome and never touches frameworkIndex", async () => {
  const result = await collectFrameworkEvidence(input({ frameworkIndex: undefined as never }), []);

  assert.deepEqual(result.outcome.evidence, []);
  assert.equal(Object.hasOwn(result.outcome, "candidates"), false);
  assert.equal(result.outcome.completion, "COMPLETE");
  assert.deepEqual(result.metadata, {});
});

test("collectFrameworkEvidence with the default adapters adds no evidence for a non-Spring, non-MyBatis, non-MapStruct repo", async () => {
  const result = await collectFrameworkEvidence(input());

  assert.deepEqual(result.outcome.evidence, []);
  assert.equal(Object.hasOwn(result.outcome, "candidates"), false);
  assert.equal(result.outcome.completion, "COMPLETE");
});

test("default adapters share one framework status, build-marker, and bounded facts preflight", async () => {
  const calls = { status: 0, markers: 0, factMarkers: 0, facts: 0 };
  const frameworkIndex: FrameworkIndexView = {
    ...fakeFrameworkIndex(),
    frameworkFactsForFiles: async () => {
      calls.facts += 1;
      return [];
    },
    repositoryMarkers: async () => {
      calls.markers += 1;
      return new Map();
    },
    repositoryFactMarkers: async () => {
      calls.factMarkers += 1;
      return { importPrefixFound: false, annotationPrefixFound: false };
    },
    frameworkStatus: async () => {
      calls.status += 1;
      return { coverage: "complete" };
    }
  };

  const result = await collectFrameworkEvidence(input({ frameworkIndex }));

  assert.deepEqual(result.outcome.evidence, []);
  assert.deepEqual(calls, { status: 1, markers: 1, factMarkers: 2, facts: 1 });
});

test("a marker failure runs adapters conservatively and cannot report COMPLETE", async () => {
  let markerCalls = 0;
  const frameworkIndex: FrameworkIndexView = {
    ...fakeFrameworkIndex(),
    repositoryMarkers: async () => {
      markerCalls += 1;
      throw new Error("marker worker unavailable");
    }
  };

  const result = await collectFrameworkEvidence(input({ frameworkIndex }));

  assert.equal(result.outcome.completion, "FAILED");
  assert.ok(markerCalls >= 3, "each adapter gets a bounded retry after the request-local failure is evicted");
  assert.ok(result.diagnostics.some(message => message.includes("conservatively")));
});

test("collectFrameworkEvidence maps ProviderInput fields onto FrameworkAdapterContext for an injected adapter", async () => {
  let seenContext: FrameworkAdapterContext | undefined;
  const capturingAdapter: FrameworkAdapter = {
    id: "capturing",
    version: "1",
    isActive: async ctx => { seenContext = ctx; return true; },
    collect: async () => ({
      outcome: { providerId: "x", providerVersion: "1", evidence: [], completion: "COMPLETE", elapsedMs: 0 },
      metadata: {},
      diagnostics: []
    })
  };
  const providerInput = input();

  await collectFrameworkEvidence(providerInput, [capturingAdapter]);

  assert.equal(seenContext?.repoRoot, "/repo");
  assert.equal(seenContext?.generation, 3);
  assert.deepEqual(seenContext?.candidateFiles, ["/repo/module-a/src/main/java/demo/Service.java"]);
  assert.deepEqual(seenContext?.staticEvidence, []);
  assert.strictEqual(seenContext?.frameworkIndex, providerInput.frameworkIndex);
});
