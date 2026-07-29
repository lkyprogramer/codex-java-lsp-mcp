// input: A complete JavaIndex V2 fixture and a router with rg disabled for index-backed relations.
// output: End-to-end proof that AgentRouter consumes async V2 facts without falling back to a repository scan.
// pos: Task 22 router integration and no-hidden-rg-fallback coverage.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRouter } from "../agent-router/index.js";
import type { ImpactOptions } from "../agent-types.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { createGitWorktreeFamily } from "../test-support/git-worktree.js";
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
    const router = new AgentRouter(root, new NoLspSession() as never, index, undefined, undefined, undefined, rg);
    const impact = await router.impact(options({
      anchors: [{ file: gateway, line: 4, column: 18 }],
      profile: "port",
      taskKeywords: ["payment"]
    }));

    assert.ok(rg.calls > 0, "normal naming recall remains a separate asynchronous collector");
    const implementationCandidate = impact.files.find(file => String(file.path).endsWith("GatewayImpl.java"));
    assert.ok(implementationCandidate, "implementation candidate must come from JavaIndex");
    assert.ok(
      Array.isArray(implementationCandidate.reasons) && implementationCandidate.reasons.includes("typeGraph:implementation-lookup"),
      "interface implementations must retain their protected static-evidence reason"
    );
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shadowRanking is populated end-to-end only when JAVA_LSP_SHADOW_RANKING=1 and verbosity=diagnostic, and never leaks into standard verbosity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-index-router-shadow-ranking-"));
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
  const previousFlag = process.env.JAVA_LSP_SHADOW_RANKING;
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
      undefined,
      new FixedFileRgRunner(processor)
    );
    const anchors = [{ file: request, line: 3, column: 15 }];

    process.env.JAVA_LSP_SHADOW_RANKING = "1";
    const diagnosticImpact = await router.impact(options({
      anchors,
      profile: "dto",
      mode: "balanced",
      readPlanMaxItems: 2,
      verbosity: "diagnostic"
    }));
    assert.ok(diagnosticImpact.shadowRanking, "flag on + diagnostic verbosity must populate shadowRanking");
    const shadow = diagnosticImpact.shadowRanking as { categoryFidelity: string; candidates: Array<{ path: string }> };
    assert.equal(shadow.categoryFidelity, "approximate");
    assert.ok(
      shadow.candidates.some(item => item.path.endsWith("OrderProcessor.java")),
      "the naming-recall candidate must appear in the shadow ranking too"
    );

    const standardImpact = await router.impact(options({
      anchors,
      profile: "dto",
      mode: "balanced",
      readPlanMaxItems: 2,
      verbosity: "standard"
    }));
    assert.equal(standardImpact.shadowRanking, undefined, "standard verbosity must never carry shadowRanking, flag or not");

    delete process.env.JAVA_LSP_SHADOW_RANKING;
    const flagOffImpact = await router.impact(options({
      anchors,
      profile: "dto",
      mode: "balanced",
      readPlanMaxItems: 2,
      verbosity: "diagnostic"
    }));
    assert.equal(flagOffImpact.shadowRanking, undefined, "diagnostic verbosity without the flag must not compute shadowRanking");
  } finally {
    if (previousFlag === undefined) {
      delete process.env.JAVA_LSP_SHADOW_RANKING;
    } else {
      process.env.JAVA_LSP_SHADOW_RANKING = previousFlag;
    }
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
    const linkedImplementationFile = await writeJava(family.linked, implementationPath, linkedImplementation);

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
      undefined,
      new EmptyRgRunner()
    );
    const beforeRefresh = await router.impact(options({
      anchors: [{ file: gatewayPath, line: 3, column: 12 }],
      profile: "port"
    }));
    assert.equal(
      beforeRefresh.files.some(file => String(file.path).endsWith("GatewayImpl.java")),
      false,
      "the changed implementation must not be borrowed from the sibling snapshot"
    );

    await linkedIndex.ensureFresh([linkedImplementationFile], 2);
    const afterRefresh = await router.impact(options({
      anchors: [{ file: gatewayPath, line: 3, column: 12 }],
      profile: "port"
    }));
    assert.ok(
      afterRefresh.files.some(file => String(file.path).endsWith("GatewayImpl.java")),
      "after target foreground refresh, the linked worktree implementation must be selected"
    );
  } finally {
    await linkedIndex?.close();
    await primaryClient.close().catch(() => undefined);
    await rm(path.dirname(family.primary), { recursive: true, force: true });
    await rm(cacheBase, { recursive: true, force: true });
  }
});
