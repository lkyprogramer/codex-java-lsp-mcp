import path from "node:path";
import { classifyPath } from "../repo-layout.js";
import type { LayoutContext } from "../layout-probe.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { Completion } from "../runtime/completion.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type { SearchResult } from "../search/search-types.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor, RgPlanSection } from "../agent-types.js";
import { breakdown, scoreBase, unique } from "./candidate-helpers.js";
import { classStem } from "./name-helpers.js";
import { persistenceRoots, rootsFor } from "./rg-roots.js";
import {
  controllerTerms,
  dtoTerms,
  dtoUpstream,
  entityTerms,
  jobTerms,
  listenerTerms,
  mapperTerms,
  parserTerms,
  portTerms,
  repositoryTerms,
  serviceTerms,
  sqlTerms,
  taskKeywordTerms,
  testTerms,
  voTerms
} from "./rg-terms.js";

export type RgCommandSummary = {
  rawBytes: number;
  totalMatches: number;
  elapsedMs: number;
  files: CandidateFile[];
  cacheHit: boolean;
  /** Whether the underlying search actually finished; gates caching. */
  completion: Completion;
};

type BuildRgPlanInput = {
  readonly repoRoot: string;
  readonly anchor: ResolvedAnchor;
  readonly options: ImpactOptions;
  readonly layoutContext: LayoutContext;
};

type SummaryFromSearchResultInput = {
  readonly policy: RoutingPolicy;
  readonly repoRoot: string;
  readonly section: RgPlanSection;
  readonly result: SearchResult;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
};

export function buildRgPlan(input: BuildRgPlanInput): RgPlanSection[] {
  const { repoRoot, anchor, options, layoutContext } = input;
  const base = anchor.className || path.basename(anchor.absolutePath, ".java");
  const stem = classStem(base);
  const symbol = anchor.methodName || anchor.symbolName;
  const sections: RgPlanSection[] = [];
  const mainRoots = rootsFor(repoRoot, anchor, "main", options, layoutContext);
  const testRoots = rootsFor(repoRoot, anchor, "test", options, layoutContext);
  const expand = (terms: string[]) => [...terms, ...taskKeywordTerms(options.taskKeywords)];
  if (anchor.profile === "repository") {
    sections.push(section("java", "repository port, implementation, mapper, entity, and application callers", expand(repositoryTerms(base, stem, symbol)), mainRoots, ["*.java"]));
    sections.push(section("persistence", "mapper, migration, and SQL evidence", expand(sqlTerms(base, stem, symbol)), persistenceRoots(anchor, layoutContext), ["*.sql", "*.xml", "*.java"]));
  } else if (anchor.profile === "controller") {
    sections.push(section("protocol", "endpoint contract, assembler, command/result, and application service path", expand(controllerTerms(base, stem, symbol)), mainRoots, ["*.java"]));
  } else if (anchor.profile === "parser") {
    sections.push(section("java", "parser port, implementation, parsed model, and app-service callers", expand(parserTerms(base, stem, symbol)), mainRoots, ["*.java"]));
  } else if (anchor.profile === "dto") {
    sections.push(section("java", "DTO/view field propagation and mapper usage", expand(dtoTerms(base, stem, symbol)), mainRoots, ["*.java"]));
    const upstream = dtoUpstream(anchor, symbol, repoRoot, layoutContext);
    if (upstream.terms.length > 0) {
      sections.push(section("java", "likely upstream source service or view", expand(upstream.terms), upstream.paths, ["*.java"]));
    }
  } else if (anchor.profile === "vo") {
    sections.push(section("java", "VO/view field propagation, assembler, and service callers", expand(voTerms(base, stem, symbol)), mainRoots, ["*.java"]));
  } else if (anchor.profile === "entity") {
    sections.push(section("java", "entity mapping, mapper, repository, and service callers", expand(entityTerms(base, stem, symbol)), mainRoots, ["*.java"]));
    sections.push(section("persistence", "entity table, mapper XML, migration, and SQL evidence", expand(sqlTerms(base, stem, symbol)), persistenceRoots(anchor, layoutContext), ["*.sql", "*.xml", "*.java"]));
  } else if (anchor.profile === "mapper") {
    sections.push(section("java", "mapper interface, entity, repository, and service callers", expand(mapperTerms(base, stem, symbol)), mainRoots, ["*.java"]));
    sections.push(section("persistence", "mapper XML, entity table, migration, and SQL evidence", expand(sqlTerms(base, stem, symbol)), persistenceRoots(anchor, layoutContext), ["*.sql", "*.xml", "*.java"]));
  } else if (anchor.profile === "job") {
    sections.push(section("java", "scheduled job, application service, repository, and config path", expand(jobTerms(base, stem, symbol)), mainRoots, ["*.java"]));
    sections.push(section("config", "job scheduling and runtime configuration evidence", expand([base, stem, symbol]), layoutContext.broadRoots, ["*.yml", "*.yaml", "*.properties", "*.xml"]));
  } else if (anchor.profile === "listener") {
    sections.push(section("java", "event listener, publisher, handler, service, and repository path", expand(listenerTerms(base, stem, symbol)), mainRoots, ["*.java"]));
    sections.push(section("config", "listener/event runtime configuration evidence", expand([base, stem, symbol]), layoutContext.broadRoots, ["*.yml", "*.yaml", "*.properties", "*.xml"]));
  } else if (anchor.profile === "port") {
    sections.push(section("java", "port contract, implementations, and direct callers", expand(portTerms(base, stem, symbol)), rootsFor(repoRoot, anchor, "main", { ...options, crossModulePolicy: "all" }, layoutContext), ["*.java"]));
  } else {
    sections.push(section("java", "service, direct callers, and local protocol family", expand(serviceTerms(base, stem, symbol)), mainRoots, ["*.java"]));
  }
  sections.push(section("tests", "targeted verification candidates", expand(testTerms(anchor, base, stem, symbol)), testRoots, ["*Test.java"]));
  if (options.mode === "recall") {
    sections.push(section("config", "runtime configuration evidence", expand([base, stem]), layoutContext.broadRoots, ["*.yml", "*.yaml", "*.properties", "*.xml"]));
  }
  return sections
    .filter(item => item.paths.length > 0 && item.pattern.length > 0)
    .map(item => ({ ...item, anchorId: anchor.id }));
}

export function summaryFromSearchResult(input: SummaryFromSearchResultInput): RgCommandSummary {
  const files: CandidateFile[] = [];
  const anchor = input.anchors.find(candidate => candidate.id === input.section.anchorId);
  if (!anchor) {
    throw new JavaIntelligenceError(
      "INVALID_INPUT",
      `rg plan section has unknown anchor ${String(input.section.anchorId)}`
    );
  }
  for (const match of input.result.files) {
    const context = classifyPath(input.repoRoot, match.absolutePath);
    const score = scoreBase(input.policy, input.section.category, context, anchor, input.options);
    files.push({
      absolutePath: match.absolutePath,
      path: context.relativePath,
      module: context.module,
      layer: context.layer,
      sourceSet: context.sourceSet,
      score,
      matchCount: match.matchCount,
      positions: match.positions.map(position => ({ line: position.line, column: position.column })),
      categories: [input.section.category],
      reasons: [`rg:${input.section.category}`],
      confidence: "medium",
      verifiedBy: ["rg"],
      scoreBreakdown: [breakdown(`rg.${input.section.category}`, "rg", score, input.section.reason)]
    });
  }
  return {
    rawBytes: input.result.rawBytes,
    totalMatches: input.result.totalMatches,
    elapsedMs: Math.round(input.result.elapsedMs),
    files,
    cacheHit: false,
    completion: input.result.completion
  };
}

function section(category: RgPlanSection["category"], reason: string, terms: string[], paths: string[], globs: string[]): RgPlanSection {
  return {
    category,
    reason,
    pattern: unique(terms.filter(term => term.length > 0)).join("|"),
    paths,
    globs
  };
}
