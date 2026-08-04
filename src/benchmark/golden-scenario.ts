// input: golden/*.scenarios.jsonl (schema V3, Task 32 Step 1).
// output: Scenario type plus the golden-file accessors every benchmark/attribution module shares.
// pos: Extracted from benchmark-agent-impact.ts so src/benchmark/*.ts can import scenario
//      parsing without importing that script's side-effecting top level.
import { existsSync, readFileSync } from "node:fs";
import type { ImpactOptions } from "../agent-types.js";

export type WarmState = "cold-nolsp" | "cold-lsp" | "warm-auto" | "warm-required";

export type GoldenKind = "must" | "taskBlocking" | "should" | "support";

export type Scenario = {
  id: string;
  name: string;
  projectId?: string;
  layoutProfile?: string;
  repoCommit?: string;
  scenarioVersion?: number;
  warmState?: WarmState;
  skippedProfiles?: string[];
  anchor: {
    file: string;
    line: number;
    column: number;
    profile: ImpactOptions["profile"];
    focusModules?: string[];
    taskKeywords?: string[];
  };
  golden?: {
    mustHit?: string[];
    taskBlocking?: string[];
    shouldHit?: string[];
    support?: string[];
    mustReadRanges?: Record<string, Array<{ startLine: number; endLine: number }>>;
  };
  groundTruth?: string[];
};

export function loadScenarios(file: string): Scenario[] {
  if (!existsSync(file)) {
    throw new Error(`Scenario file does not exist: ${file}`);
  }
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Scenario;
      } catch (error) {
        throw new Error(`Invalid scenario JSON at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export function goldenFiles(scenario: Scenario, key: "mustHit" | "taskBlocking" | "shouldHit" | "support"): string[] {
  if (scenario.golden) {
    return scenario.golden[key] || [];
  }
  return key === "mustHit" ? scenario.groundTruth || [] : [];
}

export function goldenEntries(scenario: Scenario): Array<{ file: string; kind: GoldenKind }> {
  return [
    ...goldenFiles(scenario, "mustHit").map(file => ({ file, kind: "must" as const })),
    ...goldenFiles(scenario, "taskBlocking").map(file => ({ file, kind: "taskBlocking" as const })),
    ...goldenFiles(scenario, "shouldHit").map(file => ({ file, kind: "should" as const })),
    ...goldenFiles(scenario, "support").map(file => ({ file, kind: "support" as const }))
  ];
}
