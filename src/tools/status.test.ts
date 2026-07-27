import assert from "node:assert/strict";
import test from "node:test";
import { javaStatus } from "./status.js";
import type { ToolContext } from "./context.js";

test("java_status exposes runtime build and root source metadata", async () => {
  const context = {
    repoRoot: "/tmp/demo",
    repoHash: "demo",
    aliases: ["demo"],
    layoutProfile: "generic-java",
    rootSource: "explicit",
    lsp: {
      enabled: true,
      matchedBy: "direct-root",
      effectiveRepoRoot: "/tmp/demo"
    },
    session: {
      status() {
        return testSessionStatus(false);
      }
    },
    sourceIndex: {
      status() {
        return { entries: 0 };
      }
    },
    router: {
      rgCacheStatus() {
        return { entries: 0 };
      }
    }
  } as unknown as ToolContext;

  const result = await javaStatus(context, { start: false });

  assert.equal(result.rootSource, "explicit");
  assert.equal((result.layout as Record<string, unknown>).layoutProfile, "generic-java");
  assert.equal(typeof (result.runtimeBuild as Record<string, unknown>).generatedAt, "string");
  assert.equal(typeof (result.runtimeBuild as Record<string, unknown>).defaultsFingerprint, "string");
});

test("java_status returns summary by default and keeps diagnostics explicit", async () => {
  const context = {
    repoRoot: "/tmp/demo",
    repoHash: "demo",
    aliases: ["demo"],
    layoutProfile: "generic-java",
    rootSource: "explicit",
    lsp: {
      enabled: true,
      matchedBy: "direct-root",
      effectiveRepoRoot: "/tmp/demo"
    },
    session: {
      status() {
        return {
          repoRoot: "/tmp/demo",
          dataDir: "/tmp/demo/.jdtls",
          logFile: "/tmp/demo/jdtls.log",
          jdtlsBin: "/opt/homebrew/bin/jdtls",
          state: "READY",
          started: true,
          restartBackoff: { consecutiveFailures: 0, blockedUntilExplicitReset: false },
          pid: 1234,
          knownDiagnostics: 0,
          openDocuments: 1,
          fileWatcher: {
            enabled: true,
            active: true,
            watchedRoots: ["/tmp/demo/src/main/java"],
            pendingChanges: 0,
            lastFlushSize: 0
          },
          cache: {
            enabled: true,
            entries: 2,
            hits: 3,
            misses: 4,
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
              detected: true,
              agentEnabled: true,
              jar: "/tmp/lombok.jar",
              status: "enabled"
            },
            annotationProcessing: {
              detectedProcessors: ["lombok"],
              enabled: true,
              source: "auto"
            },
            generatedCodeSemantics: "ok"
          },
          progress: {
            active: 0,
            activeMessages: []
          }
        };
      }
    },
    sourceIndex: {
      status() {
        return {
          entries: 5,
          hits: 1,
          misses: 2,
          regexFacts: 4,
          documentSymbolFacts: 1,
          dirtyCount: 0,
          warmIndexPending: 0,
          warmIndexFailed: 0
        };
      }
    },
    router: {
      rgCacheStatus() {
        return {
          enabled: true,
          entries: 1,
          hits: 2,
          misses: 3,
          generation: 0,
          ttlMs: 300000
        };
      }
    }
  } as unknown as ToolContext;

  const summary = await javaStatus(context, { start: false });
  const diagnostic = await javaStatus(context, { start: false, detail: "diagnostic" });

  assert.equal(summary.started, true);
  assert.equal(Object.hasOwn(summary, "dataDir"), false);
  assert.equal(Object.hasOwn(summary, "logFile"), false);
  assert.equal(Object.hasOwn(summary, "rgCache"), false);
  assert.equal((summary.fileWatcher as Record<string, unknown>).watchedRootCount, 1);
  assert.equal(Object.hasOwn(summary.fileWatcher as Record<string, unknown>, "watchedRoots"), false);
  assert.equal(Object.hasOwn(summary.projectJdk as Record<string, unknown>, "candidates"), false);
  assert.equal(Object.hasOwn(summary.generatedCode as Record<string, unknown>, "jar"), false);
  assert.equal(diagnostic.dataDir, "/tmp/demo/.jdtls");
  assert.deepEqual((diagnostic.fileWatcher as Record<string, unknown>).watchedRoots, ["/tmp/demo/src/main/java"]);
  assert.equal(Object.hasOwn(diagnostic, "rgCache"), true);
});

test("java_status exposes sibling-seed progress without requiring diagnostic detail", async () => {
  const context = {
    repoRoot: "/tmp/demo",
    session: { status: () => testSessionStatus(false) },
    sourceIndex: { status: () => ({ entries: 0 }) },
    router: { rgCacheStatus: () => ({ entries: 0 }) },
    javaIndexClient: {
      async status() {
        return {
          state: "READY",
          indexedGeneration: 7,
          files: 12,
          types: 12,
          methods: 4,
          edges: 3,
          snapshotBytes: 1024,
          pendingForeground: 0,
          pendingBackground: 2,
          coverage: [],
          worktreeSeed: {
            attempted: true,
            sourceRepoHash: "sibling-hash",
            reusedFiles: 9,
            dirtyFiles: 3,
            relinkFiles: 1,
            droppedCrossFileEdges: 2,
            manifestValidationMs: 18,
            deltaParsedFiles: 0,
            completion: "SEEDED_DEGRADED"
          }
        };
      }
    }
  } as unknown as ToolContext;

  const result = await javaStatus(context, { start: false });
  const javaIndex = result.javaIndex as Record<string, unknown>;
  const seed = javaIndex.worktreeSeed as Record<string, unknown>;
  assert.equal(javaIndex.files, 12);
  assert.equal(seed.completion, "SEEDED_DEGRADED");
  assert.equal(seed.reusedFiles, 9);
  assert.equal(seed.dirtyFiles, 3);
  assert.equal(seed.deltaParsedFiles, 0);
});

function testSessionStatus(started: boolean): Record<string, unknown> {
  return {
    repoRoot: "/tmp/demo",
    dataDir: "/tmp/demo/.jdtls",
    logFile: "/tmp/demo/jdtls.log",
    jdtlsBin: "/opt/homebrew/bin/jdtls",
    state: started ? "READY" : "NEW",
    started,
    restartBackoff: { consecutiveFailures: 0, blockedUntilExplicitReset: false },
    knownDiagnostics: 0,
    openDocuments: 0,
    fileWatcher: {
      enabled: true,
      active: started,
      watchedRoots: [],
      pendingChanges: 0,
      lastFlushSize: 0
    },
    cache: {
      enabled: true,
      entries: 0,
      hits: 0,
      misses: 0,
      invalidations: 0
    },
    buildSystem: "unknown",
    projectJdk: {
      primarySource: "missing",
      allSources: [],
      status: "missing",
      candidates: [],
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
