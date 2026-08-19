// input: Materialized indexed windows plus request options.
// output: ReadUnits whose mergedRanges equal the indexed window order.
// pos: V5R Phase 2 context closure is a classification of existing ranges, not new golden cuts.
import type { ImpactOptions, ReadPriority, ReadRange } from "../../agent-types.js";
import { evidenceKeys, familyKeys } from "./evidence-features.js";
import type {
  ContinuationRelation,
  MaterializedReadWindow,
  ReadUnit
} from "./retrieval-types.js";
import { protectedSelectionUtility } from "./selection-utility.js";

export function buildReadUnits(input: {
  readonly windows: readonly MaterializedReadWindow[];
  readonly ids: ReadonlyMap<string, string>;
  readonly options: ImpactOptions;
  readonly priorityOf: (file: ReadUnit["file"], options: ImpactOptions) => ReadPriority;
}): ReadUnit[] {
  return input.windows.map(window => readUnitFromWindow(window, input.ids, input.options, input.priorityOf));
}

export function windowsFromReadUnits(units: readonly ReadUnit[]): MaterializedReadWindow[] {
  return units.map(unit => ({
    file: unit.file,
    ranges: unit.mergedRanges,
    coordinateRanges: unit.coordinateRanges,
    bytes: unit.estimatedBytes,
    extremeMethod: unit.extremeMethod,
    rangeKinds: unit.mergedRanges.map(range => rangeKindFromReason(range.reason))
  }));
}

export function closeContextRanges(ranges: readonly ReadRange[], kinds: readonly string[]): {
  primaryRanges: ReadRange[];
  contextRanges: ReadRange[];
  mergedRanges: ReadRange[];
} {
  const primaryRanges: ReadRange[] = [];
  const contextRanges: ReadRange[] = [];
  ranges.forEach((range, index) => {
    if (isPrimaryRange(kinds[index] ?? rangeKindFromReason(range.reason), ranges.length)) {
      primaryRanges.push(range);
    } else {
      contextRanges.push(range);
    }
  });
  return { primaryRanges, contextRanges, mergedRanges: [...ranges] };
}

function readUnitFromWindow(
  window: MaterializedReadWindow,
  ids: ReadonlyMap<string, string>,
  options: ImpactOptions,
  priorityOf: (file: ReadUnit["file"], options: ImpactOptions) => ReadPriority
): ReadUnit {
  const closed = closeContextRanges(window.ranges, window.rangeKinds);
  const relativePath = window.file.path || relativeFromAbsolute(window.file.absolutePath);
  const hop = hopOf(window, options);
  const relationClass = relationClassOf(window, options, hop);
  const unitBase = {
    file: window.file,
    estimatedBytes: window.bytes
  };
  return {
    id: `ru:${relativePath}`,
    absolutePath: window.file.absolutePath,
    relativePath,
    fileId: ids.get(window.file.absolutePath) || "F?",
    ...closed,
    coordinateRanges: window.coordinateRanges,
    estimatedBytes: window.bytes,
    extremeMethod: window.extremeMethod,
    priority: priorityOf(window.file, options),
    confidence: window.file.confidence ?? "medium",
    evidenceKeys: evidenceKeys(window.file),
    evidenceFamilies: [...familyKeys(window.file)],
    plannerEvidence: window.file.plannerEvidence ?? [],
    module: window.file.module,
    layer: window.file.layer,
    sourceSet: window.file.sourceSet,
    relationClass,
    hop,
    utility: protectedSelectionUtility(unitBase),
    file: window.file
  };
}

function isPrimaryRange(kind: string, rangeCount: number): boolean {
  if (kind === "method" || kind === "xml-statement") return true;
  if (kind === "type" || kind === "xml-resultMap") return false;
  return rangeCount === 1;
}

function rangeKindFromReason(reason: string | undefined): string {
  if (reason?.includes("method range")) return "method";
  if (reason?.includes("type header")) return "type";
  if (reason?.includes("XML statement")) return "xml-statement";
  if (reason?.includes("XML resultMap")) return "xml-resultMap";
  return "fallback";
}

function hopOf(window: MaterializedReadWindow, options: ImpactOptions): ReadUnit["hop"] {
  if (window.file.reasons.includes("target")
    || options.anchors.some(anchor => anchor.file === window.file.absolutePath || anchor.file === window.file.path)) {
    return 0;
  }
  const calls = window.file.plannerEvidence?.filter(evidence => evidence.kind === "CALLS") ?? [];
  if (calls.some(evidence => (evidence.callOrigin === "anchor" || evidence.callOrigin === undefined) && (evidence.callDepth ?? 0) === 0)) {
    return 1;
  }
  if (calls.some(evidence => evidence.callDepth === 1 || evidence.callOrigin === "helper" || evidence.callOrigin === "implementation")) {
    return 2;
  }
  return "unknown";
}

function relationClassOf(
  window: MaterializedReadWindow,
  options: ImpactOptions,
  hop: ReadUnit["hop"]
): ContinuationRelation {
  if (hop === 0) return "FIRST_CALL_ANCHOR";
  const kinds = new Set([
    ...window.file.reasons,
    ...(window.file.verifiedBy || []),
    ...(window.file.plannerEvidence?.map(evidence => evidence.kind) ?? [])
  ]);
  if (window.file.sourceSet === "test") return "TEST_VERIFICATION";
  if ([...kinds].some(kind => kind === "CALLS")) return "SECOND_HOP_EXACT";
  if ([...kinds].some(kind => kind === "METHOD_RELATION")) return "SIGNATURE_COLLABORATOR";
  if ([...kinds].some(kind => kind === "IMPLEMENTS" || kind === "IMPLEMENTATION" || kind === "TYPE_RELATION" || kind === "TYPE_SYMMETRIC")) {
    return "CLOSED_PORT_IMPLEMENTATION";
  }
  if ([...kinds].some(kind => kind.startsWith("SPRING_") || kind.startsWith("MYBATIS_") || kind.startsWith("MAPSTRUCT_"))) {
    return "FRAMEWORK_SUPPORT";
  }
  if (kinds.has("typeReference") || kinds.has("importGraph")) return "CROSS_MODULE_ALTERNATIVE";
  return hop === 1 || hop === 2 ? "FIRST_CALL_CORE" : "CROSS_MODULE_ALTERNATIVE";
}

function relativeFromAbsolute(absolutePath: string): string {
  const marker = "/src/";
  const index = absolutePath.lastIndexOf(marker);
  if (index >= 0) return absolutePath.slice(index + 1);
  return absolutePath.replace(/^.*\//, "");
}
