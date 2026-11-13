import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CAUSES, anchorExactOf, breakdown, callsOf, classifyMiss, roleAudit, runMissBreakdown, summarize } from "./ilv2-impact-miss-breakdown.mjs";

const T = "src/main/java/demo/Target.java";
const item = { path: T, startLine: 10, endLine: 20 };
const diag = (files, gaps = []) => ({ files, readPlan: [], evidenceGaps: gaps });
const call = (exact, files, gaps) => ({ exact, anchorFile: "A.java", diagnostic: diag(files, gaps) });
const CORE_GAP = "Protected core exceeded read-plan limits (4)";

test("causes follow the pre-registered order", () => {
  assert.equal(classifyMiss({ item, label: "NO_IMPACT_CALL", calls: [] }).cause, "NO_IMPACT_CALL");
  assert.equal(classifyMiss({ item, label: "SELECTED_RANGE_MISS", calls: [call("match", [])] }).cause, "SELECTED_RANGE_MISS");
  assert.equal(classifyMiss({ item, label: "POOL_ABSENT", calls: [call("ambiguous", []), call("text", [])] }).cause, "ANCHOR_CONFOUND", "no exact anchor: not attributable");
  assert.equal(classifyMiss({ item, label: "POOL_ABSENT", calls: [call("text", []), call("match", [])] }).cause, "RELATION_MISSING");
  const weak = classifyMiss({ item, label: "UNSELECTED", calls: [call("match", [{ id: "f1", path: "X.java", reasons: [] }, { id: "f2", path: T, role: "reference", reasons: ["typeGraph"] }])] });
  assert.deepEqual([weak.cause, weak.poolRank, weak.poolSize, weak.presentAnchorExact], ["WEAK_RELATION", 2, 2, true]);
  const capped = classifyMiss({ item, label: "UNSELECTED", calls: [call("ambiguous", [{ id: "f1", path: T, role: "related", reasons: ["IMPLEMENTATION"] }], [CORE_GAP])] });
  assert.deepEqual([capped.cause, capped.protectedReasons, capped.presentAnchorExact], ["CORE_CAPPED", ["IMPLEMENTATION"], false]);
  assert.equal(classifyMiss({ item, label: "UNSELECTED", calls: [call("match", [{ id: "f1", path: T, reasons: ["CALLS"] }])] }).cause, "PROTECTED_UNSELECTED");
});

test("the first call holding the file decides, as in F's own label", () => {
  const calls = [call("text", []), call("match", [{ id: "f1", path: T, reasons: ["typeGraph"] }]), call("match", [{ id: "f9", path: T, reasons: ["IMPLEMENTS"] }], [CORE_GAP])];
  const row = classifyMiss({ item, label: "UNSELECTED", calls });
  assert.deepEqual([row.cause, row.inPoolCalls, row.calls, row.anchorExactCalls], ["WEAK_RELATION", 2, 3, 2]);
});

const observation = (taskId, rows) => ({ taskId, terms: rows });
const term = (exact, files, gaps = []) => ({ exact, symbol: { candidates: [{ declaration: { relativePath: "A.java" } }] },
  impacts: { C0: { diagnostic: diag(files, gaps) }, C3: { diagnostic: diag(files, gaps) } } });

test("breakdown keeps uncredited Java targets only, checks alignment with gold, and summarizes counts", () => {
  const gold = new Map([["t1", { requiredEvidence: [item, { path: "B.java", startLine: 1, endLine: 2 }, { path: "x.xml", startLine: 1, endLine: 1 }] }]]);
  const targets = [{ kind: "java", credited: false, label: "UNSELECTED" }, { kind: "java", credited: true, label: "IMPACT_SPAN" }, { kind: "other", credited: false, label: "POOL_ABSENT" }];
  const rows = [{ taskId: "t1", category: "implementations", configs: { C0: { targets }, C3: { targets } } }];
  const observations = [observation("t1", [term("match", [{ id: "f1", path: T, role: "related", reasons: ["IMPLEMENTATION"] }], [CORE_GAP])])];
  const missRows = breakdown({ rows, observations, gold });
  assert.equal(missRows.length, 2);
  assert.deepEqual(missRows.map(row => [row.config, row.cause]), [["C0", "CORE_CAPPED"], ["C3", "CORE_CAPPED"]]);
  const summary = summarize(missRows, roleAudit(observations, "C0"));
  assert.deepEqual(Object.keys(summary.byConfig.C0.byCause), [...CAUSES]);
  assert.equal(summary.byConfig.C0.byCategory.implementations.CORE_CAPPED, 1);
  assert.deepEqual(summary.rules.R2_selection, { exactAnchor: 1, all: 1, persistsInC3: 1, gate: 5, triggered: false });
  assert.deepEqual(summary.focusTable, { "implementations/CORE_CAPPED": { exactAnchor: 1, inexactAnchor: 0 } });
  assert.deepEqual(summary.roleAudit, { poolFiles: 1, withProtectedReason: 1, protectedByRole: { related: 1 }, relatedWithProtectedReason: 1, relatedProtectedKinds: { IMPLEMENTATION: 1 } });
  assert.doesNotMatch(JSON.stringify(summary), /Target\.java|demo/);
  assert.throws(() => breakdown({ rows, observations, gold: new Map([["t1", { requiredEvidence: [item] }]]) }), /scored targets vs 1 gold/);
  assert.throws(() => breakdown({ rows: [{ ...rows[0], configs: { C0: { targets: [targets[2], targets[1], targets[0]] }, C3: { targets } } }], observations, gold }), /kind does not match/);
});

test("rule gates count exact-anchor rows only; selection also needs persistence in C3", () => {
  const miss = (taskId, cause, { config = "C0", category = "callers", exact = true } = {}) =>
    ({ taskId, index: 0, config, category, cause, poolRank: 1, presentAnchorExact: exact, anchorExactCalls: exact ? 1 : 0 });
  const selection = ["a", "b", "c", "d", "e"].map(id => miss(id, "PROTECTED_UNSELECTED"));
  const persisted = ["a", "b", "c"].map(id => miss(id, "PROTECTED_UNSELECTED", { config: "C3" }));
  const absent = { taskId: "f", index: 0, config: "C0", category: "implementations", cause: "ANCHOR_CONFOUND", anchorExactCalls: 0 };
  const rules = summarize([...selection, ...persisted, absent, miss("g", "WEAK_RELATION", { category: "spring" }), miss("h", "PROTECTED_UNSELECTED", { exact: false })], {}).rules;
  assert.deepEqual([rules.focusMissesC0, rules.focusExactAnchorC0, rules.R2_selection.exactAnchor, rules.R2_selection.all, rules.R2_selection.persistsInC3, rules.R2_selection.triggered],
    [7, 5, 5, 6, 3, true]);
  assert.deepEqual(rules.R1_poolAbsent, { value: 1, relationMissing: 0 });
  const weakish = selection.map((row, i) => ({ ...row, cause: i < 3 ? "WEAK_RELATION" : row.cause }));
  assert.equal(summarize(weakish, {}).rules.R3_weak.triggered, true);
  assert.equal(summarize(weakish.map(row => ({ ...row, presentAnchorExact: false, anchorExactCalls: 0 })), {}).rules.R3_weak.triggered, false, "inexact anchors cannot carry R3");
  assert.equal(anchorExactOf({ cause: "RELATION_MISSING", anchorExactCalls: 2 }), true);
  assert.equal(callsOf(observation("t", [{ exact: null, impacts: { C0: { diagnostic: diag([]) } } }]), "C0")[0].exact, "text");
});

test("the run binds to the recorded F artifacts and writes private rows apart from the count summary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d16-"));
  try {
    const hash = text => createHash("sha256").update(text).digest("hex");
    const gold = `${JSON.stringify({ taskId: "t1", requiredEvidence: [item] })}\n`;
    const responses = `${JSON.stringify(observation("t1", [term("match", [{ id: "f1", path: T, role: "reference", reasons: ["typeGraph"] }])]))}\n`;
    const targets = [{ kind: "java", credited: false, label: "UNSELECTED" }];
    const rows = `${JSON.stringify({ taskId: "t1", category: "callers", configs: { C0: { targets }, C3: { targets } } })}\n`;
    for (const [name, text] of [["gold.jsonl", gold], ["responses.jsonl", responses], ["rows.jsonl", rows]]) await writeFile(path.join(dir, name), text);
    const verify = async () => ({ manifest: { datasetId: "fixture", datasetDigest: "d", parts: { "gold-dev": { sha256: hash(gold) } } } });
    const args = { datasetFile: "unused", goldFile: path.join(dir, "gold.jsonl"), responsesFile: path.join(dir, "responses.jsonl"), rowsFile: path.join(dir, "rows.jsonl"), out: path.join(dir, "out"), verify };
    await assert.rejects(runMissBreakdown({ ...args, expect: { responses: "0".repeat(64), rows: hash(rows) } }), /not the recorded D15-F artifact/);
    const summary = await runMissBreakdown({ ...args, expect: { responses: hash(responses), rows: hash(rows) } });
    assert.equal(summary.byConfig.C0.byCause.WEAK_RELATION, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "out/summary.json"), "utf8")), summary);
    assert.match(await readFile(path.join(dir, "out/miss-rows.jsonl"), "utf8"), /Target\.java/);
    assert.doesNotMatch(JSON.stringify(summary), /Target\.java/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
