import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { encodeSnapshotV4, decodeSnapshotV4View, SNAPSHOT_V4_CHUNK_JSON_BYTES } from "./snapshot-v4.js";
import { hydrateSnapshotView } from "./hydrate-snapshot-view.js";
import { JavaIndexStore } from "./index-store.js";
import type { JavaFileFacts, JavaMethodFacts, JavaTypeFacts, SourceRange } from "./index-types.js";

const RANGE: SourceRange = {
  start: { line: 1, column: 1 },
  end: { line: 1, column: 2 }
};
const METHOD_COUNT = 7000;
const PAD = "x".repeat(32_000);
const PROBE_WORKER = fileURLToPath(new URL("./hydrate-snapshot-view.js", import.meta.url));
const UNCHUNKED_OOM_TIMEOUT_MS = 12_000;

function fileFacts(): JavaFileFacts {
  return {
    fileId: "file:src/A.java",
    relativePath: "src/A.java",
    sourceRoot: "src/main/java",
    module: ".",
    sourceSet: "main",
    packageName: "demo",
    imports: [],
    topLevelTypeIds: ["type:demo.A"],
    allTypeIds: ["type:demo.A"],
    contentHash: "hash",
    size: 10,
    mtimeMs: 1,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation: 1
  };
}

function typeFacts(): JavaTypeFacts {
  return {
    typeId: "type:demo.A",
    fqn: "demo.A",
    simpleName: "A",
    kind: "class",
    fileId: "file:src/A.java",
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
}

function methodFacts(index: number): JavaMethodFacts {
  return {
    methodId: `method:demo.A#m${index}()`,
    ownerTypeId: "type:demo.A",
    name: `m${index}`,
    constructor: false,
    signatureKey: `m${index}()`,
    range: RANGE,
    bodyRange: RANGE,
    modifiers: [],
    annotations: [{ name: "Pad", argumentsText: PAD, range: RANGE }],
    typeParameters: [],
    parameters: [],
    throws: [],
    callSites: [],
    localTypes: []
  };
}

function snapshotFacts(methods: JavaMethodFacts[]) {
  return {
    extractorVersion: "schema-3|tree-sitter-0.25.0|tree-sitter-java-0.23.5|extractor-code-abc123",
    stableIdVersion: 1,
    canonicalRepoRoot: "/repo",
    buildFingerprint: "build-a",
    manifestFingerprint: "manifest-a",
    indexedGeneration: 1,
    createdAt: new Date(0).toISOString(),
    coverage: [],
    resourceCoverage: [],
    files: [fileFacts()],
    types: [typeFacts()],
    fields: [],
    methods,
    edges: [],
    myBatisResources: []
  };
}

function writeSnapshot(methods: JavaMethodFacts[], chunkRest: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), "java-index-hydrate-probe-"));
  const target = path.join(dir, chunkRest ? "chunked.json.gz" : "unchunked.json.gz");
  const encoded = encodeSnapshotV4(snapshotFacts(methods.slice()), { chunkRest });
  writeFileSync(target, encoded);
  return target;
}

function isWorkerOom(error: NodeJS.ErrnoException): boolean {
  return error.code === "ERR_WORKER_OUT_OF_MEMORY"
    || /out of memory/i.test(error.message ?? "");
}

function runHydrateProbe(snapshotPath: string, timeoutMs: number): Promise<{ methods?: number; oom: boolean; timeout: boolean; code?: string; error?: string }> {
  return new Promise(resolve => {
    const worker = new Worker(PROBE_WORKER, {
      workerData: { snapshotPath },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let settled = false;
    const finish = (result: { methods?: number; oom: boolean; timeout: boolean; code?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ oom: false, timeout: true }), timeoutMs);
    worker.on("message", (message: { methods?: number }) => {
      finish({ methods: message.methods, oom: false, timeout: false });
    });
    worker.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        oom: isWorkerOom(error),
        timeout: false,
        code: error.code,
        error: error.message
      });
    });
    worker.on("exit", code => {
      if (code === 0) return;
      finish({ oom: false, timeout: false, code: `exit:${code}` });
    });
  });
}

test("hydrateSnapshotView ingests two method chunks on the shipped rest path", async () => {
  const methods = [methodFacts(0), methodFacts(1)];
  methods[0]!.annotations = [];
  methods[1]!.annotations = [];
  const encoded = encodeSnapshotV4(snapshotFacts(methods));
  const view = decodeSnapshotV4View(encoded);
  assert.equal("error" in view, false);
  if ("error" in view) return;
  const store = new JavaIndexStore();
  store.loadSnapshotData({
    files: view.files,
    types: [],
    fields: [],
    methods: [],
    edges: [],
    myBatisResources: []
  });
  await hydrateSnapshotView(store, view);
  assert.equal(store.files(["src/A.java"])[0]?.methods.length, 2);
});

test("a 256-cap isolate hydrates chunked methods and OOMs the unchunked twin", async () => {
  const methods = Array.from({ length: METHOD_COUNT }, (_, index) => methodFacts(index));
  assert.ok(
    METHOD_COUNT * PAD.length > 2 * SNAPSHOT_V4_CHUNK_JSON_BYTES,
    `methods padding must exceed two snapshot chunks (${METHOD_COUNT * PAD.length} bytes)`
  );
  const chunkedPath = writeSnapshot(methods, true);
  const unchunkedPath = writeSnapshot(methods, false);
  const chunkedView = decodeSnapshotV4View(readFileSync(chunkedPath));
  assert.equal("error" in chunkedView, false);
  if ("error" in chunkedView) return;
  const methodParts = chunkedView.header.segments.filter(entry => entry.kind === "methods");
  assert.ok(methodParts.length >= 2, `expected chunked methods, got ${methodParts.length} parts`);

  const chunked = await runHydrateProbe(chunkedPath, 20_000);
  assert.equal(chunked.timeout, false, "chunked hydrate timed out");
  assert.equal(chunked.oom, false, `chunked hydrate OOM: ${chunked.code}`);
  assert.equal(chunked.methods, METHOD_COUNT);

  const unchunked = await runHydrateProbe(unchunkedPath, UNCHUNKED_OOM_TIMEOUT_MS);
  assert.equal(unchunked.timeout, false, "unchunked twin hung instead of OOM");
  assert.equal(
    unchunked.oom,
    true,
    `unchunked twin exited code=${unchunked.code} methods=${unchunked.methods} error=${unchunked.error}`
  );
});
