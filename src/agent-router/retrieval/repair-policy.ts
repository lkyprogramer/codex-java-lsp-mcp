// input: Golden required ranges plus measured file/member/plan bytes.
// output: Repair-policy byte costs for offline first-call vs miss-repair comparison.
// pos: V5R Phase 3. Does not execute continuation or invent TaskSuccess.
export type RepairPolicy =
  | "EXACT_RANGE_ORACLE"
  | "CONTINUATION_DEFAULT"
  | "MEMBER_READ"
  | "WHOLE_FILE_UPPER_BOUND";

export type RepairRange = {
  file: string;
  estimatedBytes: number;
};

export type RepairFileBudget = {
  file: string;
  memberBytes: number;
  wholeFileBytes: number;
};

export type RepairPlan = {
  selected: RepairRange[];
  missedRequired: RepairRange[];
};

export function repairReadBytes(
  policy: RepairPolicy,
  plan: RepairPlan,
  files: readonly RepairFileBudget[]
): number {
  const byFile = new Map(files.map(file => [file.file, file]));
  if (policy === "EXACT_RANGE_ORACLE") {
    return sumBytes([...plan.selected, ...plan.missedRequired]);
  }
  if (policy === "WHOLE_FILE_UPPER_BOUND") {
    const paths = unique([...plan.selected, ...plan.missedRequired].map(range => range.file));
    return paths.reduce((sum, path) => sum + (byFile.get(path)?.wholeFileBytes ?? 0), 0);
  }
  if (policy === "MEMBER_READ") {
    const paths = unique([...plan.selected, ...plan.missedRequired].map(range => range.file));
    return paths.reduce((sum, path) => sum + (byFile.get(path)?.memberBytes ?? 0), 0);
  }
  const firstCall = sumBytes(plan.selected);
  const missedPaths = unique(plan.missedRequired.map(range => range.file))
    .filter(path => !plan.selected.some(range => range.file === path));
  const repair = missedPaths.reduce((sum, path) => sum + (byFile.get(path)?.memberBytes ?? 0), 0);
  return firstCall + repair;
}

function sumBytes(ranges: readonly RepairRange[]): number {
  return ranges.reduce((sum, range) => sum + Math.max(0, range.estimatedBytes), 0);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
