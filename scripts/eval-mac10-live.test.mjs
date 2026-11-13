// post-ILV2 Q10: the MAC-10 LIVE adapter on the two-commit fixture dataset. Corpora are materialized with a portable
// copy here (the real materializeCorpus uses an APFS clone and runs in ilv2-mac-eval-chain.test on the Mac); the
// repair oracle is stubbed (the real javac/java oracle runs in ilv2-mac-repair-oracle.test). The model is a fake chat.
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { convertDataset } from "./ilv2-mac-eval-dataset.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { hashBoundEvents, main, runLiveEvalRun, scoreQaAnswer } from "./evaluate-java-task.mjs";
import { LIMITS as RECEIPT_LIMITS, verifyReceipt } from "./ilv2-mac-delivery-receipt.mjs";
import { impactSessionFromClient } from "./run-agent-trace-live.mjs";
import { mac10PublicFields, parseSourceBudget, prepareMac10Live, selectPilot } from "./eval-mac10-live.mjs";

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
const judged = [];
const stubOracle = async ({ sourceText }) => {
  judged.push(sourceText);
  return sourceText.includes("value > high")
    ? { state: "PASS", completion: "COMPLETE", compileMs: 1, runMs: 1, detail: "ORACLE PASS" }
    : { state: "TEST_FAILED", completion: "INCOMPLETE", compileMs: 1, runMs: 1, detail: "ORACLE FAIL above" };
};
const stubJava = async javaHome => ({ javaHome, javaSha256: "stub-java", javacSha256: "stub-javac", version: "stub" });
/** A toolchains manifest freezing a fake JDK (bin/java, bin/javac) by hash, as ILV2_TOOLCHAINS does. */
function fakeToolchains(dir) {
  const javaHome = path.join(dir, "jdk");
  mkdirSync(path.join(javaHome, "bin"), { recursive: true });
  const files = ["bin/java", "bin/javac", "lib/modules"].map(rel => {
    const file = path.join(javaHome, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `frozen ${rel}\n`);
    return { path: file, sha256: sha256(readFileSync(file)) };
  });
  const toolchainsFile = path.join(dir, "toolchains.json");
  writeFileSync(toolchainsFile, JSON.stringify({ javaHome, files: [...files, { path: path.join(dir, "gradle/bin/gradle"), sha256: "not-under-java-home" }] }));
  return { javaHome, toolchainsFile };
}

async function dataset(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mac10-live-"));
  t.after(() => removeTree(dir));
  const fixture = await evalFixture(dir);
  const datasetDir = path.join(dir, "dataset");
  const manifest = await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out: datasetDir });
  return { dir, fixture, manifest, toolchains: fakeToolchains(dir), datasetFile: path.join(datasetDir, "dataset-manifest.json"), tasksFile: path.join(datasetDir, "tasks-dev.jsonl"),
    goldFile: path.join(datasetDir, "private/gold-dev.jsonl"), oracleTest: readFileSync(path.join(fixture.curationDir, "oracles/ClampOracle.java"), "utf8") };
}
const prepare = (data, extra = {}) => prepareMac10Live({ datasetFile: data.datasetFile, tasksFile: data.tasksFile, goldFile: data.goldFile, inputsFile: data.fixture.inputsFile,
  outputDir: path.join(data.dir, extra.out ?? "run"), toolchainsFile: data.toolchains.toolchainsFile, materialize: copyMaterialize, javaIdentityOf: stubJava, evaluate: stubOracle, ...extra });

test("MAC-10 adapter: agent-visible rows only, sorted set gold with file hashes, corpora from the frozen tree with overlays and no hidden tests", async t => {
  const data = await dataset(t);
  const live = await prepare(data, { sourceBudget: { max_lines: 120, max_bytes: 24000 } });
  assert.equal(live.split, "dev");
  const callers = live.tasks.find(task => task.id === "FX-CALLERS");
  assert.deepEqual(callers.output_contract, { answer_keys: { callers: "array" } });
  assert.deepEqual(callers.answerSlots, { callers: "string-set" });
  assert.deepEqual(callers.budget, { max_lines: 120, max_bytes: 24000 });
  assert.match(callers.query, /Named anchors: `Calc`, `Calc.clamp`\./);
  const repair = live.tasks.find(task => task.id === "FX-REPAIR");
  assert.deepEqual(repair.budget, callers.budget);
  // Nothing evaluator-side reaches an agent-visible task row.
  const visible = JSON.stringify(live.tasks);
  for (const secret of ["demo.OrderService", "OrderService.java", "FlatRule.java", "requiredEvidence", "repairOracle", "ORACLE", "private/"]) {
    assert.equal(visible.includes(secret), false, `task rows leak ${secret}`);
  }
  assert.deepEqual(live.gold.get("FX-IMPLS").answer, { implementations: ["demo.FlatRule", "demo.PercentRule"] });
  const evidence = live.gold.get("FX-CALLERS").required_evidence[0];
  assert.deepEqual([evidence.path, evidence.start_line, evidence.end_line], ["src/main/java/demo/OrderService.java", 10, 12]);
  assert.equal(evidence.file_sha256, sha256(readFileSync(path.join(live.repoRoots.fixture, evidence.path))));
  assert.deepEqual(live.publicAnswerContract.tasks.get("FX-CALLERS"), mac10PublicFields({ callers: { type: "string-set" } }).fields);
  assert.equal(live.publicAnswerContract.sha256, data.manifest.parts["answer-contract"].sha256);
  // The corpus is the broken pre-state, without the tests that assert the fix.
  assert.match(readFileSync(path.join(live.repoRoots.fixture, "src/main/java/demo/Calc.java"), "utf8"), /return value;/);
  assert.equal(readFileSync(path.join(live.repoRoots.fixture, "src/main/java/demo/Calc.java"), "utf8").includes("value > high"), false);
  assert.equal(existsSync(path.join(live.repoRoots.fixture, "src/test/java/demo/CalcTest.java")), false);
  assert.equal(existsSync(path.join(live.repoRoots.fixture, ".git")), false);
  assert.equal(live.identity.java.javaSha256, "stub-java");
  assert.equal(live.identity.java.frozenFiles, 3, "every frozen file under javaHome is hash-checked");
  assert.match(live.tasks.find(task => task.id === "FX-CALLERS").query, /Answer rules: Answer with one strict JSON object/);
  assert.deepEqual(live.identity.sourceBudget, { max_lines: 120, max_bytes: 24000 });
  // Identity is fail-closed: gold of another part, a missing JDK for repair, a corpus that is not the frozen input.
  await assert.rejects(prepare(data, { goldFile: data.tasksFile, out: "bad-gold" }), /gold of --dataset/);
  await assert.rejects(prepare(data, { toolchainsFile: null, out: "no-jdk" }), /ILV2_TOOLCHAINS/);
  const inputs = JSON.parse(readFileSync(data.fixture.inputsFile, "utf8"));
  const drifted = path.join(data.dir, "inputs-drifted.json");
  writeFileSync(drifted, JSON.stringify([{ ...inputs[0], head: "0".repeat(40) }]));
  await assert.rejects(prepare(data, { inputsFile: drifted, out: "drifted" }), /does not match its frozen input/);
  // QA only: no JDK is needed.
  const qaOnly = await prepare(data, { toolchainsFile: null, taskIds: ["FX-CALLERS"], out: "qa-only" });
  assert.equal(qaOnly.identity.java, null);
  // A drifted JDK fails closed.
  writeFileSync(path.join(data.toolchains.javaHome, "lib/modules"), "upgraded\n");
  await assert.rejects(prepare(data, { out: "jdk-drift" }), /frozen JDK drift: .*lib\/modules/);
  // Build output or any untracked/ignored file in the input checkout would be copied into the corpus: refused.
  writeFileSync(path.join(data.fixture.repoRoot, "src/main/java/demo/Calc.class"), "fixed bytecode");
  await assert.rejects(prepare(data, { toolchainsFile: null, taskIds: ["FX-CALLERS"], out: "dirty" }), /untracked, ignored or modified files/);
});

test("MAC-10 scoring: string-set is order-free but not duplicate-tolerant; evidence counts only from the verified file version", () => {
  const gold = { callers: ["a.A", "b.B"] };
  assert.equal(scoreQaAnswer(gold, '{"callers":["b.B","a.A"]}', { setKeys: ["callers"] }).correct, true);
  assert.equal(scoreQaAnswer(gold, '{"callers":["b.B","a.A"]}').correct, false, "without set keys arrays stay ordered (kit semantics)");
  assert.equal(scoreQaAnswer(gold, '{"callers":["a.A","b.B","a.A"]}', { setKeys: ["callers"] }).correct, false);
  assert.equal(scoreQaAnswer(gold, '{"callers":["a.A"]}', { setKeys: ["callers"] }).status, "WRONG_ANSWER");
  const required = [{ path: "src/A.java", start_line: 1, end_line: 2, file_sha256: "good" }];
  const events = [{ type: "SOURCE_RECEIVED", path: "src/A.java", startLine: 1, endLine: 2, fileContentHash: "stale" },
    { type: "SOURCE_RECEIVED", path: "src/B.java", startLine: 1, endLine: 1 },
    { type: "SOURCE_RECEIVED", path: "src/A.java", startLine: 1, endLine: 2, fileContentHash: "good" }];
  assert.deepEqual(hashBoundEvents(required, events).map(event => event.fileContentHash ?? event.path), ["src/B.java", "good"]);
  assert.equal(hashBoundEvents([{ path: "x", start_line: 1, end_line: 1 }], events).length, 3, "kit gold without file hashes is unchanged");
  assert.equal(parseSourceBudget("none"), null);
  assert.deepEqual(parseSourceBudget("80:16000"), { max_lines: 80, max_bytes: 16000 });
  for (const bad of [undefined, "", "80", "0:1", "80:-1", "1.5:2"]) assert.throws(() => parseSourceBudget(bad));
});

test("pilot selection: deterministic, stratified by corpus and category, independent of input order", () => {
  const tasks = [];
  for (const corpus of ["a", "b", "c"]) for (const category of ["callers", "xml", "repair"]) for (let i = 0; i < 4; i += 1) tasks.push({ id: `${corpus}-${category}-${i}`, corpus, category });
  const first = selectPilot(tasks, { count: 12, seed: "q10-pilot" });
  assert.equal(first.tasks.length, 12);
  assert.deepEqual(selectPilot([...tasks].reverse(), { count: 12, seed: "q10-pilot" }).identity.taskIds, first.identity.taskIds);
  const perStratum = new Map();
  for (const task of first.tasks) perStratum.set(`${task.corpus}/${task.category}`, (perStratum.get(`${task.corpus}/${task.category}`) ?? 0) + 1);
  assert.equal(perStratum.size, 9, "every stratum is covered before any gets a second task");
  assert.ok([...perStratum.values()].every(n => n === 1 || n === 2));
  assert.notDeepEqual(selectPilot(tasks, { count: 12, seed: "other" }).identity.taskIds, first.identity.taskIds);
  assert.throws(() => selectPilot(tasks, { count: 0, seed: "s" }));
  assert.throws(() => selectPilot(tasks, { count: 37, seed: "s" }));
  assert.throws(() => selectPilot(tasks, { count: 2 }));
});

const toolCall = (id, name, args) => ({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
const scripted = steps => {
  const requests = [];
  let index = 0;
  return { requests, chat: async request => { requests.push(JSON.stringify(request)); const step = steps[Math.min(index, steps.length - 1)]; index += 1; return step; } };
};

test("default serialized transport verifies the exact final source on both arms", async t => {
  const data = await dataset(t);
  const live = await prepare(data, { sourceBudget: { max_lines: 80, max_bytes: 16000 } });
  const outputDir = path.join(data.dir, "verified-transport");
  const bodies = [];
  let inFlight = false;
  const result = await runLiveEvalRun({
    tasks: live.tasks.filter(task => task.id === "FX-CALLERS"),
    gold: live.gold, repoRoots: live.repoRoots, outputDir, publicAnswerContract: live.publicAnswerContract,
    arms: ["b0", "b2"], verifyRequestDelivery: true, indexReadyTimeoutMs: 1000,
    env: { OPENAI_API_KEY: "fake", OPENAI_BASE_URL: "http://fake.invalid", OPENAI_MODEL: "fixture" },
    openSessionImpl: async () => {
      let sample = 0;
      return {
        waitIndexFresh: async () => 2,
        readIndexTelemetry: async () => ({ actualBuildMode: "full", fullReason: "no-base", queryCounters: { queueFull: 0, runKills: sample++ } }),
        close: async () => {}
      };
    },
    fetchImpl: async (_url, { body }) => {
      assert.equal(inFlight, false);
      inFlight = true;
      try {
        bodies.push(body);
        const request = JSON.parse(body);
        const reply = request.messages.some(message => message.role === "tool")
          ? toolCall("s", "submit_answer", { callers: ["demo.OrderService"] })
          : toolCall("r", "read", { path: "src/main/java/demo/OrderService.java", startLine: 10, maxLines: 3 });
        await new Promise(resolve => setImmediate(resolve));
        return new Response(JSON.stringify(reply));
      } finally { inFlight = false; }
    }
  });
  const captures = (await readFile(path.join(outputDir, "final-requests.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(bodies.length, 4);
  assert.deepEqual(captures.map(row => row.body), [bodies[1], bodies[3]]);
  for (const [i, run] of result.runs.entries()) {
    const request = JSON.parse(captures[i].body);
    assert.equal(request.tools.some(tool => tool.function.name === "java_evidence"), run.arm === "b2");
    assert.equal(run.taskSuccess, true);
    assert.equal(run.requestDelivery.status, "VERIFIED");
    assert.equal(run.requestDelivery.requestBodySha256, sha256(captures[i].body));
    assert.equal(run.verifiedSourceReceived.length, 1);
    assert.deepEqual(run.indexTelemetry[0].queryCounterDelta, { queueFull: 0, runKills: 1 });
  }
});

test("final request receipts cover source above the per-receipt limits", async t => {
  const file = "A.java";
  const shortLines = Array.from({ length: 160 }, (_, index) => `// line ${index + 1} 订单\r\n`);
  const byteHeavyLine = `// ${"界".repeat(3000)}\r\n`;
  const cases = [
    { name: "split one 81-line read", lines: [...shortLines.slice(0, 81), "class A {}"],
      reads: [{ startLine: 2, maxLines: 81 }], receiptRanges: [[[2, 81]], [[82, 82]]] },
    { name: "two default reads", lines: shortLines, reads: [{}, { startLine: 81 }], receiptRanges: [[[1, 80]], [[81, 160]]] },
    { name: "UTF-8 byte cap", lines: [byteHeavyLine, byteHeavyLine], reads: [{ maxLines: 1 }, { startLine: 2, maxLines: 1 }],
      budget: parseSourceBudget("80:20000"), receiptRanges: [[[1, 1]], [[2, 2]]] },
    { name: "unit cap", lines: shortLines.slice(0, 9), reads: shortLines.slice(0, 9).map((_, index) => ({ startLine: index + 1, maxLines: 1 })),
      receiptRanges: [[...Array.from({ length: 8 }, (_, index) => [index + 1, index + 1])], [[9, 9]]] }
  ];
  for (const { name, lines, reads, budget, receiptRanges } of cases) await t.test(name, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), "mac10-receipt-batches-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fixture = path.join(dir, "fixture");
    await mkdir(fixture);
    await writeFile(path.join(fixture, file), lines.join(""));
    const start = reads[0].startLine ?? 1;
    const required = { path: file, start_line: start, end_line: lines.length, file_sha256: sha256(lines.join("")) };
    const task = { id: "Q", corpus: "c", kind: "qa", query: "Which file contains the source?", output_contract: { answer_keys: { file: "string" } }, budget };
    const replies = reads.map((args, index) => toolCall(`r${index + 1}`, "read", { path: file, ...args }));
    replies.push(toolCall("s", "submit_answer", { file }));
    let finalBody;
    let requestIndex = 0;
    const { runs: [run] } = await runLiveEvalRun({
      tasks: [task], gold: new Map([[task.id, { answer: { file }, required_evidence: [required] }]]),
      arms: ["control"], repoRoots: { c: fixture }, outputDir: path.join(dir, "run"), verifyRequestDelivery: true,
      env: { OPENAI_API_KEY: "fake", OPENAI_BASE_URL: "http://fake.invalid", OPENAI_MODEL: "fixture" },
      fetchImpl: async (_url, { body }) => {
        finalBody = body;
        return new Response(JSON.stringify(replies[requestIndex++]));
      }
    });
    assert.equal(requestIndex, replies.length);
    assert.deepEqual([run.answerStatus, run.taskSuccess, run.requiredEvidenceCovered], ["CORRECT", true, true]);
    const delivery = run.requestDelivery;
    assert.equal(delivery.status, "VERIFIED");
    assert.equal(delivery.verifiedUnits, reads.length);
    assert.deepEqual(delivery.refused, []);
    assert.deepEqual(run.verifiedSourceReceived, run.sourceReceived.filter(event => event.type === "SOURCE_RECEIVED"));
    assert.deepEqual(delivery.receipts.map(receipt => receipt.units.map(unit => [unit.startLine, unit.endLine])), receiptRanges);
    const { workspaceId, contentManifestId } = delivery.receipts[0];
    for (const receipt of delivery.receipts) {
      const result = await verifyReceipt({ body: finalBody, receipt, workspaceRoot: fixture, expectedView: { workspaceId, contentManifestId } });
      assert.equal(result.status, "REQUEST_BODY_VERIFIED");
      assert.ok(result.verifiedUnits <= RECEIPT_LIMITS.maxUnits);
      assert.ok(result.sourceLines <= RECEIPT_LIMITS.maxLines);
      assert.ok(result.sourceBytes <= RECEIPT_LIMITS.maxBytes);
    }
  });
});

test("MAC-10 LIVE chain (fake model): QA credited on received verified source, repair judged by the oracle, gold never sent", async t => {
  const data = await dataset(t);
  const live = await prepare(data, { sourceBudget: null });
  const base = { gold: live.gold, repoRoots: live.repoRoots, publicAnswerContract: live.publicAnswerContract, repairJudge: live.repairJudge, arms: ["control"], env: {} };

  const qa = scripted([toolCall("r1", "read", { path: "src/main/java/demo/OrderService.java" }), toolCall("s", "submit_answer", { callers: ["demo.OrderService"] })]);
  const qaRun = await runLiveEvalRun({ ...base, tasks: live.tasks.filter(task => task.id === "FX-CALLERS"), outputDir: path.join(data.dir, "out-qa"), chat: qa.chat });
  const row = qaRun.runs[0];
  assert.equal(row.taskSuccess, true, JSON.stringify({ status: row.answerStatus, missing: row.missingEvidence }));
  assert.equal(row.answerCorrect, true);
  assert.equal(row.requiredEvidenceCovered, true);
  assert.equal(row.publicAnswerContract.sha256, data.manifest.parts["answer-contract"].sha256);
  // The first request is everything the model gets before it acts: prompt, contract, tools. No gold, evidence path or oracle.
  for (const secret of ["demo.OrderService", "OrderService.java", "ClampOracle", "ORACLE PASS", data.oracleTest.slice(0, 60)]) {
    assert.equal(qa.requests[0].includes(secret), false, `first request leaks ${secret}`);
  }

  const answerOnly = scripted([toolCall("s", "submit_answer", { callers: ["demo.OrderService"] })]);
  const unsupported = (await runLiveEvalRun({ ...base, tasks: live.tasks.filter(task => task.id === "FX-CALLERS"), outputDir: path.join(data.dir, "out-answer-only"), chat: answerOnly.chat })).runs[0];
  assert.deepEqual([unsupported.taskSuccess, unsupported.answerCorrect, unsupported.requiredEvidenceCovered, unsupported.answerStatus],
    [false, true, false, "MISSING_REQUIRED_EVIDENCE"], "a correct answer without received evidence is not a success, and both facts are kept");

  const fix = { path: "src/main/java/demo/Calc.java", before: "        return value;", after: "        if (value > high) {\n            return high;\n        }\n        return value;" };
  const repairTask = live.tasks.filter(task => task.id === "FX-REPAIR");
  const repaired = scripted([toolCall("w", "replace_file", fix), toolCall("s", "submit_answer", { patchApplied: true, summary: "Clamp above the upper bound." })]);
  const repairRow = (await runLiveEvalRun({ ...base, tasks: repairTask, outputDir: path.join(data.dir, "out-repair"), chat: repaired.chat })).runs[0];
  assert.equal(repairRow.taskSuccess, true, JSON.stringify(repairRow.repairJudge));
  assert.equal(repairRow.repairJudge.state, "VALIDATED_SUCCESS");
  assert.equal(JSON.parse(readFileSync(repairRow.repairJudge.judgeArtifactPath, "utf8")).policy.allowedEdits[0], "src/main/java/demo/Calc.java");
  assert.equal(existsSync(path.join(repairRow.candidateRoot, "src/main/java/demo/ClampOracle.java")), false, "the oracle never enters the candidate");
  assert.equal(repaired.requests.some(body => body.includes("ClampOracle") || body.includes("ORACLE PASS")), false);

  const untouched = scripted([toolCall("s", "submit_answer", { patchApplied: true, summary: "Done." })]);
  const failed = (await runLiveEvalRun({ ...base, tasks: repairTask, outputDir: path.join(data.dir, "out-untouched"), chat: untouched.chat })).runs[0];
  assert.deepEqual([failed.taskSuccess, failed.repairJudge.state], [false, "TEST_FAILED"], "the self-report is not the verdict");

  const judgedBefore = judged.length;
  const stray = scripted([toolCall("w", "replace_file", fix), toolCall("x", "write_file", { path: "src/main/java/demo/Extra.java", content: "package demo;\n" }),
    toolCall("s", "submit_answer", { patchApplied: true, summary: "Fixed." })]);
  const rejected = (await runLiveEvalRun({ ...base, tasks: repairTask, outputDir: path.join(data.dir, "out-stray"), chat: stray.chat })).runs[0];
  assert.deepEqual([rejected.taskSuccess, rejected.repairJudge.state], [false, "REJECTED_DISALLOWED_EDIT"]);
  assert.equal(judged.length, judgedBefore, "a disallowed edit is rejected before the oracle runs");

  const broken = await prepare(data, { sourceBudget: null, out: "run-judge-error", evaluate: async () => { throw new Error("javac vanished"); } });
  const judgeError = (await runLiveEvalRun({ ...base, repoRoots: broken.repoRoots, repairJudge: broken.repairJudge, tasks: broken.tasks.filter(task => task.id === "FX-REPAIR"),
    outputDir: path.join(data.dir, "out-judge-error"), chat: scripted([toolCall("w", "replace_file", fix), toolCall("s", "submit_answer", { patchApplied: true, summary: "Fixed." })]).chat })).runs[0];
  assert.deepEqual([judgeError.attemptState, judgeError.taskOutcome, judgeError.taskSuccess, judgeError.answerStatus], ["COMPLETED", "UNMEASURED", null, "REPAIR_JUDGE_ERROR"],
    "a judge failure leaves the slot unmeasured; it is not the agent's failure");
});

test("index readiness: product sessions wait for a FRESH view before the agent, and a session that cannot report it blocks setup", async t => {
  const calls = [];
  const states = ["NOT_READY", "STALE", "FRESH"];
  const client = { callTool: async ({ name, arguments: args }) => {
    calls.push([name, args.start === true]);
    const state = name === "java_status" && !args.start ? states.shift() : "NOT_READY";
    return { content: [{ text: JSON.stringify({ indexView: { state } }) }] };
  } };
  const session = impactSessionFromClient({ repoRoot: "/repo", client });
  assert.equal(typeof await session.waitIndexFresh({ timeoutMs: 5000, pollMs: 1 }), "number");
  assert.deepEqual(calls, [["java_status", true], ["java_status", false], ["java_status", false], ["java_status", false]]);
  const never = impactSessionFromClient({ repoRoot: "/repo", client: { callTool: async () => ({ content: [{ text: '{"indexView":{"state":"NOT_READY"}}' }] }) } });
  await assert.rejects(never.waitIndexFresh({ timeoutMs: 5, pollMs: 1 }), /not FRESH within 5 ms \(state NOT_READY\)/);

  const dir = await mkdtemp(path.join(tmpdir(), "mac10-ready-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "fixture");
  await mkdir(fixture);
  writeFileSync(path.join(fixture, "A.java"), "class A {}\n");
  const task = { id: "Q", corpus: "c", kind: "qa", query: "Which file is this?", output_contract: { answer_keys: { file: "string" } } };
  const submit = scripted([toolCall("s", "submit_answer", { file: "x" })]);
  const common = { tasks: [task], gold: new Map([["Q", { answer: { file: "x" }, required_evidence: [] }]]), arms: ["b2"], repoRoots: { c: fixture }, env: {}, chat: submit.chat, indexReadyTimeoutMs: 1000 };
  const ready = await runLiveEvalRun({ ...common, outputDir: path.join(dir, "ready"),
    openSessionImpl: async () => ({ waitIndexFresh: async () => 42, symbol: async () => ({}), evidence: async () => ({}), outline: async () => ({}), close: async () => {} }) });
  assert.deepEqual(ready.runs[0].indexReadyMs, [42]);
  const blind = await runLiveEvalRun({ ...common, outputDir: path.join(dir, "blind"),
    openSessionImpl: async () => ({ symbol: async () => ({}), close: async () => {} }) });
  assert.equal(blind.runs[0].attemptState, "BLOCKED_SETUP", "no readiness report: the attempt never reaches the model");
});

test("CLI: MAC-10 adapter dry run materializes and pins identity; missing budget, raw repo roots or a kit are refused before anything is written", async t => {
  const data = await dataset(t);
  const serverFile = path.join(data.dir, "server.js");
  writeFileSync(serverFile, "// fixture server\n");
  const deps = { materialize: copyMaterialize, javaIdentityOf: stubJava, evaluateOracle: stubOracle };
  const env = { ILV2_TOOLCHAINS: data.toolchains.toolchainsFile };
  const args = ["--dataset", data.datasetFile, "--tasks", data.tasksFile, "--gold", data.goldFile, "--inputs", data.fixture.inputsFile,
    "--arms", "b0,b2", "--repeats", "3", "--require-identity", "--server-js", serverFile, "--dry-run"];
  const output = path.join(data.dir, "cli");
  assert.equal(await main([...args, "--source-budget", "none", "--pilot", "2", "--pilot-seed", "q10", "--output", output], env, deps), 0);
  const pack = JSON.parse(readFileSync(path.join(output, "results-pack.json"), "utf8"));
  assert.equal(pack.status, "DRY_RUN");
  assert.deepEqual(pack.identity.identityCheck, { status: "VERIFIED", problems: [] });
  assert.equal(pack.identity.mac10.adapter, "mac10-live-adapter/v1");
  assert.equal(pack.identity.mac10.sourceBudget, null);
  assert.equal(pack.identity.pilot.taskIds.length, 2);
  assert.equal(pack.identity.indexReadyTimeoutMs, 900000);
  assert.equal(pack.denominator, 2 * 2 * 3);
  assert.ok(existsSync(path.join(output, "corpora", "fixture", "src/main/java/demo/Calc.java")));
  for (const [extra, name] of [[[], "no-budget"], [["--source-budget", "none", "--repo-roots", `fixture=${data.fixture.repoRoot}`], "raw-root"],
    [["--source-budget", "none", "--kit-root", data.dir], "kit"], [["--source-budget", "none", "--pilot", "9", "--pilot-seed", "q10"], "pilot-too-large"]]) {
    const out = path.join(data.dir, `cli-${name}`);
    assert.equal(await main([...args, ...extra, "--output", out], env, deps), 2, name);
    assert.equal(existsSync(path.join(out, "schedule.jsonl")), false, `${name}: no schedule`);
  }
  // Kit rows: the MAC-10 flags are refused rather than silently ignored, and no readiness wait is implied.
  const kitTasks = path.join(data.dir, "kit-tasks.jsonl");
  writeFileSync(kitTasks, `${JSON.stringify({ id: "K1", corpus: "c", kind: "qa", query: "q" })}\n`);
  assert.equal(await main(["--tasks", kitTasks, "--inputs", data.fixture.inputsFile, "--dry-run", "--output", path.join(data.dir, "cli-kit-inputs")], env, deps), 2);
  const kitOut = path.join(data.dir, "cli-kit");
  assert.equal(await main(["--tasks", kitTasks, "--dry-run", "--output", kitOut], env, deps), 0);
  assert.equal(JSON.parse(readFileSync(path.join(kitOut, "results-pack.json"), "utf8")).identity.indexReadyTimeoutMs, 0);
});
