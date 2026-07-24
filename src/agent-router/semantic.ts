import { classifyPath } from "../repo-layout.js";
import { normalizeRepoLocation } from "../semantic-location.js";
import { classifySemanticError, isExpectedSemanticOutcome } from "../runtime/intelligence-error.js";
import type { EdgeStore, SemanticEdgeInput } from "../edge-store.js";
import type { JdtlsSession, LspLocation, LspLocationLink } from "../jdtls-session.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { CandidateFile, ImpactMode, ImpactOptions, ResolvedAnchor, SemanticPolicy } from "../agent-types.js";
import { breakdown, mergeCandidate, scoreBase } from "./candidate-helpers.js";

type SemanticSuppressed = {
  /** Locations JDT returned that resolve outside this repository. */
  externalLocations: number;
};

type SemanticSeedState = {
  used: boolean;
  skipped: boolean;
  timeout: boolean;
  errorCode?: string;
  externalLocationsSuppressed: number;
};

type SemanticVerifyState = {
  used: boolean;
  verifyUsed: boolean;
  verifySkipped: boolean;
  timeout: boolean;
  errorCode?: string;
  externalLocationsSuppressed: number;
};

type SemanticInput = {
  readonly candidates: Map<string, CandidateFile>;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly phaseMs: Record<string, number>;
  readonly repoRoot: string;
  readonly session: JdtlsSession;
  readonly routingPolicy: RoutingPolicy;
};

type SemanticSeedInput = SemanticInput & {
  readonly semantic: SemanticSeedState;
};

type SemanticVerifyInput = SemanticInput & {
  readonly semantic: SemanticVerifyState;
  readonly edgeStore: EdgeStore;
};

type LocationCandidateInput = {
  readonly location: LspLocation | LspLocationLink;
  readonly reason: string;
  readonly anchor: ResolvedAnchor;
  readonly options: ImpactOptions;
  readonly repoRoot: string;
  readonly routingPolicy: RoutingPolicy;
  readonly suppressed: SemanticSuppressed;
};

export async function collectSemanticSeed(input: SemanticSeedInput): Promise<void> {
  if (!shouldUseSemantic(input.options.semanticPolicy, input.options.mode, input.anchors)) {
    input.semantic.skipped = true;
    return;
  }
  input.semantic.used = true;
  const suppressed: SemanticSuppressed = { externalLocations: 0 };
  await timed(input.phaseMs, "semantic", async () => {
    for (const anchor of input.anchors) {
      const before = Date.now();
      try {
        const context = await input.session.semanticLocations(anchor.absolutePath, anchor.line, anchor.column, input.options.semanticTimeoutMs, shouldIncludeImplementations(anchor));
        input.semantic.timeout ||= Date.now() - before >= input.options.semanticTimeoutMs;
        for (const location of [...context.definitions, ...context.implementations]) {
          const described = locationCandidate({
            location,
            reason: context.implementations.includes(location) ? "implementation" : "definition",
            anchor,
            options: input.options,
            repoRoot: input.repoRoot,
            routingPolicy: input.routingPolicy,
            suppressed
          });
          if (described) {
            mergeCandidate(input.candidates, described);
          }
        }
      } catch (error) {
        // Semantic evidence is an enhancement. A backed-off, misconfigured or
        // still-starting JDT must degrade this stage, not fail the request.
        recordSemanticFailure(input.semantic, error);
      }
    }
  });
  input.semantic.externalLocationsSuppressed += suppressed.externalLocations;
}

function recordSemanticFailure(
  state: { timeout: boolean; errorCode?: string },
  error: unknown
): void {
  const classified = classifySemanticError(error);
  state.errorCode = classified.code;
  state.timeout ||= classified.code === "DEADLINE_EXCEEDED";
  if (!isExpectedSemanticOutcome(classified.code)) {
    console.error(`[codex-java-lsp] semantic stage failed code=${classified.code} ${classified.message}`);
  }
}

export async function semanticVerify(input: SemanticVerifyInput): Promise<void> {
  if (!shouldUseSemanticVerify(input.options, input.semantic, input.session)) {
    input.semantic.verifySkipped = true;
    return;
  }
  input.semantic.verifyUsed = true;
  const suppressed: SemanticSuppressed = { externalLocations: 0 };
  await timed(input.phaseMs, "semanticVerify", async () => {
    for (const anchor of input.anchors) {
      const before = Date.now();
      const verifiedEdges: SemanticEdgeInput[] = [];
      try {
        const references = await input.session.references(anchor.absolutePath, anchor.line, anchor.column, false, input.options.semanticTimeoutMs);
        input.semantic.timeout ||= Date.now() - before >= input.options.semanticTimeoutMs;
        for (const location of references.items.slice(0, 40)) {
          const candidate = locationCandidate({ location, reason: "reference", anchor, options: input.options, repoRoot: input.repoRoot, routingPolicy: input.routingPolicy, suppressed });
          if (candidate) {
            candidate.confidence = "high";
            candidate.verifiedBy = ["reference"];
            mergeCandidate(input.candidates, candidate);
            if (candidate.absolutePath !== anchor.absolutePath) {
              verifiedEdges.push({
                to: candidate.absolutePath,
                kind: "reference",
                line: candidate.positions[0]?.line || 1,
                column: candidate.positions[0]?.column || 1
              });
            }
          }
        }
        if (shouldUseTypeHierarchyVerify(anchor, input.options)) {
          const hierarchy = await input.session.typeHierarchy(anchor.absolutePath, anchor.line, anchor.column, "subtypes", 2, 40);
          for (const edge of hierarchy.edges.slice(0, 40)) {
            const location = hierarchyItemLocation(edge.from);
            const candidate = location ? locationCandidate({ location, reason: "typeHierarchy", anchor, options: input.options, repoRoot: input.repoRoot, routingPolicy: input.routingPolicy, suppressed }) : undefined;
            if (candidate) {
              candidate.confidence = "high";
              candidate.verifiedBy = ["typeHierarchy"];
              mergeCandidate(input.candidates, candidate);
              if (candidate.absolutePath !== anchor.absolutePath) {
                verifiedEdges.push({
                  to: candidate.absolutePath,
                  kind: "typeHierarchy",
                  line: candidate.positions[0]?.line || 1,
                  column: candidate.positions[0]?.column || 1
                });
              }
            }
          }
        }
      } catch (error) {
        recordSemanticFailure(input.semantic, error);
      }
      if (verifiedEdges.length > 0) {
        try {
          input.edgeStore.recordEdges(anchor.absolutePath, verifiedEdges);
        } catch {
          continue;
        }
      }
    }
  });
  input.semantic.externalLocationsSuppressed += suppressed.externalLocations;
}

function shouldUseSemantic(policy: SemanticPolicy, mode: ImpactMode, anchors: readonly ResolvedAnchor[]): boolean {
  if (policy === "fast") {
    return false;
  }
  if (policy === "required" || mode === "precision" || mode === "recall") {
    return true;
  }
  return anchors.some(anchor => anchor.profile === "service");
}

function shouldUseTypeHierarchyVerify(anchor: ResolvedAnchor, options: ImpactOptions): boolean {
  return options.semanticPolicy === "required" && (anchor.kind === "interface" || new Set(["port", "repository", "service"]).has(anchor.profile));
}

function shouldUseSemanticVerify(options: ImpactOptions, semantic: { used: boolean }, session: JdtlsSession): boolean {
  if (options.semanticPolicy === "fast") {
    return false;
  }
  if (options.semanticPolicy === "required" || options.mode === "precision" || options.mode === "recall") {
    return true;
  }
  if (options.semanticPolicy === "auto" && !semantic.used) {
    return false;
  }
  const status = session.status();
  return Boolean(status.started && status.progress?.active === 0);
}

function locationCandidate(input: LocationCandidateInput): CandidateFile | undefined {
  // JDT resolves definitions into ~/.m2 jars and JDK sources. Those are real
  // answers but they are not this repository, and they must never reach output.
  const normalized = normalizeRepoLocation(input.repoRoot, input.location);
  if (!normalized) {
    input.suppressed.externalLocations += 1;
    return undefined;
  }
  const context = classifyPath(input.repoRoot, normalized.absolutePath);
  const range = normalized.range;
  const score = scoreBase(input.routingPolicy, "semantic", context, input.anchor, input.options) + (input.reason === "implementation" ? 120 : input.reason === "typeHierarchy" ? 110 : 80);
  return {
    absolutePath: normalized.absolutePath,
    path: context.relativePath,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet,
    score,
    matchCount: 0,
    positions: [{ line: range.start.line, column: range.start.column }],
    categories: ["semantic"],
    reasons: [input.reason],
    confidence: "high",
    verifiedBy: [semanticVerifiedBy(input.reason)],
    scoreBreakdown: [breakdown(`semantic.${input.reason}`, "semantic-seed", score, input.reason)]
  };
}

function shouldIncludeImplementations(anchor: ResolvedAnchor): boolean {
  return anchor.kind === "interface" || new Set(["port", "service", "repository"]).has(anchor.profile);
}

function hierarchyItemLocation(item: unknown): LspLocation | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as { uri?: unknown; range?: unknown; selectionRange?: unknown };
  const range = isLspRange(record.range) ? record.range : isLspRange(record.selectionRange) ? record.selectionRange : undefined;
  return typeof record.uri === "string" && range ? { uri: record.uri, range } : undefined;
}

function isLspRange(value: unknown): value is LspLocation["range"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { start?: unknown; end?: unknown };
  return isLspPosition(record.start) && isLspPosition(record.end);
}

function isLspPosition(value: unknown): value is LspLocation["range"]["start"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { line?: unknown; character?: unknown };
  return typeof record.line === "number" && typeof record.character === "number";
}

function semanticVerifiedBy(reason: string): string {
  return reason === "reference" || reason === "typeHierarchy" ? reason : `semantic-${reason}`;
}

async function timed<T>(phases: Record<string, number>, name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    phases[name] = (phases[name] || 0) + Date.now() - startedAt;
  }
}
