// input: SemanticGateway cache keys plus a session's uncached raw LSP methods.
// output: Typed SemanticBackend results for hover/definition/references/symbols/hierarchy.
// pos: Extracted from JdtlsSession so the gateway switch is not mixed with lifecycle.
import path from "node:path";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import type { JdtRestartBackoffStatus } from "./jdt-restart-backoff.js";
import type { GeneratedCodeStatus } from "./generated-code.js";
import type { BuildSystem, ProjectJdkStatus } from "./project-jdk.js";
import { toFileUri } from "./repo-layout.js";
import { positiveInteger, resourceDefaults } from "./resource-defaults.js";
import type {
  SemanticBackend,
  SemanticBackendResult,
  SemanticBackendValue,
  SemanticGatewayOptions,
  SemanticValueMap
} from "./semantic-gateway.js";
import type { HierarchyResult } from "./jdtls-hierarchy-walk.js";
import type {
  DiagnosticFilterInput,
  LspDiagnostic,
  LspDocumentSymbol,
  LspLocation,
  LspLocationLink,
  LspSymbol
} from "./jdtls-lsp-types.js";

export type JdtlsRawSemanticSession = {
  rawHover(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget,
    signal?: AbortSignal
  ): Promise<unknown>;
  rawDefinition(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget,
    signal?: AbortSignal
  ): Promise<Array<LspLocation | LspLocationLink>>;
  rawImplementation(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget,
    signal?: AbortSignal
  ): Promise<Array<LspLocation | LspLocationLink>>;
  rawReferences(
    file: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
    timeoutOrBudget: number | DeadlineBudget,
    signal?: AbortSignal
  ): Promise<LspLocation[]>;
  rawDocumentSymbols(
    file: string,
    timeoutOrBudget?: number | DeadlineBudget,
    signal?: AbortSignal
  ): Promise<LspDocumentSymbol[]>;
  rawWorkspaceSymbols(
    query: string,
    limit: number,
    timeoutOrBudget?: number | DeadlineBudget,
    signal?: AbortSignal
  ): Promise<{ items: LspSymbol[]; truncated: boolean }>;
  rawTypeHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "supertypes" | "subtypes",
    depth: number,
    limit: number,
    budget: DeadlineBudget,
    signal?: AbortSignal
  ): Promise<HierarchyResult>;
  rawCallHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "incoming" | "outgoing",
    depth: number,
    limit: number,
    budget: DeadlineBudget,
    signal?: AbortSignal
  ): Promise<HierarchyResult>;
};

/**
 * The only production bridge from SemanticGateway's typed operations to
 * JdtlsSession's raw (uncached) request methods. Exhaustive switch over
 * SemanticOperation so an unhandled operation is a compile error.
 */
export function createJdtlsSemanticBackend(session: JdtlsRawSemanticSession): SemanticBackend {
  return {
    async execute(key, timeoutMs, signal): Promise<SemanticBackendResult<SemanticBackendValue>> {
      const options = parseOptionsKey(key.optionsKey);
      const budget = DeadlineBudget.fromTimeout(timeoutMs);
      switch (key.operation) {
        case "hover": {
          const { line, column } = requirePosition(key.line, key.column, "hover");
          const value = await session.rawHover(key.file, line, column, budget, signal) as SemanticValueMap["hover"];
          return { completion: "COMPLETE", value };
        }
        case "definition": {
          const { line, column } = requirePosition(key.line, key.column, "definition");
          const value = await session.rawDefinition(key.file, line, column, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "implementation": {
          const { line, column } = requirePosition(key.line, key.column, "implementation");
          const value = await session.rawImplementation(key.file, line, column, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "references": {
          const { line, column } = requirePosition(key.line, key.column, "references");
          const includeDeclaration = options.get("includeDeclaration") === "true";
          const value = await session.rawReferences(key.file, line, column, includeDeclaration, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "documentSymbol": {
          const value = await session.rawDocumentSymbols(key.file, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "workspaceSymbol": {
          const query = options.get("query") ?? "";
          const parsedLimit = Number(options.get("limit") ?? "50");
          const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
          const value = await session.rawWorkspaceSymbols(query, limit, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "typeHierarchy": {
          const { line, column } = requirePosition(key.line, key.column, "typeHierarchy");
          const direction = options.get("direction") === "subtypes" ? "subtypes" : "supertypes";
          const depth = Number(options.get("depth") ?? "1");
          const limit = Number(options.get("limit") ?? "50");
          const result = await session.rawTypeHierarchy(key.file, line, column, direction, depth, limit, budget, signal);
          return {
            completion: result.completion,
            value: { roots: result.roots, edges: result.edges, truncated: result.truncated, requests: result.requests, visited: result.visited },
            errorCode: result.errorCode
          };
        }
        case "callHierarchy": {
          const { line, column } = requirePosition(key.line, key.column, "callHierarchy");
          const direction = options.get("direction") === "outgoing" ? "outgoing" : "incoming";
          const depth = Number(options.get("depth") ?? "1");
          const limit = Number(options.get("limit") ?? "50");
          const result = await session.rawCallHierarchy(key.file, line, column, direction, depth, limit, budget, signal);
          return {
            completion: result.completion,
            value: { roots: result.roots, edges: result.edges, truncated: result.truncated, requests: result.requests, visited: result.visited },
            errorCode: result.errorCode
          };
        }
      }
    }
  };
}

function parseOptionsKey(optionsKey: string): URLSearchParams {
  return new URLSearchParams(optionsKey);
}

function requirePosition(line: number | undefined, column: number | undefined, operation: string): { line: number; column: number } {
  if (line === undefined || column === undefined) {
    throw new JavaIntelligenceError("INVALID_INPUT", `${operation} requires a line and column`);
  }
  return { line, column };
}

export function lifecycleGateFromRestartBackoffStatus(
  status: JdtRestartBackoffStatus
): { allowed: true } | { allowed: false; code: "JDT_BACKOFF" | "JDT_CONFIG_ERROR"; message: string } {
  if (status.blockedUntilExplicitReset) {
    return {
      allowed: false,
      code: "JDT_CONFIG_ERROR",
      message: "JDT start is blocked until configuration changes or java_runtime(action=restart)"
    };
  }
  if (status.retryAfterMs !== undefined) {
    return {
      allowed: false,
      code: "JDT_BACKOFF",
      message: `JDT restart is backing off for ${status.retryAfterMs}ms`
    };
  }
  return { allowed: true };
}

export function semanticLifecycleGateFor(
  session: { status(): { restartBackoff: JdtRestartBackoffStatus } }
): SemanticGatewayOptions["lifecycleGate"] {
  return () => lifecycleGateFromRestartBackoffStatus(session.status().restartBackoff);
}

const LOMBOK_LOG_ANNOTATION = /@(?:[A-Za-z_$][\w$]*\.)*(?:Slf4j|XSlf4j|Log4j2?|CommonsLog|Flogger|JBossLog|Log)\b/;

export function filterGeneratedCodeDiagnostics(input: DiagnosticFilterInput): LspDiagnostic[] {
  if (!input.source || !hasLombokLogSource(input.generatedCode, input.source)) {
    return [...input.diagnostics];
  }
  const { source } = input;
  return input.diagnostics.filter(diagnostic => !isLombokLogUnresolvedDiagnostic(source, diagnostic));
}

function hasLombokLogSource(generatedCode: GeneratedCodeStatus, source: string): boolean {
  const lombokKnown = generatedCode.lombok.detected || /\blombok\.extern\./.test(source);
  return lombokKnown && LOMBOK_LOG_ANNOTATION.test(source);
}

function isLombokLogUnresolvedDiagnostic(source: string, diagnostic: LspDiagnostic): boolean {
  return tokenAt(source, diagnostic.range.start.line, diagnostic.range.start.character) === "log"
    && unresolvedLogMessage(diagnostic.message);
}

function unresolvedLogMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return /\blog\b.*\bcannot be resolved\b/.test(normalized)
    || /\bcannot resolve symbol\b[\s\S]*\blog\b/.test(normalized)
    || /\bcannot find symbol\b[\s\S]*\blog\b/.test(normalized);
}

function tokenAt(source: string, lineNumber: number, character: number): string | undefined {
  const line = source.split(/\r?\n/)[lineNumber];
  if (line === undefined) {
    return undefined;
  }
  return line.slice(Math.max(0, character)).match(/^[A-Za-z_$][\w$]*/)?.[0];
}

export function buildJavaSettings(input: {
  repoRoot: string;
  buildSystem: BuildSystem;
  projectJdk: ProjectJdkStatus;
  generatedCode: GeneratedCodeStatus;
}): Record<string, unknown> {
  const runtime = input.projectJdk.resolvedHome && input.projectJdk.runtimeName
    ? [{ name: input.projectJdk.runtimeName, path: input.projectJdk.resolvedHome, default: true }]
    : [];
  const annotationProcessing = input.generatedCode.annotationProcessing.enabled;
  return {
    java: {
      import: {
        gradle: {
          enabled: input.buildSystem !== "maven",
          annotationProcessing: { enabled: annotationProcessing }
        },
        maven: {
          enabled: input.buildSystem === "maven"
        }
      },
      configuration: {
        updateBuildConfiguration: "automatic",
        runtimes: runtime
      },
      autobuild: {
        enabled: ["1", "on", "true"].includes(process.env.JAVA_LSP_AUTOBUILD?.toLowerCase() || "")
      },
      compile: {
        nullAnalysis: { mode: "disabled" }
      },
      maxConcurrentBuilds: positiveInteger(process.env.JAVA_LSP_IMPORT_CONCURRENCY, resourceDefaults().importConcurrency)
    }
  };
}

export function buildInitializeParams(repoRoot: string, settings: Record<string, unknown>): unknown {
  const rootUri = toFileUri(repoRoot);
  return {
    processId: process.pid,
    rootPath: repoRoot,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: path.basename(repoRoot) || "java-worktree" }],
    capabilities: {
      workspace: {
        applyEdit: false,
        configuration: true,
        workspaceFolders: true,
        didChangeWatchedFiles: { dynamicRegistration: false },
        symbol: { dynamicRegistration: false }
      },
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          didSave: false,
          willSave: false,
          willSaveWaitUntil: false
        },
        hover: { dynamicRegistration: false },
        definition: { dynamicRegistration: false, linkSupport: true },
        implementation: { dynamicRegistration: false, linkSupport: true },
        references: { dynamicRegistration: false },
        callHierarchy: { dynamicRegistration: false },
        typeHierarchy: { dynamicRegistration: false },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true }
      },
      window: { workDoneProgress: true },
      general: { positionEncodings: ["utf-16"] }
    },
    initializationOptions: {
      bundles: [],
      extendedClientCapabilities: {
        progressReportProvider: true,
        classFileContentsSupport: false,
        overrideMethodsPromptSupport: false,
        hashCodeEqualsPromptSupport: false
      },
      settings
    }
  };
}

export function pickJavaConfigurationSection(source: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return null;
  }, source);
}
