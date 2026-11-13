// input: synthetic outline entries, a fake index client and a temporary source file.
// output: post-ILV2 Q03 contract checks for selectOutlineEntries, runOutline and fitOutlineWire.
// pos: unit level; the java_symbol wire path is covered in tools/symbol-static.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JavaFileBundle, JavaIndexStatus } from "../java-index/index-types.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import { symbolNeedsJdt } from "../tools/symbol.js";
import { fitOutlineWire, runOutline, selectOutlineEntries, type PublicOutlineEntry } from "./outline.js";

test("nearLine picks the containing overload, not the first same-name method", () => {
  const entries = [
    { declarationKey: "m:a", kind: "method", name: "cancel", signature: "cancel(long)", startLine: 10, endLine: 15, selection: { line: 10, column: 17 } },
    { declarationKey: "m:b", kind: "method", name: "cancel", signature: "cancel(String)", startLine: 21, endLine: 25, selection: { line: 21, column: 17 } }
  ] as const;
  const picked = selectOutlineEntries(entries, { limit: 1, nearLine: 23 });
  assert.equal(picked.entries[0]!.declarationKey, "m:b");
  assert.equal(picked.entries[0]!.containsNearLine, true);
  assert.equal(picked.omittedSymbols, 1);
  assert.equal(symbolNeedsJdt({ operation: "outline" }), false);
});

test("a nearLine at the end of a large file keeps its neighbours, not the file head", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ declarationKey: `m:${i}`, kind: "method" as const,
    name: `op${i}`, signature: `op${i}()`, startLine: 10 * i + 1, endLine: 10 * i + 9, selection: { line: 10 * i + 1, column: 5 } }));
  const tail = selectOutlineEntries(many, { limit: 8, nearLine: 905 });
  assert.ok(tail.entries.some(entry => entry.declarationKey === "m:90"));
  assert.ok(tail.entries.every(entry => Math.abs(entry.startLine - 905) <= 60));
  assert.ok(!tail.entries.some(entry => entry.declarationKey === "m:0"));
  assert.deepEqual(tail.entries.map(entry => entry.startLine), [...tail.entries.map(entry => entry.startLine)].sort((a, b) => a - b));
  assert.equal(tail.omittedSymbols, 92);
  // Without nearLine: the head of the file in source order.
  const head = selectOutlineEntries([...many].reverse(), { limit: 3 });
  assert.deepEqual(head.entries.map(entry => entry.declarationKey), ["m:0", "m:1", "m:2"]);
});

test("fields are entries; duplicate keys collapse, same names do not; limits outside 1..20 are refused", () => {
  const withField = selectOutlineEntries([{ declarationKey: "f:status", kind: "field", name: "status",
    signature: "OrderStatus status", startLine: 4, endLine: 4, selection: { line: 4, column: 23 } }], { limit: 8 });
  assert.equal(withField.entries[0]!.kind, "field");
  const twice = { declarationKey: "m:x", kind: "method" as const, name: "run", signature: "run()", startLine: 3, endLine: 5, selection: { line: 3, column: 9 } };
  const deduped = selectOutlineEntries([twice, { ...twice }, { ...twice, declarationKey: "m:y", startLine: 7, endLine: 9, selection: { line: 7, column: 9 } }], { limit: 8 });
  assert.deepEqual(deduped.entries.map(entry => entry.declarationKey), ["m:x", "m:y"]);
  assert.equal(deduped.omittedSymbols, 0);
  for (const limit of [0, 21, 1.5]) assert.throws(() => selectOutlineEntries([twice], { limit }), /limit 1\.\.20/);
  assert.throws(() => selectOutlineEntries([twice], { limit: 8, nearLine: 0 }), /nearLine/);
});

const SOURCE = "package demo;\n\npublic class Broken {\n    void run() {\n}\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeClient(bundle: JavaFileBundle | undefined, indexedGeneration = 3): JavaIndexClientApi {
  const status: JavaIndexStatus = {
    state: "READY", indexedGeneration, files: 1, types: 1, methods: 1, edges: 0, snapshotBytes: 0, pendingForeground: 0, pendingBackground: 0,
    coverage: [{ root: "src/main/java", generation: indexedGeneration, state: "COMPLETE", discoveredFiles: 1, indexedFiles: 1, failedFiles: 0, recoveredFiles: 0, extractorVersion: "x" }],
    resourceCoverage: []
  };
  return { queryFiles: async () => (bundle ? [bundle] : []), status: async () => status } as unknown as JavaIndexClientApi;
}

function bundleOf(parseState: "COMPLETE" | "RECOVERED" | "FAILED", contentHash = hash(SOURCE)): JavaFileBundle {
  const range = (start: number, end: number) => ({ start: { line: start, column: 1 }, end: { line: end, column: 2 } });
  return {
    file: { fileId: "f", relativePath: "src/main/java/demo/Broken.java", sourceRoot: "src/main/java", module: "", sourceSet: "main", packageName: "demo",
      imports: [], topLevelTypeIds: [], allTypeIds: [], contentHash, size: SOURCE.length, parseState, parseErrorCount: parseState === "COMPLETE" ? 0 : 1, generation: 3 },
    types: parseState === "FAILED" ? [] : [{ typeId: "type:v2:demo.Broken", simpleName: "Broken", kind: "class", fileId: "f", range: range(3, 5),
      nameRange: range(3, 3), modifiers: [], annotations: [], typeParameters: [], extends: [], implements: [], permits: [], fieldIds: [], methodIds: [], confidence: 1 }],
    fields: [],
    methods: [],
    edges: []
  } as unknown as JavaFileBundle;
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "outline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
  await writeFile(path.join(root, "src/main/java/demo/Broken.java"), SOURCE);
  return root;
}

test("a FAILED file is PARTIAL with no entries, never an empty READY outline", async t => {
  const repoRoot = await workspace(t);
  const failed = await runOutline(fakeClient(bundleOf("FAILED")), { repoRoot, file: "src/main/java/demo/Broken.java" });
  assert.notEqual(failed.scopeState, "READY");
  assert.deepEqual(failed.entries, []);
  assert.ok(failed.reasons.includes("ANCHOR_PARSE_INCOMPLETE"));
  const recovered = await runOutline(fakeClient(bundleOf("RECOVERED")), { repoRoot, file: "src/main/java/demo/Broken.java" });
  assert.equal(recovered.scopeState, "PARTIAL");
  assert.equal(recovered.entries.length, 1, "recovered facts are shown, labelled partial");
  const complete = await runOutline(fakeClient(bundleOf("COMPLETE")), { repoRoot, file: "src/main/java/demo/Broken.java" });
  assert.equal(complete.scopeState, "READY");
  assert.equal(complete.schemaVersion, "java-outline/v1");
  // A later publication that did not rewrite this file leaves its row at generation 3: still READY.
  const later = await runOutline(fakeClient(bundleOf("COMPLETE"), 7), { repoRoot, file: "src/main/java/demo/Broken.java" });
  assert.equal(later.scopeState, "READY");
  assert.equal(later.generation, 7);
});

test("source bytes that differ from the indexed hash are not READY and list nothing", async t => {
  const repoRoot = await workspace(t);
  const stale = await runOutline(fakeClient(bundleOf("COMPLETE", hash("older bytes"))), { repoRoot, file: "src/main/java/demo/Broken.java" });
  assert.equal(stale.scopeState, "PARTIAL");
  assert.deepEqual(stale.entries, []);
  assert.ok(stale.reasons.includes("ANCHOR_STALE"));
  const missing = await runOutline(fakeClient(undefined), { repoRoot, file: "src/main/java/demo/Broken.java" });
  assert.notEqual(missing.scopeState, "READY", "a file absent from the snapshot is not a file without declarations");
  const outside = await runOutline(fakeClient(bundleOf("COMPLETE")), { repoRoot, file: "../etc/passwd" });
  assert.deepEqual(outside.reasons, ["SOURCE_OUTSIDE_REPO"]);
});

test("the wire fit drops signatures, then far entries, and never an identity", () => {
  const entries: PublicOutlineEntry[] = Array.from({ length: 20 }, (_, i) => ({
    kind: "method", name: `operation${i}`, signature: `operation${i}(${"java.util.Map<java.lang.String, java.util.List<com.example.Order>>, ".repeat(3)}int)`,
    startLine: 10 * i + 1, endLine: 10 * i + 9, selection: { line: 10 * i + 1, column: 5 }, stability: "STABLE",
    symbolId: `jsym:mac1:workspace-outline:${Buffer.from(`method:v3:src/main/java/demo/Service.java#demo.Service#operation${i}(java.util.Map,int)`).toString("base64url")}`,
    ...(i === 10 ? { containsNearLine: true as const } : {})
  }));
  const response = { schemaVersion: "java-outline/v1", relativePath: "src/main/java/demo/Service.java", entries, omittedSymbols: 0, scopeState: "READY", reasons: [] as string[] };
  const fitted = fitOutlineWire(response, 105);
  assert.ok(fitted);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), "utf8") <= 4096);
  assert.ok(fitted.entries.length < 20);
  assert.equal(fitted.omittedSymbols, 20 - fitted.entries.length);
  assert.equal(fitted.scopeState, "PARTIAL");
  assert.ok(fitted.reasons.includes("SOURCE_BUDGET"));
  assert.ok(fitted.entries.every(entry => typeof entry.symbolId === "string"));
  assert.ok(fitted.entries.some(entry => entry.containsNearLine), "the entry containing nearLine is the last to go");
  assert.ok(fitted.entries.every(entry => entry.signature !== undefined || entry.signatureOmitted === true));
  assert.equal(fitOutlineWire(response, 105, 64), undefined, "an envelope that cannot fit is reported, not truncated");
  const small = { ...response, entries: entries.slice(0, 2) };
  assert.equal(fitOutlineWire(small, undefined), small, "a response within budget is returned unchanged");
});

test("an exhausted or expiring deadline yields PARTIAL DEADLINE_EXCEEDED, never a short READY outline", async t => {
  const repoRoot = await workspace(t);
  const file = "src/main/java/demo/Broken.java";
  const budgetAt = (ms: { left: number }) => ({ remainingMs: () => ms.left }) as unknown as DeadlineBudget;
  let calls = 0;
  const counting = fakeClient(bundleOf("COMPLETE"));
  const spy = { ...counting, queryFiles: async (...a: Parameters<JavaIndexClientApi["queryFiles"]>) => { calls++; return counting.queryFiles(...a); } } as JavaIndexClientApi;
  const before = await runOutline(spy, { repoRoot, file, budget: budgetAt({ left: 0 }) });
  assert.equal(before.scopeState, "PARTIAL");
  assert.deepEqual(before.reasons, ["DEADLINE_EXCEEDED"]);
  assert.deepEqual(before.entries, []);
  assert.equal(calls, 0, "an expired request does not touch the index");

  // The deadline passes while the index is queried: the failure is the deadline, not the index.
  const during = { left: 1000 };
  const failing = { ...counting, queryFiles: async () => { during.left = 0; throw new Error("aborted"); } } as unknown as JavaIndexClientApi;
  const queried = await runOutline(failing, { repoRoot, file, budget: budgetAt(during) });
  assert.deepEqual([queried.scopeState, queried.reasons, queried.entries], ["PARTIAL", ["DEADLINE_EXCEEDED"], []]);
  // With time left, an index failure is not disguised as a deadline.
  await assert.rejects(runOutline(failing, { repoRoot, file, budget: budgetAt({ left: 1000 }) }), /aborted/);

  // The deadline passes after the index answered: whichever check sees it first (the reader's or the one
  // after verification), nothing is listed. The reader's own check is pinned in evidence-source-reader.test.
  const reading = { left: 1000 };
  const expiresAtStatus = { ...counting, status: async () => { reading.left = 0; return counting.status(); } } as unknown as JavaIndexClientApi;
  const read = await runOutline(expiresAtStatus, { repoRoot, file, budget: budgetAt(reading) });
  assert.equal(read.scopeState, "PARTIAL");
  assert.ok(read.reasons.includes("DEADLINE_EXCEEDED"));
  assert.deepEqual(read.entries, []);
});
