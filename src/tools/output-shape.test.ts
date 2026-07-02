import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { javaDiagnostics } from "./diagnostics.js";
import { javaReferences } from "./references.js";
import { javaRestart } from "./restart.js";
import { javaShutdown } from "./shutdown.js";
import { javaSymbol } from "./symbol.js";
import type { ToolContext } from "./context.js";

const repoRoot = "/tmp/demo";
const sourceFile = path.join(repoRoot, "src", "main", "java", "demo", "DemoService.java");
const sourceUri = pathToFileURL(sourceFile).toString();

test("action tools return summaries by default and diagnostic status on request", async () => {
  const restartContext = {
    session: {
      async restart(_clearCache: boolean) {
        return sessionStatus(true);
      }
    }
  } as unknown as ToolContext;

  let stopped = false;
  let rgCacheCleared = false;
  const shutdownContext = {
    session: {
      status() {
        return sessionStatus(!stopped);
      },
      async stop() {
        stopped = true;
      }
    },
    router: {
      clearRgCache() {
        rgCacheCleared = true;
      }
    }
  } as unknown as ToolContext;

  const restartSummary = record(await javaRestart(restartContext, { clearCache: false }));
  const restartDiagnostic = record(await javaRestart(restartContext, { clearCache: false, detail: "diagnostic" }));
  const shutdownSummary = record(await javaShutdown(shutdownContext, { all: false }));

  assert.equal(restartSummary.restarted, true);
  assert.equal(Object.hasOwn(restartSummary, "dataDir"), false);
  assert.equal((restartSummary.fileWatcher as Record<string, unknown>).watchedRootCount, 1);
  assert.equal(restartDiagnostic.dataDir, "/tmp/demo/.jdtls");
  assert.equal(shutdownSummary.stopped, true);
  assert.equal(shutdownSummary.started, false);
  assert.equal(shutdownSummary.rgCacheCleared, true);
  assert.equal(rgCacheCleared, true);
  assert.equal(Object.hasOwn(shutdownSummary, "status"), false);
});

test("java_diagnostics summarizes repo-relative diagnostics by default", async () => {
  const context = {
    repoRoot,
    session: {
      async diagnosticsFor(files: string[], _waitMs: number) {
        return {
          [files[0]]: [{
            range: {
              start: { line: 4, character: 8 },
              end: { line: 4, character: 20 }
            },
            severity: 1,
            code: "compiler.err.cant.resolve",
            source: "Java",
            message: "cannot find symbol"
          }]
        };
      }
    }
  } as unknown as ToolContext;

  const summary = record(await javaDiagnostics(context, { files: ["src/main/java/demo/DemoService.java"], waitMs: 0 }));
  const diagnostic = record(await javaDiagnostics(context, { files: ["src/main/java/demo/DemoService.java"], waitMs: 0, detail: "diagnostic" }));

  assert.equal(summary.totalDiagnostics, 1);
  assert.equal((summary.files as Array<Record<string, unknown>>)[0]?.path, "src/main/java/demo/DemoService.java");
  assert.equal(Object.hasOwn(summary, "diagnostics"), false);
  assert.equal((diagnostic.files as string[])[0], sourceFile);
  assert.equal(Object.hasOwn(diagnostic, "diagnostics"), true);
});

test("java_symbol and java_references omit raw uri ranges unless diagnostic is requested", async () => {
  const context = {
    repoRoot,
    session: {
      async workspaceSymbols(_query: string, _limit: number) {
        return {
          truncated: false,
          items: [{
            name: "DemoService",
            kind: 5,
            location: locationAt(5, 9)
          }]
        };
      },
      async symbolContext(_file: string, _line: number, _column: number, _timeoutMs: number) {
        return {
          hover: { contents: "DemoService" },
          definitions: [locationAt(5, 9)],
          implementations: [locationAt(7, 11)]
        };
      },
      async references(_file: string, _line: number, _column: number, _includeDeclaration: boolean) {
        return {
          items: [locationAt(5, 9), locationAt(7, 11)],
          totalReferences: 2,
          truncated: false
        };
      }
    }
  } as unknown as ToolContext;

  const symbolSummary = record(await javaSymbol(context, { query: "DemoService", semanticTimeoutMs: 3000 }));
  const symbolDiagnostic = record(await javaSymbol(context, { query: "DemoService", semanticTimeoutMs: 3000, detail: "diagnostic" }));
  const positionSummary = record(await javaSymbol(context, { file: "src/main/java/demo/DemoService.java", line: 5, column: 9, semanticTimeoutMs: 3000 }));
  const referencesSummary = record(await javaReferences(context, { file: "src/main/java/demo/DemoService.java", line: 5, column: 9, includeDeclaration: false, positionsPerFile: 3 }));
  const referencesDiagnostic = record(await javaReferences(context, { file: "src/main/java/demo/DemoService.java", line: 5, column: 9, includeDeclaration: false, positionsPerFile: 3, detail: "diagnostic" }));

  const symbolLocation = ((symbolSummary.items as Array<Record<string, unknown>>)[0]?.location) as Record<string, unknown>;
  const diagnosticLocation = ((symbolDiagnostic.items as Array<Record<string, unknown>>)[0]?.location) as Record<string, unknown>;
  const firstPosition = (((referencesSummary.groups as Array<Record<string, unknown>>)[0]?.files as Array<Record<string, unknown>>)[0]?.positions as Array<Record<string, unknown>>)[0];
  const firstDiagnosticPosition = (((referencesDiagnostic.groups as Array<Record<string, unknown>>)[0]?.files as Array<Record<string, unknown>>)[0]?.positions as Array<Record<string, unknown>>)[0];

  assert.equal(symbolLocation.path, "src/main/java/demo/DemoService.java");
  assert.equal(Object.hasOwn(symbolLocation, "uri"), false);
  assert.equal(Object.hasOwn(symbolLocation, "range"), false);
  assert.equal(Object.hasOwn(diagnosticLocation, "uri"), true);
  assert.equal(Object.hasOwn(diagnosticLocation, "range"), true);
  assert.equal(positionSummary.file, "src/main/java/demo/DemoService.java");
  assert.equal(referencesSummary.matchedReferences, 2);
  assert.equal(referencesSummary.returnedReferences, 2);
  assert.equal(Object.hasOwn(firstPosition, "range"), false);
  assert.equal(Object.hasOwn(firstDiagnosticPosition, "range"), true);
});

function locationAt(line: number, column: number) {
  return {
    uri: sourceUri,
    range: {
      start: { line: line - 1, character: column - 1 },
      end: { line: line - 1, character: column + 3 }
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object result.");
  }
  return value as Record<string, unknown>;
}

function sessionStatus(started: boolean) {
  return {
    repoRoot,
    dataDir: "/tmp/demo/.jdtls",
    logFile: "/tmp/demo/jdtls.log",
    jdtlsBin: "/opt/homebrew/bin/jdtls",
    started,
    pid: started ? 1234 : undefined,
    knownDiagnostics: 0,
    openDocuments: 0,
    startedAt: started ? "2026-07-01T00:00:00.000Z" : undefined,
    fileWatcher: {
      enabled: true,
      active: started,
      watchedRoots: [path.join(repoRoot, "src", "main", "java")],
      pendingChanges: 0,
      lastFlushSize: 0
    },
    cache: {
      enabled: true,
      entries: 1,
      hits: 2,
      misses: 3,
      invalidations: 0
    },
    buildSystem: "maven",
    projectJdk: {
      requiredMajor: 21,
      primarySource: "maven",
      allSources: ["maven"],
      status: "resolved",
      candidates: ["21:/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home"],
      notes: []
    },
    generatedCode: {
      lombok: {
        detected: false,
        agentEnabled: false,
        status: "not-detected"
      },
      annotationProcessing: {
        detectedProcessors: [],
        enabled: false,
        source: "not-detected"
      },
      generatedCodeSemantics: "not-detected"
    },
    progress: {
      active: 0,
      activeMessages: []
    }
  };
}
