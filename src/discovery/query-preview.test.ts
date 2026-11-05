// input: runStaticDiscovery over real files on disk with a fake index client
//        that returns chosen hits (locator hash, evidence source).
// output: R08 regression lock: no READY stale locator, previews bound to the
//         verified evidence source, byte/IO caps, CRLF/UTF-8/EOF ranges,
//         secret redaction, one read per file, snapshot generation check.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DISCOVERY_FILE_READ_MAX_BYTES,
  DISCOVERY_PREVIEW_LINES,
  DISCOVERY_PREVIEW_MAX_BYTES,
  DISCOVERY_REQUEST_PREVIEW_MAX_BYTES,
  DISCOVERY_REQUEST_READ_MAX_BYTES,
  RequestSourceReader,
  runStaticDiscovery,
  splitSourceLines,
  type DiscoveryResult
} from "./query.js";
import type { DetailedEntitySearchResult, EntityHit } from "../java-index/entity-search.js";
import { redactPreviewLine } from "./search-document.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "r08-preview-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
  }
  return root;
}

function hit(relativePath: string, content: string, line = 1, extra: Partial<EntityHit> = {}): EntityHit {
  const name = path.basename(relativePath, ".java");
  return {
    entityId: `type:v2:${relativePath}#demo.${name}`, kind: "type", fqn: `demo.${name}`, simpleName: name,
    relativePath, layer: "FQN", score: 1, line, column: 1, contentHash: sha(content), ...extra
  };
}

function client(hits: EntityHit[], options: { statusGeneration?: number; queryGeneration?: number } = {}): JavaIndexClientApi {
  const status = { state: "READY" as const, indexedGeneration: options.statusGeneration ?? 1, files: 1, types: 1, methods: 0, edges: 0, snapshotBytes: 0, pendingForeground: 0, pendingBackground: 0, coverage: [], resourceCoverage: [] };
  return {
    status: async () => status,
    querySearch: async (): Promise<DetailedEntitySearchResult> =>
      ({ hits, truncated: false, selectionLimited: false, work: { postings: 0 }, generation: options.queryGeneration ?? 1 })
  } as unknown as JavaIndexClientApi;
}

const discover = (root: string, hits: EntityHit[], extra: Record<string, unknown> = {}, options?: Parameters<typeof client>[1]) =>
  runStaticDiscovery(client(hits, options), { repoRoot: root, query: "demo.A", searchMode: "text", ...extra });

const withRepo = async (files: Record<string, string>, fn: (root: string) => Promise<void>) => {
  const root = await repo(files);
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("Q08: a file changed (or deleted) after indexing never yields a READY stale locator", async () => {
  const indexed = "package demo;\nclass A {}\n";
  await withRepo({ "A.java": "package demo;\n\n\nclass A {}\n", "B.java": indexed }, async root => {
    const stale = await discover(root, [hit("A.java", indexed, 2), hit("B.java", indexed, 2), hit("Gone.java", indexed, 2)]);
    assert.equal(stale.scopeState, "PARTIAL");
    assert.equal(stale.stopReason, "source_changed");
    assert.equal(stale.droppedStale, 2, "changed A and deleted Gone are dropped");
    assert.deepEqual(stale.candidates.map(c => c.declaration.relativePath), ["B.java"], "the verified locator stays");
    assert.equal(stale.candidates[0]!.declaration.contentHash, sha(indexed));
    const fresh = await discover(root, [hit("B.java", indexed, 2)]);
    assert.equal(fresh.scopeState, "READY");
    assert.equal(fresh.droppedStale, 0);
    assert.deepEqual(fresh.candidates[0]!.evidenceRange, { relativePath: "B.java", contentHash: sha(indexed), startLine: 2, endLine: 2 });
    assert.equal(fresh.candidates[0]!.preview, "class A {}\n");
  });
});

test("K20: hits from another generation than the status are not stitched into READY", async () => {
  const text = "class A {}\n";
  await withRepo({ "A.java": text }, async root => {
    const r = await discover(root, [hit("A.java", text)], {}, { statusGeneration: 1, queryGeneration: 2 });
    assert.equal(r.scopeState, "PARTIAL");
    assert.equal(r.stopReason, "changed_during_request");
    assert.equal(r.generation, 2, "the reported generation is the hits' own snapshot");
  });
});

test("Q09 (preview=window): a preview has a 4 KiB byte cap and whole lines; the range is recomputed from the kept lines", async () => {
  const longLine = `class A { String x="${"x".repeat(100_000)}"; }\n`;
  const kiloLines = Array.from({ length: 12 }, (_, i) => `// ${String(i).padStart(2, "0")} ${"y".repeat(994)}\n`).join("");
  const exact = `${"z".repeat(DISCOVERY_PREVIEW_MAX_BYTES - 1)}\n${"w".repeat(10)}\n`;
  await withRepo({ "A.java": longLine, "K.java": kiloLines, "E.java": exact }, async root => {
    const huge = await discover(root, [hit("A.java", longLine)], { preview: "window" });
    assert.equal(huge.candidates[0]!.preview, undefined);
    assert.equal(huge.candidates[0]!.previewOmitted, "preview_byte_cap");
    assert.equal(huge.scopeState, "READY", "a verified locator without preview is still complete");

    const kilo = (await discover(root, [hit("K.java", kiloLines)], { preview: "window" })).candidates[0]!;
    assert.ok(Buffer.byteLength(kilo.preview!) <= DISCOVERY_PREVIEW_MAX_BYTES, `${Buffer.byteLength(kilo.preview!)}`);
    assert.equal(splitSourceLines(kilo.preview!).length, 4, "four 1000-byte lines fit, the fifth would exceed 4096");
    assert.deepEqual([kilo.evidenceRange!.startLine, kilo.evidenceRange!.endLine], [1, 4]);
    assert.ok(kiloLines.startsWith(kilo.preview!), "byte-for-byte source window");

    const boundary = (await discover(root, [hit("E.java", exact)], { preview: "window" })).candidates[0]!;
    assert.equal(Buffer.byteLength(boundary.preview!), DISCOVERY_PREVIEW_MAX_BYTES, "exactly 4096 bytes is admitted");
    assert.equal(boundary.evidenceRange!.endLine, 1);
  });
});

test("R08 (preview=window): preview bytes are capped per request (16 KiB); later candidates keep safe locators", async () => {
  const body = Array.from({ length: 3 }, () => `${"q".repeat(999)}\n`).join("");
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`F${i}.java`, body]));
  await withRepo(files, async root => {
    const r = await discover(root, Object.keys(files).map(rel => hit(rel, body)), { preview: "window" });
    const total = r.candidates.reduce((sum, c) => sum + Buffer.byteLength(c.preview ?? ""), 0);
    assert.ok(total <= DISCOVERY_REQUEST_PREVIEW_MAX_BYTES, `${total}`);
    assert.equal(r.candidates.length, 8, "no locator is dropped for preview budget");
    assert.equal(total, 16000, "5 x 3000 bytes, then one 1000-byte line in the remaining 1384");
    assert.deepEqual([r.candidates[5]!.evidenceRange!.startLine, r.candidates[5]!.evidenceRange!.endLine], [1, 1],
      "the shortened preview reports its real range");
    assert.ok(r.candidates.slice(6).every(c => c.previewOmitted === "preview_budget" && !c.evidenceRange));
    assert.equal(r.scopeState, "READY");
  });
});

test("R08: a file over 2 MiB is hash-verified by streaming (READY, no preview); the 8 MiB request cap leaves unverified locators", async () => {
  const big = `class Big {}\n${"/".repeat(DISCOVERY_FILE_READ_MAX_BYTES)}\n`;
  const nearCap = `class N {}\n${"/".repeat(DISCOVERY_FILE_READ_MAX_BYTES - 100)}\n`;
  const huge = `class H {}\n${"/".repeat(DISCOVERY_REQUEST_READ_MAX_BYTES)}\n`;
  const files: Record<string, string> = { "Big.java": big, "H.java": huge };
  for (let i = 0; i < 5; i += 1) files[`N${i}.java`] = nearCap;
  await withRepo(files, async root => {
    const large = await discover(root, [hit("Big.java", big)]);
    assert.equal(large.candidates[0]!.previewOmitted, "file_too_large");
    assert.equal(large.candidates[0]!.preview, undefined);
    assert.equal(large.scopeState, "READY", "the locator is verified fresh even without a preview");
    const staleLarge = await discover(root, [hit("Big.java", `${big}changed`)]);
    assert.equal(staleLarge.droppedStale, 1, "a changed large file is still detected");
    const unverifiable = await discover(root, [hit("H.java", huge)]);
    assert.equal(unverifiable.candidates[0]!.previewOmitted, "file_too_large");
    assert.equal(unverifiable.scopeState, "PARTIAL", "over the request read budget the locator is unverified");
    assert.equal(unverifiable.stopReason, "read_budget");
    const r = await discover(root, [0, 1, 2, 3, 4].map(i => hit(`N${i}.java`, nearCap)));
    assert.deepEqual(r.candidates.map(c => c.previewOmitted === "read_budget"), [false, false, false, false, true],
      "four ~2 MiB files fit in 8 MiB, the fifth is not read");
    assert.equal(r.scopeState, "PARTIAL");
  });
});

test("R08: the request deadline stops source reads (locator kept, PARTIAL deadline)", async () => {
  const text = "class A {}\n";
  await withRepo({ "A.java": text }, async root => {
    // The deadline passes after the query answered (R09: one expired on
    // entry never reaches the query; see query-deadline.test.ts).
    let queried = false;
    const base = client([hit("A.java", text)]);
    const r = await runStaticDiscovery({ ...base, querySearch: async (...args: Parameters<JavaIndexClientApi["querySearch"]>) => {
      const result = await base.querySearch(...args);
      queried = true;
      return result;
    } } as JavaIndexClientApi, { repoRoot: root, query: "demo.A", searchMode: "text", budget: { remainingMs: () => (queried ? 0 : 60_000) } });
    assert.equal(r.candidates[0]!.previewOmitted, "deadline");
    assert.equal(r.scopeState, "PARTIAL");
    assert.equal(r.stopReason, "deadline");
  });
});

test("R08: each unique file is read once per request and its hash is recomputed every request", async () => {
  const text = "class A {}\nclass B {}\n";
  await withRepo({ "A.java": text }, async root => {
    const reader = new RequestSourceReader(root);
    const [first, second] = await Promise.all([reader.read("A.java"), reader.read("A.java")]);
    assert.equal(first, second);
    assert.deepEqual(reader.work(), { filesRead: 1, bytesRead: Buffer.byteLength(text) });
    const r = await discover(root, [hit("A.java", text, 1), hit("A.java", text, 2, { entityId: "type:v2:A.java#demo.B", simpleName: "B", fqn: "demo.B" })]);
    assert.deepEqual(r.candidates.map(c => c.preview), [text, "class B {}\n"], "two candidates share one read");
    // Same size and mtime restored would fool an mtime check; the hash does not.
    await writeFile(path.join(root, "A.java"), "class X {}\nclass B {}\n", "utf8");
    const again = await discover(root, [hit("A.java", text, 1)]);
    assert.equal(again.droppedStale, 1);
    assert.ok(!(await reader.read("../outside.java") as { state: string }).state.startsWith("ok"), "no read outside the repo");
  });
});

test("K09/R08: CRLF, lone CR, UTF-8/emoji and EOF ranges use the parser's LF line numbering", async () => {
  const crlf = "package demo;\r\nclass A {\r\n}\r\n";
  const cr = "package demo;\rclass A {\r}\r";
  const emoji = "package demo;\n// 冲正 😀😀\nclass A {}";
  await withRepo({ "C.java": crlf, "R.java": cr, "U.java": emoji }, async root => {
    const c = (await discover(root, [hit("C.java", crlf, 2)])).candidates[0]!;
    assert.equal(c.preview, "class A {\r\n}\r\n", "CRLF stays one terminator per line, bytes untouched");
    assert.deepEqual([c.evidenceRange!.startLine, c.evidenceRange!.endLine], [2, 3]);
    const r = (await discover(root, [hit("R.java", cr, 1)])).candidates[0]!;
    assert.deepEqual([r.evidenceRange!.startLine, r.evidenceRange!.endLine], [1, 1], "a lone CR is line content, as for tree-sitter and rg");
    assert.equal(r.preview, cr);
    const u = (await discover(root, [hit("U.java", emoji, 2)])).candidates[0]!;
    assert.equal(u.preview, "// 冲正 😀😀\nclass A {}", "the last line without terminator is still a line");
    assert.deepEqual([u.evidenceRange!.startLine, u.evidenceRange!.endLine], [2, 3]);
    const eof = await discover(root, [hit("U.java", emoji, 4)]);
    assert.equal(eof.candidates[0]!.previewOmitted, "range_invalid", "a line past EOF is never previewed");
    assert.deepEqual(splitSourceLines("a\r\nb\rc\n"), ["a\r\n", "b\rc\n"]);
    assert.ok(DISCOVERY_PREVIEW_LINES >= 3);
  });
});

test("R08: a recognised credential is redacted and the preview is not source evidence", async () => {
  const canary = "AKIAFIXTURE0CANARY42";
  const text = `package demo;\nclass A {\n    private static final String API_TOKEN = "${canary}";\n    String path = "/orders/refund";\n}\n`;
  await withRepo({ "A.java": text }, async root => {
    const r = await discover(root, [hit("A.java", text, 2)]);
    const candidate = r.candidates[0]!;
    assert.ok(!candidate.preview!.includes(canary), candidate.preview);
    assert.ok(candidate.preview!.includes("/orders/refund"), "a safe route literal is kept");
    const plain = "class T {\n    String[] parts = tokenizer.split(\",\");\n}\n";
    await writeFile(path.join(root, "T.java"), plain, "utf8");
    const call = (await discover(root, [hit("T.java", plain, 1)])).candidates[0]!;
    assert.equal(call.previewKind, "source", "a call on a token-named receiver is not a secret assignment");
    assert.equal(call.preview, plain);
    assert.equal(candidate.previewKind, "redacted-preview");
    assert.ok(!JSON.stringify(r).includes(canary), "the canary appears nowhere in the result");
  });
});

test("R08 review: preview redaction covers setter/call, quoted-key and single-quote shapes; identifier words that merely contain a key word stay source", () => {
  const redacted = [
    'ds.setPassword("hunter2");',
    "db.password='pw12'",
    '"password": "p1",',
    'String accessToken = "t1";',
    'builder.apiKey("k1")',
    'SECRET_KEY = "s1"'
  ];
  for (const line of redacted) {
    const out = redactPreviewLine(line);
    assert.ok(/<value-redacted>/.test(out) && !/hunter2|pw12|"p1"|t1|k1|s1/.test(out), `${line} -> ${out}`);
  }
  for (const line of ['String tokenizerName = "ws";', 'parts = tokenizer.split(",");', 'String path = "/a/b";', 'String label = tokenStore.name("ws");']) {
    assert.equal(redactPreviewLine(line), line, line);
  }
});

test("P01/R08: a document hit previews its own evidence source (XML), verified against the XML hash", async () => {
  const java = "package demo;\npublic interface Mapper {\n    int load(int id);\n}\n";
  const xml = `<mapper namespace="demo.Mapper">\n  <select id="load">\n    SELECT 1\n  </select>\n</mapper>\n`;
  await withRepo({ "src/main/java/demo/Mapper.java": java, "src/main/resources/Mapper.xml": xml }, async root => {
    const docHit = (xmlHash: string): EntityHit => ({
      ...hit("src/main/java/demo/Mapper.java", java, 3),
      kind: "method", layer: "DOCUMENT",
      evidence: { relativePath: "src/main/resources/Mapper.xml", contentHash: xmlHash, startLine: 2, endLine: 4, sourceKind: "framework-key" }
    });
    const r: DiscoveryResult = await discover(root, [docHit(sha(xml))]);
    const candidate = r.candidates[0]!;
    assert.equal(candidate.declaration.relativePath, "src/main/java/demo/Mapper.java", "the target stays the Java method");
    assert.deepEqual(candidate.evidenceRange, { relativePath: "src/main/resources/Mapper.xml", contentHash: sha(xml), startLine: 2, endLine: 4 });
    assert.equal(candidate.preview, `  <select id="load">\n    SELECT 1\n  </select>\n`);
    assert.deepEqual(candidate.matchedBy, ["framework"]);

    const staleXml = await discover(root, [docHit(sha("older xml"))]);
    assert.equal(staleXml.candidates[0]!.previewOmitted, "source_changed");
    assert.equal(staleXml.candidates[0]!.preview, undefined);
    assert.equal(staleXml.scopeState, "PARTIAL");
    assert.equal(staleXml.stopReason, "source_changed");
  });
});
