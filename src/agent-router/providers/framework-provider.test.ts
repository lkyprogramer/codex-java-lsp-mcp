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

test("the exported default FRAMEWORK_ADAPTERS registry contains the registered Spring pack", () => {
  assert.deepEqual(FRAMEWORK_ADAPTERS, [springAdapter]);
});

test("collectFrameworkEvidence with an explicitly empty adapters list returns a zero-evidence COMPLETE outcome and never touches frameworkIndex", async () => {
  const result = await collectFrameworkEvidence(input({ frameworkIndex: undefined as never }), []);

  assert.deepEqual(result.outcome.evidence, []);
  assert.deepEqual(result.outcome.candidates, []);
  assert.equal(result.outcome.completion, "COMPLETE");
  assert.deepEqual(result.metadata, {});
});

test("collectFrameworkEvidence with the default (registered) adapters runs springAdapter.isActive, which is false and adds no evidence for a non-Spring repo", async () => {
  const result = await collectFrameworkEvidence(input());

  assert.deepEqual(result.outcome.evidence, []);
  assert.deepEqual(result.outcome.candidates, []);
  assert.equal(result.outcome.completion, "COMPLETE");
});

test("collectFrameworkEvidence maps ProviderInput fields onto FrameworkAdapterContext for an injected adapter", async () => {
  let seenContext: FrameworkAdapterContext | undefined;
  const capturingAdapter: FrameworkAdapter = {
    id: "capturing",
    version: "1",
    isActive: async ctx => { seenContext = ctx; return true; },
    collect: async () => ({
      outcome: { providerId: "x", providerVersion: "1", evidence: [], candidates: [], completion: "COMPLETE", elapsedMs: 0 },
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
