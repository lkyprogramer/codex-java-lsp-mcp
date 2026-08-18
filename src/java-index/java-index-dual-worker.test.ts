import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { JavaIndexClient } from "./java-index-client.js";
import { isJavaIndexDualWorkerEnabled, JAVA_LSP_JAVA_INDEX_DUAL_WORKER } from "./java-index-dual-worker.js";
import { deriveJavaSourceLayout } from "./java-index-file-parse.js";
import { validateSweepParsedFiles } from "./java-index-sweep-protocol.js";
import type { JavaFileBundle } from "./index-types.js";

function tempRepo(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function tempCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), "java-index-dual-worker-cache-"));
}

function writeJavaFile(repoRoot: string, relativePath: string, content: string): void {
  const absolutePath = path.join(repoRoot, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function workerFactory(dualWorker: boolean): () => Worker {
  return () => new Worker(new URL("./java-index-worker.js", import.meta.url), {
    env: {
      ...process.env,
      [JAVA_LSP_JAVA_INDEX_DUAL_WORKER]: dualWorker ? "1" : "0"
    }
  });
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function writeDemoRepo(repoRoot: string): string[] {
  writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  writeJavaFile(repoRoot, "src/main/java/demo/Impl.java", "package demo;\n\nclass Impl implements Gateway {}\n");
  writeJavaFile(repoRoot, "src/test/java/demo/ImplTest.java", "package demo;\n\nclass ImplTest {}\n");
  return [
    path.join(repoRoot, "src/main/java/demo/Gateway.java"),
    path.join(repoRoot, "src/main/java/demo/Impl.java"),
    path.join(repoRoot, "src/test/java/demo/ImplTest.java")
  ];
}

function bundleDigest(bundles: JavaFileBundle[]): string {
  const normalized = bundles
    .map(bundle => ({
      file: {
        ...bundle.file,
        mtimeMs: 0,
        ...(bundle.file.ctimeMs === undefined ? {} : { ctimeMs: 0 })
      },
      types: bundle.types,
      fields: bundle.fields,
      methods: bundle.methods,
      edges: [...bundle.edges].sort((left, right) => left.edgeId.localeCompare(right.edgeId))
    }))
    .sort((left, right) => left.file.relativePath.localeCompare(right.file.relativePath));
  return JSON.stringify(normalized);
}

test("dual-worker flag stays off unless the env value is exactly 1", () => {
  assert.equal(isJavaIndexDualWorkerEnabled({}), false);
  assert.equal(isJavaIndexDualWorkerEnabled({ [JAVA_LSP_JAVA_INDEX_DUAL_WORKER]: "0" }), false);
  assert.equal(isJavaIndexDualWorkerEnabled({ [JAVA_LSP_JAVA_INDEX_DUAL_WORKER]: "true" }), false);
  assert.equal(isJavaIndexDualWorkerEnabled({ [JAVA_LSP_JAVA_INDEX_DUAL_WORKER]: "1" }), true);
});

test("deriveJavaSourceLayout prefers a layout-probe modules/ prefix over classifyPath", () => {
  const repoRoot = tempRepo("java-index-file-parse-layout-");
  writeJavaFile(repoRoot, "modules/foo/src/main/java/demo/A.java", "package demo; class A {}\n");
  const layout = deriveJavaSourceLayout(
    repoRoot,
    path.join(repoRoot, "modules/foo/src/main/java/demo/A.java"),
    { sourceRoots: [{ relativePath: "modules/foo/src/main/java", module: "foo", sourceSet: "main" }] }
  );
  assert.equal(layout.relativePath, "modules/foo/src/main/java/demo/A.java");
  assert.equal(layout.sourceRoot, "modules/foo/src/main/java");
});

test("sweep protocol rejects a parse result that is neither facts nor an error", () => {
  assert.throws(
    () => validateSweepParsedFiles([{ relativePath: "A.java", sourceRoot: "src/main/java" }]),
    /neither ok facts nor an error/
  );
});

test("dual-worker background sweep indexes files and resolves cross-file edges", async () => {
  const repoRoot = tempRepo("java-index-dual-worker-sweep-");
  const files = writeDemoRepo(repoRoot);
  const client = new JavaIndexClient(repoRoot, tempCacheDir(), workerFactory(true));
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 8000);

  const status = await client.status();
  assert.equal(status.files, 3);
  assert.ok(status.coverage.every(entry => entry.state === "COMPLETE"));

  const implBundle = (await client.queryFiles([files[1]!]))[0]!;
  const gatewayBundle = (await client.queryFiles([files[0]!]))[0]!;
  const gateway = gatewayBundle.types.find(type => type.simpleName === "Gateway")!;
  assert.ok(implBundle.edges.some(edge => edge.kind === "IMPLEMENTS" && edge.toId === gateway.typeId));
  await client.close();
});

test("dual-worker sweep facts and edges match the single-worker digest", async () => {
  const repoRoot = tempRepo("java-index-dual-worker-digest-");
  const files = writeDemoRepo(repoRoot);

  const single = new JavaIndexClient(repoRoot, tempCacheDir(), workerFactory(false));
  const dual = new JavaIndexClient(repoRoot, tempCacheDir(), workerFactory(true));
  await single.open(1);
  await dual.open(1);
  await single.reconcile(1);
  await dual.reconcile(1);
  await waitFor(async () => (await single.status()).pendingBackground === 0, 8000);
  await waitFor(async () => (await dual.status()).pendingBackground === 0, 8000);

  const singleBundles = await single.queryFiles(files);
  const dualBundles = await dual.queryFiles(files);
  assert.equal(bundleDigest(dualBundles), bundleDigest(singleBundles));
  assert.equal((await dual.status()).edges, (await single.status()).edges);
  await single.close();
  await dual.close();
});

test("dual-worker multi-chunk sweep keeps resolved IMPLEMENTS edges", async () => {
  const repoRoot = tempRepo("java-index-dual-worker-chunks-");
  writeJavaFile(repoRoot, "src/main/java/demo/Gateway.java", "package demo;\n\ninterface Gateway {}\n");
  const implFiles: string[] = [];
  for (let index = 0; index < 51; index += 1) {
    const relativePath = `src/main/java/demo/Impl${index}.java`;
    writeJavaFile(repoRoot, relativePath, `package demo;\n\nclass Impl${index} implements Gateway {}\n`);
    implFiles.push(path.join(repoRoot, relativePath));
  }
  const client = new JavaIndexClient(repoRoot, tempCacheDir(), workerFactory(true));
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 10000);
  const status = await client.status();
  assert.equal(status.files, 52);
  const gateway = (await client.queryFiles([path.join(repoRoot, "src/main/java/demo/Gateway.java")]))[0]!
    .types.find(type => type.simpleName === "Gateway")!;
  const implBundles = await client.queryFiles(implFiles);
  for (const bundle of implBundles) {
    assert.ok(bundle.edges.some(edge => edge.kind === "IMPLEMENTS" && edge.toId === gateway.typeId));
  }
  await client.close();
});
