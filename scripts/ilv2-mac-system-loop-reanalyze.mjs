#!/usr/bin/env node
// G11 re-analysis: runs the current system-loop analysis over a recorded run's raw evidence, read-only.
//   --evidence DIR   a final-g11/rerun-g11 0.evidence directory (samples.json, calls.jsonl, owner-telemetry.jsonl, versions.json)
//   [--out FILE]     write the verdict there (must not exist); default stdout
// The recorded g11-analysis.json stays as the run wrote it; this output is a separate, reproducible verdict.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, requireValue, sha256 } from "./ilv2-mac-contracts.mjs";
import { analyze } from "./ilv2-mac-system-loop.mjs";

export async function reanalyze(dir) {
  const bytes = {};
  for (const name of ["samples.json", "calls.jsonl", "owner-telemetry.jsonl", "versions.json", "g11-analysis.json"]) bytes[name] = await readFile(path.join(dir, name));
  const rows = name => bytes[name].toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const samples = JSON.parse(bytes["samples.json"]);
  const recorded = JSON.parse(bytes["g11-analysis.json"]);
  const verdict = analyze({ ...samples, calls: rows("calls.jsonl"), telemetry: rows("owner-telemetry.jsonl"), versions: JSON.parse(bytes["versions.json"]),
    quick: false, deltaClosureLimit: recorded.deltaCalibration?.limit ?? 400 });
  const brief = analysis => Object.fromEntries(Object.entries(analysis.hardGates).map(([name, item]) => [name, item.verdict]));
  return {
    evidence: dir, inputs: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha256(value)])),
    recorded: { status: recorded.status, hardGates: brief(recorded) }, status: verdict.status, hardGates: brief(verdict), performanceReady: verdict.performanceReady,
    performanceVerdicts: verdict.performanceVerdicts, verdict
  };
}

if (isMain(import.meta.url)) {
  const options = cliOptions(process.argv.slice(2), ["--evidence", "--out"]);
  requireValue(options.evidence, "--evidence DIR required");
  const text = `${JSON.stringify(await reanalyze(path.resolve(options.evidence)), null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, { flag: "wx" });
  else process.stdout.write(text);
}
