import type { SourceRange } from "../runtime/source-range.js";
export type { SourcePosition, SourceRange } from "../runtime/source-range.js";

export type JavaSourceSet = "main" | "test" | "generated" | "unknown";
export type JavaParseState = "COMPLETE" | "RECOVERED" | "FAILED";
export type JavaTypeKind = "class" | "interface" | "record" | "enum" | "annotation";

export type JavaImportFact = {
  qualifiedName: string;
  wildcard: boolean;
  static: boolean;
  range: SourceRange;
};

export type JavaAnnotationFact = {
  name: string;
  qualifiedName?: string;
  argumentsText?: string;
  range: SourceRange;
};

export type TypeResolutionStrategy =
  | "QUALIFIED"
  | "EXPLICIT_IMPORT"
  | "ENCLOSING_TYPE"
  | "SAME_PACKAGE"
  | "JAVA_LANG"
  | "WILDCARD_IMPORT"
  | "REPO_UNIQUE_SIMPLE_NAME";

export type JavaTypeRef = {
  text: string;
  simpleName: string;
  qualifiedName?: string;
  typeArguments: JavaTypeRef[];
  arrayDepth: number;
  wildcard?: "extends" | "super" | "unbounded";
  resolution:
    | { state: "RESOLVED_REPO"; typeId: string; strategy: TypeResolutionStrategy }
    | { state: "EXTERNAL"; qualifiedName: string; strategy: "QUALIFIED" | "EXPLICIT_IMPORT" | "JAVA_LANG" }
    | { state: "TYPE_VARIABLE"; name: string }
    | { state: "AMBIGUOUS"; candidates: string[] }
    | { state: "UNRESOLVED" };
  range?: SourceRange;
};

export type JavaTypeParameterFact = {
  name: string;
  bounds: JavaTypeRef[];
  range: SourceRange;
};

export type JavaCallSiteKind =
  | "METHOD_INVOCATION"
  | "CONSTRUCTOR_INVOCATION"
  | "METHOD_REFERENCE";

export type JavaCallSiteFact = {
  kind: JavaCallSiteKind;
  name: string;
  receiverText?: string;
  receiverDeclaredType?: JavaTypeRef;
  arity: number;
  /**
   * One entry per argument, aligned by index with the call's actual argument
   * list (`argumentTypeHints.length === arity`). An argument whose type
   * cannot be determined from local syntax (anything but a direct
   * `new T(...)` or an identifier already in scope as a parameter/field/
   * local variable) gets an UNRESOLVED placeholder rather than an omitted
   * slot, so callers can index into this array without losing alignment.
   */
  argumentTypeHints: JavaTypeRef[];
  range: SourceRange;
};

export type JavaFieldFacts = {
  fieldId: string;
  ownerTypeId: string;
  name: string;
  type: JavaTypeRef;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  range: SourceRange;
};

export type JavaMethodFacts = {
  methodId: string;
  ownerTypeId: string;
  name: string;
  constructor: boolean;
  signatureKey: string;
  range: SourceRange;
  bodyRange?: SourceRange;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  typeParameters: JavaTypeParameterFact[];
  returnType?: JavaTypeRef;
  parameters: Array<{ name: string; type: JavaTypeRef; varargs: boolean; annotations: JavaAnnotationFact[]; range: SourceRange }>;
  throws: JavaTypeRef[];
  callSites: JavaCallSiteFact[];
  localTypes: JavaTypeRef[];
};

export type JavaTypeFacts = {
  typeId: string;
  fqn?: string;
  simpleName: string;
  kind: JavaTypeKind;
  fileId: string;
  enclosingTypeId?: string;
  range: SourceRange;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  typeParameters: JavaTypeParameterFact[];
  extends: JavaTypeRef[];
  implements: JavaTypeRef[];
  permits: JavaTypeRef[];
  fieldIds: string[];
  methodIds: string[];
  confidence: number;
};

export type JavaFileFacts = {
  fileId: string;
  relativePath: string;
  sourceRoot: string;
  module: string;
  sourceSet: JavaSourceSet;
  packageName: string;
  imports: JavaImportFact[];
  topLevelTypeIds: string[];
  allTypeIds: string[];
  contentHash: string;
  size: number;
  mtimeMs: number;
  /** Filesystem change time persisted for metadata-only own-snapshot validation. */
  ctimeMs?: number;
  parseState: JavaParseState;
  parseErrorCount: number;
  generation: number;
};

export type StaticEdgeResolutionKind =
  | "AST_EXPLICIT"
  | "TYPE_REFERENCE"
  | "SAME_OWNER_NAME_ARITY"
  | "DECLARED_RECEIVER_NAME_ARITY"
  | "SUPER_CHAIN_NAME_ARITY"
  | "CONSTRUCTOR_TYPE"
  | "METHOD_REFERENCE_OWNER";

export type StaticEdgeKind =
  | "DECLARES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "PERMITS"
  | "IMPORTS"
  | "FIELD_TYPE"
  | "PARAM_TYPE"
  | "RETURN_TYPE"
  | "THROWS_TYPE"
  | "LOCAL_TYPE"
  | "CALLS"
  | "CONSTRUCTS"
  | "METHOD_REFERENCE"
  | "ANNOTATED_WITH";

export type StaticEdge = {
  edgeId: string;
  fromId: string;
  toId: string;
  kind: StaticEdgeKind;
  confidence: number;
  range?: SourceRange;
  sourceFile: string;
  generation: number;
  resolution: {
    kind: StaticEdgeResolutionKind;
    typeStrategy?: TypeResolutionStrategy;
  };
};

export type SourceRootCoverage = {
  root: string;
  generation: number;
  state: "UNKNOWN" | "BUILDING" | "COMPLETE" | "DEGRADED";
  discoveredFiles: number;
  indexedFiles: number;
  failedFiles: number;
  recoveredFiles: number;
  extractorVersion: string;
  completedAt?: string;
};

/** Per-resource-root MyBatis coverage, independent from Java source coverage. */
export type MyBatisResourceCoverage = {
  root: string;
  generation: number;
  state: "UNKNOWN" | "BUILDING" | "COMPLETE" | "DEGRADED";
  discoveredFiles: number;
  indexedFiles: number;
  failedFiles: number;
};

/** Task 21a diagnostic summary of the OPEN-time sibling-worktree seed attempt, if any. */
export type WorktreeSeedStatus = {
  attempted: boolean;
  sourceRepoHash?: string;
  reusedFiles: number;
  dirtyFiles: number;
  relinkFiles: number;
  droppedCrossFileEdges: number;
  droppedFrameworkEdges: number;
  manifestValidationMs: number;
  /** Files actually passed through the target's post-seed reconciliation sweep. */
  deltaParsedFiles: number;
  /** Task 28 Slice C: MyBatis resources reused (content-hash matched) vs. left for the normal post-seed sweep to re-derive. */
  reusedResources: number;
  dirtyResources: number;
  /** How many sibling cache directories findCandidate() scanned, regardless of eligibility (V3.2-19). */
  cacheDirsScanned: number;
  /** Of those scanned, how many held a snapshot that passed every eligibility check (V3.2-19). */
  eligibleSnapshots: number;
  fingerprintMatched?: boolean;
  metaMissing?: number;
  selfSkip?: number;
  familyMismatch?: number;
  identityMismatch?: number;
  coverageIncomplete?: number;
  /** Decompress, pre-load scan, and publication-boundary re-scan phase timings (V3.2-19). */
  candidateDecompressMs: number;
  initialManifestScanMs: number;
  finalManifestScanMs: number;
  completion: "NOT_ATTEMPTED" | "SEEDED_DEGRADED" | "RECONCILED_COMPLETE" | "NO_VALID_SOURCE" | "FAILED";
};

/** Observable publication state for the rebuildable JavaIndex snapshot. */
export type JavaIndexSnapshotStatus =
  | { state: "EMPTY" }
  | {
      state: "PENDING";
      durableGeneration?: number;
      durableManifestFingerprint?: string;
    }
  | {
      state: "DURABLE";
      durableGeneration: number;
      durableManifestFingerprint: string;
    }
  | {
      state: "FAILED";
      durableGeneration?: number;
      durableManifestFingerprint?: string;
      failure: "MANIFEST_CHANGED" | "WRITE_FAILED";
    };

export type JavaIndexStatus = {
  state: "NEW" | "OPENING" | "READY" | "DEGRADED" | "CLOSED";
  indexedGeneration: number;
  files: number;
  types: number;
  methods: number;
  edges: number;
  snapshotBytes: number;
  /** Optional for compatibility with older workers; new workers always publish it. */
  snapshot?: JavaIndexSnapshotStatus;
  pendingForeground: number;
  pendingBackground: number;
  /** Own-snapshot manifest validation still running after OPEN returned. */
  snapshotVerificationPending?: boolean;
  coverage: SourceRootCoverage[];
  resourceCoverage: MyBatisResourceCoverage[];
  lastError?: string;
  worktreeSeed?: WorktreeSeedStatus;
  /** Worker has unloaded facts/parse trees; next fact query reheats from v4. */
  hibernated?: boolean;
  /** Rest-segment facts are in the store. Absent on older workers. */
  factsHydrated?: boolean;
  /** Worker-local heapUsed, published on HIBERNATE (S4). */
  heapUsedBytes?: number;
  /** FSX0/FSX2: process heap plus family-store counts. Absent on older workers. */
  heapSplit?: JavaIndexHeapSplit;
};

export type JavaIndexHeapSplit = {
  heapUsedMb: number;
  rssMb: number;
  poolBundles: number;
  familyRootCount: number;
  thisRootFiles: number;
  thisRootOverlayFiles: number;
  graphSynced: boolean;
  /** FSY2 byte ledger. Absent on older workers. */
  donorStoreBytes?: number;
  overlayBytes?: number;
  graphBytes?: number;
  parseTreeCacheBytes?: number;
  otherBytes?: number;
};

export type JavaTypeLookupResult =
  | { state: "RESOLVED"; type: JavaTypeFacts }
  | { state: "AMBIGUOUS"; candidates: JavaTypeFacts[] }
  | { state: "UNRESOLVED"; coverage: "COMPLETE" | "PARTIAL" | "DEGRADED" };

export type JavaFileBundle = {
  file: JavaFileFacts;
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
  edges: StaticEdge[];
};

export type AnchorFacts = {
  file: JavaFileFacts;
  symbolId: string;
  symbolKind: "TYPE" | "METHOD" | "CONSTRUCTOR" | "FIELD" | "FILE";
  symbolName: string;
  range: SourceRange;
  type?: JavaTypeFacts;
  method?: JavaMethodFacts;
  field?: JavaFieldFacts;
  coverage: SourceRootCoverage["state"];
  confidence: number;
};

export type IndexedReference = {
  sourceId: string;
  targetId: string;
  sourceFile: string;
  sourceModule: string;
  sourceSet: JavaSourceSet;
  kind: StaticEdgeKind;
  confidence: number;
  range?: SourceRange;
  generation: number;
};

/** A worker-computed source window with bytes counted from the exact UTF-8 source slice. */
export type IndexedReadRange = {
  startLine: number;
  endLine: number;
  /** Exact source slice read by the worker: 1-based UTF-16, end-exclusive. */
  range: SourceRange;
  kind: "method" | "type" | "xml-statement" | "xml-resultMap" | "fallback";
  /** Every source-window kind merged into this range, retained for planner reason fidelity. */
  kinds?: Array<"method" | "type" | "xml-statement" | "xml-resultMap" | "fallback">;
  estimatedBytes: number;
};

export type IndexedReadRangeResult = {
  file: string;
  ranges: IndexedReadRange[];
  /** An extreme method is represented by bounded first/last windows instead of a broken body fragment. */
  extremeMethod?: boolean;
};
