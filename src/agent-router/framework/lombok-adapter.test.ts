// input: fixtures/framework-lombok - a real, checked-in Lombok-flavored fixture repo
//         (indexed by a real worker, never hand-assembled facts), plus generated-code.ts's
//         own build-file detection.
// output: lombokCompleteness()'s semantics classification and task-gap gating.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameworkIndexView } from "../../java-index/framework-index-view.js";
import { RouterJavaIndex } from "../../java-index/router-java-index.js";
import { lombokCompleteness } from "./lombok-adapter.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "framework-lombok");

function unreachableFrameworkIndex(): FrameworkIndexView {
  return {
    frameworkFactsForFiles: async () => {
      throw new Error("must not be called: the build-level short-circuit should have already returned");
    }
  } as unknown as FrameworkIndexView;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function readyRouter(): Promise<RouterJavaIndex> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "lombok-fixture-cache-"));
  const router = RouterJavaIndex.create(repoRoot, cacheDir);
  await router.open(1);
  await router.reconcile(1);
  await waitFor(async () => (await router.status()).pendingBackground === 0, 15_000);
  return router;
}

function file(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

test("returns NOT_DETECTED and no task gap for a repo with no Lombok build marker", async () => {
  const plainRoot = mkdtempSync(path.join(tmpdir(), "lombok-inactive-repo-"));
  writeFileSync(path.join(plainRoot, "pom.xml"), "<project><artifactId>plain</artifactId></project>");
  const result = await lombokCompleteness(plainRoot, [], unreachableFrameworkIndex());
  assert.equal(result.semantics, "NOT_DETECTED");
  assert.equal(result.taskGapDetected, false);
});

test("returns OK and no task gap when the Lombok agent jar is resolvable, without consulting framework facts", async () => {
  const jarRoot = mkdtempSync(path.join(tmpdir(), "lombok-agent-enabled-"));
  const jar = path.join(jarRoot, "lombok.jar");
  writeFileSync(path.join(jarRoot, "pom.xml"), "<project><dependencies><dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId><version>1.18.30</version></dependency></dependencies></project>");
  writeFileSync(jar, "");
  process.env.JAVA_LSP_LOMBOK_JAR = jar;
  try {
    const result = await lombokCompleteness(jarRoot, [path.join(jarRoot, "src/main/java/demo/Whatever.java")], unreachableFrameworkIndex());
    assert.equal(result.semantics, "OK");
    assert.equal(result.taskGapDetected, false);
  } finally {
    delete process.env.JAVA_LSP_LOMBOK_JAR;
  }
});

test("returns INCOMPLETE with a task gap when the agent is missing and the anchor's own type carries @Data", async () => {
  const router = await readyRouter();
  try {
    const result = await lombokCompleteness(repoRoot, [file("src/main/java/demo/LombokOrder.java")], router);
    assert.equal(result.semantics, "INCOMPLETE");
    assert.equal(result.taskGapDetected, true);
  } finally {
    await router.close();
  }
});

test("returns INCOMPLETE but no task gap when the agent is missing and the anchor's own type carries no Lombok annotation", async () => {
  const router = await readyRouter();
  try {
    const result = await lombokCompleteness(repoRoot, [file("src/main/java/demo/PlainOrder.java")], router);
    assert.equal(result.semantics, "INCOMPLETE");
    assert.equal(result.taskGapDetected, false);
  } finally {
    await router.close();
  }
});
