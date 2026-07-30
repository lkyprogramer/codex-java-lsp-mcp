import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderInput } from "../evidence.js";
import { collectSupportEvidence } from "./support-provider.js";

test("support provider carries focus-module and task-keyword score through its outcome", async () => {
  const candidatePath = "/repo/modules/report/src/main/java/demo/ReportExportTask.java";
  const result = await collectSupportEvidence({
    repoRoot: "/repo",
    anchors: [{ id: "A1" }],
    options: {
      anchors: [],
      mode: "balanced",
      profile: "auto",
      semanticPolicy: "fast",
      semanticTimeoutMs: 1_500,
      testReadMode: "defer",
      focusModules: ["report"],
      excludeModules: [],
      taskKeywords: ["export"],
      crossModulePolicy: "auto"
    },
    existingCandidatePaths: [candidatePath],
    generation: 0
  } as unknown as ProviderInput);

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.score, 85);
  assert.deepEqual(
    result.candidates[0]!.reasons,
    ["taskContext:focusModule", "taskContext:taskKeyword"]
  );
  assert.deepEqual(result.evidence.map(signal => [signal.kind, signal.weight, signal.confidence]), [
    ["FOCUS_MODULE", 55, 0.9],
    ["TASK_KEYWORD", 30, 0.5]
  ]);
});
