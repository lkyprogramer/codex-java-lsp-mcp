// input: Materialized ReadUnits plus the first-call selected paths and budget.
// output: Diagnostic-only frontier shadow. Does not change first-plan selection.
// pos: V5R Phase 4. Reverse-caller queries stay design-only; no public MCP scores.
import { selectionUtility } from "./selection-utility.js";
import type {
  ContinuationRelation,
  FrontierShadowReport,
  FrontierItemV1,
  ReadUnit,
  RetrievalBudget,
  RetrievalStopReason
} from "./retrieval-types.js";

export const FRONTIER_MAX_PER_RELATION = 2;
export const FRONTIER_MAX_PER_FILE = 1;
export const FRONTIER_MAX_PER_FAMILY = 2;

const RELATION_PRIORITY: Record<ContinuationRelation, number> = {
  BUDGET_EVICTED: 0,
  SECOND_HOP_EXACT: 1,
  CLOSED_PORT_IMPLEMENTATION: 2,
  SIGNATURE_COLLABORATOR: 3,
  WRONG_MEMBER_ALTERNATIVE: 4,
  FRAMEWORK_SUPPORT: 5,
  CROSS_MODULE_ALTERNATIVE: 6,
  AMBIGUOUS_DISPATCH: 7,
  TEST_VERIFICATION: 8,
  REVERSE_CALLER_QUERY: 9,
  FIRST_CALL_ANCHOR: 10,
  FIRST_CALL_CORE: 11
};

export function frontierRelation(unit: ReadUnit): ContinuationRelation {
  if (unit.relationClass === "REVERSE_CALLER_QUERY") return "REVERSE_CALLER_QUERY";
  if (unit.relationClass === "FIRST_CALL_ANCHOR" || unit.relationClass === "FIRST_CALL_CORE") {
    return "BUDGET_EVICTED";
  }
  return unit.relationClass;
}

export function publicFrontierItem(unit: ReadUnit, id: string, relation: ContinuationRelation): FrontierItemV1 {
  return {
    id,
    fileId: unit.fileId,
    path: unit.relativePath,
    ranges: unit.mergedRanges.map(range => ({
      startLine: range.startLine,
      endLine: range.endLine,
      estimatedBytes: range.estimatedBytes
    })),
    relation,
    expectedEvidence: unit.evidenceKeys.slice(0, 4),
    confidence: unit.confidence,
    estimatedReadBytes: unit.estimatedBytes,
    hop: unit.hop
  };
}

export function buildFrontier(
  units: readonly ReadUnit[],
  selectedPaths: readonly string[],
  budget: RetrievalBudget
): FrontierShadowReport {
  const selected = new Set(selectedPaths);
  const remaining = units.filter(unit => !selected.has(unit.absolutePath) && unit.mergedRanges.length > 0);
  const deferredQueries = remaining
    .filter(unit => frontierRelation(unit) === "REVERSE_CALLER_QUERY")
    .map(() => ({
      relation: "REVERSE_CALLER_QUERY" as const,
      reason: "Reverse-caller continuation is a deferred extra query, not a dropped first-call candidate.",
      notOpened: true as const
    }));
  const eligible = remaining.filter(unit => frontierRelation(unit) !== "REVERSE_CALLER_QUERY");
  const caps = {
    maxItems: budget.frontierMaxItems,
    maxBytes: budget.frontierMaxBytes,
    maxPerRelation: FRONTIER_MAX_PER_RELATION,
    maxPerFile: FRONTIER_MAX_PER_FILE,
    maxPerFamily: FRONTIER_MAX_PER_FAMILY
  };
  const emptyCoverage = coverageOf([], 0);
  if (caps.maxItems <= 0 || caps.maxBytes <= 0) {
    return {
      items: [],
      deferredQueries,
      stopReason: eligible.length === 0 ? "NO_FRONTIER" : "FRONTIER_BYTE_CAP",
      coverage: emptyCoverage,
      caps
    };
  }

  const items: FrontierItemV1[] = [];
  const picked: ReadUnit[] = [];
  const selectedCarriers = units
    .filter(unit => selected.has(unit.absolutePath))
    .map(unit => ({ file: unit.file, estimatedBytes: unit.estimatedBytes }));
  const relationCounts = new Map<ContinuationRelation, number>();
  const fileCounts = new Map<string, number>();
  const familyCounts = new Map<string, number>();
  let readBytes = 0;
  let responseBytes = 0;
  let hitByteCap = false;

  while (items.length < caps.maxItems) {
    const next = nextFrontierUnit(eligible, picked, selectedCarriers, relationCounts, fileCounts, familyCounts, caps);
    if (!next) break;
    const relation = frontierRelation(next);
    const item = publicFrontierItem(next, `C${items.length + 1}`, relation);
    const nextResponse = Buffer.byteLength(JSON.stringify([...items, item]), "utf8");
    if (readBytes + next.estimatedBytes > caps.maxBytes || nextResponse > caps.maxBytes) {
      hitByteCap = true;
      break;
    }
    items.push(item);
    picked.push(next);
    readBytes += next.estimatedBytes;
    responseBytes = nextResponse;
    relationCounts.set(relation, (relationCounts.get(relation) ?? 0) + 1);
    fileCounts.set(next.relativePath, (fileCounts.get(next.relativePath) ?? 0) + 1);
    const family = familyKey(next);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  return {
    items,
    deferredQueries,
    stopReason: stopReason(items.length, eligible.length, hitByteCap),
    coverage: coverageOf(items, responseBytes),
    caps
  };
}

function nextFrontierUnit(
  eligible: readonly ReadUnit[],
  picked: readonly ReadUnit[],
  selectedCarriers: readonly { file: ReadUnit["file"]; estimatedBytes: number }[],
  relationCounts: ReadonlyMap<ContinuationRelation, number>,
  fileCounts: ReadonlyMap<string, number>,
  familyCounts: ReadonlyMap<string, number>,
  caps: FrontierShadowReport["caps"]
): ReadUnit | undefined {
  const pickedPaths = new Set(picked.map(unit => unit.absolutePath));
  const selected = [
    ...selectedCarriers,
    ...picked.map(unit => ({ file: unit.file, estimatedBytes: unit.estimatedBytes }))
  ];
  const ranked = eligible
    .filter(unit => !pickedPaths.has(unit.absolutePath))
    .filter(unit => (fileCounts.get(unit.relativePath) ?? 0) < caps.maxPerFile)
    .filter(unit => (relationCounts.get(frontierRelation(unit)) ?? 0) < caps.maxPerRelation)
    .filter(unit => (familyCounts.get(familyKey(unit)) ?? 0) < caps.maxPerFamily)
    .map(unit => ({
      unit,
      utility: selectionUtility({ file: unit.file, estimatedBytes: unit.estimatedBytes }, selected),
      relation: frontierRelation(unit)
    }))
    .sort((left, right) =>
      right.utility - left.utility
      || RELATION_PRIORITY[left.relation] - RELATION_PRIORITY[right.relation]
      || left.unit.estimatedBytes - right.unit.estimatedBytes
      || left.unit.relativePath.localeCompare(right.unit.relativePath)
      || (left.unit.mergedRanges[0]?.startLine ?? 0) - (right.unit.mergedRanges[0]?.startLine ?? 0));
  return ranked[0]?.unit;
}

function familyKey(unit: ReadUnit): string {
  return unit.evidenceFamilies[0] ?? unit.relationClass;
}

function stopReason(itemCount: number, eligibleCount: number, hitByteCap: boolean): RetrievalStopReason {
  if (itemCount > 0) return "FRONTIER_AVAILABLE";
  if (hitByteCap) return "FRONTIER_BYTE_CAP";
  if (eligibleCount === 0) return "NO_FRONTIER";
  return "NO_HIGH_VALUE_FRONTIER";
}

function coverageOf(items: readonly FrontierItemV1[], responseBytes: number): FrontierShadowReport["coverage"] {
  const relationCounts: Record<string, number> = {};
  const familyCounts: Record<string, number> = {};
  for (const item of items) {
    relationCounts[item.relation] = (relationCounts[item.relation] ?? 0) + 1;
    const family = item.expectedEvidence[0] ?? item.relation;
    familyCounts[family] = (familyCounts[family] ?? 0) + 1;
  }
  return {
    itemCount: items.length,
    relationCounts,
    familyCounts,
    estimatedReadBytes: items.reduce((sum, item) => sum + item.estimatedReadBytes, 0),
    responseBytes,
    distinctRelations: Object.keys(relationCounts).length,
    distinctFamilies: Object.keys(familyCounts).length
  };
}
