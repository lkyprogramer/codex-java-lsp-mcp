// input: java_status MCP request and optional start flag.
// output: Current JDT LS, watcher, JavaIndex, and router cache status.
// pos: v5 status tool handler.
import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import { readRuntimeBuild, type RuntimeBuildInfo } from "../build-info.js";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import type { JdtlsProgressStatus } from "../jdtls-session.js";
import type { FileWatcherStatus } from "../file-watcher.js";
import type { GeneratedCodeStatus } from "../generated-code.js";
import type { JavaIndexStatus } from "../java-index/index-types.js";
import { summarizeCoverage } from "../java-index/java-index-view.js";
import type { ProjectJdkStatus } from "../project-jdk.js";
import type { ToolContext } from "./context.js";
import { compact, detailSchema, isDiagnosticDetail } from "./shared.js";

type SessionStatus = ReturnType<ToolContext["session"]["status"]>;

type DisabledStatus = {
  readonly repoRoot: string;
  readonly rootSource?: ToolContext["rootSource"];
  readonly repoHash?: string;
  readonly aliases: string[];
  readonly layoutProfile?: string;
  readonly layout: LayoutContext;
  readonly runtimeBuild: RuntimeBuildInfo;
  readonly rootWarnings: string[];
  readonly lsp: ToolContext["lsp"];
  readonly started: false;
  readonly note: string;
};

type StatusSummaryInput = {
  readonly context: ToolContext;
  readonly sessionStatus: SessionStatus;
  readonly layout: LayoutContext;
  readonly runtimeBuild: RuntimeBuildInfo;
  readonly warnings: string[];
  readonly javaIndex?: JavaIndexStatus;
};

export const statusSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  start: z.boolean().default(false),
  detail: detailSchema
};

export async function javaStatus(context: ToolContext, _args: z.infer<z.ZodObject<typeof statusSchema>>): Promise<Record<string, unknown>> {
  const layout = probeLayout(context.repoRoot, context.layoutProfile);
  const runtimeBuild = readRuntimeBuild();
  const warnings = rootWarnings(context.repoRoot);
  if (_args.start) {
    if (context.lsp && !context.lsp.enabled) {
      const disabled: DisabledStatus = {
        repoRoot: context.repoRoot,
        rootSource: context.rootSource,
        repoHash: context.repoHash,
        aliases: context.aliases || [],
        layoutProfile: context.layoutProfile,
        layout,
        runtimeBuild,
        rootWarnings: warnings,
        lsp: context.lsp,
        started: false,
        note: context.lsp.enableHint || "Enable this project in projects.json before starting JDT LS."
      };
      return isDiagnosticDetail(_args.detail) ? disabled : disabledSummary(disabled);
    }
    await context.session.ensureStarted();
  }
  const sessionStatus = context.session.status();
  const javaIndex = await context.javaIndexClient?.status().catch(() => undefined);
  const full = {
    ...sessionStatus,
    repoHash: context.repoHash,
    rootSource: context.rootSource,
    aliases: context.aliases || [],
    layoutProfile: context.layoutProfile,
    layout,
    runtimeBuild,
    rootWarnings: warnings,
    lsp: context.lsp,
    repoRoot: context.repoRoot,
    javaIndex,
    watcher: context.watcher,
    rgCache: context.router.rgCacheStatus(),
    note: "This MCP server is read-only and exposes the Java impact router."
  };
  return isDiagnosticDetail(_args.detail)
    ? full
    : statusSummary({ context, sessionStatus, layout, runtimeBuild, warnings, javaIndex });
}

export function summarizeSessionStatus(status: SessionStatus): Record<string, unknown> {
  return compact({
    repoRoot: status.repoRoot,
    state: status.state,
    started: status.started,
    pid: status.pid,
    startingPid: status.startingPid,
    restartBackoff: compact({
      consecutiveFailures: status.restartBackoff.consecutiveFailures || undefined,
      retryAfterMs: status.restartBackoff.retryAfterMs,
      blockedUntilExplicitReset: status.restartBackoff.blockedUntilExplicitReset || undefined,
      lastErrorCode: status.restartBackoff.lastErrorCode
    }),
    startedAt: status.startedAt,
    knownDiagnostics: status.knownDiagnostics,
    openDocuments: status.openDocuments,
    buildSystem: status.buildSystem,
    projectJdk: summarizeProjectJdk(status.projectJdk),
    generatedCode: summarizeGeneratedCode(status.generatedCode),
    fileWatcher: summarizeFileWatcher(status.fileWatcher),
    progress: summarizeProgress(status.progress)
  });
}

export function summarizeResourceStatus(resource: NonNullable<ToolContext["resource"]>): Record<string, unknown> {
  return {
    maxActiveRepos: resource.maxActiveRepos,
    idleTtlMs: resource.idleTtlMs,
    jdtlsXmx: resource.jdtlsXmx,
    activeRepos: resource.activeRepos,
    activeJdtlsPids: resource.activeJdtlsPids,
    importConcurrency: resource.importConcurrency,
    workspaceRetainedOnShutdown: resource.workspaceRetainedOnShutdown
  };
}

function rootWarnings(repoRoot: string): string[] {
  return hasBuildFile(repoRoot) ? [] : ["No pom.xml, build.gradle, or settings.gradle file was found at the resolved repo root."];
}

function hasBuildFile(repoRoot: string): boolean {
  return [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts"
  ].some(file => existsSync(path.join(repoRoot, file)));
}

function statusSummary(input: StatusSummaryInput): Record<string, unknown> {
  return compact({
    ...summarizeSessionStatus(input.sessionStatus),
    repoHash: input.context.repoHash,
    rootSource: input.context.rootSource,
    aliases: input.context.aliases || [],
    layoutProfile: input.context.layoutProfile,
    layout: summarizeLayout(input.layout),
    runtimeBuild: summarizeRuntimeBuild(input.runtimeBuild),
    rootWarnings: input.warnings,
    lsp: input.context.lsp,
    repoRoot: input.context.repoRoot,
    javaIndex: input.javaIndex && summarizeJavaIndex(input.javaIndex),
    watcher: input.context.watcher && summarizeWatcher(input.context.watcher)
  });
}

function summarizeJavaIndex(status: JavaIndexStatus): Record<string, unknown> {
  return compact({
    state: status.state,
    indexedGeneration: status.indexedGeneration,
    files: status.files,
    coverage: summarizeCoverage(status),
    pendingBackground: status.pendingBackground,
    worktreeSeed: status.worktreeSeed && compact({
      completion: status.worktreeSeed.completion,
      reusedFiles: status.worktreeSeed.reusedFiles,
      dirtyFiles: status.worktreeSeed.dirtyFiles,
      deltaParsedFiles: status.worktreeSeed.deltaParsedFiles
    })
  });
}

function summarizeWatcher(watcher: NonNullable<ToolContext["watcher"]>): Record<string, unknown> {
  return compact({
    ready: watcher.ready,
    degraded: watcher.degraded,
    pending: watcher.pending,
    lastStorm: watcher.lastStorm && compact({
      observedAt: watcher.lastStorm.observedAt,
      changeCount: watcher.lastStorm.changeCount,
      affectedRoots: watcher.lastStorm.affectedRoots
    })
  });
}

function disabledSummary(status: DisabledStatus): Record<string, unknown> {
  return compact({
    repoRoot: status.repoRoot,
    rootSource: status.rootSource,
    repoHash: status.repoHash,
    aliases: status.aliases,
    layoutProfile: status.layoutProfile,
    layout: summarizeLayout(status.layout),
    runtimeBuild: summarizeRuntimeBuild(status.runtimeBuild),
    rootWarnings: status.rootWarnings,
    lsp: status.lsp,
    started: false,
    note: status.note
  });
}

function summarizeLayout(layout: LayoutContext): Record<string, unknown> {
  return {
    layout: layout.layout,
    layoutProfile: layout.layoutProfile,
    sourceRootCount: layout.sourceRoots.length,
    resourceRootCount: layout.resourceRoots.length,
    broadRoots: layout.broadRoots
  };
}

function summarizeRuntimeBuild(runtimeBuild: RuntimeBuildInfo): Record<string, unknown> {
  return compact({
    gitSha: runtimeBuild.gitSha,
    generatedAt: runtimeBuild.generatedAt,
    defaultsFingerprint: runtimeBuild.defaultsFingerprint,
    missing: runtimeBuild.missing
  });
}

function summarizeProjectJdk(projectJdk: ProjectJdkStatus): Record<string, unknown> {
  return compact({
    requiredMajor: projectJdk.requiredMajor,
    requiredRaw: projectJdk.requiredRaw,
    resolvedHome: projectJdk.resolvedHome,
    runtimeName: projectJdk.runtimeName,
    primarySource: projectJdk.primarySource,
    allSources: projectJdk.allSources,
    status: projectJdk.status,
    notes: projectJdk.notes
  });
}

function summarizeGeneratedCode(generatedCode: GeneratedCodeStatus): Record<string, unknown> {
  return {
    lombok: {
      detected: generatedCode.lombok.detected,
      agentEnabled: generatedCode.lombok.agentEnabled,
      status: generatedCode.lombok.status
    },
    annotationProcessing: generatedCode.annotationProcessing,
    generatedCodeSemantics: generatedCode.generatedCodeSemantics
  };
}

function summarizeFileWatcher(fileWatcher: FileWatcherStatus): Record<string, unknown> {
  return compact({
    enabled: fileWatcher.enabled,
    active: fileWatcher.active,
    watchedRootCount: fileWatcher.watchedRoots.length,
    pendingChanges: fileWatcher.pendingChanges,
    lastFlushAt: fileWatcher.lastFlushAt,
    lastFlushSize: fileWatcher.lastFlushSize,
    lastError: fileWatcher.lastError
  });
}

function summarizeProgress(progress: JdtlsProgressStatus): Record<string, unknown> {
  return compact({
    active: progress.active,
    activeMessageCount: progress.activeMessages.length,
    lastProgressAt: progress.lastProgressAt,
    lastLanguageStatus: progress.lastLanguageStatus
  });
}
