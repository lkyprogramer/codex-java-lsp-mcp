// input: Ranked candidates, anchors, and raw pipeline metrics for an impact() call.
// output: ImpactResultV6 file/target entries and its self-referential cost object.
// pos: Task 31. Types live in agent-types.ts (the codebase's existing shared-type module);
//      this module holds the builder functions that turn internal shapes into the public V6 contract.
import type {
  CandidateFile,
  ImpactCostV6,
  ImpactFileV6,
  ImpactTargetV6,
  ImpactVerbosity,
  ResolvedAnchor
} from "../agent-types.js";
import { reconstructEstimatedTokens, tokensProxyFromBytes } from "./retrieval/cost-model.js";

/**
 * cost.resultBytes includes the cost object itself, so recompute until the
 * byte count stabilizes - the same fixed-point approach the v5 path already
 * used for metrics.outputBytes (tools/impact.ts, format.ts), relocated to
 * this contract's cost shape. Three attempts is the documented bound: a
 * result only needs more than one correction when a byte-count digit itself
 * changes width, which cannot cascade past the first correction here.
 */
export function withConvergedCostV6<T extends { cost: ImpactCostV6 }>(
  payload: T,
  readBytes: number,
  suppressedRawBytes: number
): T {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resultBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const estimatedTokens = reconstructEstimatedTokens(resultBytes, readBytes);
    const wireTokensProxy = tokensProxyFromBytes(resultBytes);
    const plannedSourceTokensProxy = tokensProxyFromBytes(readBytes);
    if (
      payload.cost.resultBytes === resultBytes
      && payload.cost.estimatedTokens === estimatedTokens
      && payload.cost.wireTokensProxy === wireTokensProxy
      && payload.cost.plannedSourceTokensProxy === plannedSourceTokensProxy
    ) {
      return payload;
    }
    payload.cost = {
      resultBytes,
      readBytes,
      estimatedTokens,
      suppressedRawBytes,
      wireTokensProxy,
      plannedSourceTokensProxy,
      tokenEstimator: "BYTE_DIV_4"
    };
  }
  return payload;
}

const FRAMEWORK_KIND = /^(?:SPRING|MYBATIS|MAPSTRUCT)_/;

/**
 * One precedence list over `CandidateFile.reasons`' kind-string vocabulary
 * (not `categories`: categories collapses EXACT_SEMANTIC and STATIC_STRUCTURE
 * onto the single string "semantic", which would make a resolved CALLS edge
 * indistinguishable from a same-package type reference - exactly the
 * distinction `role` exists to convey). First matching bucket wins, highest
 * confidence first. `role` is deliberately a small, generic, extensible
 * string (architecture doc §15.3 leaves it unconstrained) - this is the
 * default taxonomy this router happens to produce, not a closed enum.
 */
const ROLE_PRECEDENCE: ReadonlyArray<{ role: string; kinds: ReadonlySet<string> }> = [
  { role: "target", kinds: new Set(["target", "anchor"]) },
  { role: "collaborator", kinds: new Set(["CALLS", "METHOD_RELATION"]) },
  { role: "implementation", kinds: new Set(["TYPE_SYMMETRIC", "IMPLEMENTS", "TYPE_RELATION"]) },
  {
    role: "reference", kinds: new Set([
      "typeGraph", "importGraph", "reference", "typeReference", "typeHierarchy",
      "semantic-definition", "semantic-implementation", "EXACT_SEMANTIC", "STATIC_STRUCTURE",
      "AST_EXACT", "AST_RESOLVED", "JDT_EXACT", "PERSISTED_JDT", "REFERENCE", "EXPLICIT_IMPORT",
      "QUALIFIED", "WILDCARD_IMPORT", "DIRECT_DECLARATION", "FIELD_TYPE", "ENCLOSING_TYPE",
      "IMPORTED_BY", "KIND_PAIRING", "PACKAGE_PROXIMITY", "SAME_PACKAGE", "ANNOTATION_COLLABORATION",
      "IMPLEMENTATION_METHOD_TYPE", "METHOD_INVOCATION", "JAVA_LANG"
    ])
  },
  { role: "config", kinds: new Set(["SUPPORT_FILE", "config"]) }
];

export function roleOf(reasons: readonly string[]): string {
  if (reasons.some(reason => FRAMEWORK_KIND.test(reason))) {
    return "framework";
  }
  for (const bucket of ROLE_PRECEDENCE) {
    if (reasons.some(reason => bucket.kinds.has(reason))) {
      return bucket.role;
    }
  }
  return "related";
}

/**
 * Generic per-kind phrases, not per-target ("implements PaymentGateway"):
 * the candidate data available here (kind strings) does not carry a
 * specific class/method name without parsing an internal id format
 * (`plannerEvidence.sourceTarget`) that is not meant for this purpose and
 * risks a wrong extraction being presented as fact. A deliberate
 * simplification, same class as Task 26's representative-position choice.
 */
const EVIDENCE_PHRASES: Readonly<Record<string, string>> = {
  CALLS: "calls or is called by the anchor",
  METHOD_RELATION: "direct parameter/return relationship with the anchor",
  TYPE_SYMMETRIC: "implements/extends a type related to the anchor",
  IMPLEMENTS: "implements a type related to the anchor",
  TYPE_RELATION: "structurally related type",
  DIRECT_DECLARATION: "declared directly on the anchor's type",
  FIELD_TYPE: "field type relationship",
  ENCLOSING_TYPE: "encloses the anchor's type",
  IMPORTED_BY: "imported by a related file",
  KIND_PAIRING: "same-kind pairing with the anchor",
  PACKAGE_PROXIMITY: "same package as the anchor",
  SAME_PACKAGE: "same package as the anchor",
  ANNOTATION_COLLABORATION: "shares an annotation-driven relationship",
  IMPLEMENTATION_METHOD_TYPE: "implementation method type match",
  METHOD_INVOCATION: "method invocation relationship",
  REFERENCE: "JDT reference verified",
  AST_EXACT: "exact AST-resolved reference",
  AST_RESOLVED: "AST-resolved reference",
  JDT_EXACT: "JDT reference verified",
  PERSISTED_JDT: "previously verified JDT reference",
  EXACT_SEMANTIC: "JDT reference verified",
  STATIC_STRUCTURE: "static structural reference",
  EXPLICIT_IMPORT: "explicitly imported",
  QUALIFIED: "qualified reference",
  WILDCARD_IMPORT: "wildcard-imported",
  JAVA_LANG: "java.lang type",
  TASK_KEYWORD: "name/task match",
  FOCUS_MODULE: "in a focused module",
  SUPPORT_FILE: "supporting config/resource file",
  SPRING_INJECTION: "Spring constructor/field injection",
  SPRING_CALL_PATH: "Spring-resolved call path",
  SPRING_REQUEST_BODY: "Spring @RequestBody type",
  SPRING_RESPONSE_TYPE: "Spring response type",
  SPRING_PUBLISHES_EVENT: "publishes a Spring event",
  SPRING_CONSUMES_EVENT: "consumes a Spring event",
  SPRING_EVENT_LISTENER: "Spring event listener",
  SPRING_BEAN_PRODUCES: "produces a Spring bean",
  SPRING_BEAN_DEPENDS_ON: "Spring bean dependency",
  SPRING_BOOT_APPLICATION: "Spring Boot application wiring",
  MYBATIS_NAMESPACE: "MyBatis mapper namespace",
  MYBATIS_STATEMENT_METHOD: "MyBatis statement binding",
  MYBATIS_PARAMETER_TYPE: "MyBatis statement parameter type",
  MYBATIS_RESULT_TYPE: "MyBatis statement result type",
  MYBATIS_RESULT_MAP: "MyBatis resultMap",
  MAPSTRUCT_SOURCE: "MapStruct mapping source type",
  MAPSTRUCT_TARGET: "MapStruct mapping target type",
  MAPSTRUCT_USES: "MapStruct @Mapper(uses=...) dependency",
  target: "anchor file",
  anchor: "anchor file",
  typeGraph: "resolved type graph edge",
  importGraph: "import graph edge",
  reference: "JDT reference verified",
  typeReference: "type reference match",
  typeHierarchy: "type hierarchy relationship",
  "semantic-definition": "JDT definition verified",
  "semantic-implementation": "JDT implementation verified",
  config: "supporting config/resource file",
  naming: "name/task match"
};

const MAX_EVIDENCE_PHRASES = 4;

export function evidencePhrasesFor(reasons: readonly string[]): string[] {
  const phrases: string[] = [];
  for (const reason of reasons) {
    const phrase = EVIDENCE_PHRASES[reason] ?? (reason.startsWith("rg:") ? "name/task match" : humanize(reason));
    if (!phrases.includes(phrase)) {
      phrases.push(phrase);
    }
    if (phrases.length >= MAX_EVIDENCE_PHRASES) {
      break;
    }
  }
  return phrases;
}

function humanize(kind: string): string {
  return `${kind.replace(/_/g, " ").toLowerCase()} evidence`;
}

export function buildImpactFileV6(file: CandidateFile, id: string, verbosity: ImpactVerbosity): ImpactFileV6 {
  const reasons = file.reasons;
  const base: ImpactFileV6 = {
    id,
    path: file.path || file.absolutePath,
    role: roleOf(reasons),
    // Mirrors the pre-V6 default in format.ts's formatCandidate: a candidate
    // with no explicit confidence reads as medium, not as a missing field.
    confidence: file.confidence ?? "medium",
    evidence: evidencePhrasesFor(reasons),
    locations: file.positions.slice(0, 3).map(position => ({ line: position.line, column: position.column }))
  };
  if (verbosity !== "diagnostic") {
    return base;
  }
  return {
    ...base,
    reasons,
    verifiedBy: file.verifiedBy ?? [],
    scoreBreakdown: file.scoreBreakdown
  };
}

export function buildImpactTargetV6(anchor: ResolvedAnchor): ImpactTargetV6 {
  return {
    file: anchor.path || anchor.absolutePath,
    symbol: anchor.symbolName,
    type: anchor.className,
    method: anchor.methodName,
    profile: anchor.profile,
    range: {
      start: { line: anchor.line, column: anchor.column },
      end: { line: anchor.line, column: anchor.column }
    }
  };
}
