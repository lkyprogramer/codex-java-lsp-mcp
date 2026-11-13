import test from "node:test";
import assert from "node:assert/strict";
import { LADDER, coveringDeclaration, declarationVocabulary, diagnoseMissedTarget, enclosingType, lexicalTokens, oracleQuery, summarizeMissed } from "./ilv2-not-returned-diagnosis.mjs";

const FILE = "app/src/main/java/demo/OrderService.java";
const sel = line => ({ line, column: 5 });
const TYPE = { kind: "class", name: "OrderService", startLine: 3, endLine: 200, selection: sel(3) };
const CANCEL = { kind: "method", name: "cancelOrder", startLine: 40, endLine: 70, selection: sel(42) };
const FIELD = { kind: "field", name: "repo", startLine: 5, endLine: 5, selection: sel(5) };
const LINES = Array.from({ length: 200 }, (_, i) => `    int line${i + 1};`);
LINES[37] = "    // unrelated note";
LINES[38] = "    /** 取消订单并释放库存 */";
LINES[39] = "    @Transactional";
LINES[41] = "    public void cancelOrder(long orderId) {";
const target = (startLine, endLine, file = FILE) => ({ path: file, startLine, endLine });

function stub({ outline = { scopeState: "READY", entries: [TYPE, FIELD, CANCEL] }, oracle } = {}) {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, ...args });
    if (args.operation === "outline") return outline;
    return oracle ?? { exact: "unique", candidates: [{ declaration: { relativePath: FILE, selection: sel(42) } }] };
  };
  return { call, calls };
}

test("tokens mirror the index split; vocabulary takes head, leading comments, type name and file stem", () => {
  assert.deepEqual([...lexicalTokens("cancelOrder 取消订单")].sort(), ["cancel", "cancelorder", "order", "取消", "取消订单", "消订", "订单"].sort());
  assert.equal(lexicalTokens("public void get").size, 0, "generic words do not count");
  const vocabulary = declarationVocabulary(LINES, CANCEL, "OrderService", FILE);
  for (const token of ["cancelorder", "transactional", "取消", "库存", "orderservice", "service"]) assert.ok(vocabulary.has(token), token);
  assert.equal(vocabulary.has("unrelated"), true, "a contiguous comment run above the declaration is leading text");
  assert.equal(vocabulary.has("line37"), false, "code above the leading block is not taken");
});

test("covering declaration prefers the innermost member whose name line windows the range", () => {
  const entries = [TYPE, FIELD, CANCEL];
  assert.equal(coveringDeclaration(entries, target(50, 60)), CANCEL);
  assert.equal(coveringDeclaration(entries, target(10, 12)), TYPE, "no member covers it: the type wins over a field");
  assert.equal(coveringDeclaration([FIELD], target(10, 12)), FIELD, "a field only when nothing else covers");
  assert.equal(coveringDeclaration(entries, target(150, 160)), null, "line 150 lies beyond every name line's window");
  assert.equal(enclosingType(entries, CANCEL), TYPE);
  assert.equal(oracleQuery(CANCEL, TYPE), "OrderService#cancelOrder");
  assert.equal(oracleQuery(TYPE, null), "OrderService");
});

test("the ladder stops at the first failing layer", async () => {
  const plan = { terms: ["取消订单"] };
  const run = (overrides, t = target(50, 60), p = plan) => diagnoseMissedTarget({ target: t, plan: p, lines: LINES, call: stub(overrides).call });
  assert.equal((await run({}, target(1, 2, "app/src/main/resources/logback.xml"))).label, "NON_JAVA");
  assert.equal((await run({}, target(50, 60), { terms: [] })).label, "NO_PLAN_TERMS");
  assert.equal((await run({ outline: { scopeState: "PARTIAL", entries: [CANCEL] } })).label, "OUTLINE_UNAVAILABLE");
  assert.equal((await run({}, target(150, 160))).label, "WINDOW_UNREACHABLE");
  const miss = await run({ oracle: { exact: "miss", candidates: [] } });
  assert.deepEqual([miss.label, miss.oracleExact, miss.coveringKind], ["ORACLE_MISS", "miss", "method"]);
  assert.equal((await run({}, target(50, 60), { terms: ["payment_gateway"] })).label, "NO_VOCAB_OVERLAP");
  const ranked = await run({});
  assert.deepEqual([ranked.label, ranked.oracleRank, ranked.vocabOverlap], ["RANKED_OUT", 1, true]);
});

test("probes use outline near the target and an exact owner#member query; the summary is counts only", async () => {
  const { call, calls } = stub();
  await diagnoseMissedTarget({ target: target(50, 60), plan: { terms: ["cancelOrder"] }, lines: LINES, call });
  assert.deepEqual(calls.map(item => [item.operation, item.file ?? item.query, item.nearLine ?? null, item.searchMode ?? null, item.limit]), [
    ["outline", FILE, 50, null, 20], ["query", "OrderService#cancelOrder", null, "exact", 20]]);
  const rows = [
    { label: "RANKED_OUT", mechanism: "NOT_RETURNED", category: "callers", coveringKind: "method" },
    { label: "NON_JAVA", mechanism: "NOT_RETURNED", category: "xml", coveringKind: null },
    { label: "ORACLE_MISS", mechanism: "FILE_ONLY", category: "callers", coveringKind: "method", oracleExact: "ambiguous" }
  ];
  const summary = summarizeMissed(rows, { total: 10, byMechanism: { TOP1: 7, NOT_RETURNED: 2, FILE_ONLY: 1 } });
  assert.deepEqual(Object.keys(summary.byLabel), [...LADDER]);
  assert.equal(summary.missedTargets, 3);
  assert.equal(summary.byLabelAndMechanism.NOT_RETURNED.RANKED_OUT, 1);
  assert.equal(summary.byLabelAndMechanism.FILE_ONLY.ORACLE_MISS, 1);
  assert.equal(summary.byCategory.xml.NON_JAVA, 1);
  assert.deepEqual(summary.oracleExact, { ambiguous: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /OrderService|cancelOrder|\.java/);
});
