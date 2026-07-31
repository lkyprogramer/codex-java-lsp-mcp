// input: fixtures/framework-mapstruct - a real, checked-in MapStruct-flavored fixture repo (indexed
//         by a real worker, never hand-assembled facts).
// output: mapstructAdapter's isActive()/collect() behavior - source/target evidence from method
//         parameters and return types, and the @MappingTarget parameter special case.
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
import { mapstructAdapter } from "./mapstruct-adapter.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "framework-mapstruct");

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function readyRouterAt(root: string): Promise<RouterJavaIndex> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "mapstruct-fixture-cache-"));
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

test("isActive is true for the MapStruct fixture (pom.xml dependency marker)", async () => {
  const router = await readyRouter();
  try {
    const context = await frameworkContextFor(router, repoRoot, [anchor(file("src/main/java/demo/OrderMapper.java"))], []);
    assert.equal(await mapstructAdapter.isActive(context), true);
  } finally {
    await router.close();
  }
});

test("isActive is false for a fully-indexed repo with no MapStruct build marker or Java facts", async () => {
  const plainRoot = mkdtempSync(path.join(tmpdir(), "mapstruct-inactive-repo-"));
  write(plainRoot, "src/main/java/demo/Plain.java", "package demo;\nclass Plain {}\n");
  write(plainRoot, "pom.xml", "<project><artifactId>plain</artifactId></project>");
  const router = await readyRouterAt(plainRoot);
  try {
    const context = await frameworkContextFor(router, plainRoot, [anchor(path.join(plainRoot, "src/main/java/demo/Plain.java"))], []);
    assert.equal(await mapstructAdapter.isActive(context), false);
  } finally {
    await router.close();
  }
});

test("collect links OrderMapper.toResponse's parameter as SOURCE and its return type as TARGET", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const orderEntityFile = file("src/main/java/demo/OrderEntity.java");
    const orderResponseFile = file("src/main/java/demo/OrderResponse.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    assert.equal(result.outcome.completion, "COMPLETE");
    const source = signalsOf(result.outcome.evidence, "MAPSTRUCT_SOURCE");
    assert.ok(source.some(s => s.candidateFile === orderEntityFile && s.sourceFile === orderMapperFile));

    const target = signalsOf(result.outcome.evidence, "MAPSTRUCT_TARGET");
    assert.ok(target.some(s => s.candidateFile === orderResponseFile), "toResponse's return type is a target");

    const candidatePaths = new Set(result.outcome.candidates.map(candidate => candidate.absolutePath));
    assert.ok(candidatePaths.has(orderEntityFile));
    assert.ok(candidatePaths.has(orderResponseFile));
  } finally {
    await router.close();
  }
});

test("collect treats a @MappingTarget parameter as TARGET, not SOURCE, on a void update method", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const orderResponseFile = file("src/main/java/demo/OrderResponse.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    const target = signalsOf(result.outcome.evidence, "MAPSTRUCT_TARGET").filter(s => s.detail?.includes("updateResponse"));
    assert.equal(target.length, 1, "the @MappingTarget parameter on the void updateResponse method is the only target for that method");
    assert.equal(target[0]!.candidateFile, orderResponseFile);

    const source = signalsOf(result.outcome.evidence, "MAPSTRUCT_SOURCE").filter(s => s.detail?.includes("updateResponse"));
    assert.equal(source.length, 1, "updateResponse's non-@MappingTarget parameter (source) is still a SOURCE");
  } finally {
    await router.close();
  }
});
