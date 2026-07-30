import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactOptions, ResolvedAnchor } from "../../agent-types.js";
import { resolveRoutingPolicy } from "../../routing-policy.js";
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
  const input = {
    repoRoot: "/repo",
    anchors: [anchor],
    options,
    javaIndex: {},
    routingPolicy: resolveRoutingPolicy("/repo"),
    existingCandidatePaths: [],
    generation: 0,
    phaseMs: {},
    edgeStore: {
      edgesFor: (from: string) => from === anchor.absolutePath
        ? [{ from, to: target, kind: "reference", line: 4, column: 7, fromMtimeMs: 0, confirmedAt: "2026-07-30T00:00:00.000Z" }]
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
});
