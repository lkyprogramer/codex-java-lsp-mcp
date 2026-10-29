import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_TESTS, JDT_EVIDENCE_SCHEMA, K_CONTRACT_VERSION, K29_REQUEST_PROTOCOL, acceptJdtEvidence, combinedEvidence, contractOutcome, loadEvidenceGate, testEvidence } from "./run-release-contracts.mjs";
import { INTERLEAVED_ROUNDS, fixtureDigest } from "./release-jdt-contracts.mjs";
import { REQUEST_LOAD_PROTOCOL } from "../dist/benchmark/measure-request-load.js";

const tap = (result, directive = "") => `# Subtest: K01: real contract\n${result} 1 - K01: real contract${directive}\n`;
test("release runner requires a selected passing behavior, not exit zero or a file wrapper", () => {
  const run = stdout => ({ stdout, stderr: "", exitCode: 0, timedOut: false });
  assert.equal(testEvidence(run(tap("ok")), "^K01:").status, "PASS");
  for (const output of ["", "ok 1 - /tmp/file.test.js\n", tap("not ok"), tap("ok", " # SKIP"), tap("ok", " # TODO"), tap("ok").replaceAll("K01", "K02")]) {
    assert.equal(testEvidence(run(output), "^K01:").status, "FAIL");
  }
  assert.equal(testEvidence({ ...run(tap("ok")), timedOut: true }, "^K01:").status, "FAIL");
  assert.equal(testEvidence({ ...run(tap("ok")), exitCode: 1 }, "^K01:").status, "FAIL");
});

test("release load gate keeps the static SLO and judges the update step on service time and its prepare wait separately", () => {
  const step = concurrency => ({ concurrency, requests: 100, settled: true, errors: 0, previews: 300, publishes: 0, prepareUnattributed: 0,
    worker: { queuePeak: concurrency - 1, submits: 200, pids: [101, 102] }, latencyMs: { p95: 80 }, serviceMs: { p95: 80 }, prepareMs: { p95: 0 }, eventLoopDelayMs: { p95: 3 } });
  const report = { protocol: K29_REQUEST_PROTOCOL, steps: [step(1), step(5), step(20)], withUpdates: { ...step(20), publishes: 2 } };
  assert.equal(loadEvidenceGate(report).status, "PASS");
  assert.equal(loadEvidenceGate({ steps: [] }).status, "FAIL");
  assert.equal(loadEvidenceGate({ ...report, steps: [step(1)] }).status, "FAIL");
  for (const change of [{ requests: 0 }, { settled: false }, { latencyMs: { p95: 151 } }, { eventLoopDelayMs: { p95: 21 } }, { worker: { queuePeak: 33, submits: 200, pids: [1] } }]) {
    assert.equal(loadEvidenceGate({ ...report, steps: [step(1), step(5), { ...step(20), ...change }] }).status, "FAIL", `static ${JSON.stringify(change)}`);
  }
  // Under updates the prepare wait leaves the 150 ms: a request that waited for its round passes on its service time alone.
  const waited = { ...report.withUpdates, latencyMs: { p95: 1080 }, serviceMs: { p95: 150 }, prepareMs: { p95: 1000 } };
  assert.equal(loadEvidenceGate({ ...report, withUpdates: waited }).status, "PASS");
  for (const change of [{ serviceMs: { p95: 151 } }, { serviceMs: undefined }, { prepareMs: { p95: 1001 } }, { prepareMs: undefined }, { prepareUnattributed: 1 },
    { requests: 0 }, { settled: false }, { eventLoopDelayMs: { p95: 21 } }, { worker: { queuePeak: 33, submits: 200, pids: [1] } }]) {
    assert.equal(loadEvidenceGate({ ...report, withUpdates: { ...waited, ...change } }).status, "FAIL", `updates ${JSON.stringify(change)}`);
  }
  assert.deepEqual(loadEvidenceGate({ ...report, withUpdates: waited }).withUpdates, { latencyMs: { p95: 1080 }, serviceMs: { p95: 150 }, prepareMs: { p95: 1000 }, prepareOutcomes: undefined },
    "the update step's whole latency stays in the gate row as reported");
});

test("release load gate accepts only the request-path driver with the pool, previews and a publish under load", () => {
  const step = concurrency => ({ concurrency, requests: 100, settled: true, errors: 0, previews: 300, publishes: 0, prepareUnattributed: 0,
    worker: { queuePeak: 3, submits: 200, pids: [101] }, latencyMs: { p95: 40 }, serviceMs: { p95: 40 }, prepareMs: { p95: 0 }, eventLoopDelayMs: { p95: 2 } });
  const report = { protocol: K29_REQUEST_PROTOCOL, steps: [step(1), step(5), step(20)], withUpdates: { ...step(20), publishes: 1 } };
  assert.equal(K29_REQUEST_PROTOCOL, REQUEST_LOAD_PROTOCOL, "runner and driver share one protocol");
  assert.equal(loadEvidenceGate(report).requestPathPass, true);
  // The retired in-process SQL driver met the SLO but never passed the request view or the pool.
  const retired = { ...report, protocol: "p3-capacity-v1" };
  assert.deepEqual([loadEvidenceGate(retired).status, loadEvidenceGate(retired).requestPathPass, loadEvidenceGate(retired).performancePass], ["FAIL", false, true]);
  for (const change of [{ errors: 1 }, { previews: 0 }, { worker: { queuePeak: 3, submits: 99, pids: [101] } }, { worker: { queuePeak: 3, submits: 200, pids: [] } }]) {
    assert.equal(loadEvidenceGate({ ...report, steps: [step(1), step(5), { ...step(20), ...change }] }).status, "FAIL", JSON.stringify(change));
  }
  assert.equal(loadEvidenceGate({ ...report, withUpdates: { ...report.withUpdates, publishes: 0 } }).status, "FAIL", "no publish landed under load");
});

test("a selected-only run exits on its selected contracts and never claims the full K set", () => {
  const rows = Array.from({ length: 32 }, (_, i) => ({ id: "K" + String(i + 1).padStart(2, "0"), status: "NOT_RUN" }));
  const withK29 = status => rows.map(row => row.id === "K29" ? { ...row, status } : row);
  const pass = contractOutcome(withK29("PASS"), ["K29"]);
  assert.equal(pass.exitCode, 0);
  assert.deepEqual(pass.summary, { PASS: 1, FAIL: 0, BLOCKED_ENV: 0, NOT_RUN: 31, selection: "selected", selected: ["K29"], selectedPass: true, allContractsPass: false });
  assert.equal(contractOutcome(withK29("FAIL"), ["K29"]).exitCode, 1);
  assert.equal(contractOutcome(withK29("BLOCKED_ENV"), ["K29"]).exitCode, 1);
  assert.equal(contractOutcome(withK29("PASS"), ["K29"], true).exitCode, 1, "candidate drift fails the run");
  assert.equal(contractOutcome(rows, []).exitCode, 1, "nothing selected is not a pass");
  const all = rows.map(row => ({ ...row, status: "PASS" }));
  const ids = all.map(row => row.id);
  assert.deepEqual([contractOutcome(all, ids).exitCode, contractOutcome(all, ids).summary.allContractsPass, contractOutcome(all, ids).summary.selection], [0, true, "all"]);
  const oneMissing = all.map(row => row.id === "K26" ? { ...row, status: "BLOCKED_ENV" } : row);
  assert.deepEqual([contractOutcome(oneMissing, ids).exitCode, contractOutcome(oneMissing, ids).summary.allContractsPass], [1, false]);
});

test("release JDT gate accepts only owner-path v2 evidence for this candidate, native and fixture", () => {
  const identity = { sourceDigest: "a".repeat(64) };
  const native = { binarySha256: "n".repeat(64), sourceDigest: "s".repeat(64) };
  const base = { inflight: 0, sharedJoins: 0, abortedNoWaiters: 0, completeWrites: 2 };
  const k28 = { shortCode: "DEADLINE_EXCEEDED", whileShortExited: { inflight: 1, sharedJoins: 1, abortedNoWaiters: 0, base }, longOutcome: { completion: "COMPLETE" }, settled: { inflight: 0, completeWrites: 3, abortedNoWaiters: 0 } };
  const refs = { groups: [{ files: [{ path: "src/main/java/probe/Caller.java", positions: [{ line: 5, column: 23 }] }] }] };
  const k26 = {
    disabled: { isError: true, message: "start with --enable-lsp", status: { lsp: { enabled: false }, started: false } },
    enabled: { locator: { summary: { candidates: 1, errors: 0, selectionResolvesDeclaration: 1 } }, references: refs,
      isolation: { a: { hover: "compute(int value)" }, b: { hover: "compute(long value)" }, references: { a: refs, b: refs }, sessions: { a: { repoHash: "x" }, b: { repoHash: "y" } },
        interleaved: { crosstalk: 0, rounds: Array.from({ length: INTERLEAVED_ROUNDS }, (_, round) => ({ round, order: round % 2 ? ["b", "a"] : ["a", "b"],
          file: round % 4 < 2 ? "src/main/java/probe/Target.java" : "src/main/java/probe/Caller.java", a: { hover: "compute(int value)" }, b: { hover: "compute(long value)" } })) } } }
  };
  const payload = { schema: JDT_EVIDENCE_SCHEMA, candidateIdentity: identity, nativeBinarySha256: native.binarySha256, nativeSourceDigest: native.sourceDigest, fixtureDigest,
    K26: { status: "PASS", evidence: k26 }, K28: { status: "PASS", evidence: k28 } };
  const accept = (p, id, i = identity, n = native) => acceptJdtEvidence(p, i, id, n).status;
  assert.deepEqual([accept(payload, "K26"), accept(payload, "K28")], ["PASS", "PASS"]);
  assert.equal(accept({ ...payload, schema: "release-real-jdt-evidence/v1" }, "K28"), "FAIL", "in-process v1 evidence is not owner-path evidence");
  assert.equal(accept(payload, "K28", { sourceDigest: "b" }), "FAIL");
  assert.equal(accept(payload, "K28", identity, { ...native, binarySha256: "m" }), "FAIL");
  assert.equal(accept({ ...payload, fixtureDigest: "f" }, "K26"), "FAIL");
  assert.equal(accept({ ...payload, K28: { status: "PASS", evidence: {} } }, "K28"), "FAIL");
  assert.equal(accept({ ...payload, K28: { status: "PASS", evidence: { ...k28, settled: { ...k28.settled, completeWrites: 4 } } } }, "K28"), "FAIL", "backend ran twice");
  assert.equal(accept({ ...payload, K26: { status: "PASS", evidence: {} } }, "K26"), "FAIL");
  const swapped = { ...k26.enabled.isolation, b: k26.enabled.isolation.a };
  assert.equal(accept({ ...payload, K26: { status: "PASS", evidence: { ...k26, enabled: { ...k26.enabled, isolation: swapped } } } }, "K26"), "FAIL", "cross-worktree content");
  const shared = { ...k26.enabled.isolation, sessions: { a: { repoHash: "x" }, b: { repoHash: "x" } } };
  assert.equal(accept({ ...payload, K26: { status: "PASS", evidence: { ...k26, enabled: { ...k26.enabled, isolation: shared } } } }, "K26"), "FAIL", "shared session");
  const leaked = structuredClone(k26.enabled.isolation);
  leaked.interleaved.rounds[7].b = leaked.interleaved.rounds[7].a;
  assert.equal(accept({ ...payload, K26: { status: "PASS", evidence: { ...k26, enabled: { ...k26.enabled, isolation: leaked } } } }, "K26"), "FAIL", "one interleaved round answered from the other worktree");
  const { interleaved: _, ...noInterleaving } = k26.enabled.isolation;
  assert.equal(accept({ ...payload, K26: { status: "PASS", evidence: { ...k26, enabled: { ...k26.enabled, isolation: noInterleaving } } } }, "K26"), "FAIL", "interleaving is required");
});

test("a multi-entry contract passes only when every entry selected and passed its tests", () => {
  const pass = { status: "PASS", selected: [{ name: "a", status: "passed" }] }, fail = { status: "FAIL", selected: [] };
  assert.equal(combinedEvidence([pass]), pass, "a single entry keeps its own evidence shape");
  assert.equal(combinedEvidence([pass, pass]).status, "PASS");
  assert.equal(combinedEvidence([pass, fail]).status, "FAIL");
  assert.equal(combinedEvidence([]).status, "FAIL");
  assert.equal(combinedEvidence([pass, pass]).parts.length, 2);
  for (const [id, entries] of Object.entries(CONTRACT_TESTS)) {
    assert.ok(Array.isArray(entries) && entries.length > 0, id);
    for (const [file, pattern] of entries) assert.ok(typeof file === "string" && new RegExp(pattern), `${id} ${file}`);
  }
});

test("release runner covers all 32 contracts through tests or explicit real runtime handlers", () => {
  const ids = [...Object.keys(CONTRACT_TESTS), "K26", "K28", "K29"].sort();
  assert.deepEqual(ids, Array.from({ length: 32 }, (_, i) => "K" + String(i + 1).padStart(2, "0")));
});

test("the current K matrix names a contract version and covers every §6.2 change on the frozen K list", async () => {
  const { readFileSync } = await import("node:fs");
  const current = JSON.parse(readFileSync(new URL("./release-k-contract-matrix.json", import.meta.url), "utf8"));
  const frozen = JSON.parse(readFileSync(new URL("../docs/java-specialist-release-audit-v1.1/contracts/runtime-matrix.json", import.meta.url), "utf8"));
  assert.equal(K_CONTRACT_VERSION, current.contractVersion);
  assert.match(K_CONTRACT_VERSION, /mac14/);
  assert.deepEqual(frozen.contracts.map(row => row.id), Array.from({ length: 32 }, (_, i) => "K" + String(i + 1).padStart(2, "0")), "the full K01–K32 list is kept");
  for (const id of ["K05", "K06", "K11", "K12", "K15", "K19", "K20", "K21", "K24", "K26", "K28", "K29", "K30"]) assert.ok(current.changes[id]?.oracle, `${id} has its §6.2 oracle`);
  for (const id of Object.keys(current.changes)) assert.ok(frozen.contracts.some(row => row.id === id), id);
});
