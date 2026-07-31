// input: fixtures/framework-mybatis - a real, checked-in MyBatis-flavored fixture repo (indexed by
//         a real worker, never hand-assembled facts).
// output: mybatisAdapter's isActive()/collect() behavior against real extracted+resolved facts -
//         namespace/statement/parameter/result-type/resultMap evidence, overload ambiguity, and
//         method-anchor scoping.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedAnchor } from "../../agent-types.js";
import { RouterJavaIndex } from "../../java-index/router-java-index.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { FrameworkAdapterContext } from "./adapter.js";
import type { CandidateEvidence, EvidenceSignal } from "../evidence.js";
import { runFrameworkAdapters } from "./runner.js";
import { mybatisAdapter } from "./mybatis-adapter.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "framework-mybatis");

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function readyRouterAt(root: string): Promise<RouterJavaIndex> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "mybatis-fixture-cache-"));
  const router = RouterJavaIndex.create(root, cacheDir);
  await router.open(1);
  await router.reconcile(1);
  await waitFor(async () => (await router.status()).pendingBackground === 0, 15_000);
  return router;
}

async function readyRouter(): Promise<RouterJavaIndex> {
  return readyRouterAt(repoRoot);
}

function file(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function anchor(absolutePath: string, overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  return {
    id: "A1", absolutePath, line: 1, column: 1, profile: "service", symbolName: "Anchor", kind: "class",
    ...overrides
  };
}

async function frameworkContextFor(
  router: RouterJavaIndex,
  repo: string,
  anchors: readonly ResolvedAnchor[],
  candidateFiles: readonly string[]
): Promise<FrameworkAdapterContext> {
  return {
    repoRoot: repo,
    anchors,
    candidateFiles,
    staticEvidence: candidateFiles.map(candidate => ({
      file: candidate,
      signals: [],
      familyScores: { STATIC_STRUCTURE: 1 },
      finalScore: 1,
      confidence: "medium",
      degradation: []
    } satisfies CandidateEvidence)),
    frameworkIndex: router,
    generation: 1,
    budget: DeadlineBudget.fromTimeout(5_000)
  };
}

function signalsOf(evidence: readonly EvidenceSignal[], kind: string): EvidenceSignal[] {
  return evidence.filter(signal => signal.kind === kind);
}

test("isActive is true for the MyBatis fixture (pom.xml dependency marker)", async () => {
  const router = await readyRouter();
  try {
    const context = await frameworkContextFor(router, repoRoot, [anchor(file("src/main/java/demo/OrderMapper.java"))], []);
    assert.equal(await mybatisAdapter.isActive(context), true);
  } finally {
    await router.close();
  }
});

test("isActive is false for a fully-indexed repo with no MyBatis build marker or Java facts", async () => {
  const plainRoot = mkdtempSync(path.join(tmpdir(), "mybatis-inactive-repo-"));
  write(plainRoot, "src/main/java/demo/Plain.java", "package demo;\nclass Plain {}\n");
  write(plainRoot, "pom.xml", "<project><artifactId>plain</artifactId></project>");
  const router = await readyRouterAt(plainRoot);
  try {
    const context = await frameworkContextFor(router, plainRoot, [anchor(path.join(plainRoot, "src/main/java/demo/Plain.java"))], []);
    assert.equal(await mybatisAdapter.isActive(context), false);
  } finally {
    await router.close();
  }
});

test("collect links OrderMapper's namespace, both statements, and their resolved parameter/resultMap types", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const orderMapperXml = file("src/main/resources/mapper/OrderMapper.xml");
    const orderEntityFile = file("src/main/java/demo/OrderEntity.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mybatisAdapter], context);

    assert.equal(result.outcome.completion, "COMPLETE");
    const namespace = signalsOf(result.outcome.evidence, "MYBATIS_NAMESPACE");
    assert.equal(namespace.length, 1);
    assert.equal(namespace[0]!.candidateFile, orderMapperXml);
    assert.equal(namespace[0]!.sourceFile, orderMapperFile);

    const statementMethods = signalsOf(result.outcome.evidence, "MYBATIS_STATEMENT_METHOD");
    assert.equal(statementMethods.length, 2, "findById and insert are both unambiguous single-method matches");
    assert.ok(statementMethods.every(signal => signal.candidateFile === orderMapperXml));

    // findById's parameterType (java.lang.Long) is not a repo type - no evidence.
    // insert's parameterType (demo.OrderEntity) resolves to a real repo file.
    const parameterType = signalsOf(result.outcome.evidence, "MYBATIS_PARAMETER_TYPE");
    assert.equal(parameterType.length, 1);
    assert.equal(parameterType[0]!.candidateFile, orderEntityFile);
    assert.equal(parameterType[0]!.sourceFile, orderMapperXml, "type-kind evidence sources from the XML resource, not the Java interface");

    // findById has no resultType (it uses resultMap instead); insert has no result at all.
    assert.equal(signalsOf(result.outcome.evidence, "MYBATIS_RESULT_TYPE").length, 0);

    const resultMap = signalsOf(result.outcome.evidence, "MYBATIS_RESULT_MAP");
    assert.equal(resultMap.length, 1);
    assert.equal(resultMap[0]!.candidateFile, orderEntityFile);

    const candidatePaths = new Set(result.outcome.candidates.map(candidate => candidate.absolutePath));
    assert.ok(candidatePaths.has(orderMapperXml));
    assert.ok(candidatePaths.has(orderEntityFile));
  } finally {
    await router.close();
  }
});

test("collect skips MYBATIS_STATEMENT_METHOD for an ambiguous overload but still emits its resultType evidence", async () => {
  const router = await readyRouter();
  try {
    const itemMapperFile = file("src/main/java/demo/ItemMapper.java");
    const itemMapperXml = file("src/main/resources/mapper/ItemMapper.xml");
    const itemEntityFile = file("src/main/java/demo/ItemEntity.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(itemMapperFile)], [itemMapperFile]);

    const result = await runFrameworkAdapters([mybatisAdapter], context);

    assert.equal(signalsOf(result.outcome.evidence, "MYBATIS_NAMESPACE").length, 1, "namespace evidence is type-level, unaffected by method ambiguity");
    assert.equal(
      signalsOf(result.outcome.evidence, "MYBATIS_STATEMENT_METHOD").length,
      0,
      "findAll is overloaded on ItemMapper - no single method can be claimed"
    );
    const resultType = signalsOf(result.outcome.evidence, "MYBATIS_RESULT_TYPE");
    assert.equal(resultType.length, 1);
    assert.equal(resultType[0]!.candidateFile, itemEntityFile);
    assert.equal(resultType[0]!.sourceFile, itemMapperXml);

    const candidatePaths = new Set(result.outcome.candidates.map(candidate => candidate.absolutePath));
    assert.ok(candidatePaths.has(itemMapperXml));
  } finally {
    await router.close();
  }
});

test("collect scopes MYBATIS_STATEMENT_METHOD to the anchored method, but not type-kind or namespace evidence", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const insertAnchor = anchor(orderMapperFile, { kind: "method", symbolName: "insert", line: 6 });
    const context = await frameworkContextFor(router, repoRoot, [insertAnchor], [orderMapperFile]);

    const result = await runFrameworkAdapters([mybatisAdapter], context);

    const statementMethods = signalsOf(result.outcome.evidence, "MYBATIS_STATEMENT_METHOD");
    assert.equal(statementMethods.length, 1, "only the anchored insert() method is rankable");
    assert.equal(statementMethods[0]!.detail, "OrderMapper.insert() statement");

    assert.equal(signalsOf(result.outcome.evidence, "MYBATIS_NAMESPACE").length, 1, "namespace evidence is not method-scoped");
    // Both findById's and insert's type-kind evidence still fire regardless of the method anchor.
    assert.equal(signalsOf(result.outcome.evidence, "MYBATIS_PARAMETER_TYPE").length, 1);
    assert.equal(signalsOf(result.outcome.evidence, "MYBATIS_RESULT_MAP").length, 1);
  } finally {
    await router.close();
  }
});
