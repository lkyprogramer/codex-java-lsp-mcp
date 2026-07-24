import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRouter } from "./index.js";
import { SourceIndex } from "../source-index.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { JavaIntelligenceError, type JavaIntelligenceErrorCode } from "../runtime/intelligence-error.js";
import type { ImpactOptions } from "../agent-types.js";

function buildRepo(): { repoRoot: string; anchorFile: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "semantic-failure-"));
  const javaDir = path.join(repoRoot, "src", "main", "java", "demo");
  mkdirSync(javaDir, { recursive: true });
  writeFileSync(path.join(repoRoot, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n", "utf8");
  const anchorFile = path.join(javaDir, "DemoService.java");
  writeFileSync(anchorFile, [
    "package demo;",
    "public class DemoService {",
    "  public void handle() {}",
    "}"
  ].join("\n"), "utf8");
  return { repoRoot, anchorFile };
}

function routerThatThrows(repoRoot: string, code: JavaIntelligenceErrorCode, message: string): AgentRouter {
  const failure = () => {
    throw new JavaIntelligenceError(code, message);
  };
  const session = {
    cacheStatus: () => ({ enabled: true, entries: 0, hits: 0, misses: 0, invalidations: 0 }),
    status: () => ({ state: "BROKEN", started: false, progress: { active: 0 } }),
    drainPhaseMetrics: () => ({}),
    semanticLocations: failure,
    references: failure,
    typeHierarchy: failure
  };
  return new AgentRouter(repoRoot, session as never, new SourceIndex(repoRoot));
}

function options(anchorFile: string, repoRoot: string): ImpactOptions {
  return {
    anchors: [{ file: path.relative(repoRoot, anchorFile), line: 2, column: 14 }],
    mode: "precision",
    profile: "service",
    // "required" forces both the seed and the verify stage to run.
    semanticPolicy: "required",
    semanticTimeoutMs: 500,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    verbosity: "diagnostic"
  };
}

for (const code of ["JDT_BACKOFF", "JDT_CONFIG_ERROR", "JDT_BROKEN", "DEADLINE_EXCEEDED"] as const) {
  test(`a ${code} JDT degrades the semantic stage instead of failing the request`, async () => {
    const { repoRoot, anchorFile } = buildRepo();
    const router = routerThatThrows(repoRoot, code, `simulated ${code}`);

    const result = await router.impact(options(anchorFile, repoRoot), DeadlineBudget.fromTimeout(5000));

    // The lexical and structural evidence must still be delivered.
    assert.equal(Array.isArray(result.files), true);
    assert.equal(Array.isArray(result.readPlan), true);
    const semantic = result.metrics.semantic as Record<string, unknown>;
    assert.equal(semantic.used, true, "the semantic stage was attempted");
    assert.equal(semantic.errorCode, code, "the failure is classified, not swallowed as a timeout");
  });
}

test("a JDT failure is not reported as a timeout unless it actually was one", async () => {
  const { repoRoot, anchorFile } = buildRepo();
  const router = routerThatThrows(repoRoot, "JDT_BACKOFF", "simulated backoff");

  const result = await router.impact(options(anchorFile, repoRoot), DeadlineBudget.fromTimeout(5000));

  const semantic = result.metrics.semantic as Record<string, unknown>;
  assert.equal(semantic.timeout, false, "backoff is not a timeout");
});
