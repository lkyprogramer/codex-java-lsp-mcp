// input: Relationship workload needs/limits and worker bundle payload.
// output: Shared QUERY_RELATIONSHIP_BUNDLE types, flag, and identity helpers.
// pos: V5R Phase 1. Worker payload stays compact store types; router maps to facts.
import { MAX_FACTS_FOR_FILES } from "./router-facts.js";
import type {
  IndexedReadRangeResult,
  IndexedReference,
  JavaFileBundle,
  JavaTypeFacts,
  JavaTypeLookupResult
} from "./index-types.js";
import type { FactsForFileItem } from "./router-facts.js";

export const JAVA_LSP_RELATIONSHIP_BUNDLE = "JAVA_LSP_RELATIONSHIP_BUNDLE";

export const MAX_RELATIONSHIP_BUNDLE_ANCHORS = 8;
export const DEFAULT_RELATIONSHIP_BUNDLE_LIMITS = {
  maxCandidateFiles: MAX_FACTS_FOR_FILES,
  maxDefinitions: 12,
  maxCallees: 16,
  maxImplementations: 32
} as const;

export type RelationshipBundleMode = "off" | "shadow" | "on";

export type RelationshipBundleNeeds = {
  anchorFacts: boolean;
  candidateFacts: boolean;
  directCallees: boolean;
  implementationOverrides: boolean;
  signatureDefinitions: boolean;
  frameworkFacts: boolean;
  readRanges: boolean;
};

export type RelationshipBundleLimits = {
  maxCandidateFiles: number;
  maxDefinitions: number;
  maxCallees: number;
  maxImplementations: number;
};

export type RelationshipBundleAnchorInput = {
  anchorId: string;
  file: string;
  line: number;
  column: number;
  methodId?: string;
};

export type RelationshipBundleRequest = {
  generation: number;
  anchors: RelationshipBundleAnchorInput[];
  candidateFiles: string[];
  needs: RelationshipBundleNeeds;
  limits: RelationshipBundleLimits;
};

export type RelationshipBundleAnchorResult = {
  anchorId: string;
  methodId?: string;
  ownerTypeId?: string;
  directCalls: IndexedReference[];
  implementations: JavaTypeFacts[];
  signatureLookups: JavaTypeLookupResult[];
  calleeTruncated: boolean;
};

export type RelationshipBundleWorkerValue = {
  generation: number;
  indexedGeneration: number;
  stale: boolean;
  completion: "COMPLETE" | "PARTIAL" | "DEGRADED";
  truncated: boolean;
  anchors: RelationshipBundleAnchorResult[];
  files: JavaFileBundle[];
  readRanges?: IndexedReadRangeResult[];
  metrics: {
    parsedFiles: number;
    hydratedFiles: number;
    cacheHits: number;
    queryCount: number;
  };
};

export type RelationshipBundleView = {
  generation: number;
  completion: "COMPLETE" | "PARTIAL" | "DEGRADED";
  stale: boolean;
  truncated: boolean;
  items: FactsForFileItem[];
  anchors: Array<{
    anchorId: string;
    methodId?: string;
    ownerTypeId?: string;
    calleeTargetIds: string[];
    calleeTruncated: boolean;
    implementationTypeIds: string[];
    signatureTypeIds: string[];
  }>;
  metrics: RelationshipBundleWorkerValue["metrics"];
};

export type RelationshipBundleIdentity = {
  files: string[];
  calleeTargetIds: string[];
  implementationTypeIds: string[];
  signatureTypeIds: string[];
};

export const ALL_RELATIONSHIP_BUNDLE_NEEDS: RelationshipBundleNeeds = {
  anchorFacts: true,
  candidateFacts: true,
  directCallees: true,
  implementationOverrides: true,
  signatureDefinitions: true,
  frameworkFacts: true,
  readRanges: false
};

export function relationshipBundleMode(env: NodeJS.ProcessEnv = process.env): RelationshipBundleMode {
  const raw = env[JAVA_LSP_RELATIONSHIP_BUNDLE];
  if (raw === "1" || raw === "on") return "on";
  if (raw === "shadow") return "shadow";
  return "off";
}

export function clampRelationshipBundleLimits(limits: RelationshipBundleLimits): RelationshipBundleLimits {
  return {
    maxCandidateFiles: clampLimit(limits.maxCandidateFiles, DEFAULT_RELATIONSHIP_BUNDLE_LIMITS.maxCandidateFiles),
    maxDefinitions: clampLimit(limits.maxDefinitions, DEFAULT_RELATIONSHIP_BUNDLE_LIMITS.maxDefinitions),
    maxCallees: clampLimit(limits.maxCallees, DEFAULT_RELATIONSHIP_BUNDLE_LIMITS.maxCallees),
    maxImplementations: clampLimit(limits.maxImplementations, DEFAULT_RELATIONSHIP_BUNDLE_LIMITS.maxImplementations)
  };
}

export function relationshipBundleIdentity(view: RelationshipBundleView): RelationshipBundleIdentity {
  return {
    files: uniqueSorted(view.items.filter(item => item.state === "FOUND").map(item => item.absolutePath)),
    calleeTargetIds: uniqueSorted(view.anchors.flatMap(anchor => anchor.calleeTargetIds)),
    implementationTypeIds: uniqueSorted(view.anchors.flatMap(anchor => anchor.implementationTypeIds)),
    signatureTypeIds: uniqueSorted(view.anchors.flatMap(anchor => anchor.signatureTypeIds))
  };
}

function clampLimit(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 1) return max;
  return Math.min(Math.floor(value), max);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
