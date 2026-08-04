import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { javaDiagnostics } from "./diagnostics.js";
import { javaImpact } from "./impact.js";
import { javaReferences } from "./references.js";
import { javaRestart } from "./restart.js";
import { javaShutdown } from "./shutdown.js";
import { javaSymbol } from "./symbol.js";
import type { ToolContext } from "./context.js";
import { AgentRouter } from "../agent-router/index.js";
import { JavaIndexClient } from "../java-index/java-index-client.js";
import { RouterJavaIndex } from "../java-index/router-java-index.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";

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

test("semantic tools never emit locations from outside the repository", async () => {
  const externalUri = pathToFileURL(path.join(tmpdir(), "dependency", "Library.java")).toString();
  const jarUri = pathToFileURL(path.join(homedir(), ".m2", "repository", "org", "example", "Lib.java")).toString();
  const jdkUri = pathToFileURL("/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/lib/src/String.java").toString();
  const external = (uri: string) => ({
    uri,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }
  });

  const context = {
    repoRoot,
    session: {
      async workspaceSymbols() {
        return {
          truncated: false,
          items: [
            { name: "Library", kind: 5, location: external(jarUri) },
            { name: "DemoService", kind: 5, location: locationAt(5, 9) }
          ]
        };
      },
      async symbolContext() {
        return {
          hover: { contents: "DemoService" },
          definitions: [external(jarUri), locationAt(5, 9)],
          implementations: [external(jdkUri)]
        };
      },
      async references() {
        return {
          items: [external(externalUri), locationAt(5, 9), external(jdkUri)],
          totalReferences: 3,
          truncated: false
        };
      }
    }
  } as unknown as ToolContext;

  const results = [
    record(await javaSymbol(context, { query: "Library", semanticTimeoutMs: 3000 })),
    record(await javaSymbol(context, { query: "Library", semanticTimeoutMs: 3000, detail: "diagnostic" })),
    record(await javaSymbol(context, { file: "src/main/java/demo/DemoService.java", line: 5, column: 9, semanticTimeoutMs: 3000 })),
    record(await javaSymbol(context, { file: "src/main/java/demo/DemoService.java", line: 5, column: 9, semanticTimeoutMs: 3000, detail: "diagnostic" })),
    record(await javaReferences(context, { file: "src/main/java/demo/DemoService.java", line: 5, column: 9, includeDeclaration: false, positionsPerFile: 3 })),
    record(await javaReferences(context, { file: "src/main/java/demo/DemoService.java", line: 5, column: 9, includeDeclaration: false, positionsPerFile: 3, detail: "diagnostic" }))
  ];

  for (const result of results) {
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(tmpdir()), false, "no temp-dir path leaks");
    assert.equal(serialized.includes(".m2/repository"), false, "no Maven jar source leaks");
    assert.equal(serialized.includes("Library/Java/JavaVirtualMachines"), false, "no JDK source leaks");
  }

  const symbolQuery = results[0];
  assert.deepEqual(
    (symbolQuery.items as Array<Record<string, unknown>>).map(item => item.name),
    ["DemoService"],
    "a symbol whose only location is outside the repo is dropped"
  );

  const positionResult = results[2];
  assert.equal((positionResult.definitions as unknown[]).length, 1);
  assert.equal((positionResult.implementations as unknown[]).length, 0);

  const referencesResult = results[4];
  assert.equal(referencesResult.totalReferences, 3, "the raw JDT total is still reported");
  assert.equal(referencesResult.matchedReferences, 1);
  assert.equal(referencesResult.externalReferencesSuppressed, 2);
});

class NoLspSession {
  cacheStatus(): { invalidations: number; entries: number; hits: number; misses: number } {
    return { invalidations: 0, entries: 0, hits: 0, misses: 0 };
  }

  status(): { started: boolean; progress: { active: number }; generatedCode: { lombok: { detected: false } } } {
    return { started: false, progress: { active: 0 }, generatedCode: { lombok: { detected: false } } };
  }

  drainPhaseMetrics(): Record<string, number> {
    return {};
  }
}

class EmptyRgRunner extends RgRunner {
  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
}

async function waitForCompleteIndex(index: RouterJavaIndex): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await index.routerStatus()).coverage === "complete") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("fixture JavaIndex did not reach complete coverage within 2 seconds");
}

test("java_impact standard output matches the ImpactResultV6 contract - present/absent fields per architecture V3.1 §15", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "impact-shape-"));
  const sourceDir = path.join(root, "src", "main", "java", "demo");
  const serviceFile = path.join(sourceDir, "DemoService.java");
  const repositoryFile = path.join(sourceDir, "DemoRepository.java");
  const index = new RouterJavaIndex(root, new JavaIndexClient(root, path.join(root, ".cache")));
  try {
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
    await writeFile(repositoryFile, [
      "package demo;",
      "",
      "public class DemoRepository {",
      "  public String findById(String id) {",
      "    return id;",
      "  }",
      "}",
      ""
    ].join("\n"));
    await writeFile(serviceFile, [
      "package demo;",
      "",
      "public class DemoService {",
      "  private final DemoRepository repository = new DemoRepository();",
      "",
      "  public String process(String id) {",
      "    return repository.findById(id);",
      "  }",
      "}",
      ""
    ].join("\n"));
    await index.open(0);
    await index.reconcile(0);
    await waitForCompleteIndex(index);

    const session = new NoLspSession();
    const router = new AgentRouter(root, session as never, index, undefined, undefined, undefined, new EmptyRgRunner());
    const context = { repoRoot: root, session, router } as unknown as ToolContext;

    const impactArgs = {
      anchors: [{ file: serviceFile, line: 6, column: 21 }],
      mode: "balanced" as const,
      profile: "auto" as const,
      semanticPolicy: "fast" as const,
      testReadMode: "defer" as const,
      focusModules: [],
      excludeModules: [],
      taskKeywords: [],
      crossModulePolicy: "auto" as const
    };

    const standard = record(await javaImpact(context, { ...impactArgs, verbosity: "standard" }));
    const diagnostic = record(await javaImpact(context, { ...impactArgs, verbosity: "diagnostic" }));

    for (const key of ["version", "target", "freshness", "semantic", "files", "readPlan", "evidenceGaps", "cost"]) {
      assert.equal(Object.hasOwn(standard, key), true, `standard output must carry top-level "${key}"`);
    }
    assert.equal(Object.hasOwn(standard, "options"), false, "v5's top-level options is retired in V6");
    assert.equal(Object.hasOwn(standard, "counts"), false, "v5's top-level counts is retired in V6");
    assert.equal(Object.hasOwn(standard, "rgSummary"), false, "v5's top-level rgSummary is retired in V6");
    assert.equal(Object.hasOwn(standard, "suppressed"), false, "v5's top-level suppressed is retired in V6");

    const files = standard.files as Array<Record<string, unknown>>;
    assert.ok(files.length > 0, "the fixture's direct field-receiver call must produce at least one candidate, or the absence assertions below are untested");
    for (const file of files) {
      assert.equal(Object.hasOwn(file, "score"), false);
      assert.equal(Object.hasOwn(file, "scoreBreakdown"), false);
      assert.equal(Object.hasOwn(file, "reasons"), false);
      assert.equal(Object.hasOwn(file, "verifiedBy"), false);
      assert.equal(Object.hasOwn(file, "absolutePath"), false);
    }
    const standardMetrics = (standard.metrics ?? {}) as Record<string, unknown>;
    assert.equal(Object.hasOwn(standardMetrics, "phaseMs"), false);
    assert.equal(Object.hasOwn(standardMetrics, "cache"), false);

    const serializedStandard = JSON.stringify(standard);
    assert.equal(serializedStandard.includes(root), false, "standard output must never leak the repo's absolute filesystem path");
    assert.equal(serializedStandard.includes(".m2/repository"), false, "no Maven jar cache path leaks");
    assert.equal(serializedStandard.includes("JavaVirtualMachines"), false, "no JDK source path leaks");

    // Diagnostic mode is additive on top of the same base contract, not a
    // different shape - the file-level provider attribution reappears, but
    // the top-level V6 fields are unchanged.
    const diagnosticFiles = diagnostic.files as Array<Record<string, unknown>>;
    assert.ok(diagnosticFiles.some(file => Object.hasOwn(file, "reasons")), "diagnostic mode must expose provider attribution the standard mode hides");
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
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
    state: started ? "READY" : "NEW",
    started,
    restartBackoff: { consecutiveFailures: 0, blockedUntilExplicitReset: false },
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
