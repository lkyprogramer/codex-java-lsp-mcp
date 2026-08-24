// input: A diagnostic cold benchmark JSON generated with exactly 20 attempts per scenario.
// output: Machine-readable PASS summary, or a non-zero exit with the first semantic drift.
// pos: Task 36 reproducible determinism command.
import { readFileSync } from "node:fs";
import path from "node:path";
import { verifyImpactDeterminismPayload } from "./determinism.js";

try {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(required(args, "--input"));
  const expectedRuns = positiveInteger(args.get("--expected-runs") ?? "20", "--expected-runs");
  const payload = JSON.parse(readFileSync(input, "utf8")) as unknown;
  const summary = verifyImpactDeterminismPayload(payload, expectedRuns);
  process.stdout.write(`${JSON.stringify({ version: 1, input, ...summary, gate: "PASS" }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`determinism gate failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument sequence near ${name ?? "<end>"}`);
    }
    result.set(name, value);
  }
  return result;
}

function required(args: ReadonlyMap<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
