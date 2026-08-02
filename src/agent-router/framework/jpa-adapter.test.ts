// input: fixtures/framework-jpa - a real, checked-in JPA/Spring-Data-flavored fixture repo
//         (indexed by a real worker, never hand-assembled facts).
// output: jpaAdapter's isActive()/collect() behavior - repository-entity linking (via the
//         extends/implements projection from Task 29 commit 1), single- and collection-valued
//         entity relations, derived-query method-anchor scoping, and ambiguous-generic safety.
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
import { jpaAdapter } from "./jpa-adapter.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "framework-jpa");

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function readyRouterAt(root: string): Promise<RouterJavaIndex> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "jpa-fixture-cache-"));
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

test("isActive is true for the JPA fixture (pom.xml dependency marker)", async () => {
  const router = await readyRouter();
  try {
    const context = await frameworkContextFor(router, repoRoot, [anchor(file("src/main/java/demo/OrderRepository.java"))], []);
    assert.equal(await jpaAdapter.isActive(context), true);
  } finally {
    await router.close();
  }
});

test("isActive is false for a fully-indexed repo with no JPA build marker or Java facts", async () => {
  const plainRoot = mkdtempSync(path.join(tmpdir(), "jpa-inactive-repo-"));
  write(plainRoot, "src/main/java/demo/Plain.java", "package demo;\nclass Plain {}\n");
  write(plainRoot, "pom.xml", "<project><artifactId>plain</artifactId></project>");
  const router = await readyRouterAt(plainRoot);
  try {
    const context = await frameworkContextFor(router, plainRoot, [anchor(path.join(plainRoot, "src/main/java/demo/Plain.java"))], []);
    assert.equal(await jpaAdapter.isActive(context), false);
  } finally {
    await router.close();
  }
});

test("collect links OrderRepository to its JpaRepository<OrderEntity, Long> entity argument", async () => {
  const router = await readyRouter();
  try {
    const repositoryFile = file("src/main/java/demo/OrderRepository.java");
    const entityFile = file("src/main/java/demo/OrderEntity.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(repositoryFile)], [repositoryFile]);

    const result = await runFrameworkAdapters([jpaAdapter], context);

    assert.equal(result.outcome.completion, "COMPLETE");
    const repositoryEntity = signalsOf(result.outcome.evidence, "JPA_REPOSITORY_ENTITY");
    assert.equal(repositoryEntity.length, 1);
    assert.equal(repositoryEntity[0]!.candidateFile, entityFile);
    assert.equal(repositoryEntity[0]!.sourceFile, repositoryFile);

    const candidatePaths = new Set(result.outcome.candidates.map(candidate => candidate.absolutePath));
    assert.ok(candidatePaths.has(entityFile));
  } finally {
    await router.close();
  }
});

test("collect emits JPA_DERIVED_QUERY only for the anchored method, scoped like every other pack's method-level evidence", async () => {
  const router = await readyRouter();
  try {
    const repositoryFile = file("src/main/java/demo/OrderRepository.java");
    const entityFile = file("src/main/java/demo/OrderEntity.java");
    const findByAnchor = anchor(repositoryFile, { kind: "method", symbolName: "findByCustomerId", line: 11 });
    const context = await frameworkContextFor(router, repoRoot, [findByAnchor], [repositoryFile]);

    const result = await runFrameworkAdapters([jpaAdapter], context);

    const derivedQuery = signalsOf(result.outcome.evidence, "JPA_DERIVED_QUERY");
    assert.equal(derivedQuery.length, 1, "only findByCustomerId is anchored - countByCustomerId must not also fire");
    assert.equal(derivedQuery[0]!.detail, "OrderRepository.findByCustomerId() derived query");
    assert.equal(derivedQuery[0]!.candidateFile, entityFile);

    // Repository-entity evidence is type-level, unaffected by the method anchor.
    assert.equal(signalsOf(result.outcome.evidence, "JPA_REPOSITORY_ENTITY").length, 1);
  } finally {
    await router.close();
  }
});

test("collect requires By after a derived-query prefix, excluding findAll and getFoo", async () => {
  const router = await readyRouter();
  try {
    const repositoryFile = file("src/main/java/demo/OrderRepository.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(repositoryFile)], [repositoryFile]);

    const result = await runFrameworkAdapters([jpaAdapter], context);

    assert.deepEqual(
      signalsOf(result.outcome.evidence, "JPA_DERIVED_QUERY").map(signal => signal.detail).sort(),
      [
        "OrderRepository.countByCustomerId() derived query",
        "OrderRepository.findByCustomerId() derived query"
      ],
      "findAll and getFoo are repository methods, not conservative prefix-plus-By derived-query matches"
    );
  } finally {
    await router.close();
  }
});

test("collect links a single-valued (@ManyToOne) and a collection-valued (@OneToMany List<...>) entity relation, both ways", async () => {
  const router = await readyRouter();
  try {
    const orderEntityFile = file("src/main/java/demo/OrderEntity.java");
    const customerEntityFile = file("src/main/java/demo/CustomerEntity.java");
    const context = await frameworkContextFor(
      router, repoRoot,
      [anchor(orderEntityFile)],
      [orderEntityFile, customerEntityFile]
    );

    const result = await runFrameworkAdapters([jpaAdapter], context);

    const relations = signalsOf(result.outcome.evidence, "JPA_ENTITY_RELATION");
    assert.ok(
      relations.some(s => s.sourceFile === orderEntityFile && s.candidateFile === customerEntityFile),
      "OrderEntity.customer (@ManyToOne) must resolve directly to CustomerEntity"
    );
    assert.ok(
      relations.some(s => s.sourceFile === customerEntityFile && s.candidateFile === orderEntityFile),
      "CustomerEntity.orders (@OneToMany List<OrderEntity>) must resolve to OrderEntity via its generic type argument, not to java.util.List"
    );
  } finally {
    await router.close();
  }
});

test("collect produces no repository-entity evidence for an ambiguous generic argument", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "jpa-ambiguous-generic-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.springframework.data</groupId></dependency></dependencies></project>");
  write(root, "src/main/java/a/OrderEntity.java", "package a;\nclass OrderEntity {}\n");
  write(root, "src/main/java/b/OrderEntity.java", "package b;\nclass OrderEntity {}\n");
  write(
    root,
    "src/main/java/demo/OrderRepository.java",
    [
      "package demo;",
      "import org.springframework.data.jpa.repository.JpaRepository;",
      // No import for OrderEntity - "a.OrderEntity" and "b.OrderEntity" both
      // exist, so the repo-unique-simple-name fallback cannot disambiguate.
      "interface OrderRepository extends JpaRepository<OrderEntity, Long> {}",
      ""
    ].join("\n")
  );
  const router = await readyRouterAt(root);
  try {
    const repositoryFile = path.join(root, "src/main/java/demo/OrderRepository.java");
    const context = await frameworkContextFor(router, root, [anchor(repositoryFile)], [repositoryFile]);

    const result = await runFrameworkAdapters([jpaAdapter], context);

    assert.equal(signalsOf(result.outcome.evidence, "JPA_REPOSITORY_ENTITY").length, 0);
    assert.equal(signalsOf(result.outcome.evidence, "JPA_DERIVED_QUERY").length, 0, "no resolved entity means no derived-query target to point at either");
  } finally {
    await router.close();
  }
});
