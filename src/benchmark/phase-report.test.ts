import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPhaseReport } from "./phase-report.js";
import type { MatrixRunSummary, ProviderValueRow } from "./matrix-runner.js";

function summary(overrides: Partial<MatrixRunSummary> = {}): MatrixRunSummary {
  return {
    generatedAt: "2026-08-05T00:00:00.000Z",
    runtimeCommit: "abc1234",
    projects: [
      {
        project: "demo",
        repoRoot: "/repo/demo",
        warmStates: [
          { warmState: "cold-nolsp", runs: 5, recall: 0.95, pRead: 0.9, rReadMust: 1, rTaskBlocking: 0.98, estimatedTokensP50: 1200, estimatedTokensP95: 1800, elapsedMsP50: 400, elapsedMsP95: 900, artifactFile: "/out/matrix/demo-cold-nolsp.json" },
          { warmState: "warm-auto", runs: 5, recall: 0.97, pRead: 0.93, rReadMust: 1, rTaskBlocking: 1, estimatedTokensP50: 1100, estimatedTokensP95: 1700, elapsedMsP50: 2200, elapsedMsP95: 3400, artifactFile: "/out/matrix/demo-warm-auto.json" }
        ]
      }
    ],
    hardGateFailures: [],
    artifactFiles: ["/out/matrix/demo-cold-nolsp.json", "/out/matrix/demo-warm-auto.json"],
    ...overrides
  };
}

const providerRows: ProviderValueRow[] = [
  { provider: "framework", added: 4, selected: 3, goldenHits: 2, counterfactualGain: 1, costP50Ms: 30, costP95Ms: 55, decision: "KEEP" },
  { provider: "lexical", added: 6, selected: 0, goldenHits: 0, counterfactualGain: 0, decision: "PENDING" }
];

test("renderPhaseReport produces deterministic heading order", () => {
  const markdown = renderPhaseReport("Phase 4 Report", "KEEP", summary(), providerRows, []);
  const headings = markdown.split("\n").filter(line => line.startsWith("#")).map(line => line.replace(/^#+\s*/, ""));
  assert.deepEqual(headings, [
    "Phase 4 Report",
    "Warm-State Matrix",
    "Evidence Provider Value",
    "Hard Gate Failures",
    "Raw Artifacts",
    "Known Limitations"
  ]);
});

test("renderPhaseReport includes every artifact path verbatim", () => {
  const markdown = renderPhaseReport("Phase 4 Report", "KEEP", summary(), providerRows, []);
  for (const file of summary().artifactFiles) {
    assert.ok(markdown.includes(`\`${file}\``), `expected ${file} to appear in the report`);
  }
});

test("renderPhaseReport includes every hard gate failure verbatim and skips the 'None.' fallback", () => {
  const failing = summary({ hardGateFailures: ["demo/cold-nolsp: R_read_must 0.8 < 1.0000", "demo/warm-auto: estimatedTokensP50 1300 > baseline*1.05"] });
  const markdown = renderPhaseReport("Phase 4 Report", "FAIL", failing, providerRows, []);
  for (const failure of failing.hardGateFailures) {
    assert.ok(markdown.includes(failure), `expected failure text to appear verbatim: ${failure}`);
  }
  const section = markdown.split("## Hard Gate Failures")[1].split("## Raw Artifacts")[0];
  assert.ok(!section.includes("None."));
});

test("renderPhaseReport prints 'None.' under Hard Gate Failures when the list is empty", () => {
  const markdown = renderPhaseReport("Phase 4 Report", "KEEP", summary(), providerRows, []);
  const section = markdown.split("## Hard Gate Failures")[1].split("## Raw Artifacts")[0];
  assert.ok(section.includes("None."));
});

test("renderPhaseReport output is unaffected by the input objects' own JSON key order", () => {
  const canonical = summary();
  // Rebuild the same summary with every object's keys inserted in a different order -
  // JS preserves insertion order for string keys, so this really does reorder Object.keys().
  const reordered: MatrixRunSummary = {
    artifactFiles: canonical.artifactFiles,
    hardGateFailures: canonical.hardGateFailures,
    projects: canonical.projects.map(project => ({
      warmStates: project.warmStates.map(cell => ({
        artifactFile: cell.artifactFile,
        elapsedMsP95: cell.elapsedMsP95,
        elapsedMsP50: cell.elapsedMsP50,
        estimatedTokensP95: cell.estimatedTokensP95,
        estimatedTokensP50: cell.estimatedTokensP50,
        rTaskBlocking: cell.rTaskBlocking,
        rReadMust: cell.rReadMust,
        pRead: cell.pRead,
        recall: cell.recall,
        runs: cell.runs,
        warmState: cell.warmState
      })),
      repoRoot: project.repoRoot,
      project: project.project
    })),
    runtimeCommit: canonical.runtimeCommit,
    generatedAt: canonical.generatedAt
  };
  assert.equal(
    renderPhaseReport("Phase 4 Report", "KEEP", canonical, providerRows, []),
    renderPhaseReport("Phase 4 Report", "KEEP", reordered, providerRows, [])
  );
});

test("renderPhaseReport known limitations render verbatim, one bullet per entry", () => {
  const markdown = renderPhaseReport("Phase 4 Report", "MODIFY", summary(), providerRows, [
    "cold-nolsp and warm-auto P95 are never pooled together (different semanticPolicy budgets).",
    "Provider counterfactual gain approximates family->provider attribution; see matrix-runner.ts."
  ]);
  assert.ok(markdown.includes("- cold-nolsp and warm-auto P95 are never pooled together (different semanticPolicy budgets)."));
  assert.ok(markdown.includes("- Provider counterfactual gain approximates family->provider attribution; see matrix-runner.ts."));
});
