// input: Required golden groups and a first-call selected file set.
// output: Default vs oracle coverage of those groups. No public planner score.
// pos: V5R Phase 3 offline policy labels. Continuation is not executed here.
export type RequiredGroupHit = {
  file: string;
  ranges?: Array<{ startLine: number; endLine: number }>;
};

export type RequiredGroup = {
  id: string;
  weight: number;
  anyOf: RequiredGroupHit[];
};

export type RetrievalPolicyName = "DEFAULT" | "ORACLE";

export function groupCovered(group: RequiredGroup, selectedFiles: ReadonlySet<string>): boolean {
  return group.anyOf.some(hit => selectedFiles.has(hit.file));
}

export function defaultPolicyCoverage(groups: readonly RequiredGroup[], selectedFiles: readonly string[]): number {
  if (groups.length === 0) return 1;
  const selected = new Set(selectedFiles);
  const hitWeight = groups.filter(group => groupCovered(group, selected)).reduce((sum, group) => sum + group.weight, 0);
  const totalWeight = groups.reduce((sum, group) => sum + group.weight, 0);
  return totalWeight === 0 ? 1 : hitWeight / totalWeight;
}

export function oraclePolicyCoverage(
  groups: readonly RequiredGroup[],
  availableFiles: readonly string[]
): { coverage: number; selected: string[] } {
  const available = new Set(availableFiles);
  const selected: string[] = [];
  const uncovered = groups.filter(group => !group.anyOf.some(hit => selected.includes(hit.file)));
  for (const group of uncovered) {
    const hit = group.anyOf.find(item => available.has(item.file));
    if (hit && !selected.includes(hit.file)) selected.push(hit.file);
  }
  return { coverage: defaultPolicyCoverage(groups, selected), selected };
}
