import test from "node:test";
import assert from "node:assert/strict";
import { C0, CALLER_FILE_CAP, corpusLines, PROBE_EDGE_LIMIT, callerFiles, callersOf, judgeTarget, planState, probeTasks, spanCredits, stopRule, summarize, typePath } from "./ilv2-s3-callers-probe.mjs";

const CORE_GAP = "Protected core exceeded read-plan limits; lower-value core files were omitted.";
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const source = { "A.java": lines(200), "Caller.java": lines(200), "Hit.java": lines(200), "Big.java": [...lines(10), "x".repeat(20000), ...lines(10)] };
const linesOf = file => source[file];

/** A recorded C0 diagnostic: the anchor, protected core files, and plain files, all selected unless listed in `unselected`. */
function diagnostic({ core = 0, plain = [], unselected = [], exceeded = false }) {
  const files = [{ id: "f0", path: "A.java", role: "target", reasons: ["anchor", "DEFINITION"] }];
  for (let i = 0; i < core; i += 1) files.push({ id: `c${i}`, path: `A.java`, role: "candidate", reasons: ["CALLS"] });
  plain.forEach((file, i) => files.push({ id: `p${i}`, path: file, role: "candidate", reasons: ["typeReference"] }));
  unselected.forEach((file, i) => files.push({ id: `u${i}`, path: file, role: "candidate", reasons: ["typeReference"] }));
  const selected = files.filter(file => !file.id.startsWith("u"));
  return { files, readPlan: selected.map(file => ({ fileId: file.id, ranges: [{ startLine: 1, endLine: 5 }] })), evidenceGaps: exceeded ? [CORE_GAP] : [] };
}

test("plan state counts protected core, anchor+core bytes and the core-exceeded gap", () => {
  const plan = planState(diagnostic({ core: 2, plain: ["Hit.java"], exceeded: true }), linesOf);
  assert.equal(plan.coreExceeded, true);
  assert.equal(plan.coreSelected, 2);
  assert.equal(plan.selectedFiles, 4);
  assert.equal(plan.coreBytes, 3 * Buffer.byteLength(lines(5).join("\n") + "\n"));
  assert.ok(plan.selectedPaths.has("Hit.java"));
});

test("caller files drop tests and the anchor file, group by file, rank by confidence and cap at 8", () => {
  const edges = [
    { sourceFile: "T.java", sourceSet: "test", confidence: 1, callerRange: { startLine: 1, endLine: 2 } },
    { sourceFile: "A.java", sourceSet: "main", confidence: 1, callerRange: { startLine: 1, endLine: 2 } },
    { sourceFile: "B.java", sourceSet: "main", confidence: 0.85, callerRange: { startLine: 1, endLine: 2 } },
    { sourceFile: "B.java", sourceSet: "main", confidence: 0.9, callerRange: { startLine: 5, endLine: 9 } },
    ...Array.from({ length: 10 }, (_, i) => ({ sourceFile: `Z${i}.java`, sourceSet: "main", confidence: 0.5, callerRange: null }))
  ];
  const files = callerFiles(edges, "A.java");
  assert.equal(files.length, CALLER_FILE_CAP);
  assert.deepEqual(files[0], { path: "B.java", confidence: 0.9, ranges: [{ startLine: 1, endLine: 2 }, { startLine: 5, endLine: 9 }] });
  assert.ok(!files.some(file => file.path === "T.java" || file.path === "A.java"));
});

test("a span credits only when it covers the item and the item ends inside the 80-line reader cap", () => {
  assert.equal(spanCredits({ startLine: 10, endLine: 50 }, { startLine: 20, endLine: 30 }), true);
  assert.equal(spanCredits({ startLine: 25, endLine: 50 }, { startLine: 20, endLine: 30 }), false);
  assert.equal(spanCredits({ startLine: 1, endLine: 200 }, { startLine: 70, endLine: 81 }), false, "line 81 is past the reader cap");
});

const callerOf = (file, startLine, endLine) => [{ path: file, confidence: 0.9, ranges: [{ startLine, endLine }] }];
const item = { path: "Caller.java", startLine: 20, endLine: 30 };

test("an uncredited direct caller is reachable only with core room and bytes", () => {
  const open = planState(diagnostic({ core: 1 }), linesOf);
  assert.equal(judgeTarget({ item, credited: false, plan: open, direct: callerOf("Caller.java", 10, 40), via: [], lines: linesOf }).reachable, true);
  const full = planState(diagnostic({ core: C0.coreMax }), linesOf);
  const blocked = judgeTarget({ item, credited: false, plan: full, direct: callerOf("Caller.java", 10, 40), via: [], lines: linesOf });
  assert.deepEqual([blocked.reachable, blocked.coreRoom], [false, false]);
  const exceeded = planState(diagnostic({ core: 1, exceeded: true }), linesOf);
  assert.equal(judgeTarget({ item, credited: false, plan: exceeded, direct: callerOf("Caller.java", 10, 40), via: [], lines: linesOf }).reachable, false);
  const big = { path: "Big.java", startLine: 5, endLine: 15 };
  const tooBig = judgeTarget({ item: big, credited: false, plan: open, direct: callerOf("Big.java", 1, 21), via: [], lines: linesOf });
  assert.deepEqual([tooBig.spanCredits, tooBig.fits, tooBig.reachable], [true, false, false]);
});

test("a supertype caller is counted apart and never as directly reachable", () => {
  const open = planState(diagnostic({ core: 0 }), linesOf);
  const judged = judgeTarget({ item, credited: false, plan: open, direct: [], via: callerOf("Caller.java", 10, 40), lines: linesOf });
  assert.deepEqual([judged.returned, judged.reachable, judged.reachableViaSupertype], ["via-supertype", false, true]);
});

test("a credited, selected, unprotected target returned as a caller is at risk when the core is full or exceeded", () => {
  const hit = { path: "Hit.java", startLine: 20, endLine: 30 };
  const full = planState(diagnostic({ core: C0.coreMax, plain: ["Hit.java"] }), linesOf);
  assert.equal(judgeTarget({ item: hit, credited: true, plan: full, direct: callerOf("Hit.java", 10, 40), via: [], lines: linesOf }).atRisk, true);
  const open = planState(diagnostic({ core: 1, plain: ["Hit.java"] }), linesOf);
  assert.equal(judgeTarget({ item: hit, credited: true, plan: open, direct: callerOf("Hit.java", 10, 40), via: [], lines: linesOf }).atRisk, false);
  assert.equal(judgeTarget({ item: hit, credited: true, plan: full, direct: [], via: [], lines: linesOf }).atRisk, false, "not returned, not touched");
});

test("stop rule: fewer than 2 reachable or fewer than 2 task groups; targets at risk only exclude the locked-core shape", () => {
  assert.deepEqual(stopRule({ reachable: 2, groups: 2, atRisk: 0 }), { stop: false, reasons: [], lockedCoreShapeExcluded: false });
  assert.deepEqual(stopRule({ reachable: 2, groups: 2, atRisk: 1 }), { stop: false, reasons: [], lockedCoreShapeExcluded: true });
  assert.deepEqual(stopRule({ reachable: 1, groups: 1, atRisk: 0 }).reasons, ["reachable<2", "taskGroups<2"]);
});

test("the anchor (role target, even with a protected reason) is not counted as core", () => {
  assert.equal(planState(diagnostic({ core: 0 }), linesOf).coreSelected, 0);
});

test("corpus lines read any file kind once and refuse paths outside the corpus", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "s3-lines-"));
  try {
    await writeFile(path.join(dir, "m.xml"), "<a>\n</a>\n");
    const read = corpusLines(dir);
    assert.deepEqual(read("m.xml"), ["<a>", "</a>", ""]);
    assert.equal(read("../etc/passwd"), undefined);
    assert.equal(read("missing.java"), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("named type ids map back to their file; local types do not", () => {
  assert.equal(typePath(`type:v2:${encodeURIComponent("m/src/main/java/a/B C.java")}#${encodeURIComponent("a.B")}`), "m/src/main/java/a/B C.java");
  assert.equal(typePath("type-local:a/B.java:3:5"), null);
});

/** A fake index: one method anchor whose owner implements a repo interface; callers of both. */
function fakeIndex() {
  const ownerId = `type:v2:${encodeURIComponent("A.java")}#a.A`;
  const portId = `type:v2:${encodeURIComponent("Port.java")}#a.Port`;
  const methods = {
    "A.java": [{ methodId: "m:A#run", ownerTypeId: ownerId, name: "run", parameters: [{}], range: { start: { line: 3 }, end: { line: 9 } } }],
    "Port.java": [{ methodId: "m:Port#run", ownerTypeId: portId, name: "run", parameters: [{}], constructor: false, range: { start: { line: 2 }, end: { line: 2 } } }],
    "Caller.java": [{ methodId: "m:Caller#go", range: { start: { line: 10 }, end: { line: 40 } } }],
    "Iface.java": [{ methodId: "m:Iface#use", range: { start: { line: 1 }, end: { line: 50 } } }]
  };
  const calls = [];
  return {
    calls,
    queryAnchor: async (file, line) => (line === 3
      ? { symbolKind: "METHOD", method: methods["A.java"][0], type: { extends: [], implements: [{ resolution: { state: "RESOLVED_REPO", typeId: portId } }] } }
      : { symbolKind: "TYPE", type: {} }),
    queryFiles: async ([file]) => [{ methods: methods[file] ?? [] }],
    queryCallers: async (methodId, limit) => {
      calls.push([methodId, limit]);
      if (methodId === "m:A#run") return [{ sourceId: "m:Caller#go", sourceFile: "Caller.java", sourceSet: "main", confidence: 0.9 }];
      if (methodId === "m:Port#run") return [{ sourceId: "m:Iface#use", sourceFile: "Iface.java", sourceSet: "main", confidence: 0.9 },
        { sourceId: "m:Caller#go", sourceFile: "Caller.java", sourceSet: "main", confidence: 0.9 }];
      return [];
    }
  };
}

test("callersOf queries one limit past the probe cap, resolves calling method ranges, and keeps supertype-only callers apart", async () => {
  const index = fakeIndex();
  const found = await callersOf(index, { relativePath: "A.java", selection: { line: 3, column: 5 } });
  assert.equal(found.anchorKind, "METHOD");
  assert.deepEqual(index.calls, [["m:A#run", PROBE_EDGE_LIMIT + 1], ["m:Port#run", PROBE_EDGE_LIMIT + 1]]);
  assert.deepEqual(found.direct, [{ path: "Caller.java", confidence: 0.9, ranges: [{ startLine: 10, endLine: 40 }] }]);
  assert.deepEqual(found.via.map(file => file.path), ["Iface.java"], "a file already returned directly is not counted again via the supertype");
  const typeAnchor = await callersOf(fakeIndex(), { relativePath: "A.java", selection: { line: 1, column: 1 } });
  assert.deepEqual([typeAnchor.anchorKind, typeAnchor.queried], ["TYPE", false]);
});

test("probeTasks + summarize: reachable and at-risk counts per task group, with names kept out of the summary", async () => {
  const tasks = new Map([["t1", { taskId: "t1", corpusId: "c", taskGroup: "g1" }], ["t2", { taskId: "t2", corpusId: "c", taskGroup: "g2" }], ["t3", { taskId: "t3", corpusId: "c", taskGroup: "g3" }]]);
  const gold = new Map([["t1", { requiredEvidence: [item, { path: "Hit.java", startLine: 1, endLine: 2 }] }], ["t2", { requiredEvidence: [item] }], ["t3", { requiredEvidence: [item] }]]);
  const rows = [
    { taskId: "t1", category: "callers", configs: { C0: { targets: [{ kind: "java", credited: false, label: "UNSELECTED" }, { kind: "java", credited: true, label: "IMPACT_SPAN" }] } } },
    { taskId: "t2", category: "callers", configs: { C0: { targets: [{ kind: "java", credited: false, label: "UNSELECTED" }] } } },
    { taskId: "t3", category: "callers", configs: { C0: { targets: [{ kind: "java", credited: false, label: "UNSELECTED" }] } } },
    { taskId: "t9", category: "spring", configs: { C0: { targets: [] } } }
  ];
  const term = (line, diag) => ({ exact: "match", symbol: { candidates: [{ declaration: { relativePath: "A.java", selection: { line, column: 5 } } }] }, impacts: { C0: { diagnostic: diag } } });
  const observations = [
    { taskId: "t1", terms: [term(3, diagnostic({ core: 1, plain: ["Hit.java"] }))] },
    { taskId: "t2", terms: [term(3, diagnostic({ core: 1 }))] },
    { taskId: "t3", terms: [term(1, diagnostic({ core: 1 }))] }
  ];
  const result = await probeTasks({ tasks, gold, rows, observations, indexFor: async () => fakeIndex(), linesFor: () => linesOf });
  assert.equal(result.rows.length, 4);
  assert.equal(result.calls.length, 3);
  const summary = summarize(result);
  assert.deepEqual(summary.calls.anchorKinds, { METHOD: 2, TYPE: 1 });
  assert.equal(summary.targets.reachable, 2);
  assert.equal(summary.targets.reachableTaskGroups, 2);
  assert.deepEqual(summary.targets.uncreditedByAnchorKind, { METHOD: 2, TYPE: 1 });
  assert.equal(summary.targets.creditedAtRisk, 0);
  assert.deepEqual(summary.stopRule, { stop: false, reasons: [], lockedCoreShapeExcluded: false });
  assert.doesNotMatch(JSON.stringify(summary), /Caller|Hit|A\.java|t1|g1/);
});
