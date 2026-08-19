import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JavaIndexRpcTelemetryCollector } from "../agent-router/impact-metrics.js";
import { JavaIndexClient } from "./java-index-client.js";
import {
  ALL_RELATIONSHIP_BUNDLE_NEEDS,
  clampRelationshipBundleLimits,
  DEFAULT_RELATIONSHIP_BUNDLE_LIMITS,
  JAVA_LSP_RELATIONSHIP_BUNDLE,
  relationshipBundleMode,
  type RelationshipBundleView
} from "./relationship-bundle.js";
import { buildRelationshipQueryPlan } from "../agent-router/providers/relationship/relationship-query-plan.js";
import {
  observeRelationshipParity,
  resetRelationshipParityTracker,
  relationshipParityTracker
} from "../agent-router/providers/relationship/relationship-parity.js";

function tempRepo(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeJavaFile(repoRoot: string, relativePath: string, content: string): string {
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  return absolutePath;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test("relationship bundle mode stays off unless the env value is on, 1, or shadow", () => {
  assert.equal(relationshipBundleMode({}), "off");
  assert.equal(relationshipBundleMode({ [JAVA_LSP_RELATIONSHIP_BUNDLE]: "0" }), "off");
  assert.equal(relationshipBundleMode({ [JAVA_LSP_RELATIONSHIP_BUNDLE]: "true" }), "off");
  assert.equal(relationshipBundleMode({ [JAVA_LSP_RELATIONSHIP_BUNDLE]: "1" }), "on");
  assert.equal(relationshipBundleMode({ [JAVA_LSP_RELATIONSHIP_BUNDLE]: "on" }), "on");
  assert.equal(relationshipBundleMode({ [JAVA_LSP_RELATIONSHIP_BUNDLE]: "shadow" }), "shadow");
});

test("relationship bundle limits clamp to the Phase 1 hard caps", () => {
  assert.deepEqual(
    clampRelationshipBundleLimits({ maxCandidateFiles: 0, maxDefinitions: 99, maxCallees: 3.8, maxImplementations: -1 }),
    {
      maxCandidateFiles: DEFAULT_RELATIONSHIP_BUNDLE_LIMITS.maxCandidateFiles,
      maxDefinitions: DEFAULT_RELATIONSHIP_BUNDLE_LIMITS.maxDefinitions,
      maxCallees: 3,
      maxImplementations: DEFAULT_RELATIONSHIP_BUNDLE_LIMITS.maxImplementations
    }
  );
});

test("a relationship query plan keeps anchor order and caps candidate files", () => {
  const plan = buildRelationshipQueryPlan({
    generation: 4,
    anchors: [{
      id: "A1",
      absolutePath: "/repo/src/main/java/demo/OrderService.java",
      path: "src/main/java/demo/OrderService.java",
      module: "demo",
      sourceSet: "main",
      line: 12,
      column: 5,
      profile: "service",
      symbolName: "place",
      className: "OrderService",
      kind: "method"
    }],
    staticVerifiedCandidates: [
      {
        absolutePath: "/repo/src/main/java/demo/OrderService.java",
        path: "src/main/java/demo/OrderService.java",
        module: "demo",
        score: 1,
        matchCount: 0,
        positions: [{ line: 1, column: 1 }],
        categories: ["semantic"],
        reasons: ["typeReference"],
        confidence: "medium",
        verifiedBy: ["typeReference"]
      },
      {
        absolutePath: "/repo/src/main/java/demo/OrderRepo.java",
        path: "src/main/java/demo/OrderRepo.java",
        module: "demo",
        score: 1,
        matchCount: 0,
        positions: [{ line: 1, column: 1 }],
        categories: ["semantic"],
        reasons: ["typeReference"],
        confidence: "medium",
        verifiedBy: ["typeReference"]
      }
    ]
  });
  assert.equal(plan.generation, 4);
  assert.deepEqual(plan.anchors.map(anchor => anchor.anchorId), ["A1"]);
  assert.deepEqual(plan.candidateFiles, [
    "/repo/src/main/java/demo/OrderService.java",
    "/repo/src/main/java/demo/OrderRepo.java"
  ]);
  assert.deepEqual(plan.needs, ALL_RELATIONSHIP_BUNDLE_NEEDS);
});

test("shadow parity observes file identity without requiring callee agreement", () => {
  resetRelationshipParityTracker();
  const bundle: RelationshipBundleView = {
    generation: 1,
    completion: "COMPLETE",
    stale: false,
    truncated: false,
    items: [{
      inputFile: "/repo/A.java",
      absolutePath: "/repo/A.java",
      state: "FOUND",
      facts: {
        absolutePath: "/repo/A.java",
        implementsTypes: [],
        referencedTypes: [],
        imports: [],
        wildcardImports: [],
        annotations: [],
        methods: [],
        factSource: "javaIndex"
      }
    }],
    anchors: [{
      anchorId: "A1",
      calleeTargetIds: ["method:demo.B#run"],
      calleeTruncated: false,
      implementationTypeIds: [],
      signatureTypeIds: []
    }],
    metrics: { parsedFiles: 1, hydratedFiles: 1, cacheHits: 0, queryCount: 1 }
  };
  const match = observeRelationshipParity(["/repo/A.java"], [], bundle);
  assert.equal(match.match, true);
  assert.equal(relationshipParityTracker.matches, 1);
  const mismatch = observeRelationshipParity(["/repo/B.java"], [], bundle);
  assert.equal(mismatch.match, false);
  assert.equal(relationshipParityTracker.mismatches, 1);
});

test("QUERY_RELATIONSHIP_BUNDLE matches sequential files and implementers on a real worker", async () => {
  const repoRoot = tempRepo("rel-bundle-e2e-");
  const gateway = writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway { void run(); }\n");
  const impl = writeJavaFile(repoRoot, "src/main/java/demo/Impl.java", "package demo;\n\nclass Impl implements Gateway { public void run() {} }\n");
  const cacheDir = mkdtempSync(path.join(tmpdir(), "rel-bundle-cache-"));
  const telemetry = new JavaIndexRpcTelemetryCollector();
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  await client.refresh(2, [gateway, impl], [], { telemetry });
  await waitFor(async () => (await client.status()).files === 2, 8000);

  const sequentialFiles = await client.queryFiles([gateway, impl], { telemetry });
  const gatewayType = sequentialFiles.find(bundle => bundle.file.relativePath.endsWith("Gateway.java"))!
    .types.find(type => type.simpleName === "Gateway")!;
  const sequentialImplementers = await client.queryImplementers(gatewayType.typeId, 8, { telemetry });

  const bundle = await client.queryRelationshipBundle({
    generation: 2,
    anchors: [{ anchorId: "A1", file: gateway, line: 3, column: 11 }],
    candidateFiles: [gateway, impl],
    needs: { ...ALL_RELATIONSHIP_BUNDLE_NEEDS, readRanges: false },
    limits: { ...DEFAULT_RELATIONSHIP_BUNDLE_LIMITS }
  }, { telemetry });

  assert.equal(bundle.stale, false);
  assert.equal(bundle.generation, 2);
  assert.equal(bundle.files.length, sequentialFiles.length);
  assert.deepEqual(
    bundle.files.map(entry => entry.file.relativePath).sort(),
    sequentialFiles.map(entry => entry.file.relativePath).sort()
  );
  const bundleAnchor = bundle.anchors.find(anchor => anchor.anchorId === "A1")!;
  assert.deepEqual(
    bundleAnchor.implementations.map(type => type.typeId).sort(),
    sequentialImplementers.map(type => type.typeId).sort()
  );
  const summary = telemetry.relationshipSummary(1);
  assert.equal(summary.bundleCount, 1);
  assert.ok(summary.relationshipOperations >= 1);
  await client.close();
});

test("a stale generation relationship bundle is DEGRADED and does not mix file facts", async () => {
  const repoRoot = tempRepo("rel-bundle-stale-");
  const gateway = writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  const client = new JavaIndexClient(repoRoot, mkdtempSync(path.join(tmpdir(), "rel-bundle-stale-cache-")));
  await client.open(1);
  await client.refresh(2, [gateway], []);
  const bundle = await client.queryRelationshipBundle({
    generation: 1,
    anchors: [{ anchorId: "A1", file: gateway, line: 3, column: 11 }],
    candidateFiles: [gateway],
    needs: { ...ALL_RELATIONSHIP_BUNDLE_NEEDS, readRanges: false },
    limits: { ...DEFAULT_RELATIONSHIP_BUNDLE_LIMITS }
  });
  assert.equal(bundle.stale, true);
  assert.equal(bundle.completion, "DEGRADED");
  assert.equal(bundle.files.length, 0);
  await client.close();
});
