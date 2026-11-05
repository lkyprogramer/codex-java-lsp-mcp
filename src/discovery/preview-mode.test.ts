// java_symbol previews are discovery aids, not the evidence read: by default
// each candidate carries a short declaration head under a small per-request
// cap, so discovery cannot spend an agent's whole source budget; the full
// window and no preview are explicit choices. Locators and stale checks are
// the same in every mode.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runStaticDiscovery, type DiscoveryResult } from "./query.js";
import type { DetailedEntitySearchResult, EntityHit } from "../java-index/entity-search.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const body = (name: string) => [
  "package demo;",
  ...Array.from({ length: 3 }, (_, i) => `@Tag${i}("${"x".repeat(60)}")`),
  `public class ${name} {`,
  ...Array.from({ length: 30 }, (_, i) => `    int field${i} = ${i}; // ${"y".repeat(60)}`),
  "}",
  ""
].join("\n");

const NAMES = Array.from({ length: 10 }, (_, i) => `Big${i}`);

async function withRepo(fn: (root: string, hits: EntityHit[]) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "preview-mode-"));
  const hits: EntityHit[] = [];
  for (const name of NAMES) {
    const rel = `src/main/java/demo/${name}.java`;
    const text = body(name);
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
    hits.push({
      entityId: `type:v2:${rel}#demo.${name}`, kind: "type", fqn: `demo.${name}`, simpleName: name, relativePath: rel,
      layer: "BM25_IDENTIFIER", score: 1, line: 5, column: 14, declarationStartLine: 2, contentHash: sha(text)
    } as EntityHit);
  }
  try {
    await fn(root, hits);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function client(hits: EntityHit[]): JavaIndexClientApi {
  const status = { state: "READY" as const, indexedGeneration: 1, files: 10, types: 10, methods: 0, edges: 0, snapshotBytes: 0, pendingForeground: 0, pendingBackground: 0, coverage: [], resourceCoverage: [] };
  return {
    status: async () => status,
    querySearch: async (): Promise<DetailedEntitySearchResult> => ({ hits, truncated: false, selectionLimited: false, work: { postings: 0 }, generation: 1 })
  } as unknown as JavaIndexClientApi;
}

const previewTotals = (result: DiscoveryResult) => {
  const previews = result.candidates.filter(candidate => typeof candidate.preview === "string");
  return {
    previews: previews.length,
    bytes: previews.reduce((sum, candidate) => sum + Buffer.byteLength(candidate.preview!, "utf8"), 0),
    lines: previews.reduce((sum, candidate) => sum + candidate.evidenceRange!.endLine - candidate.evidenceRange!.startLine + 1, 0),
    maxLines: Math.max(0, ...previews.map(candidate => candidate.evidenceRange!.endLine - candidate.evidenceRange!.startLine + 1))
  };
};

test("default preview: a short declaration head per candidate, inside a small per-request cap", async () => {
  await withRepo(async (root, hits) => {
    const result = await runStaticDiscovery(client(hits), { repoRoot: root, query: "big", searchMode: "text", limit: 10 });
    assert.equal(result.candidates.length, 10, "every candidate keeps its locator");
    const totals = previewTotals(result);
    assert.ok(totals.previews > 0);
    assert.ok(totals.maxLines <= 4, `head previews are at most 4 lines, got ${totals.maxLines}`);
    assert.ok(totals.bytes <= 2048, `the request's previews stay within 2048 bytes, got ${totals.bytes}`);
    const first = result.candidates[0]!;
    assert.equal(first.evidenceRange?.startLine, 2, "the head starts at the declaration's first annotation");
    for (const candidate of result.candidates.filter(entry => entry.preview === undefined)) {
      assert.equal(candidate.previewOmitted, "preview_budget", "a candidate past the cap says so");
    }
  });
});

test("preview=window keeps the full window; preview=none returns verified locators only", async () => {
  await withRepo(async (root, hits) => {
    const window = await runStaticDiscovery(client(hits), { repoRoot: root, query: "big", searchMode: "text", limit: 10, preview: "window" } as Parameters<typeof runStaticDiscovery>[1]);
    assert.equal(previewTotals(window).maxLines, 12, "the R08 12-line window");

    const none = await runStaticDiscovery(client(hits), { repoRoot: root, query: "big", searchMode: "text", limit: 10, preview: "none" } as Parameters<typeof runStaticDiscovery>[1]);
    assert.equal(none.candidates.length, 10);
    assert.equal(previewTotals(none).previews, 0);
    assert.ok(none.candidates.every(candidate => String(candidate.previewOmitted) === "not_requested"));
    assert.equal(none.scopeState, "READY", "no preview is not a partial answer");

    // A stale file is still dropped without a preview.
    await writeFile(path.join(root, hits[0]!.relativePath), "changed", "utf8");
    const stale = await runStaticDiscovery(client(hits), { repoRoot: root, query: "big", searchMode: "text", limit: 10, preview: "none" } as Parameters<typeof runStaticDiscovery>[1]);
    assert.equal(stale.droppedStale, 1);
  });
});
