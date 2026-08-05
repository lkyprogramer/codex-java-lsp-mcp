import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  buildProviderValueRows,
  readCellPayloads,
  runMatrix,
  type CommandOutcome,
  type CommandRunner,
  type RawCellPayload
} from "./matrix-runner.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "matrix-runner-test-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fakePayload(overrides: Partial<RawCellPayload["totals"]> = {}): RawCellPayload {
  return {
    metadata: { projectId: "demo", warmState: "cold-nolsp" },
    totals: {
      recall: 0.95,
      pRead: 0.9,
      rReadMust: 1,
      rTaskBlocking: 0.98,
      estimatedTokensP50: 1200,
      estimatedTokensP95: 1800,
      elapsedMsP50: 400,
      elapsedMsP95: 900,
      ...overrides
    },
    rows: [{ id: "s1", attempts: [{ elapsedMs: 400 }] }]
  };
}

function fakeRunner(responses: CommandOutcome[]): { runner: CommandRunner; calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> } {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = [];
  let index = 0;
  const runner: CommandRunner = async (command, args, env) => {
    calls.push({ command, args: [...args], env: { ...env } });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  };
  return { runner, calls };
}

test("runMatrix runs one cell per project x warm-state, defaulting to cold-nolsp and warm-auto", async () => {
  const outputDir = tempDir();
  const payload = fakePayload();
  const { runner, calls } = fakeRunner([{ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 }]);

  const summary = await runMatrix({
    projects: [{ project: "demo", repoRoot: "/repo/demo", scenarioFile: "/repo/demo/golden/demo.scenarios.jsonl" }],
    outputDir,
    runtimeCommit: "abc1234",
    benchmarkScript: "/dist/benchmark-agent-impact.js",
    runCommand: runner
  });

  assert.equal(calls.length, 2, "cold-nolsp and warm-auto by default");
  assert.deepEqual(calls.map(call => call.args[call.args.indexOf("--warm-state") + 1]), ["cold-nolsp", "warm-auto"]);
  for (const call of calls) {
    assert.equal(call.env.JAVA_LSP_SHADOW_RANKING, "1", "shadow ranking must stay enabled for counterfactual evidence");
    assert.ok(call.args.includes("--verbosity") && call.args[call.args.indexOf("--verbosity") + 1] === "diagnostic");
    assert.ok(call.args.includes("--runs") && call.args[call.args.indexOf("--runs") + 1] === "5");
  }

  assert.equal(summary.projects.length, 1);
  assert.equal(summary.projects[0].warmStates.length, 2);
  assert.equal(summary.projects[0].warmStates[0].recall, 0.95);
  assert.equal(summary.artifactFiles.length, 2);
  assert.equal(summary.hardGateFailures.length, 0);
  assert.equal(summary.runtimeCommit, "abc1234");

  for (const file of summary.artifactFiles) {
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.metadata.projectId, "demo");
  }
});

test("runMatrix only runs warm-required when the caller explicitly requests it", async () => {
  const outputDir = tempDir();
  const payload = fakePayload();
  const { runner, calls } = fakeRunner([{ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 }]);

  await runMatrix({
    projects: [{ project: "demo", repoRoot: "/repo/demo", scenarioFile: "/repo/demo/golden/demo.scenarios.jsonl" }],
    outputDir,
    runtimeCommit: "abc1234",
    benchmarkScript: "/dist/benchmark-agent-impact.js",
    runCommand: runner,
    warmStates: ["warm-required"]
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf("--warm-state") + 1], "warm-required");
});

test("runMatrix throws (does not silently swallow) a nonzero cell exit code", async () => {
  const outputDir = tempDir();
  const { runner } = fakeRunner([{ stdout: "", stderr: "boom", exitCode: 2 }]);

  await assert.rejects(
    () => runMatrix({
      projects: [{ project: "demo", repoRoot: "/repo/demo", scenarioFile: "/repo/demo/golden/demo.scenarios.jsonl" }],
      outputDir,
      runtimeCommit: "abc1234",
      benchmarkScript: "/dist/benchmark-agent-impact.js",
      runCommand: runner,
      warmStates: ["cold-nolsp"]
    }),
    /exited with 2/
  );
});

test("runMatrix throws when a cell's totals is missing a required metric instead of defaulting to 0", async () => {
  const outputDir = tempDir();
  const payload = fakePayload();
  delete (payload.totals as Record<string, number>).rTaskBlocking;
  const { runner } = fakeRunner([{ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 }]);

  await assert.rejects(
    () => runMatrix({
      projects: [{ project: "demo", repoRoot: "/repo/demo", scenarioFile: "/repo/demo/golden/demo.scenarios.jsonl" }],
      outputDir,
      runtimeCommit: "abc1234",
      benchmarkScript: "/dist/benchmark-agent-impact.js",
      runCommand: runner,
      warmStates: ["cold-nolsp"]
    }),
    /rTaskBlocking is missing/
  );
});

test("runMatrix collects hardGateFailures verbatim from every supplied gate check", async () => {
  const outputDir = tempDir();
  const payload = fakePayload({ rReadMust: 0.8 });
  const { runner } = fakeRunner([{ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 }]);

  const summary = await runMatrix({
    projects: [{ project: "demo", repoRoot: "/repo/demo", scenarioFile: "/repo/demo/golden/demo.scenarios.jsonl" }],
    outputDir,
    runtimeCommit: "abc1234",
    benchmarkScript: "/dist/benchmark-agent-impact.js",
    runCommand: runner,
    warmStates: ["cold-nolsp"],
    hardGates: [
      finalSummary => finalSummary.projects.flatMap(project => project.warmStates
        .filter(cell => cell.rReadMust < 1)
        .map(cell => `${project.project}/${cell.warmState}: R_read_must ${cell.rReadMust} < 1.0000`))
    ]
  });

  assert.deepEqual(summary.hardGateFailures, ["demo/cold-nolsp: R_read_must 0.8 < 1.0000"]);
});

test("readCellPayloads round-trips artifact files written by runMatrix", async () => {
  const outputDir = tempDir();
  const payload = fakePayload();
  const { runner } = fakeRunner([{ stdout: JSON.stringify(payload), stderr: "", exitCode: 0 }]);

  const summary = await runMatrix({
    projects: [{ project: "demo", repoRoot: "/repo/demo", scenarioFile: "/repo/demo/golden/demo.scenarios.jsonl" }],
    outputDir,
    runtimeCommit: "abc1234",
    benchmarkScript: "/dist/benchmark-agent-impact.js",
    runCommand: runner,
    warmStates: ["cold-nolsp"]
  });

  const cells = readCellPayloads(summary.artifactFiles);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].metadata.projectId, "demo");
});

test("buildProviderValueRows aggregates added/selected/goldenHits and attributes counterfactual gain to a golden file's recorded providers", () => {
  const cells: RawCellPayload[] = [
    {
      metadata: { projectId: "demo", warmState: "cold-nolsp" },
      totals: {},
      rows: [{
        id: "s1",
        attempts: [{
          goldenAttribution: [
            { scenarioId: "s1", file: "A.java", kind: "must", inCandidates: true, inReadPlan: true, firstRank: 1, sourceFamilies: ["STATIC_STRUCTURE"], providers: ["static", "relationship"], blockedBy: "hit" },
            { scenarioId: "s1", file: "B.java", kind: "should", inCandidates: true, inReadPlan: false, firstRank: 8, sourceFamilies: ["LEXICAL"], providers: ["lexical"], blockedBy: "candidate-limit" }
          ],
          counterfactual: {
            withoutExactSemantic: { candidateHitLost: [], readPlanHitLost: [], measured: true },
            withoutStaticStructure: { candidateHitLost: [], readPlanHitLost: ["A.java"], measured: true },
            withoutFramework: { candidateHitLost: [], readPlanHitLost: [], measured: true },
            withoutLexical: { candidateHitLost: [], readPlanHitLost: [], measured: true },
            withoutTaskContext: { candidateHitLost: [], readPlanHitLost: [], measured: true },
            withoutSupport: { candidateHitLost: [], readPlanHitLost: [], measured: true }
          },
          timing: { phaseMs: { relationshipEvidence: 12, frameworkEvidence: 30 } }
        }]
      }]
    }
  ];

  const rows = buildProviderValueRows(cells);
  const byProvider = Object.fromEntries(rows.map(row => [row.provider, row]));

  assert.equal(byProvider.static.added, 1);
  assert.equal(byProvider.static.selected, 1);
  assert.equal(byProvider.static.goldenHits, 1);
  assert.equal(byProvider.static.counterfactualGain, 1, "A.java's readPlanHitLost under STATIC_STRUCTURE credits every provider recorded for A.java");
  assert.equal(byProvider.relationship.counterfactualGain, 1);
  assert.equal(byProvider.relationship.costP50Ms, 12);
  assert.equal(byProvider.framework.costP50Ms, 30, "framework gets a cost row from phaseMs even with zero goldenAttribution hits");

  assert.equal(byProvider.lexical.added, 1);
  assert.equal(byProvider.lexical.selected, 0);
  assert.equal(byProvider.lexical.goldenHits, 0);
  assert.equal(byProvider.lexical.counterfactualGain, 0);
  assert.equal(byProvider.lexical.costP50Ms, undefined, "lexical has no dedicated phase timer, so cost must stay undefined rather than a fabricated 0");

  for (const row of rows) {
    assert.equal(row.decision, "PENDING", "decision is left for the report author, not computed mechanically");
  }
});

test("buildProviderValueRows returns an empty list for cells with no goldenAttribution at all", () => {
  const cells: RawCellPayload[] = [{ metadata: { projectId: "demo", warmState: "cold-nolsp" }, totals: {}, rows: [{ id: "s1", attempts: [{}] }] }];
  assert.deepEqual(buildProviderValueRows(cells), []);
});
