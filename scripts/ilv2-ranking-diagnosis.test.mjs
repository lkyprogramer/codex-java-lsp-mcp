import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { convertDataset } from "./ilv2-mac-eval-dataset.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { classifyTarget, coAnchorOrder, diagnoseTask, inIdentityOrder, mainFirst, predictedIntent, rankOf, runDiagnosis, summarize, windowCovers } from "./ilv2-ranking-diagnosis.mjs";

const decl = (relativePath, line, name = "find", fqn = `demo.${relativePath.split("/").pop().replace(/\.java$/, "")}#${name}`) =>
  ({ declaration: { relativePath, name, fqn, kind: "method", selection: { line, column: 5 } }, matchedBy: ["exact"], binding: "ambiguous" });
const target = (path, startLine, endLine) => ({ path, startLine, endLine });

test("windowCovers mirrors the runner window: line-20, at most 80 lines, ending by line+60", () => {
  const candidate = decl("a/src/main/java/A.java", 100);
  assert.equal(windowCovers(candidate, target("a/src/main/java/A.java", 80, 159)), true);
  assert.equal(windowCovers(candidate, target("a/src/main/java/A.java", 79, 120)), false, "starts before line-20");
  assert.equal(windowCovers(candidate, target("a/src/main/java/A.java", 100, 160)), false, "80 lines from line-20 end at line+59");
  assert.equal(windowCovers(decl("a/src/main/java/A.java", 5), target("a/src/main/java/A.java", 1, 65)), true, "clamped at line 1, still ends by line+60");
  assert.equal(windowCovers(decl("a/src/main/java/A.java", 5), target("a/src/main/java/A.java", 1, 66)), false);
  assert.equal(windowCovers(candidate, target("a/src/main/java/B.java", 100, 101)), false, "other file");
  assert.equal(rankOf([decl("x/X.java", 1), candidate], target("a/src/main/java/A.java", 100, 110)), 2);
  assert.equal(rankOf([decl("x/X.java", 1)], target("a/src/main/java/A.java", 100, 110)), null);
});

test("identity order and the stable re-orderings never add or drop a candidate", () => {
  const list = [decl("a/src/main/java/A.java", 1), decl("a/src/test/java/ATest.java", 1), decl("b/src/main/java/B.java", 1)];
  assert.equal(inIdentityOrder(list), true);
  assert.equal(inIdentityOrder([list[2], list[0]]), false);
  assert.deepEqual(mainFirst(list).map(item => item.declaration.relativePath), ["a/src/main/java/A.java", "b/src/main/java/B.java", "a/src/test/java/ATest.java"]);
  const files = { "a/src/main/java/A.java": "class A { OrderService s; }", "b/src/main/java/B.java": "class B { RefundLedger r; OrderService s; }" };
  const reordered = coAnchorOrder(list, ["OrderService", "RefundLedger", "not a word"], file => files[file] ?? null);
  assert.deepEqual(reordered.map(item => item.declaration.relativePath), ["b/src/main/java/B.java", "a/src/main/java/A.java", "a/src/test/java/ATest.java"]);
  assert.equal(coAnchorOrder(list, ["OrderServiceImpl"], file => files[file] ?? null)[0], list[0], "whole words only, ties keep order");
  assert.deepEqual(coAnchorOrder(list, [], () => ""), list);
});

test("classifyTarget: ambiguous exact list ordered by path, with test sources ahead and co-anchor headroom", () => {
  const goal = "z/src/main/java/demo/RefundService.java";
  const candidates = [
    ...Array.from({ length: 6 }, (_, i) => decl(`m${i}/src/main/java/demo/Other${i}.java`, 10)),
    decl("m7/src/test/java/demo/FindTest.java", 10),
    decl(goal, 40)
  ];
  const plan = { terms: ["find", "RefundLedger"] };
  const responses = new Map([
    ["find", { auto: { exact: "ambiguous", selectionLimited: true, candidates }, text: { candidates: [decl(goal, 40)] }, withTerms: { candidates: [decl("q/Q.java", 1), decl(goal, 40)] } }],
    ["RefundLedger", { auto: { exact: "miss", candidates: [] }, text: { candidates: [] } }]
  ]);
  const row = classifyTarget({ target: target(goal, 40, 60), plan, responses, fileText: file => file === goal ? "RefundLedger ledger;" : "" });
  assert.equal(row.rank, 8);
  assert.equal(row.mechanism, "EXACT_AMBIGUOUS");
  assert.equal(row.identityOrdered, true);
  assert.deepEqual(row.ahead, { sameName: 7, test: 1, sameFile: 0 });
  assert.deepEqual(row.counterfactual, { mainFirst: 7, coAnchor: 1, mainFirstCoAnchor: 1, textRoute: 1, withTerms: 2 });
});

test("classifyTarget: text merge, file-only and never-returned targets", () => {
  const goal = "src/main/java/demo/A.java";
  const text = { auto: { candidates: [decl("src/main/java/demo/B.java", 1), decl(goal, 200)] } };
  const plan = { terms: ["refund ledger"] };
  const merged = classifyTarget({ target: target(goal, 190, 220), plan, responses: new Map([["refund ledger", text]]), fileText: () => "" });
  assert.equal(merged.mechanism, "TEXT_MERGE");
  assert.equal(merged.intent, "text");
  assert.equal(merged.counterfactual.textRoute, null, "no text probe was needed for a text query");
  const fileOnly = classifyTarget({ target: target(goal, 10, 20), plan, responses: new Map([["refund ledger", text]]), fileText: () => "" });
  assert.equal(fileOnly.mechanism, "FILE_ONLY");
  assert.equal(fileOnly.rank, null);
  const none = classifyTarget({ target: target("src/main/resources/M.xml", 1, 2), plan: { terms: [] }, responses: new Map(), fileText: () => "" });
  assert.equal(none.mechanism, "NOT_RETURNED");
  assert.equal(none.kind, "other");
});

test("the best-ranked term decides and summarize carries counts only", () => {
  const goal = "src/main/java/demo/A.java";
  const plan = { terms: ["first", "second"] };
  const responses = new Map([
    ["first", { auto: { candidates: [decl("src/main/java/demo/B.java", 1), decl("src/main/java/demo/C.java", 1), decl(goal, 30)] } }],
    ["second", { auto: { exact: "match", candidates: [decl(goal, 30)] } }]
  ]);
  const row = classifyTarget({ target: target(goal, 30, 40), plan, responses, fileText: () => "" });
  assert.equal(row.rank, 1);
  assert.equal(row.termIndex, 1);
  assert.equal(row.mechanism, "TOP1");
  const summary = summarize([{ planTerms: 2, targets: [row] }, { planTerms: 0, targets: [{ kind: "java", rank: null, mechanism: "NOT_RETURNED", intent: "text", counterfactual: { mainFirst: null, coAnchor: null, mainFirstCoAnchor: null, textRoute: null, withTerms: null } }] }]);
  assert.equal(summary.tasks, 2);
  assert.equal(summary.emptyPlanTasks, 1);
  assert.deepEqual(summary.hitAt.observed, { 1: 1, 3: 1, 8: 1, 20: 1 });
  assert.equal(summary.byMechanism.NOT_RETURNED, 1);
  assert.doesNotMatch(JSON.stringify(summary), /demo|first|second/);
});

test("diagnoseTask queries the agent-visible plan, probes the text route after an exact answer and the plan's other terms", async () => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, ...args });
    return args.query === "OrderService" && !args.searchMode && !args.terms ? { exact: "ambiguous", candidates: [] } : { candidates: [] };
  };
  const task = { taskId: "T1", anchors: ["OrderService"], prompt: "Which callers reach `refund ledger` here?" };
  const { plan, responses, intentMismatchTerms } = await diagnoseTask({ task, call });
  assert.deepEqual(plan.terms, ["OrderService", "refund ledger"]);
  assert.deepEqual(calls.map(item => [item.query, item.searchMode ?? "auto", item.terms ?? null, item.limit, item.preview]), [
    ["OrderService", "auto", null, 20, "none"], ["OrderService", "text", null, 20, "none"], ["OrderService", "auto", ["refund ledger"], 20, "none"],
    ["refund ledger", "auto", null, 20, "none"], ["refund ledger", "auto", ["OrderService"], 20, "none"]]);
  assert.ok(responses.get("OrderService").text);
  assert.equal(responses.get("refund ledger").text, undefined);
  assert.equal(intentMismatchTerms, 0);
  // A wire that omits `exact` for a code-shaped term is counted, so route labels can be distrusted.
  const silent = await diagnoseTask({ task, call: async () => ({ candidates: [] }) });
  assert.equal(silent.intentMismatchTerms, 1);
});

test("predictedIntent mirrors classifyQuery in auto mode", () => {
  for (const [query, intent] of [["OrderService", "exact"], ["getUserInfo", "exact"], ["demo.A#run", "exact"], ["refund", "text"], ["refund ledger", "text"], ["退款", "text"], ["Map<String,V>", "text"]]) {
    assert.equal(predictedIntent(query), intent, query);
  }
});

test("an exact miss recovered by the text route or by query+terms is counted, not lost", () => {
  const goal = "src/main/java/demo/A.java";
  const plan = { terms: ["RefundService", "ledger"] };
  const responses = new Map([
    ["RefundService", { auto: { exact: "miss", candidates: [] }, text: { candidates: [decl(goal, 30)] }, withTerms: { candidates: [] } }],
    ["ledger", { auto: { candidates: [decl("src/main/java/demo/B.java", 1)] }, withTerms: { candidates: [decl("x/X.java", 1), decl(goal, 30)] } }]
  ]);
  const row = classifyTarget({ target: target(goal, 30, 40), plan, responses, fileText: () => "" });
  assert.equal(row.mechanism, "NOT_RETURNED");
  assert.equal(row.intent, "exact");
  assert.deepEqual(row.exactOutcomes, ["miss"]);
  assert.deepEqual(row.counterfactual, { mainFirst: null, coAnchor: null, mainFirstCoAnchor: null, textRoute: 1, withTerms: 2 });
  const summary = summarize([{ planTerms: 2, intentMismatchTerms: 0, targets: [row] }]);
  assert.deepEqual(summary.notCovered, { targets: 1, afterExactRoute: 1, recoveredByTextRoute: 1, recoveredByWithTerms: 1 });
  assert.deepEqual(summary.hitAt.orTextRoute, { 1: 1, 3: 1, 8: 1, 20: 1 });
  assert.deepEqual(summary.hitAt.orWithTerms, { 1: 0, 3: 1, 8: 1, 20: 1 });
});

/** Same contract as materializeCorpus (frozen tree without .git, overlays, hidden tests removed), portable copy. */
async function copyMaterialize({ record, corpus, oraclesRoot, target }) {
  cpSync(record.repoRoot, target, { recursive: true, filter: src => !path.relative(record.repoRoot, src).split(path.sep).includes(".git") });
  for (const overlay of corpus.overlays) {
    const text = await readFile(path.join(oraclesRoot, overlay.taskId, "pre-state.java"), "utf8");
    assert.equal(sha256(text), overlay.preStateSha256);
    await writeFile(path.join(target, overlay.path), text);
  }
  for (const file of corpus.hidden ?? []) await rm(path.join(target, file.path));
  return target;
}

test("runDiagnosis on a frozen fixture dataset: private rows, counts-only summary, foreign tasks refused", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "ranking-diagnosis-"));
  t.after(() => removeTree(dir));
  const fixture = await evalFixture(dir);
  const datasetDir = path.join(dir, "dataset");
  await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out: datasetDir });
  const goldFile = path.join(datasetDir, "private/gold-dev.jsonl");
  const tasksFile = path.join(datasetDir, "tasks-dev.jsonl");
  const gold = readFileSync(goldFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const firstEvidence = new Map(gold.map(row => [row.taskId, row.requiredEvidence[0]]));
  const tasks = readFileSync(tasksFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const dist = path.join(dir, "dist");
  await mkdir(dist);
  await writeFile(path.join(dist, "build-stamp.json"), JSON.stringify({ gitSha: "fixture" }));
  let calls = 0;
  const opened = [];
  const openSession = async ({ corpusRoot }) => {
    opened.push(corpusRoot);
    return {
      readyMs: 5,
      // Every query returns one decoy then the declaration window of the first evidence of the task the term came from.
      call: async (_name, args) => {
        calls += 1;
        const task = tasks.find(item => (item.anchors ?? []).includes(args.query) || String(item.prompt).includes(`\`${args.query}\``));
        const evidence = task && firstEvidence.get(task.taskId);
        return { candidates: [decl("decoy/Decoy.java", 1), ...(evidence ? [decl(evidence.path, evidence.startLine)] : [])] };
      },
      close: async () => {}
    };
  };
  const out = path.join(dir, "out");
  const summary = await runDiagnosis({ datasetFile: path.join(datasetDir, "dataset-manifest.json"), tasksFile, goldFile, inputsFile: fixture.inputsFile,
    serverJs: path.join(dist, "server.js"), out, openSession, materialize: copyMaterialize });
  assert.ok(calls > 0 && opened.length > 0);
  assert.equal(summary.tasks, tasks.length);
  assert.equal(summary.targets, gold.reduce((sum, row) => sum + row.requiredEvidence.length, 0));
  const planned = tasks.filter(task => (task.anchors ?? []).length > 0 || /`[^`\n]{2,64}`/.test(task.prompt)).length;
  assert.equal(summary.hitAt.observed[3], planned, "the first evidence of every planned task is at rank 2");
  assert.equal(summary.hitAt.observed[1], 0);
  const rows = readFileSync(path.join(out, "rows.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, tasks.length);
  const serialized = JSON.stringify(summary);
  for (const task of tasks) assert.doesNotMatch(serialized, new RegExp(task.taskId), "no task id in the summary");
  for (const row of gold) for (const item of row.requiredEvidence) assert.ok(!serialized.includes(item.path), "no gold path in the summary");
  assert.match(readFileSync(path.join(out, "summary.json"), "utf8"), /ranking-diagnosis\/v1/);
  await assert.rejects(runDiagnosis({ datasetFile: path.join(datasetDir, "dataset-manifest.json"), tasksFile: goldFile, goldFile, inputsFile: fixture.inputsFile,
    serverJs: path.join(dist, "server.js"), out: path.join(dir, "out2"), openSession, materialize: copyMaterialize }), /not a part of this dataset/);
});
