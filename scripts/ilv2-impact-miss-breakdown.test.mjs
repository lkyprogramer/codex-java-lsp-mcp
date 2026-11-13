import test from "node:test";
import assert from "node:assert/strict";
import { CAUSES, breakdown, callsOf, classifyMiss, roleAudit, summarize } from "./ilv2-impact-miss-breakdown.mjs";

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
  assert.deepEqual(summary.rules.R2_selection, { value: 1, persistsInC3: 1, gate: 5, triggered: false });
  assert.deepEqual(summary.roleAudit, { poolFiles: 1, relatedWithProtectedReason: 1, protectedKinds: { IMPLEMENTATION: 1 } });
  assert.doesNotMatch(JSON.stringify(summary), /Target\.java|demo/);
  assert.throws(() => breakdown({ rows, observations, gold: new Map([["t1", { requiredEvidence: [item] }]]) }), /scored targets vs 1 gold/);
  assert.throws(() => breakdown({ rows: [{ ...rows[0], configs: { C0: { targets: [targets[2], targets[1], targets[0]] }, C3: { targets } } }], observations, gold }), /kind does not match/);
});

test("rule gates: selection needs >= 5 and persistence in C3; weak needs half; replay counts unattributable pools", () => {
  const miss = (taskId, cause, config = "C0", category = "callers") => ({ taskId, index: 0, config, category, cause });
  const selection = ["a", "b", "c", "d", "e"].map(id => miss(id, "PROTECTED_UNSELECTED"));
  const persisted = ["a", "b", "c"].map(id => miss(id, "PROTECTED_UNSELECTED", "C3"));
  const rules = summarize([...selection, ...persisted, miss("f", "ANCHOR_CONFOUND"), miss("g", "WEAK_RELATION", "C0", "spring")], {}).rules;
  assert.deepEqual([rules.focusMissesC0, rules.R2_selection.triggered, rules.R2_selection.persistsInC3, rules.R1_replay.value, rules.R3_weak.value], [6, true, 3, 1, 0]);
  assert.equal(summarize(selection.slice(0, 5).map((row, i) => ({ ...row, cause: i < 3 ? "WEAK_RELATION" : row.cause })), {}).rules.R3_weak.triggered, true);
  assert.equal(callsOf(observation("t", [{ exact: null, impacts: { C0: { diagnostic: diag([]) } } }]), "C0")[0].exact, "text");
});
