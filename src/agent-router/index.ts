// input: java_impact tool arguments, source facts, optional JDT LS context, and rg output.
// output: Compact v5 impact map, read plan, and evidence gaps.
// pos: Single agent-grade semantic router for lishuedu Java navigation.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fromFileUri, classifyPath, normalizeRepoFile } from "../repo-layout.js";
import { JdtlsSession, type LspLocation, type LspLocationLink } from "../jdtls-session.js";
import { SourceIndex, type JavaSourceFacts } from "../source-index.js";
import {
  type CandidateFile,
  type CrossModulePolicy,
  type ImpactMode,
  type ImpactOptions,
  type ImpactProfile,
  type ImpactResult,
  type ReadPlanItem,
  type ReadPriority,
  type ResolvedAnchor,
  type ResolvedImpactProfile,
  type RgPlanSection,
  type RgSectionSummary,
  type RouterPosition,
  type SemanticPolicy,
  type TestReadMode
} from "../agent-types.js";

type RgCacheEntry = {
  expiresAt: number;
  generation: number;
  summary: RgCommandSummary;
};

type RgCommandSummary = {
  rawBytes: number;
  totalMatches: number;
  elapsedMs: number;
  files: CandidateFile[];
  cacheHit: boolean;
};

type RouterStatus = {
  enabled: boolean;
  entries: number;
  hits: number;
  misses: number;
  generation: number;
  ttlMs: number;
};

const RG_CACHE_TTL_MS = positiveInteger(process.env.AGENT_RG_CACHE_TTL_MS, 300000);
const RG_CONCURRENCY = positiveInteger(process.env.JAVA_LSP_RG_CONCURRENCY, Math.min(4, availableParallelism()));

export class AgentRouter {
  private readonly rgCache = new Map<string, RgCacheEntry>();
  private rgHits = 0;
  private rgMisses = 0;

  constructor(
    private readonly repoRoot: string,
    private readonly session: JdtlsSession,
    private readonly sourceIndex: SourceIndex
  ) {}

  rgCacheStatus(): RouterStatus {
    this.evictExpiredRgCache();
    return {
      enabled: RG_CACHE_TTL_MS > 0,
      entries: this.rgCache.size,
      hits: this.rgHits,
      misses: this.rgMisses,
      generation: this.session.cacheStatus().invalidations,
      ttlMs: RG_CACHE_TTL_MS
    };
  }

  clearRgCache(): void {
    this.rgCache.clear();
  }

  async impact(options: ImpactOptions): Promise<ImpactResult> {
    const startedAt = Date.now();
    const sourceBefore = this.sourceIndex.status();
    const cacheBefore = this.session.cacheStatus();
    const rgBefore = this.rgCacheStatus();
    const semantic = {
      used: false,
      skipped: false,
      timeout: false,
      policy: options.semanticPolicy,
      timeoutMs: options.semanticTimeoutMs
    };
    const phaseMs: Record<string, number> = {};
    const anchors = options.anchors.map((anchor, index) => this.resolveAnchor(anchor, options.profile, `A${index + 1}`));
    const candidates = new Map<string, CandidateFile>();
    for (const anchor of anchors) {
      mergeCandidate(candidates, candidateFromAnchor(anchor));
    }

    const shouldUseSemantic = this.shouldUseSemantic(options.semanticPolicy, options.mode, anchors);
    if (shouldUseSemantic) {
      semantic.used = true;
      await timed(phaseMs, "semantic", async () => {
        for (const anchor of anchors) {
          const before = Date.now();
          const context = await this.session.semanticLocations(anchor.absolutePath, anchor.line, anchor.column, options.semanticTimeoutMs, shouldIncludeImplementations(anchor));
          semantic.timeout ||= Date.now() - before >= options.semanticTimeoutMs;
          for (const location of [...context.definitions, ...context.implementations]) {
            const described = this.locationCandidate(location, context.implementations.includes(location) ? "implementation" : "definition", anchor, options);
            if (described) {
              mergeCandidate(candidates, described);
            }
          }
        }
      });
    } else {
      semantic.skipped = true;
    }

    const rgPlan = anchors.flatMap(anchor => this.buildRgPlan(anchor, options));
    const rgExecution = await timed(phaseMs, "rg", async () => this.executeRgPlan(rgPlan, options, anchors));
    for (const file of rgExecution.files) {
      mergeCandidate(candidates, file);
    }

    const suppressed = {
      deferredTests: 0,
      crossModuleConsumers: 0,
      excludedModules: 0
    };
    const ranked = [...candidates.values()]
      .filter(candidate => {
        if (candidate.module && options.excludeModules.includes(candidate.module)) {
          suppressed.excludedModules += 1;
          return false;
        }
        return true;
      })
      .map(candidate => this.finalizeScore(candidate, anchors[0], options, suppressed))
      .sort((left, right) => right.score - left.score || (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath))
      .slice(0, candidateLimit(options.mode, anchors[0]?.profile));
    const formattedFiles = ranked.map((file, index) => formatCandidate(file, `F${index + 1}`));
    const idByPath = new Map(ranked.map((file, index) => [file.absolutePath, `F${index + 1}`]));
    const readPlan = this.buildReadPlan(ranked, idByPath, options);
    const cacheAfter = this.session.cacheStatus();
    const rgAfter = this.rgCacheStatus();
    const sourceAfter = this.sourceIndex.status();

    const payload: ImpactResult = {
      target: formatAnchor(anchors[0]),
      options: {
        mode: options.mode,
        profile: options.profile,
        semanticPolicy: options.semanticPolicy,
        readPlanMaxItems: readPlan.length,
        testReadMode: options.testReadMode,
        focusModules: options.focusModules,
        excludeModules: options.excludeModules,
        taskKeywords: options.taskKeywords,
        crossModulePolicy: options.crossModulePolicy
      },
      counts: {
        anchors: anchors.length,
        rgCommands: rgExecution.commandCount,
        rgFiles: rgExecution.files.length,
        totalRgMatches: rgExecution.totalMatches,
        totalRgRawBytes: rgExecution.rawBytes,
        returnedFiles: formattedFiles.length,
        readPlanItems: readPlan.length
      },
      files: formattedFiles,
      readPlan,
      rgSummary: {
        sections: rgExecution.sections,
        suppressed: rgExecution.suppressed
      },
      suppressed,
      evidenceGaps: this.evidenceGaps(anchors, options, semantic),
      metrics: {
        routingVersion: 5,
        elapsedMs: Date.now() - startedAt,
        phaseMs,
        semantic,
        cache: {
          entries: cacheAfter.entries,
          hitsDelta: cacheAfter.hits - cacheBefore.hits,
          missesDelta: cacheAfter.misses - cacheBefore.misses,
          invalidationsDelta: cacheAfter.invalidations - cacheBefore.invalidations
        },
        rgCache: {
          entries: rgAfter.entries,
          hitsDelta: rgAfter.hits - rgBefore.hits,
          missesDelta: rgAfter.misses - rgBefore.misses,
          generation: rgAfter.generation
        },
        sourceFacts: {
          entries: sourceAfter.entries,
          hitsDelta: sourceAfter.hits - sourceBefore.hits,
          missesDelta: sourceAfter.misses - sourceBefore.misses,
          regexFacts: sourceAfter.regexFacts,
          documentSymbolFacts: sourceAfter.documentSymbolFacts,
          warmIndexPending: sourceAfter.warmIndexPending,
          warmIndexFailed: sourceAfter.warmIndexFailed,
          anchorFactSource: anchors[0]?.factSource
        },
        outputBytes: 0
      }
    };
    payload.metrics.outputBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    return payload;
  }

  private resolveAnchor(input: { file: string; line: number; column: number; role?: string }, requested: ImpactProfile, id: string): ResolvedAnchor {
    const absolutePath = normalizeRepoFile(this.repoRoot, input.file);
    const facts = this.sourceIndex.factsFor(absolutePath);
    const method = this.sourceIndex.methodAt(absolutePath, input.line);
    const symbolName = tokenAtColumn(absolutePath, input.line, input.column) || method?.name || facts.typeName || path.basename(absolutePath, ".java");
    const profile = requested === "auto" ? inferProfile(facts, input.role) : requested;
    return {
      id,
      absolutePath,
      path: facts.path,
      module: facts.module,
      layer: facts.layer,
      sourceSet: facts.sourceSet,
      line: input.line,
      column: input.column,
      role: input.role,
      profile,
      symbolName,
      methodName: method?.name,
      className: facts.typeName,
      factSource: facts.factSource,
      kind: method ? "Method" : facts.kind || "Type"
    };
  }

  private shouldUseSemantic(policy: SemanticPolicy, mode: ImpactMode, anchors: ResolvedAnchor[]): boolean {
    if (policy === "fast") {
      return false;
    }
    if (policy === "required" || mode === "precision" || mode === "recall") {
      return true;
    }
    return anchors.some(anchor => anchor.profile === "service");
  }

  private locationCandidate(
    location: LspLocation | LspLocationLink,
    reason: string,
    anchor: ResolvedAnchor,
    options: ImpactOptions
  ): CandidateFile | undefined {
    const uri = "targetUri" in location ? location.targetUri : location.uri;
    const range = "targetSelectionRange" in location ? location.targetSelectionRange : location.range;
    const filePath = fromFileUri(uri);
    if (!filePath) {
      return undefined;
    }
    const context = classifyPath(this.repoRoot, filePath);
    return {
      absolutePath: filePath,
      path: context.relativePath,
      module: context.module,
      layer: context.layer,
      sourceSet: context.sourceSet,
      score: scoreBase("semantic", context, anchor, options) + (reason === "implementation" ? 120 : 80),
      matchCount: 0,
      positions: [{ line: range.start.line + 1, column: range.start.character + 1 }],
      categories: ["semantic"],
      reasons: [reason]
    };
  }

  private buildRgPlan(anchor: ResolvedAnchor, options: ImpactOptions): RgPlanSection[] {
    const base = anchor.className || path.basename(anchor.absolutePath, ".java");
    const stem = classStem(base);
    const symbol = anchor.methodName || anchor.symbolName;
    const sections: RgPlanSection[] = [];
    const mainRoots = rootsFor(this.repoRoot, anchor, "main", options);
    const testRoots = rootsFor(this.repoRoot, anchor, "test", options);
    if (anchor.profile === "repository") {
      sections.push(section("java", "repository port, implementation, mapper, entity, and application callers", repositoryTerms(base, stem, symbol), mainRoots, ["*.java"]));
      sections.push(section("persistence", "mapper, migration, and SQL evidence", sqlTerms(base, stem, symbol), persistenceRoots(anchor), ["*.sql", "*.xml", "*.java"]));
    } else if (anchor.profile === "controller") {
      sections.push(section("protocol", "endpoint contract, assembler, command/result, and application service path", controllerTerms(base, stem, symbol), mainRoots, ["*.java"]));
    } else if (anchor.profile === "parser") {
      sections.push(section("java", "parser port, implementation, parsed model, and app-service callers", parserTerms(base, stem, symbol), mainRoots, ["*.java"]));
    } else if (anchor.profile === "dto") {
      sections.push(section("java", "DTO/view field propagation and mapper usage", dtoTerms(base, stem, symbol), mainRoots, ["*.java"]));
      const upstream = dtoUpstream(anchor, symbol, this.repoRoot);
      if (upstream.terms.length > 0) {
        sections.push(section("java", "likely upstream source service or view", upstream.terms, upstream.paths, ["*.java"]));
      }
    } else if (anchor.profile === "vo") {
      sections.push(section("java", "VO/view field propagation, assembler, and service callers", voTerms(base, stem, symbol), mainRoots, ["*.java"]));
    } else if (anchor.profile === "entity") {
      sections.push(section("java", "entity mapping, mapper, repository, and service callers", entityTerms(base, stem, symbol), mainRoots, ["*.java"]));
      sections.push(section("persistence", "entity table, mapper XML, migration, and SQL evidence", sqlTerms(base, stem, symbol), persistenceRoots(anchor), ["*.sql", "*.xml", "*.java"]));
    } else if (anchor.profile === "mapper") {
      sections.push(section("java", "mapper interface, entity, repository, and service callers", mapperTerms(base, stem, symbol), mainRoots, ["*.java"]));
      sections.push(section("persistence", "mapper XML, entity table, migration, and SQL evidence", sqlTerms(base, stem, symbol), persistenceRoots(anchor), ["*.sql", "*.xml", "*.java"]));
    } else if (anchor.profile === "job") {
      sections.push(section("java", "scheduled job, application service, repository, and config path", jobTerms(base, stem, symbol), mainRoots, ["*.java"]));
      sections.push(section("config", "job scheduling and runtime configuration evidence", [base, stem, symbol], ["modules", "apps"], ["*.yml", "*.yaml", "*.properties", "*.xml"]));
    } else if (anchor.profile === "listener") {
      sections.push(section("java", "event listener, publisher, handler, service, and repository path", listenerTerms(base, stem, symbol), mainRoots, ["*.java"]));
      sections.push(section("config", "listener/event runtime configuration evidence", [base, stem, symbol], ["modules", "apps"], ["*.yml", "*.yaml", "*.properties", "*.xml"]));
    } else if (anchor.profile === "port") {
      sections.push(section("java", "port contract, implementations, and direct callers", portTerms(base, stem, symbol), rootsFor(this.repoRoot, anchor, "main", { ...options, crossModulePolicy: "all" }), ["*.java"]));
    } else {
      sections.push(section("java", "service, direct callers, and local protocol family", serviceTerms(base, stem, symbol), mainRoots, ["*.java"]));
    }
    sections.push(section("tests", "targeted verification candidates", testTerms(anchor, base, stem, symbol), testRoots, ["*Test.java"]));
    if (options.mode === "recall") {
      sections.push(section("config", "runtime configuration evidence", [base, stem], ["modules", "apps"], ["*.yml", "*.yaml", "*.properties", "*.xml"]));
    }
    return sections.filter(item => item.paths.length > 0 && item.pattern.length > 0);
  }

  private async executeRgPlan(plan: RgPlanSection[], options: ImpactOptions, anchors: ResolvedAnchor[]): Promise<{
    files: CandidateFile[];
    sections: RgSectionSummary[];
    rawBytes: number;
    totalMatches: number;
    commandCount: number;
    suppressed: Record<string, unknown>;
  }> {
    const fileMap = new Map<string, CandidateFile>();
    const sections: RgSectionSummary[] = [];
    let rawBytes = 0;
    let totalMatches = 0;
    let commandCount = 0;
    const results = await mapConcurrent(plan, RG_CONCURRENCY, async item => ({
      item,
      summary: await this.rgSummary(item, options, anchors)
    }));
    for (const { item, summary } of results) {
      commandCount += 1;
      rawBytes += summary.rawBytes;
      totalMatches += summary.totalMatches;
      for (const file of summary.files) {
        mergeCandidate(fileMap, file);
      }
      sections.push({
        category: item.category,
        reason: item.reason,
        commandCount: 1,
        matchedFiles: summary.files.length,
        totalMatches: summary.totalMatches,
        rawBytes: summary.rawBytes,
        cacheHits: summary.cacheHit ? 1 : 0,
        files: summary.files
          .sort((left, right) => right.score - left.score)
          .slice(0, 6)
          .map(file => ({
            path: file.path,
            module: file.module,
            layer: file.layer,
            sourceSet: file.sourceSet,
            score: Math.round(file.score),
            matchCount: file.matchCount
          }))
      });
    }
    return {
      files: [...fileMap.values()],
      sections,
      rawBytes,
      totalMatches,
      commandCount,
      suppressed: {
        rawBytes,
        note: "raw rg stdout is summarized inside MCP and not returned to the agent"
      }
    };
  }

  private async rgSummary(section: RgPlanSection, options: ImpactOptions, anchors: ResolvedAnchor[]): Promise<RgCommandSummary> {
    this.evictExpiredRgCache();
    const generation = this.session.cacheStatus().invalidations;
    const key = JSON.stringify({ repoRoot: this.repoRoot, generation, section, focusModules: options.focusModules, excludeModules: options.excludeModules });
    const cached = this.rgCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.rgHits += 1;
      return { ...cached.summary, cacheHit: true };
    }
    this.rgMisses += 1;
    const startedAt = Date.now();
    const paths = section.paths.filter(item => existsSync(path.resolve(this.repoRoot, item)));
    if (paths.length === 0) {
      return {
        rawBytes: 0,
        totalMatches: 0,
        elapsedMs: 0,
        files: [],
        cacheHit: false
      };
    }
    const args = [
      "-n",
      section.pattern,
      ...paths,
      ...section.globs.flatMap(glob => ["-g", glob]),
      "-g",
      "!**/README.md",
      "-g",
      "!docs/superpowers/plans/**",
      "-g",
      "!**/{build,.gradle,node_modules,dist}/**"
    ];
    const result = await runRg(args, {
      cwd: this.repoRoot,
      maxBuffer: 12 * 1024 * 1024,
      timeoutMs: 15000
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") {
      throw result.error;
    }
    if (result.status && result.status !== 1) {
      throw new Error(`rg failed for ${section.category}: ${(result.stderr || "").trim()}`);
    }
    const summary = parseRgOutput(this.repoRoot, section, result.stdout || "", Date.now() - startedAt, anchors, options);
    this.rgCache.set(key, {
      generation,
      expiresAt: Date.now() + RG_CACHE_TTL_MS,
      summary
    });
    return summary;
  }

  private finalizeScore(candidate: CandidateFile, anchor: ResolvedAnchor, options: ImpactOptions, suppressed: Record<string, number>): CandidateFile {
    let score = candidate.score + Math.min(40, candidate.matchCount * 2);
    if (candidate.module && options.focusModules.includes(candidate.module)) {
      score += 35;
    }
    if (candidate.path && matchesAny(candidate.path, options.taskKeywords)) {
      score += 30;
    }
    if (candidate.sourceSet === "test" && options.testReadMode === "defer") {
      score -= 10;
      suppressed.deferredTests += 1;
    }
    if (candidate.module && candidate.module !== anchor.module && options.crossModulePolicy !== "all") {
      if (!options.focusModules.includes(candidate.module) && !(candidate.path && matchesAny(candidate.path, options.taskKeywords))) {
        score += options.crossModulePolicy === "focused" ? -80 : -20;
        suppressed.crossModuleConsumers += 1;
      }
    }
    return { ...candidate, score: Math.max(1, score) };
  }

  private buildReadPlan(files: CandidateFile[], ids: Map<string, string>, options: ImpactOptions): ReadPlanItem[] {
    const maxItems = options.readPlanMaxItems ?? defaultReadPlanMax(options.mode);
    return files
      .map(file => ({ file, priority: readPriority(file, options) }))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
      .slice(0, maxItems)
      .map(({ file, priority }) => {
        const position = file.positions[0] || { line: 1, column: 1 };
        const radius = priority === "P0" ? { before: 24, after: 44 } : priority === "P1" ? { before: 16, after: 32 } : { before: 10, after: 22 };
        return {
          priority,
          fileId: ids.get(file.absolutePath) || "F?",
          startLine: Math.max(1, position.line - radius.before),
          endLine: position.line + radius.after,
          reason: readReason(file, priority)
        };
      });
  }

  private evidenceGaps(anchors: ResolvedAnchor[], options: ImpactOptions, semantic: { skipped: boolean; timeout: boolean }): string[] {
    const gaps = [
      "Run Gradle compile/test before claiming behavior.",
      "Use rg/runtime evidence for Spring wiring, SQL/XML/YAML, logs, Nacos, and DB state."
    ];
    if (semantic.skipped) {
      gaps.push("LSP semantic enrichment was skipped by policy; raise semanticPolicy or mode if exact symbol binding is required.");
    }
    if (semantic.timeout) {
      gaps.push("LSP semantic enrichment hit the configured timeout and fell back to source-index plus rg evidence.");
    }
    if (anchors.some(anchor => anchor.factSource !== "documentSymbol")) {
      gaps.push("Source facts are regex-derived and not yet JDT LS documentSymbol confirmed.");
    }
    if (anchors.some(anchor => anchor.profile === "repository" || anchor.profile === "port")) {
      gaps.push("Review persistence/config evidence from rgSummary before changing behavior.");
    }
    if (options.testReadMode === "defer") {
      gaps.push("Tests are returned as lower-priority candidates; use testReadMode=priority when verification planning is the main task.");
    }
    return gaps;
  }

  private evictExpiredRgCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.rgCache.entries()) {
      if (entry.expiresAt <= now) {
        this.rgCache.delete(key);
      }
    }
  }
}

function parseRgOutput(repoRoot: string, section: RgPlanSection, stdout: string, elapsedMs: number, anchors: ResolvedAnchor[], options: ImpactOptions): RgCommandSummary {
  const files = new Map<string, CandidateFile>();
  let totalMatches = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) {
      continue;
    }
    totalMatches += 1;
    const absolutePath = normalizeRepoFile(repoRoot, match[1]);
    const lineNumber = Number(match[2]);
    const context = classifyPath(repoRoot, absolutePath);
    const existing = files.get(absolutePath) || {
      absolutePath,
      path: context.relativePath,
      module: context.module,
      layer: context.layer,
      sourceSet: context.sourceSet,
      score: scoreBase(section.category, context, anchors[0], options),
      matchCount: 0,
      positions: [],
      categories: [section.category],
      reasons: [`rg:${section.category}`]
    };
    existing.matchCount += 1;
    if (existing.positions.length < 4) {
      existing.positions.push({ line: lineNumber, column: 1 });
    }
    files.set(absolutePath, existing);
  }
  return {
    rawBytes: Buffer.byteLength(stdout, "utf8"),
    totalMatches,
    elapsedMs,
    files: [...files.values()],
    cacheHit: false
  };
}

function candidateFromAnchor(anchor: ResolvedAnchor): CandidateFile {
  return {
    absolutePath: anchor.absolutePath,
    path: anchor.path,
    module: anchor.module,
    layer: anchor.layer,
    sourceSet: anchor.sourceSet,
    score: 1000,
    matchCount: 0,
    positions: [{ line: anchor.line, column: anchor.column }],
    categories: ["target"],
    reasons: ["target"]
  };
}

function mergeCandidate(target: Map<string, CandidateFile>, incoming: CandidateFile): void {
  const existing = target.get(incoming.absolutePath);
  if (!existing) {
    target.set(incoming.absolutePath, { ...incoming, positions: [...incoming.positions] });
    return;
  }
  existing.score += incoming.score;
  existing.matchCount += incoming.matchCount;
  existing.categories = unique([...existing.categories, ...incoming.categories]);
  existing.reasons = unique([...existing.reasons, ...incoming.reasons]);
  for (const position of incoming.positions) {
    if (existing.positions.length >= 8) {
      break;
    }
    if (!existing.positions.some(item => item.line === position.line && item.column === position.column)) {
      existing.positions.push(position);
    }
  }
}

function scoreBase(category: string, context: ReturnType<typeof classifyPath>, anchor: ResolvedAnchor, options: ImpactOptions): number {
  let score = category === "persistence" ? 70 : category === "protocol" ? 64 : category === "java" ? 56 : category === "semantic" ? 80 : category === "tests" ? 24 : 18;
  if (context.relativePath === anchor.path) {
    score += 180;
  }
  if (context.module === anchor.module) {
    score += 28;
  }
  if (context.sourceSet === "main") {
    score += 14;
  }
  if (context.layer === "interfaces" || context.layer === "application") {
    score += 12;
  }
  if (anchor.profile === "controller" && context.layer === "interfaces") {
    score += 35;
  }
  if (anchor.profile === "repository" && (context.layer === "infrastructure" || context.relativePath?.includes("/db/migration/"))) {
    score += 35;
  }
  if (anchor.profile === "entity" && /(\/entity\/|Entity|DO|Mapper|Repository|db\/migration)/.test(context.relativePath || "")) {
    score += 34;
  }
  if (anchor.profile === "mapper" && /(\/mapper\/|Mapper|Entity|DO|Repository|\.xml$|db\/migration)/.test(context.relativePath || "")) {
    score += 36;
  }
  if (anchor.profile === "job" && /(Job|Scheduler|Schedule|Task|Config|AppService|Service|Repository)/.test(context.relativePath || "")) {
    score += 32;
  }
  if (anchor.profile === "listener" && /(Listener|Event|Publisher|Handler|Consumer|AppService|Service|Repository)/.test(context.relativePath || "")) {
    score += 32;
  }
  if (anchor.profile === "parser" && /Parser|ParsedTemplate|DiffBuilder|Draft|PreviewItem/.test(context.relativePath || "")) {
    score += 38;
  }
  if (anchor.profile === "parser" && /\/persistence\/|Repository|Mapper|DO|Task(File|Status|Repository|Mapper|DO)?/.test(context.relativePath || "")) {
    score -= 70;
  }
  if (anchor.profile === "parser" && context.sourceSet === "test" && /ExcelParserTest|DiffBuilderTest/.test(context.relativePath || "")) {
    score += 90;
  }
  if (anchor.profile === "port" && /Gateway|Config|SignedUrl|AppService|Report/.test(context.relativePath || "")) {
    score += 30;
  }
  if (anchor.profile === "dto" && /Assembler|Controller|QueryAppService|ProductView|ParentBenefit|ItemView/.test(context.relativePath || "")) {
    score += 32;
  }
  if (anchor.profile === "vo" && /VO|Vo|View|Assembler|Controller|AppService|Service/.test(context.relativePath || "")) {
    score += 30;
  }
  if (anchor.profile === "dto" && context.sourceSet === "test" && /ParentBenefitQueryAppServiceTest|BenefitEntitlementAssemblerTest/.test(context.relativePath || "")) {
    score += 90;
  }
  if (context.module && options.focusModules.includes(context.module)) {
    score += 18;
  }
  if (context.relativePath && matchesAny(context.relativePath, options.taskKeywords)) {
    score += 20;
  }
  if (context.module === "common") {
    score -= 20;
  }
  return Math.max(1, score);
}

function inferProfile(facts: JavaSourceFacts, role?: string): ResolvedImpactProfile {
  const hint = `${facts.path || ""} ${facts.typeName || ""} ${role || ""}`.toLowerCase();
  if (hint.includes("/interfaces/web/") || /controller\b/.test(hint)) {
    return "controller";
  }
  if (/parser\b/.test(hint)) {
    return "parser";
  }
  if (/(listener|eventhandler|consumer)\b/.test(hint) || hint.includes("/listener/")) {
    return "listener";
  }
  if (/(job|scheduler|scheduled|task)\b/.test(hint) || hint.includes("/job/")) {
    return "job";
  }
  if (/repository\b/.test(hint)) {
    return "repository";
  }
  if (/(mapper)\b/.test(hint) || hint.includes("/mapper/")) {
    return "mapper";
  }
  if (/(entity|do)\b/.test(hint) || hint.includes("/entity/")) {
    return "entity";
  }
  if (/(gateway|port|client)\b/.test(hint) || facts.kind === "interface") {
    return "port";
  }
  if (/(request|response|view|dto|command|result)\b/.test(hint) || hint.includes("/dto/") || facts.kind === "record") {
    return "dto";
  }
  if (/\bvo\b/.test(hint) || hint.includes("/vo/")) {
    return "vo";
  }
  return "service";
}

function shouldIncludeImplementations(anchor: ResolvedAnchor): boolean {
  return anchor.kind === "interface" || new Set(["port", "service", "repository"]).has(anchor.profile);
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

function rootsFor(repoRoot: string, anchor: ResolvedAnchor, sourceSet: "main" | "test", options: Pick<ImpactOptions, "crossModulePolicy" | "focusModules">): string[] {
  if (options.crossModulePolicy === "all") {
    return broadSearchRoots(repoRoot);
  }
  const modules = unique([anchor.module, ...options.focusModules].filter((value): value is string => Boolean(value)));
  const roots = modules
    .flatMap(module => [`modules/${module}/src/${sourceSet}/java`, `apps/${module}/src/${sourceSet}/java`, `${module}/src/${sourceSet}/java`])
    .filter(item => existsSync(path.resolve(repoRoot, item)));
  return roots.length > 0 ? unique(roots) : broadSearchRoots(repoRoot);
}

function broadSearchRoots(repoRoot: string): string[] {
  const roots = ["modules", "apps"].filter(item => existsSync(path.resolve(repoRoot, item)));
  return roots.length > 0 ? roots : ["."];
}

function persistenceRoots(anchor: ResolvedAnchor): string[] {
  return unique([
    anchor.module ? `modules/${anchor.module}/src/main/resources` : undefined,
    anchor.module ? `modules/${anchor.module}/src/main/java` : undefined,
    "docs/sql"
  ].filter((value): value is string => Boolean(value)));
}

function classStem(baseName: string): string {
  return baseName.replace(/(Controller|AppService|Service|Assembler|Repository|Gateway|Command|Request|Response|View|VO|DTO|DO|Entity|Mapper|Parser|Port|Client|Job|Scheduler|Listener|Handler|Consumer|Event|Test)$/, "") || baseName;
}

function serviceTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Controller|AppService|Service|Assembler|Command|Request|Response|View|Result)`, safeSymbol(symbol)];
}

function controllerTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Controller|AppService|Service|Assembler|Request|Response|Command|Result|Confirm|Summary)`, safeSymbol(symbol)];
}

function repositoryTerms(base: string, stem: string, symbol: string): string[] {
  return [literal(base), `${literal(stem)}(Repository|RepositoryImpl|Mapper|DO|Entity|AppService|Service|Task)`, safeSymbol(symbol), actionTail(symbol)];
}

function parserTerms(base: string, stem: string, symbol: string): string[] {
  const domainStem = stem.replace(/Import$/, "");
  return [
    literal(base),
    `${literal(stem)}(Parser|Controller|AppService|Service|Assembler|Command|Result|DiffBuilder|ExcelParser|ParsedTemplate|Task|Artifact)`,
    domainStem !== stem ? `${literal(domainStem)}(ParsedTemplate|StudentDraft|TeacherDraft|GradeDraft|ClassDraft|PreviewItem|BindingDraft|BindingPreviewItem)` : "",
    safeSymbol(symbol)
  ];
}

function portTerms(base: string, stem: string, symbol: string): string[] {
  return [
    literal(base),
    `${literal(stem)}(Gateway|Port|Client|AppService|Service|Command|Result|Config|Mapper)`,
    safeSymbol(symbol),
    actionTail(symbol)
  ];
}

function dtoTerms(base: string, stem: string, symbol: string): string[] {
  return [
    literal(base),
    `${literal(stem)}(Response|View|DTO|Assembler|Controller|AppService|Service)`,
    ...dtoFlowStemTerms(stem),
    safeSymbol(symbol),
    `${literal(symbol)}\\(`,
    `\\.${literal(symbol)}\\(`
  ];
}

function voTerms(base: string, stem: string, symbol: string): string[] {
  return [
    literal(base),
    `${literal(stem)}(VO|Vo|View|DTO|Assembler|Controller|AppService|Service|Response)`,
    safeSymbol(symbol),
    `${literal(symbol)}\\(`,
    `\\.${literal(symbol)}\\(`
  ];
}

function entityTerms(base: string, stem: string, symbol: string): string[] {
  return [
    literal(base),
    `${literal(stem)}(Entity|DO|Mapper|Repository|RepositoryImpl|Service|AppService|Converter|Assembler)`,
    camelToSnake(stem),
    safeSymbol(symbol),
    actionTail(symbol)
  ];
}

function mapperTerms(base: string, stem: string, symbol: string): string[] {
  return [
    literal(base),
    `${literal(stem)}(Mapper|Entity|DO|Repository|RepositoryImpl|Service|AppService|Converter|Assembler)`,
    camelToSnake(stem),
    safeSymbol(symbol),
    actionTail(symbol)
  ];
}

function jobTerms(base: string, stem: string, symbol: string): string[] {
  return [
    literal(base),
    `${literal(stem)}(Job|Scheduler|Task|AppService|Service|Repository|Config|Properties)`,
    safeSymbol(symbol),
    actionTail(symbol)
  ];
}

function listenerTerms(base: string, stem: string, symbol: string): string[] {
  return [
    literal(base),
    `${literal(stem)}(Listener|Event|Publisher|Handler|Consumer|AppService|Service|Repository|Config)`,
    safeSymbol(symbol),
    actionTail(symbol)
  ];
}

function dtoUpstream(anchor: ResolvedAnchor, symbol: string, repoRoot: string): { terms: string[]; paths: string[] } {
  const root = symbol.replace(/Code$/, "");
  if (!root || root === symbol || root.length < 4) {
    return { terms: [], paths: [] };
  }
  const moduleName = root.charAt(0).toLowerCase() + root.slice(1);
  const paths = existsSync(path.resolve(repoRoot, `modules/${moduleName}/src/main/java`)) ? [`modules/${moduleName}/src/main/java`] : ["modules", "apps"];
  return {
    terms: [`${literal(capitalize(root))}(QueryAppService|View)`, `${literal(symbol)}\\(`, `\\.${literal(symbol)}\\(`],
    paths
  };
}

function testTerms(anchor: ResolvedAnchor, base: string, stem: string, symbol: string): string[] {
  if (anchor.profile === "repository") {
    return repositoryTerms(base, stem, symbol);
  }
  if (anchor.profile === "parser") {
    return parserTerms(base, stem, symbol);
  }
  if (anchor.profile === "dto") {
    return dtoTerms(base, stem, symbol);
  }
  if (anchor.profile === "vo") {
    return voTerms(base, stem, symbol);
  }
  if (anchor.profile === "entity") {
    return entityTerms(base, stem, symbol);
  }
  if (anchor.profile === "mapper") {
    return mapperTerms(base, stem, symbol);
  }
  if (anchor.profile === "job") {
    return jobTerms(base, stem, symbol);
  }
  if (anchor.profile === "listener") {
    return listenerTerms(base, stem, symbol);
  }
  if (anchor.profile === "controller") {
    return controllerTerms(base, stem, symbol);
  }
  return [...portTerms(base, stem, symbol), `${literal(stem)}.*Test`];
}

function sqlTerms(base: string, stem: string, symbol: string): string[] {
  return [camelToSnake(base), camelToSnake(stem), camelToSnake(symbol), actionTail(symbol) ? camelToSnake(actionTail(symbol) as string) : ""].map(literal);
}

function dtoFlowStemTerms(stem: string): string[] {
  const flowStem = stem.replace(/Student|Item|Detail|Entry/g, "");
  return flowStem && flowStem !== stem && flowStem.length >= 8
    ? [`${literal(flowStem)}(Controller|AppService|QueryAppService|Service|Assembler|Response|View|DTO)`]
    : [];
}

function safeSymbol(symbol: string): string {
  return isNoisySymbol(symbol) ? "" : literal(symbol);
}

function actionTail(symbol: string): string {
  const tail = symbol.replace(/^(get|find|list|load|resolve|create|update|delete|save|mark|claim)/, "");
  return tail && tail !== symbol ? literal(tail) : "";
}

function isNoisySymbol(value: string): boolean {
  return value.length < 5 || new Set(["parse", "confirm", "get", "list", "page", "save", "update", "delete", "create", "find", "load", "query", "execute", "handle", "process", "apply", "build"]).has(value);
}

function readPriority(file: CandidateFile, options: ImpactOptions): ReadPriority {
  if (file.sourceSet === "test") {
    return options.testReadMode === "priority" ? "P1" : "P2";
  }
  if (file.categories.includes("config") || file.categories.includes("nonJava")) {
    return "P2";
  }
  if (file.reasons.includes("target") || (file.reasons.includes("implementation") && file.sourceSet === "main")) {
    return "P0";
  }
  if (file.sourceSet === "main") {
    return "P1";
  }
  return "P2";
}

function readReason(file: CandidateFile, priority: ReadPriority): string {
  if (file.reasons.includes("target")) {
    return "anchor symbol and local behavior";
  }
  if (file.reasons.includes("implementation")) {
    return "main implementation candidate";
  }
  if (file.categories.includes("persistence")) {
    return "persistence or migration evidence";
  }
  if (file.sourceSet === "test") {
    return priority === "P1" ? "priority verification candidate" : "deferred verification candidate";
  }
  return "ranked candidate from source index, rg summary, and optional LSP";
}

function formatCandidate(file: CandidateFile, id: string): Record<string, unknown> {
  return compact({
    id,
    path: file.path || file.absolutePath,
    module: file.module,
    layer: file.layer,
    sourceSet: file.sourceSet,
    score: Math.round(file.score),
    matchCount: file.matchCount,
    categories: file.categories,
    reasons: file.reasons,
    positions: file.positions.slice(0, 3)
  });
}

function formatAnchor(anchor: ResolvedAnchor): Record<string, unknown> {
  return compact({
    id: anchor.id,
    path: anchor.path || anchor.absolutePath,
    module: anchor.module,
    layer: anchor.layer,
    sourceSet: anchor.sourceSet,
    line: anchor.line,
    column: anchor.column,
    profile: anchor.profile,
    symbolName: anchor.symbolName,
    methodName: anchor.methodName,
    className: anchor.className,
    factSource: anchor.factSource,
    kind: anchor.kind
  });
}

function tokenAtColumn(file: string, lineNumber: number, column: number): string | undefined {
  try {
    const line = (readFileSync(file, "utf8").split(/\r?\n/)[lineNumber - 1] || "");
    const index = Math.max(0, column - 1);
    const left = line.slice(0, index + 1).match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] || "";
    const right = line.slice(index + 1).match(/^[A-Za-z0-9_]*/)?.[0] || "";
    return left || right ? `${left}${right}` : undefined;
  } catch {
    return undefined;
  }
}

function defaultReadPlanMax(mode: ImpactMode): number {
  return mode === "minimal" ? 4 : mode === "precision" ? 8 : mode === "recall" ? 12 : 6;
}

function candidateLimit(mode: ImpactMode, profile?: ResolvedImpactProfile): number {
  if (mode === "minimal") {
    return 18;
  }
  if (mode === "precision") {
    return 45;
  }
  if (mode === "recall") {
    return 70;
  }
  if (profile === "port") {
    return 20;
  }
  if (profile === "parser") {
    return 18;
  }
  if (profile === "controller") {
    return 16;
  }
  if (profile === "dto") {
    return 24;
  }
  return 26;
}

function priorityRank(priority: ReadPriority): number {
  return priority === "P0" ? 0 : priority === "P1" ? 1 : 2;
}

function matchesAny(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some(keyword => keyword.length > 0 && lower.includes(keyword.toLowerCase()));
}

function literal(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function timed<T>(phases: Record<string, number>, name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    phases[name] = (phases[name] || 0) + Date.now() - startedAt;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type RgRunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

function runRg(args: string[], options: { cwd: string; maxBuffer: number; timeoutMs: number }): Promise<RgRunResult> {
  return new Promise(resolve => {
    const child = spawn("rg", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (result: RgRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (message: string, code: string) => {
      const error = new Error(message) as NodeJS.ErrnoException;
      error.code = code;
      child.kill("SIGTERM");
      finish({ status: null, stdout, stderr, error });
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const nextBytes = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
      if (nextBytes > options.maxBuffer) {
        fail("rg output exceeded maxBuffer", "ENOBUFS");
        return;
      }
      if (stream === "stdout") {
        stdoutBytes = nextBytes;
        stdout += chunk.toString("utf8");
      } else {
        stderrBytes = nextBytes;
        stderr += chunk.toString("utf8");
      }
    };
    const timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for rg after ${options.timeoutMs}ms`) as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      child.kill("SIGTERM");
      finish({ status: null, stdout, stderr, error });
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => append("stdout", chunk));
    child.stderr.on("data", chunk => append("stderr", chunk));
    child.on("error", error => finish({ status: null, stdout, stderr, error: error as NodeJS.ErrnoException }));
    child.on("close", code => finish({ status: code, stdout, stderr }));
  });
}
