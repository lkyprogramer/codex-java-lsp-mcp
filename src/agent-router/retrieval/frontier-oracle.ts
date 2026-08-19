// input: Required groups, first-plan files, and frontier relative paths.
// output: Per-field-free coverage lift. Never a λ-weighted KEEP/REJECT scalar.
// pos: V5R Phase 4 oracle. Continuation is not executed.
import { defaultPolicyCoverage, type RequiredGroup } from "./retrieval-policy.js";

export type FrontierOracleReport = {
  firstCoverage: number;
  oracleCoverage: number;
  lifted: boolean;
  oraclePicks: string[];
  uncoveredGroupIds: string[];
};

export function frontierOracleCoverage(
  groups: readonly RequiredGroup[],
  firstPlanFiles: readonly string[],
  frontierFiles: readonly string[]
): FrontierOracleReport {
  const first = new Set(firstPlanFiles);
  const firstCoverage = defaultPolicyCoverage(groups, firstPlanFiles);
  const picks: string[] = [];
  for (const group of groups) {
    if (group.anyOf.some(hit => first.has(hit.file) || picks.includes(hit.file))) continue;
    const hit = group.anyOf.find(item => frontierFiles.includes(item.file));
    if (hit && !picks.includes(hit.file)) picks.push(hit.file);
  }
  const combined = [...firstPlanFiles, ...picks];
  const oracleCoverage = defaultPolicyCoverage(groups, combined);
  const covered = new Set(combined);
  return {
    firstCoverage,
    oracleCoverage,
    lifted: oracleCoverage > firstCoverage,
    oraclePicks: picks,
    uncoveredGroupIds: groups.filter(group => !group.anyOf.some(hit => covered.has(hit.file))).map(group => group.id)
  };
}
