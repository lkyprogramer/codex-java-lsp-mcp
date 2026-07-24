import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRouter } from "./index.js";
import { SourceIndex } from "../source-index.js";
import { RgRunner } from "../search/rg-runner.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { createRequestContext } from "../runtime/request-context.js";
import type { Completion } from "../runtime/completion.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import type { ImpactOptions } from "../agent-types.js";

/**
 * Counts runs and always returns the completion under test. This has to be
 * driven through AgentRouter, not GenerationRgCache directly: a router that
 * bypasses the cache guard would still pass a cache-only unit test.
 */
class CountingRunner extends RgRunner {
  calls = 0;

  constructor(private readonly completion: Completion, private readonly matchPath: string) {
    super();
  }

  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    this.calls += 1;
    return {
      files: [{ absolutePath: this.matchPath, matchCount: 1, positions: [{ line: 1, column: 1 }] }],
      completion: this.completion,
      rawBytes: 128,
      totalMatches: 1,
      elapsedMs: 1,
      errorCode: this.completion === "PARTIAL_TIMEOUT" ? "SEARCH_TIMEOUT" : undefined
    };
  }
}

function buildRepo(): { repoRoot: string; anchorFile: string; serviceFile: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "rg-router-"));
  const javaDir = path.join(repoRoot, "src", "main", "java", "demo");
  mkdirSync(javaDir, { recursive: true });
  writeFileSync(path.join(repoRoot, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n", "utf8");
  const anchorFile = path.join(javaDir, "DemoService.java");
  const serviceFile = path.join(javaDir, "DemoController.java");
  writeFileSync(anchorFile, [
    "package demo;",
    "public class DemoService {",
    "  public void handle() {}",
    "}"
  ].join("\n"), "utf8");
  writeFileSync(serviceFile, [
    "package demo;",
    "public class DemoController {",
    "  private DemoService service;",
    "}"
  ].join("\n"), "utf8");
  return { repoRoot, anchorFile, serviceFile };
}

function impactOptions(anchorFile: string, repoRoot: string): ImpactOptions {
  return {
    anchors: [{ file: path.relative(repoRoot, anchorFile), line: 2, column: 14 }],
    mode: "balanced",
    profile: "auto",
    semanticPolicy: "fast",
    semanticTimeoutMs: 1000,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    verbosity: "diagnostic"
  };
}

function routerWith(runner: RgRunner, repoRoot: string): AgentRouter {
  const session = {
    cacheStatus: () => ({ enabled: true, entries: 0, hits: 0, misses: 0, invalidations: 0 }),
    status: () => ({ state: "NEW", started: false, progress: { active: 0 } }),
    drainPhaseMetrics: () => ({})
  };
  return new AgentRouter(
    repoRoot,
    session as never,
    new SourceIndex(repoRoot),
    undefined,
    undefined,
    undefined,
    runner
  );
}

test("a partial rg result is never cached, so the next request runs rg again", async () => {
  const { repoRoot, anchorFile, serviceFile } = buildRepo();
  const runner = new CountingRunner("PARTIAL_TIMEOUT", serviceFile);
  const router = routerWith(runner, repoRoot);
  const options = impactOptions(anchorFile, repoRoot);

  const first = await router.impact(options, createRequestContext({ repoRoot, repoHash: "test", generation: 0, freshnessMode: "NORMAL", cacheReadAllowed: true, cacheWriteAllowed: true, negativeLookupAllowed: false, mode: "balanced", semanticPolicy: "fast", budget: DeadlineBudget.fromTimeout(5000) }));
  const callsAfterFirst = runner.calls;
  assert.equal(callsAfterFirst > 0, true, "the first request executes rg");

  const second = await router.impact(options, createRequestContext({ repoRoot, repoHash: "test", generation: 0, freshnessMode: "NORMAL", cacheReadAllowed: true, cacheWriteAllowed: true, negativeLookupAllowed: false, mode: "balanced", semanticPolicy: "fast", budget: DeadlineBudget.fromTimeout(5000) }));
  assert.equal(
    runner.calls,
    callsAfterFirst * 2,
    "every section re-runs because no partial section was cached"
  );

  for (const payload of [first, second]) {
    const sections = payload.rgSummary.sections;
    assert.equal(sections.length > 0, true);
    assert.equal(
      sections.every(section => section.completion === "PARTIAL_TIMEOUT"),
      true,
      "the partial completion is reported, not silently upgraded"
    );
    assert.equal(
      sections.every(section => section.cacheHits === 0),
      true,
      "a partial section can never report a cache hit"
    );
  }
});

test("a complete rg result is cached and the next request reuses it", async () => {
  const { repoRoot, anchorFile, serviceFile } = buildRepo();
  const runner = new CountingRunner("COMPLETE", serviceFile);
  const router = routerWith(runner, repoRoot);
  const options = impactOptions(anchorFile, repoRoot);

  await router.impact(options, createRequestContext({ repoRoot, repoHash: "test", generation: 0, freshnessMode: "NORMAL", cacheReadAllowed: true, cacheWriteAllowed: true, negativeLookupAllowed: false, mode: "balanced", semanticPolicy: "fast", budget: DeadlineBudget.fromTimeout(5000) }));
  const callsAfterFirst = runner.calls;
  assert.equal(callsAfterFirst > 0, true);

  const second = await router.impact(options, createRequestContext({ repoRoot, repoHash: "test", generation: 0, freshnessMode: "NORMAL", cacheReadAllowed: true, cacheWriteAllowed: true, negativeLookupAllowed: false, mode: "balanced", semanticPolicy: "fast", budget: DeadlineBudget.fromTimeout(5000) }));
  assert.equal(runner.calls, callsAfterFirst, "a complete search is reused");
  assert.equal(
    second.rgSummary.sections.every(section => section.cacheHits === 1),
    true
  );
});

test("a failed rg result is not cached either", async () => {
  const { repoRoot, anchorFile, serviceFile } = buildRepo();
  const runner = new CountingRunner("FAILED", serviceFile);
  const router = routerWith(runner, repoRoot);
  const options = impactOptions(anchorFile, repoRoot);

  await router.impact(options, createRequestContext({ repoRoot, repoHash: "test", generation: 0, freshnessMode: "NORMAL", cacheReadAllowed: true, cacheWriteAllowed: true, negativeLookupAllowed: false, mode: "balanced", semanticPolicy: "fast", budget: DeadlineBudget.fromTimeout(5000) }));
  const callsAfterFirst = runner.calls;
  await router.impact(options, createRequestContext({ repoRoot, repoHash: "test", generation: 0, freshnessMode: "NORMAL", cacheReadAllowed: true, cacheWriteAllowed: true, negativeLookupAllowed: false, mode: "balanced", semanticPolicy: "fast", budget: DeadlineBudget.fromTimeout(5000) }));

  assert.equal(runner.calls, callsAfterFirst * 2);
});
