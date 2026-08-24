// input: A golden scenario, optionally with requiredGroups.
// output: Golden V2 required groups. Legacy mustHit becomes one anyOf file each.
// pos: V5R Phase 3. Does not rewrite golden jsonl; existing rows stay valid.
import { goldenFiles, type Scenario } from "./golden-scenario.js";
import type { RequiredGroup } from "../agent-router/retrieval/retrieval-policy.js";

export type GoldenRequiredHit = {
  file: string;
  ranges?: Array<{ startLine: number; endLine: number }>;
};

export type GoldenRequiredGroup = RequiredGroup;

export function requiredGroupsFromScenario(scenario: Scenario): GoldenRequiredGroup[] {
  const explicit = scenario.golden && "requiredGroups" in scenario.golden
    ? (scenario.golden as { requiredGroups?: GoldenRequiredGroup[] }).requiredGroups
    : undefined;
  if (explicit && explicit.length > 0) return explicit.map(group => ({
    id: group.id,
    weight: group.weight > 0 ? group.weight : 1,
    anyOf: group.anyOf
  }));
  return goldenFiles(scenario, "mustHit").map(file => ({
    id: `must:${file}`,
    weight: 1,
    anyOf: [{ file }]
  }));
}

export function validateRequiredGroups(value: unknown, context: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`Invalid scenario at ${context}: requiredGroups must be an array`);
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid scenario at ${context}[${index}]: expected a group object`);
    }
    const group = raw as Record<string, unknown>;
    if (typeof group.id !== "string" || group.id.length === 0) {
      throw new Error(`Invalid scenario at ${context}[${index}]: id must be a non-empty string`);
    }
    if (group.weight !== undefined && !(typeof group.weight === "number" && Number.isFinite(group.weight) && group.weight > 0)) {
      throw new Error(`Invalid scenario at ${context}[${index}]: weight must be a positive number`);
    }
    if (!Array.isArray(group.anyOf) || group.anyOf.length === 0) {
      throw new Error(`Invalid scenario at ${context}[${index}]: anyOf must be a non-empty array`);
    }
    for (const [hitIndex, hit] of group.anyOf.entries()) {
      if (!hit || typeof hit !== "object" || Array.isArray(hit) || typeof (hit as { file?: unknown }).file !== "string") {
        throw new Error(`Invalid scenario at ${context}[${index}].anyOf[${hitIndex}]: file is required`);
      }
    }
  }
}
