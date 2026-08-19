// input: Old facts-batch file identity and a relationship bundle view.
// output: Ordered identity report used by the shadow observer.
// pos: V5R Phase 1 old/new parity. Does not change evidence or ranking.
import {
  relationshipBundleIdentity,
  type RelationshipBundleIdentity,
  type RelationshipBundleView
} from "../../../java-index/relationship-bundle.js";

export type RelationshipParityReport = {
  match: boolean;
  old: RelationshipBundleIdentity;
  bundle: RelationshipBundleIdentity;
};

export type RelationshipParityTracker = {
  matches: number;
  mismatches: number;
  last?: RelationshipParityReport;
};

export const relationshipParityTracker: RelationshipParityTracker = {
  matches: 0,
  mismatches: 0
};

export function resetRelationshipParityTracker(): void {
  relationshipParityTracker.matches = 0;
  relationshipParityTracker.mismatches = 0;
  relationshipParityTracker.last = undefined;
}

export function observeRelationshipParity(
  oldFiles: readonly string[],
  oldCalleeTargetIds: readonly string[],
  bundle: RelationshipBundleView
): RelationshipParityReport {
  const old: RelationshipBundleIdentity = {
    files: uniqueSorted(oldFiles),
    calleeTargetIds: uniqueSorted(oldCalleeTargetIds),
    implementationTypeIds: [],
    signatureTypeIds: []
  };
  const identity = relationshipBundleIdentity(bundle);
  const filesMatch = sameIdentity(old.files, identity.files);
  const calleesMatch = old.calleeTargetIds.length === 0
    || sameIdentity(old.calleeTargetIds, identity.calleeTargetIds);
  const report: RelationshipParityReport = {
    match: filesMatch && calleesMatch,
    old,
    bundle: identity
  };
  relationshipParityTracker.last = report;
  if (report.match) relationshipParityTracker.matches += 1;
  else relationshipParityTracker.mismatches += 1;
  return report;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function sameIdentity(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
