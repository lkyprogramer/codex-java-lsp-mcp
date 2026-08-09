import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderInput } from "../evidence.js";
import { collectSupportEvidence } from "./support-provider.js";

test("support provider carries candidate metadata only through typed evidence", async () => {
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

  assert.equal(Object.hasOwn(result, "candidates"), false);
  assert.deepEqual(result.evidence.map(signal => [signal.kind, signal.weight, signal.confidence]), [
    ["FOCUS_MODULE", 55, 0.9],
    ["TASK_KEYWORD", 30, 0.5]
  ]);
  assert.deepEqual(result.evidence.map(signal => signal.candidateMetadata), [
    {
      categories: ["task-context"],
      reasons: ["taskContext:focusModule"],
      verifiedBy: ["taskContext"],
      matchCount: 0
    },
    {
      categories: ["task-context"],
      reasons: ["taskContext:taskKeyword"],
      verifiedBy: ["taskContext"],
      matchCount: 0
    }
  ]);
});
