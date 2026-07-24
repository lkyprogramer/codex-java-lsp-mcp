import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRouter } from "./agent-router/index.js";
import { SourceIndex } from "./source-index.js";
import { RgRunner } from "./search/rg-runner.js";
import { canonicalPath } from "./path-utils.js";
import { createRequestContext, type RequestContext } from "./runtime/request-context.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import type { RepoChangeBatch } from "./repo-generation.js";
import type { RgQuery, SearchResult } from "./search/search-types.js";
import type { ImpactOptions } from "./agent-types.js";

/** Returns a distinct match set per "world", so a stale cache is observable. */
class SwitchableRunner extends RgRunner {
  calls = 0;
  world = 0;

  constructor(private readonly worlds: string[][]) {
    super();
  }

  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    this.calls += 1;
    const files = this.worlds[this.world].map(absolutePath => ({
      absolutePath,
      matchCount: 1,
      positions: [{ line: 1, column: 1 }]
    }));
    return { files, completion: "COMPLETE", rawBytes: 64, totalMatches: files.length, elapsedMs: 1 };
  }
}

function buildRepo(): { root: string; anchor: string; first: string; second: string } {
  const root = canonicalPath(mkdtempSync(path.join(tmpdir(), "freshness-")));
  const javaDir = path.join(root, "src", "main", "java", "demo");
  mkdirSync(javaDir, { recursive: true });
  writeFileSync(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(javaDir, "DemoController.java");
  const first = path.join(javaDir, "FirstService.java");
  const second = path.join(javaDir, "SecondService.java");
  writeFileSync(anchor, "package demo;\npublic class DemoController {}\n");
  writeFileSync(first, "package demo;\npublic class FirstService {}\n");
  writeFileSync(second, "package demo;\npublic class SecondService {}\n");
  return { root, anchor, first, second };
}

function options(root: string, anchor: string): ImpactOptions {
  return {
    anchors: [{ file: path.relative(root, anchor), line: 2, column: 14 }],
    mode: "balanced",
    profile: "controller",
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

function request(root: string, generation: number): RequestContext {
  return createRequestContext({
    repoRoot: root,
    repoHash: "test",
    generation,
    freshnessMode: "NORMAL",
    cacheReadAllowed: true,
    cacheWriteAllowed: true,
    negativeLookupAllowed: false,
    mode: "balanced",
    semanticPolicy: "fast",
    budget: DeadlineBudget.fromTimeout(5000)
  });
}

function pathEnds(file: Record<string, unknown>, suffix: string): boolean {
  return typeof file.path === "string" && file.path.endsWith(suffix);
}

test("a change batch invalidates the fast-path rg cache; the next request sees the new world", async () => {
  const { root, anchor, first, second } = buildRepo();
  const runner = new SwitchableRunner([[first], [first, second]]);
  const sourceIndex = new SourceIndex(root);
  let ensureStartedCalls = 0;
  const fakeSession = {
    cacheStatus: () => ({ enabled: true, entries: 0, hits: 0, misses: 0, invalidations: 0 }),
    status: () => ({ state: "NEW", started: false, progress: { active: 0 } }),
    drainPhaseMetrics: () => ({}),
    ensureStarted: async () => { ensureStartedCalls += 1; },
    invalidateForRepoChanges: () => {}
  };
  const router = new AgentRouter(root, fakeSession as never, sourceIndex, undefined, undefined, undefined, runner);

  // World 0: only FirstService. Cache it at generation 1.
  const gen1 = await router.impact(options(root, anchor), request(root, 1));
  const callsAfterFirst = runner.calls;
  assert.ok(gen1.files.some(file => pathEnds(file, "FirstService.java")));
  assert.equal(gen1.files.some(file => pathEnds(file, "SecondService.java")), false);

  // A repeat request at the same generation reuses the cache (no new rg calls).
  const gen1Again = await router.impact(options(root, anchor), request(root, 1));
  assert.equal(runner.calls, callsAfterFirst, "same generation reuses the cache");
  assert.equal((gen1Again.metrics.freshness as Record<string, number>).requestGeneration, 1);

  // Switch worlds and deliver a change batch that advances the generation.
  runner.world = 1;
  const batch: RepoChangeBatch = {
    generation: 2,
    observedAt: new Date().toISOString(),
    changes: [{ kind: "JAVA_ADD", absolutePath: second }]
  };
  router.onRepoChanged(batch);
  sourceIndex.applyChanges(batch);

  // World 1 at generation 2: the cache is stale, so rg re-runs and SecondService appears.
  const gen2 = await router.impact(options(root, anchor), request(root, 2));
  assert.ok(runner.calls > callsAfterFirst, "the batch forced rg to re-run");
  assert.ok(gen2.files.some(file => pathEnds(file, "SecondService.java")), "the new file is visible");
  assert.ok(
    (gen2.metrics.freshness as Record<string, number>).requestGeneration
      > (gen1.metrics.freshness as Record<string, number>).requestGeneration,
    "the request generation advanced"
  );
  assert.equal(ensureStartedCalls, 0, "the fast path never started JDT");
});
