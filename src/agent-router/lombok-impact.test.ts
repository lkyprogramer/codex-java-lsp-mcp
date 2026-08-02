// input: a real JavaIndex fixture in which a service calls a Lombok-generated
//        getter on a DTO, plus the JDT session's already-computed missing-agent status.
// output: end-to-end AgentRouter proof that a selected Lombok DTO turns into a
//         visible task-level completeness gap without re-scanning build files.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRouter } from "./index.js";
import type { ImpactOptions } from "../agent-types.js";
import { JavaIndexClient } from "../java-index/java-index-client.js";
import { RouterJavaIndex } from "../java-index/router-java-index.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";

function options(overrides: Partial<ImpactOptions>): ImpactOptions {
  return {
    anchors: [],
    mode: "balanced",
    profile: "service",
    semanticPolicy: "fast",
    semanticTimeoutMs: 200,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    ...overrides
  };
}

class EmptyRgRunner extends RgRunner {
  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
}

class MissingLombokAgentSession {
  cacheStatus(): { invalidations: number; entries: number; hits: number; misses: number } {
    return { invalidations: 0, entries: 0, hits: 0, misses: 0 };
  }

  status() {
    return {
      started: false,
      progress: { active: 0 },
      generatedCode: {
        lombok: { detected: true, agentEnabled: false, status: "missing-agent" as const },
        annotationProcessing: { detectedProcessors: ["lombok"], enabled: true, source: "auto" as const },
        generatedCodeSemantics: "incomplete" as const
      }
    };
  }
}

async function waitForCompleteIndex(index: RouterJavaIndex): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await index.routerStatus()).coverage === "complete") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("fixture JavaIndex did not reach complete coverage within 2 seconds");
}

test("service task that reads a Lombok-generated getter keeps its selected DTO and reports the missing-agent gap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lombok-impact-"));
  const sourceDir = path.join(root, "src", "main", "java", "demo");
  const serviceFile = path.join(sourceDir, "OrderService.java");
  const dtoFile = path.join(sourceDir, "LombokOrder.java");
  const index = new RouterJavaIndex(root, new JavaIndexClient(root, path.join(root, ".cache")));
  try {
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
    await writeFile(dtoFile, [
      "package demo;",
      "",
      "import lombok.Data;",
      "",
      "@Data",
      "public class LombokOrder {",
      "  private String id;",
      "}",
      ""
    ].join("\n"));
    await writeFile(serviceFile, [
      "package demo;",
      "",
      "public class OrderService {",
      "  public String readId(LombokOrder order) {",
      "    return order.getId();",
      "  }",
      "}",
      ""
    ].join("\n"));
    await index.open(0);
    await index.reconcile(0);
    await waitForCompleteIndex(index);
    const session = new MissingLombokAgentSession();
    const router = new AgentRouter(
      root,
      session as never,
      index,
      undefined,
      undefined,
      undefined,
      new EmptyRgRunner()
    );
    const result = await router.impact(options({
      anchors: [{ file: serviceFile, line: 4, column: 29 }],
      readPlanMaxItems: 2,
      verbosity: "standard"
    }), {
      budget: DeadlineBudget.fromTimeout(15_000),
      generation: 0,
      cacheReadAllowed: true,
      cacheWriteAllowed: true,
      freshnessMode: "NORMAL"
    } as never);

    const selectedDto = result.files.find(file => String(file.path).endsWith("LombokOrder.java"));
    assert.ok(selectedDto, "the DTO used by the service method must remain a routed candidate");
    assert.ok(
      result.readPlan.some(item => item.fileId === selectedDto.id),
      "the routed Lombok DTO must enter the read plan before it can trigger a task-level completeness gap"
    );
    assert.ok(
      result.evidenceGaps.some(gap => gap.includes("Lombok")),
      "the selected Lombok DTO makes the task dependent on generated-member binding"
    );
    assert.equal(result.metrics.generatedSemantics, "INCOMPLETE");
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});
