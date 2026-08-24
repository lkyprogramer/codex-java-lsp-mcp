import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { FrameworkIndexView } from "../../java-index/framework-index-view.js";
import { frameworkEvidenceOriginIds, type FrameworkAdapterContext } from "./adapter.js";
import { createFrameworkPreflight } from "./shared.js";

test("score-only direct contexts conservatively retain every multi-anchor origin", () => {
  const sourceFile = "/repo/src/main/java/demo/Seed.java";
  const context = {
    repoRoot: "/repo",
    anchors: [
      { id: "A1", absolutePath: "/repo/A.java", line: 1, column: 1, profile: "service", symbolName: "A", kind: "class" },
      { id: "A2", absolutePath: "/repo/B.java", line: 1, column: 1, profile: "service", symbolName: "B", kind: "class" }
    ],
    candidateFiles: [sourceFile],
    staticEvidence: [{
      file: sourceFile,
      signals: [],
      familyScores: { STATIC_STRUCTURE: 1 },
      finalScore: 1,
      confidence: "medium",
      degradation: []
    }],
    frameworkIndex: {} as FrameworkIndexView,
    generation: 1,
    budget: DeadlineBudget.fromTimeout(5_000)
  } as FrameworkAdapterContext;

  assert.deepEqual(frameworkEvidenceOriginIds(context, sourceFile), ["A1", "A2"]);
});

test("preflight shares status and marker lookups for one request", async () => {
  let statusCalls = 0;
  let markerCalls = 0;
  let factMarkerCalls = 0;
  const index = {
    frameworkStatus: async () => {
      statusCalls += 1;
      return { coverage: "complete" as const };
    },
    repositoryMarkers: async () => {
      markerCalls += 1;
      return new Map([["pom.xml", "plain"]]);
    },
    repositoryFactMarkers: async () => {
      factMarkerCalls += 1;
      return { importPrefixFound: false, annotationPrefixFound: false };
    }
  } as unknown as FrameworkIndexView;
  const preflight = createFrameworkPreflight(index);

  assert.deepEqual(await preflight.status(), { coverage: "complete" });
  assert.deepEqual(await preflight.status(), { coverage: "complete" });
  assert.equal(preflight.statusUnavailable(), false);
  assert.deepEqual([...await preflight.repositoryMarkers(["pom.xml", "module/pom.xml"])], [["pom.xml", "plain"]]);
  await preflight.repositoryMarkers(["module/pom.xml", "pom.xml"]);
  await preflight.repositoryFactMarkers({ importPrefixes: ["b", "a"], annotationPrefixes: ["c"] });
  await preflight.repositoryFactMarkers({ importPrefixes: ["a", "b"], annotationPrefixes: ["c"] });

  assert.equal(statusCalls, 1);
  assert.equal(markerCalls, 1);
  assert.equal(factMarkerCalls, 1);
});

test("failed retryable marker queries are evicted", async () => {
  let calls = 0;
  const index = {
    repositoryMarkers: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient marker failure");
      return new Map<string, string>();
    }
  } as unknown as FrameworkIndexView;
  const preflight = createFrameworkPreflight(index);

  await assert.rejects(preflight.repositoryMarkers(["pom.xml"]), /transient marker failure/);
  await preflight.repositoryMarkers(["pom.xml"]);
  assert.equal(calls, 2);
});

test("unavailable status is cached conservatively and diagnosed", async () => {
  let calls = 0;
  const index = {
    frameworkStatus: async () => {
      calls += 1;
      throw new Error("worker unavailable");
    }
  } as unknown as FrameworkIndexView;
  const preflight = createFrameworkPreflight(index);

  assert.deepEqual(await preflight.status(), { coverage: "degraded" });
  assert.deepEqual(await preflight.status(), { coverage: "degraded" });
  assert.equal(calls, 1);
  assert.equal(preflight.statusUnavailable(), true);
  assert.deepEqual(preflight.diagnostics(), ["framework preflight status unavailable: worker unavailable"]);
});
