// input: A completed MatrixRunSummary, per-provider value rows, and known limitations.
// output: Deterministic Markdown for docs/phase-v3/phase4-evidence-framework-token-report.md.
// pos: Task 32 Step 6. Pure rendering only - no file I/O, no process spawning - so
//      phase-report.test.ts can assert exact Markdown against a fixed fixture summary.
//      Reads MatrixRunSummary/ProviderValueRow by named field access only (never
//      Object.entries/for-in over the input), so JSON key order in the source objects
//      never changes the rendered output.
import type { MatrixRunSummary, ProviderValueRow } from "./matrix-runner.js";

export function renderPhaseReport(
  title: string,
  decision: "KEEP" | "REJECT" | "MODIFY" | "FAIL",
  summary: MatrixRunSummary,
  providerRows: readonly ProviderValueRow[],
  knownLimits: readonly string[]
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`- Decision: **${decision}**`);
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Runtime commit: \`${summary.runtimeCommit}\``);
  lines.push("");

  lines.push("## Warm-State Matrix");
  lines.push("");
  lines.push("| project | warm state | runs | recall | P_read | R_read_must | R_task_blocking | tokens P50 | tokens P95 | elapsed P50 (ms) | elapsed P95 (ms) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const project of summary.projects) {
    for (const cell of project.warmStates) {
      lines.push(
        `| ${project.project} | ${cell.warmState} | ${cell.runs} | ${cell.recall.toFixed(4)} | ${cell.pRead.toFixed(4)} | ${cell.rReadMust.toFixed(4)} | ${cell.rTaskBlocking.toFixed(4)} | ${Math.round(cell.estimatedTokensP50)} | ${Math.round(cell.estimatedTokensP95)} | ${Math.round(cell.elapsedMsP50)} | ${Math.round(cell.elapsedMsP95)} |`
      );
    }
  }
  lines.push("");

  lines.push("## Evidence Provider Value");
  lines.push("");
  lines.push("| provider | added | selected | golden hits | counterfactual gain | cost P50 (ms) | cost P95 (ms) | decision |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of providerRows) {
    const p50 = row.costP50Ms !== undefined ? String(Math.round(row.costP50Ms)) : "n/a";
    const p95 = row.costP95Ms !== undefined ? String(Math.round(row.costP95Ms)) : "n/a";
    lines.push(`| ${row.provider} | ${row.added} | ${row.selected} | ${row.goldenHits} | ${row.counterfactualGain} | ${p50} | ${p95} | ${row.decision} |`);
  }
  lines.push("");

  lines.push("## Hard Gate Failures");
  lines.push("");
  if (summary.hardGateFailures.length === 0) {
    lines.push("None.");
  } else {
    for (const failure of summary.hardGateFailures) {
      lines.push(`- ${failure}`);
    }
  }
  lines.push("");

  lines.push("## Raw Artifacts");
  lines.push("");
  for (const file of summary.artifactFiles) {
    lines.push(`- \`${file}\``);
  }
  lines.push("");

  lines.push("## Known Limitations");
  lines.push("");
  if (knownLimits.length === 0) {
    lines.push("None.");
  } else {
    for (const limit of knownLimits) {
      lines.push(`- ${limit}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}
