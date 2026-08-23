import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { ContextContract } from "../context-engine/context-contract.js";
import type { ContextGraphResult } from "../java-index/worker-protocol.js";
import type { EntityHit } from "../java-index/entity-search.js";
import type { ToolContext } from "./context.js";
import {
  JAVA_CONTEXT_DESCRIPTION,
  JAVA_CONTEXT_INTENTS,
  javaContext,
  javaContextSchema
} from "./java-context.js";

const schema = z.object(javaContextSchema);

test("java_context description stays within the 700-token schema budget", () => {
  assert.equal(JAVA_CONTEXT_DESCRIPTION.includes("IMPLEMENTATION_CHANGE:"), true);
  assert.equal(JAVA_CONTEXT_DESCRIPTION.includes("auto:"), true);
  assert.equal(JAVA_CONTEXT_DESCRIPTION.includes("Prefer one search"), false);
  assert.ok(Math.ceil(Buffer.byteLength(JAVA_CONTEXT_DESCRIPTION, "utf8") / 4) <= 700);
});

test("java_context schema requires intent and allows no-anchor task plus navigate", () => {
  assert.deepEqual([...JAVA_CONTEXT_INTENTS], [
    "IMPLEMENTATION_CHANGE",
    "DOWNSTREAM_BEHAVIOR",
    "UPSTREAM_IMPACT",
    "CONTRACT_CHANGE",
    "PERSISTENCE_FLOW",
    "DATAFLOW_TRACE",
    "FRAMEWORK_WIRING",
    "TEST_PLANNING",
    "DIAGNOSTIC_ONLY",
    "auto"
  ]);
  assert.equal(schema.safeParse({ task: "find pay order" }).success, false);
  assert.equal(schema.safeParse({ intent: "PERSISTENCE_FLOW", task: "find pay order" }).success, true);
  assert.equal(schema.safeParse({
    intent: "UPSTREAM_IMPACT",
    file: "src/A.java",
    line: 3,
    column: 1,
    mode: "navigate",
    direction: "callers"
  }).success, true);
});

test("java_context requires anchors or task, and navigate needs a direction or closure", async () => {
  await assert.rejects(
    () => javaContext(mockContext(), { intent: "auto" }),
    /anchors\[\] or task/
  );
  await assert.rejects(
    () => javaContext(mockContext(), { intent: "auto", task: "claim paper task", mode: "navigate" }),
    /mode=navigate requires direction/
  );
});

test("java_context with no hits returns an entry-location contract without scores", async () => {
  const contract = await javaContext(mockContext({ hits: [] }), {
    intent: "auto",
    task: "unknown thing"
  });
  assert.equal(contract.coverage, "PARTIAL");
  assert.equal(contract.resolvedIntent, "IMPLEMENTATION_CHANGE");
  assert.deepEqual(contract.resolvedAnchors, []);
  assert.equal(JSON.stringify(contract).includes("score"), false);
});

test("java_context no-anchor search uses entity hits and one-hop planning", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const hits: EntityHit[] = [
    entity("MeQueryService", "modules/iam/src/MeQueryService.java", "SIMPLE_NAME"),
    entity("MeController", "modules/iam/src/MeController.java", "BM25_IDENTIFIER")
  ];
  const contract = await javaContext(mockContext({ hits, seen }), {
    intent: "IMPLEMENTATION_CHANGE",
    task: "claim paper task identity"
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.fromRelativePath, "modules/iam/src/MeQueryService.java");
  assert.equal(seen[0]?.maxHops, 1);
  assert.equal(seen[0]?.plan, true);
  assert.equal(seen[0]?.mode, "search");
  assert.deepEqual(contract.resolvedAnchors, [
    { path: "modules/iam/src/MeQueryService.java", symbol: "MeQueryService", layer: "SIMPLE_NAME" },
    { path: "modules/iam/src/MeController.java", symbol: "MeController", layer: "BM25_IDENTIFIER" }
  ]);
  assert.equal(JSON.stringify(contract).includes("score"), false);
});

test("java_context navigate packs a planned contract from callers", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const contract = await javaContext(mockContext({ seen }), {
    intent: "UPSTREAM_IMPACT",
    file: "src/A.java",
    line: 12,
    column: 4,
    mode: "navigate",
    direction: "callers"
  });
  assert.equal(seen[0]?.mode, "navigate");
  assert.equal(seen[0]?.direction, "callers");
  assert.equal(seen[0]?.plan, true);
  assert.equal(seen[0]?.fromRelativePath, "src/A.java");
  assert.equal(contract.anchor.path, "src/A.java");
});

function entity(simpleName: string, relativePath: string, layer: EntityHit["layer"]): EntityHit {
  return {
    entityId: `id:${simpleName}`,
    kind: "type",
    fqn: `demo.${simpleName}`,
    simpleName,
    relativePath,
    layer,
    score: 9.9
  };
}

function sampleContract(): ContextContract {
  const evidence = [{ role: "ANCHOR", path: "src/A.java", proof: ["DECLARES"], spans: [{ start: 1, end: 4 }] }];
  return {
    version: 2,
    generation: 3,
    coverage: "PARTIAL",
    resolvedIntent: "IMPLEMENTATION_CHANGE",
    resolvedAnchors: [{ path: "src/A.java", symbol: "run", layer: "graph" }],
    anchor: { path: "src/A.java", symbol: "run" },
    evidence,
    candidates: [{ path: "src/A.java", role: "ANCHOR", hop: 0, reason: "ANCHOR" }],
    contexts: evidence,
    unresolved: [],
    next: [],
    cost: { modelTokens: 12, serviceMs: 4 }
  };
}

function mockContext(options: { hits?: EntityHit[]; seen?: Array<Record<string, unknown>> } = {}): ToolContext {
  const hits = options.hits ?? [];
  const seen = options.seen ?? [];
  return {
    repoRoot: "/tmp/demo",
    repoHash: "abc",
    javaIndex: {
      async queryEntitySearch() {
        return hits;
      },
      async queryContextGraph(input: Record<string, unknown>): Promise<ContextGraphResult> {
        seen.push(input);
        return {
          resolvedIntent: "IMPLEMENTATION_CHANGE",
          coverage: "PARTIAL",
          bundles: [],
          unresolved: [],
          metrics: { expansions: 1, hops: 1, estimatedTokens: 12 },
          contract: sampleContract()
        };
      }
    }
  } as unknown as ToolContext;
}
