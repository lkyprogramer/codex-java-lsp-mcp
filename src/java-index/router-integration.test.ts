// input: A complete JavaIndex V2 fixture and a router with rg disabled for index-backed relations.
// output: End-to-end proof that AgentRouter consumes async V2 facts without falling back to a repository scan.
// pos: Task 22 router integration and no-hidden-rg-fallback coverage.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { AgentRouter } from "../agent-router/index.js";
import type { ImpactOptions } from "../agent-types.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { createGitWorktreeFamily } from "../test-support/git-worktree.test.js";
import { resolveWorktreeIdentity } from "../worktree-identity.js";
import { JavaIndexClient } from "./java-index-client.js";
import { RouterJavaIndex } from "./router-java-index.js";

function options(overrides: Partial<ImpactOptions>): ImpactOptions {
  return {
    anchors: [],
    mode: "balanced",
    profile: "auto",
    semanticPolicy: "fast",
    semanticTimeoutMs: 200,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    ...overrides
  };
}

class EmptyRgRunner extends RgRunner {
  calls = 0;

  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    this.calls += 1;
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
}

/**
 * Simulates ordinary naming recall finding a source file before the static
 * collector does. The router must merge V2 evidence into that existing
 * candidate instead of silently treating it as a duplicate.
 */
class FixedFileRgRunner extends RgRunner {
  constructor(private readonly matchPath: string) {
    super();
  }

  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    return {
      files: [{ absolutePath: this.matchPath, matchCount: 1, positions: [{ line: 3, column: 1 }] }],
      completion: "COMPLETE",
      rawBytes: 64,
      totalMatches: 1,
      elapsedMs: 0
    };
  }
}

class RecordingJavaIndexClient extends JavaIndexClient {
  refreshCalls = 0;

  override async refresh(generation: number, changed: string[], deleted: string[]) {
    this.refreshCalls += 1;
    return super.refresh(generation, changed, deleted);
  }
}

class NoLspSession {
  cacheStatus(): { invalidations: number; entries: number; hits: number; misses: number } {
    return { invalidations: 0, entries: 0, hits: 0, misses: 0 };
  }

  status(): { started: boolean; progress: { active: number } } {
    return { started: false, progress: { active: 0 } };
  }

  async semanticLocations(): Promise<{ definitions: []; implementations: [] }> {
    return { definitions: [], implementations: [] };
  }

  async references(): Promise<{ items: []; totalReferences: number; truncated: boolean }> {
    return { items: [], totalReferences: 0, truncated: false };
  }

  async typeHierarchy(): Promise<{ roots: []; edges: []; truncated: boolean }> {
    return { roots: [], edges: [], truncated: false };
  }
}

async function waitForCompleteIndex(index: RouterJavaIndex): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await index.routerStatus();
    if (status.coverage === "complete") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("fixture JavaIndex did not reach complete coverage within 2 seconds");
}

async function waitForBackgroundSweep(client: JavaIndexClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await client.status()).pendingBackground === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("fixture JavaIndex background sweep did not settle within 2 seconds");
}

async function buildCompleteSnapshot(root: string, cacheDir: string): Promise<void> {
  const client = new JavaIndexClient(root, cacheDir);
  try {
    await client.open(0);
    await client.reconcile(0);
    await waitForBackgroundSweep(client);
  } finally {
    await client.close();
  }
}

async function writeJava(root: string, relativePath: string, content: string): Promise<string> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}

test("complete JavaIndex resolves implementation relations even when naming recall is empty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-index-router-integration-"));
  const sourceDir = path.join(root, "src", "main", "java", "demo");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const gateway = path.join(sourceDir, "Gateway.java");
  const implementation = path.join(sourceDir, "GatewayImpl.java");
  const service = path.join(sourceDir, "PaymentService.java");
  const command = path.join(sourceDir, "PaymentCommand.java");
  const result = path.join(sourceDir, "PaymentResult.java");
  const complex = path.join(sourceDir, "ComplexJava.java");
  await writeFile(gateway, [
    "package demo;",
    "",
    "interface Gateway {",
    "  PaymentResult pay(PaymentCommand command);",
    "}",
    ""
  ].join("\n"));
  await writeFile(implementation, [
    "package demo;",
    "",
    "final class GatewayImpl implements Gateway {",
    "  public PaymentResult pay(PaymentCommand command) { return new PaymentResult(true); }",
    "}",
    ""
  ].join("\n"));
  await writeFile(service, [
    "package demo;",
    "",
    "final class PaymentService {",
    "  private final Gateway gateway;",
    "  PaymentService(Gateway gateway) { this.gateway = gateway; }",
    "  PaymentResult submit(PaymentCommand command) { return gateway.pay(command); }",
    "}",
    ""
  ].join("\n"));
  await writeFile(command, "package demo;\nrecord PaymentCommand(String id) {}\n");
  await writeFile(result, "package demo;\nrecord PaymentResult(boolean accepted) {}\n");
  await writeFile(complex, [
    "package demo;",
    "",
    "final class ComplexJava {",
    "  PaymentResult packagePrivate(PaymentCommand command) {",
    "    Helper helper = new Helper();",
    "    return new PaymentResult(helper.valid());",
    "  }",
    "  static class Helper { boolean valid() { return true; } }",
    "}",
    ""
  ].join("\n"));

  const client = new JavaIndexClient(root, path.join(root, ".cache"));
  const originalQueryFiles = client.queryFiles.bind(client);
  const originalQueryTypes = client.queryTypes.bind(client);
  let definitionFileQueryCount = 0;
  let definitionTypeBatchCount = 0;
  client.queryFiles = async files => {
    definitionFileQueryCount += 1;
    return originalQueryFiles(files);
  };
  client.queryTypes = async queries => {
    definitionTypeBatchCount += 1;
    return originalQueryTypes(queries);
  };
  const index = new RouterJavaIndex(root, client);
  try {
    await index.open(0);
    await index.reconcile(0);
    await waitForCompleteIndex(index);

    const complexBundle = (await index.queryFiles([complex]))[0]!;
    const packagePrivate = complexBundle.methods.find(method => method.name === "packagePrivate")!;
    const packagePrivateAnchor = await index.queryAnchor(
      complex,
      packagePrivate.range.start.line,
      packagePrivate.range.start.column
    );
    assert.equal(packagePrivateAnchor?.method?.name, "packagePrivate");
    assert.ok(complexBundle.types.some(type => type.simpleName === "Helper"), "nested type must be indexed");

    const implementers = await index.findImplementers("Gateway");
    assert.deepEqual(implementers.map(facts => path.basename(facts.absolutePath)), ["GatewayImpl.java"]);

    definitionFileQueryCount = 0;
    definitionTypeBatchCount = 0;
    const collaborators = await index.findTypeDefinitions(["PaymentCommand", "PaymentResult"]);
    assert.deepEqual(
      collaborators.map(facts => path.basename(facts.absolutePath)).sort(),
      ["PaymentCommand.java", "PaymentResult.java"]
    );
    assert.equal(
      definitionFileQueryCount,
      1,
      "resolved type definitions must hydrate their file facts in one worker batch"
    );
    assert.equal(
      definitionTypeBatchCount,
      1,
      "independent type definitions must use one worker lookup batch"
    );
    const commandFacts = await index.factsFor(command);
    assert.equal(commandFacts.typeName, "PaymentCommand");
    assert.equal(
      definitionFileQueryCount,
      1,
      "definition results must seed the router facts cache for later rank scoring"
    );
    definitionFileQueryCount = 0;
    const lightweightCollaborators = await index.findTypeDefinitions(["PaymentCommand", "PaymentResult"], 20, false);
    assert.deepEqual(
      lightweightCollaborators.map(facts => path.basename(facts.absolutePath)).sort(),
      ["PaymentCommand.java", "PaymentResult.java"]
    );
    assert.equal(
      definitionFileQueryCount,
      0,
      "candidate-only type lookup must not transfer full Java file bundles"
    );
    assert.deepEqual(
      (await index.findTypeDefinitions(["PaymentResult", "PaymentCommand"], 1)).map(facts => path.basename(facts.absolutePath)),
      ["PaymentResult.java"],
      "a definition limit must preserve the caller's direct-reference priority"
    );

    const gatewayBundle = (await index.queryFiles([gateway]))[0]!;
    const gatewayPay = gatewayBundle.methods.find(method => method.name === "pay")!;
    const callers = await index.queryCallers(gatewayPay.methodId, 10);
    assert.ok(callers.some(caller => caller.sourceFile.endsWith("PaymentService.java")), "method call must be indexed");
    assert.equal((await index.routerStatus()).coverage, "complete");

    const rg = new EmptyRgRunner();
    const router = new AgentRouter(root, new NoLspSession() as never, index, undefined, undefined, rg);
    const impact = await router.impact(options({
      anchors: [{ file: gateway, line: 4, column: 18 }],
      profile: "port",
      taskKeywords: ["payment"],
      verbosity: "diagnostic"
    }));

    assert.ok(rg.calls > 0, "normal naming recall remains a separate asynchronous collector");
    const implementationCandidate = impact.files.find(file => String(file.path).endsWith("GatewayImpl.java"));
    assert.ok(implementationCandidate, "implementation candidate must come from JavaIndex");
    assert.ok(
      Array.isArray(implementationCandidate.reasons) && implementationCandidate.reasons.includes("typeGraph:implementation-lookup"),
      "interface implementations must retain their protected static-evidence reason"
    );
    const commandCandidate = impact.files.find(file => String(file.path).endsWith("PaymentCommand.java"));
    assert.ok(commandCandidate, "the method parameter must be a production candidate");
    assert.ok(
      Array.isArray(commandCandidate.scoreBreakdown)
      && commandCandidate.scoreBreakdown.some(item => item.id === "finalize.method-relation" && item.delta > 0),
      "standard production ranking must retain method-relation evidence rather than only adding it in shadow diagnostics"
    );

    const multiAnchorOptions = options({
      anchors: [
        { file: gateway, line: 4, column: 18 },
        { file: service, line: 6, column: 17 }
      ],
      profile: "auto",
      taskKeywords: ["payment"],
      verbosity: "diagnostic"
    });
    const forward = await router.impact(multiAnchorOptions);
    const reversed = await router.impact({
      ...multiAnchorOptions,
      anchors: [...multiAnchorOptions.anchors].reverse()
    });
    assert.deepEqual(
      forward.files.map(file => file.path),
      reversed.files.map(file => file.path),
      "swapping A1/A2 must not change the candidate order"
    );
    assert.deepEqual(
      forward.readPlan.map(item => forward.files.find(file => file.id === item.fileId)?.path),
      reversed.readPlan.map(item => reversed.files.find(file => file.id === item.fileId)?.path),
      "swapping A1/A2 must not change the read-plan order"
    );
    const readPlanPaths = forward.readPlan.map(item =>
      forward.files.find(file => file.id === item.fileId)?.path ?? "");
    assert.ok(readPlanPaths.some(file => file.endsWith("Gateway.java")));
    assert.ok(readPlanPaths.some(file => file.endsWith("PaymentService.java")));
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected own snapshot stays pending until its replacement sweep has been installed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-index-snapshot-reconcile-race-"));
  const cacheDir = path.join(root, ".cache");
  let replacementClient: JavaIndexClient | undefined;
  try {
    for (let index = 0; index < 300; index += 1) {
      await writeJava(
        root,
        `src/main/java/demo/Type${index}.java`,
        `package demo; class Type${index} {}`
      );
    }
    await buildCompleteSnapshot(root, cacheDir);

    const snapshotPath = path.join(cacheDir, "java-index-snapshot.json.gz");
    const snapshot = JSON.parse(gunzipSync(await readFile(snapshotPath)).toString("utf8")) as Record<string, unknown>;
    snapshot.extractorVersion = "intentionally-stale";
    await writeFile(snapshotPath, gzipSync(JSON.stringify(snapshot)));

    replacementClient = new JavaIndexClient(root, cacheDir);
    const replacementIndex = new RouterJavaIndex(root, replacementClient);
    await replacementIndex.open(0);

    let observedIdleEmptyIndex = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const status = await replacementClient.status();
      if (status.pendingBackground === 0 && status.files === 0) {
        observedIdleEmptyIndex = true;
        break;
      }
      if (status.files === 300 && status.pendingBackground === 0) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    assert.equal(
      observedIdleEmptyIndex,
      false,
      "a caller must not observe an idle empty index between rejected snapshot hydration and its replacement sweep"
    );
    await waitForCompleteIndex(replacementIndex);
  } finally {
    await replacementClient?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("production ranking observer sees the exact in-request family rank and selected read plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-index-router-production-ranking-"));
  const request = await writeJava(root, "src/main/java/demo/api/OrderRequest.java", [
    "package demo.api;",
    "",
    "public record OrderRequest(String id) {}",
    ""
  ].join("\n"));
  const processor = await writeJava(root, "src/main/java/demo/service/OrderProcessor.java", [
    "package demo.service;",
    "",
    "import demo.api.*;",
    "",
    "public final class OrderProcessor {",
    "  public void process(OrderRequest request) {}",
    "}",
    ""
  ].join("\n"));
  const index = new RouterJavaIndex(root, new JavaIndexClient(root, path.join(root, ".cache")));
  try {
    await index.open(0);
    await index.reconcile(0);
    await waitForCompleteIndex(index);

    const router = new AgentRouter(
      root,
      new NoLspSession() as never,
      index,
      undefined,
      undefined,
      new FixedFileRgRunner(processor)
    );
    const anchors = [{ file: request, line: 3, column: 15 }];

    let observed: {
      ranked: readonly import("../agent-router/evidence.js").CandidateEvidence[];
      selectedPaths: readonly string[];
    } | undefined;
    const diagnosticImpact = await router.impact(options({
      anchors,
      profile: "dto",
      mode: "balanced",
      readPlanMaxItems: 2,
      verbosity: "diagnostic"
    }), undefined, {
      productionRanking(ranked, selectedPaths) {
        observed = { ranked, selectedPaths };
      }
    });
    assert.ok(observed, "the benchmark-only observer must receive the final production rank");
    assert.ok(
      observed.ranked.some(item => item.file.endsWith("OrderProcessor.java")),
      "the naming-recall candidate must appear in the production family rank"
    );
    assert.deepEqual(
      [...observed.selectedPaths].sort(),
      diagnosticImpact.readPlan.map(item => diagnosticImpact.files.find(file => file.id === item.fileId)?.path)
        .filter((item): item is string => item !== undefined)
        .map(item => path.join(root, item))
        .sort(),
      "observer selected paths must be the same buildReadPlan selection exposed by the request"
    );
    assert.equal("shadowRanking" in (diagnosticImpact.metrics ?? {}), false);

    const standardImpact = await router.impact(options({
      anchors,
      profile: "dto",
      mode: "balanced",
      readPlanMaxItems: 2,
      verbosity: "standard"
    }));
    assert.equal("shadowRanking" in (standardImpact.metrics ?? {}), false);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("V2 type-reference evidence upgrades a candidate that naming recall found first", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-index-router-static-merge-"));
  const request = await writeJava(root, "src/main/java/demo/api/OrderRequest.java", [
    "package demo.api;",
    "",
    "public record OrderRequest(String id) {}",
    ""
  ].join("\n"));
  const processor = await writeJava(root, "src/main/java/demo/service/OrderProcessor.java", [
    "package demo.service;",
    "",
    "import demo.api.*;",
    "",
    "public final class OrderProcessor {",
    "  public void process(OrderRequest request) {}",
    "}",
    ""
  ].join("\n"));
  const index = new RouterJavaIndex(root, new JavaIndexClient(root, path.join(root, ".cache")));
  try {
    await index.open(0);
    await index.reconcile(0);
    await waitForCompleteIndex(index);

    const router = new AgentRouter(
      root,
      new NoLspSession() as never,
      index,
      undefined,
      undefined,
      new FixedFileRgRunner(processor)
    );
    const impact = await router.impact(options({
      anchors: [{ file: request, line: 3, column: 15 }],
      profile: "dto",
      mode: "balanced",
      readPlanMaxItems: 2,
      verbosity: "diagnostic"
    }));
    const processorCandidate = impact.files.find(file => String(file.path).endsWith("OrderProcessor.java"));

    assert.ok(processorCandidate, "ordinary naming recall should return the processor first");
    assert.ok(
      Array.isArray(processorCandidate.verifiedBy) && processorCandidate.verifiedBy.includes("typeReference"),
      "V2 type-reference facts must merge into an existing naming candidate"
    );
    const processorId = String(processorCandidate.id);
    assert.ok(
      impact.readPlan.some(item => item.fileId === processorId),
      "the merged static evidence must protect the candidate's read-plan slot"
    );
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("RouterJavaIndex reuses facts refreshed at the current generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-index-router-facts-cache-"));
  const source = await writeJava(root, "src/main/java/demo/Demo.java", "package demo;\nclass Demo { void run() {} }\n");
  const client = new RecordingJavaIndexClient(root, path.join(root, ".cache"));
  const index = new RouterJavaIndex(root, client);
  try {
    await index.open(0);
    await index.factsFor(source, 0);
    await index.factsFor(source, 0);
    assert.equal(client.refreshCalls, 1, "same-generation fact reads must not reparse the same file");
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("RouterJavaIndex reuses COMPLETE coverage without reparsing an indexed candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-index-router-complete-facts-cache-"));
  const source = await writeJava(root, "src/main/java/demo/Demo.java", "package demo;\nclass Demo { void run() {} }\n");
  const client = new RecordingJavaIndexClient(root, path.join(root, ".cache"));
  const index = new RouterJavaIndex(root, client);
  try {
    await index.open(0);
    await index.reconcile(0);
    await waitForCompleteIndex(index);
    client.refreshCalls = 0;

    await index.factsFor(source, 0);

    assert.equal(client.refreshCalls, 0, "COMPLETE coverage at the request generation already proves this file is fresh");
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sibling-seeded V2 router never returns a stale implementation before its foreground refresh", async () => {
  const family = await createGitWorktreeFamily();
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-index-router-seed-cache-"));
  const gatewayPath = "src/main/java/demo/Gateway.java";
  const commandPath = "src/main/java/demo/PaymentCommand.java";
  const implementationPath = "src/main/java/demo/GatewayImpl.java";
  // Sits under a test source root so it is outside both the sibling-seed's
  // exact-content reuse (excluded like GatewayImpl below) and the bounded
  // foreground implementer scan's roots, which are main-only (router-java-index.ts's
  // foregroundImplementationRoots filters to sourceSet === "main"). It must
  // therefore stay unresolved - never surfaced with primary's stale content -
  // even after the main-root implementation below self-heals.
  const testImplementationPath = "src/test/java/demo/TestGatewayImpl.java";
  const gateway = [
    "package demo;",
    "",
    "interface Gateway { PaymentResult pay(PaymentCommand command); }",
    ""
  ].join("\n");
  const command = "package demo;\nrecord PaymentCommand(String id) {}\nrecord PaymentResult(boolean accepted) {}\n";
  const primaryImplementation = [
    "package demo;",
    "",
    "final class GatewayImpl implements Gateway {",
    "  public PaymentResult pay(PaymentCommand command) { return new PaymentResult(false); }",
    "}",
    ""
  ].join("\n");
  const linkedImplementation = [
    "package demo;",
    "",
    "final class GatewayImpl implements Gateway {",
    "  public PaymentResult pay(PaymentCommand command) { return new PaymentResult(true); }",
    "  String linkedOnlyBehavior() { return \"linked\"; }",
    "}",
    ""
  ].join("\n");
  const primaryTestImplementation = [
    "package demo;",
    "",
    "final class TestGatewayImpl implements Gateway {",
    "  public PaymentResult pay(PaymentCommand command) { return new PaymentResult(false); }",
    "}",
    ""
  ].join("\n");
  const linkedTestImplementation = [
    "package demo;",
    "",
    "final class TestGatewayImpl implements Gateway {",
    "  public PaymentResult pay(PaymentCommand command) { return new PaymentResult(true); }",
    "  String linkedTestOnlyBehavior() { return \"linked-test\"; }",
    "}",
    ""
  ].join("\n");
  const primaryCache = path.join(cacheBase, "primary");
  const linkedCache = path.join(cacheBase, "linked");
  const primaryClient = new JavaIndexClient(family.primary, primaryCache);
  let linkedIndex: RouterJavaIndex | undefined;
  try {
    for (const root of [family.primary, family.linked]) {
      await writeJava(root, gatewayPath, gateway);
      await writeJava(root, commandPath, command);
    }
    await writeJava(family.primary, implementationPath, primaryImplementation);
    await writeJava(family.primary, testImplementationPath, primaryTestImplementation);
    const linkedImplementationFile = await writeJava(family.linked, implementationPath, linkedImplementation);
    await writeJava(family.linked, testImplementationPath, linkedTestImplementation);

    await primaryClient.open(1);
    await primaryClient.reconcile(1);
    await waitForBackgroundSweep(primaryClient);
    await primaryClient.close();
    const primaryIdentity = await resolveWorktreeIdentity(family.primary);
    await writeFile(
      path.join(primaryCache, "repo-meta.json"),
      JSON.stringify({
        repoRoot: family.primary,
        repoHash: primaryIdentity.repoHash,
        familyHash: primaryIdentity.familyHash
      })
    );

    const linkedIdentity = await resolveWorktreeIdentity(family.linked);
    linkedIndex = new RouterJavaIndex(
      family.linked,
      new JavaIndexClient(family.linked, linkedCache)
    );
    await linkedIndex.open(2, { worktree: linkedIdentity, siblingCacheBase: cacheBase });
    assert.equal((await linkedIndex.routerStatus()).openSource, "sibling-seed");

    const router = new AgentRouter(
      family.linked,
      new NoLspSession() as never,
      linkedIndex,
      undefined,
      undefined,
      new EmptyRgRunner()
    );
    const beforeRefresh = await router.impact(options({
      anchors: [{ file: gatewayPath, line: 3, column: 12 }],
      profile: "port",
      // "include" (not the file default "defer") so TestGatewayImpl's
      // absence below is isolated to the foreground implementer scan's
      // main-only roots, not conflated with generic test-file deferral.
      testReadMode: "include"
    }));
    const beforeMainImpl = beforeRefresh.files.find(file => String(file.path).endsWith("GatewayImpl.java") && !String(file.path).includes("Test"));
    if (beforeMainImpl) {
      // The router's bounded foreground closure (V3.2-17) may proactively
      // self-heal an anchor-adjacent interface's implementer before this
      // test's own explicit refresh below - that is expected. What must
      // never happen is surfacing it with primary's excluded, sibling-borrowed
      // content instead of a genuine re-parse of the linked worktree's file.
      const beforeFacts = await linkedIndex.factsFor(linkedImplementationFile, 2);
      assert.ok(
        beforeFacts.methods.some(method => method.name === "linkedOnlyBehavior"),
        "an implementation surfacing before explicit refresh must be the linked worktree's real content, never primary's stale sibling-borrowed fact"
      );
    }
    assert.equal(
      beforeRefresh.files.some(file => String(file.path).endsWith("TestGatewayImpl.java")),
      false,
      "an implementer outside the bounded foreground scan's main-only roots must stay unresolved, not fall back to primary's stale content"
    );

    await linkedIndex.ensureFresh([linkedImplementationFile], 2);
    const afterRefresh = await router.impact(options({
      anchors: [{ file: gatewayPath, line: 3, column: 12 }],
      profile: "port"
    }));
    assert.ok(
      afterRefresh.files.some(file => String(file.path).endsWith("GatewayImpl.java") && !String(file.path).includes("Test")),
      "after target foreground refresh, the linked worktree implementation must be selected"
    );
  } finally {
    await linkedIndex?.close();
    await primaryClient.close().catch(() => undefined);
    await rm(path.dirname(family.primary), { recursive: true, force: true });
    await rm(cacheBase, { recursive: true, force: true });
  }
});
