// input: evaluate-java-task.mjs unit surface: backend detection, the
//         BLOCKED_AUTH pack, SOURCE_RECEIVED recording from tool results,
//         Q-track answer scoring, and the recorded-run replay invariants.
// output: RED→GREEN evidence for the M2 T09 host recorder adapter. The live
//         agent loop itself is BLOCKED_AUTH on this host (no model
//         credentials), so these tests pin the recorder/scoring semantics
//         that a live run will consume.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { convertDataset } from "./ilv2-mac-eval-dataset.mjs";
import { pairedCompare } from "./ilv2-mac-paired-compare.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import {
  assemblePack,
  backendDeficit,
  createRecorder,
  detectBackend,
  EVAL_PACK_SCHEMA_VERSION,
  EVAL_PROTOCOL_VERSION,
  EVAL_SYSTEM_PROMPT,
  boundSourceResult,
  invokeWithSourceBudget,
  EVAL_JAVA_SYMBOL_TOOL,
  productTools,
  validateProductArguments,
  diagnoseCandidateReceipts,
  normalizeTaskAnchor,
  projectDiscoveryForModel,
  runLiveEvalRun,
  extractSourceEvents,
  loadTaskFile,
  loadGoldFile,
  main,
  scoreQaAnswer,
  scoreRunOutcome
} from "./evaluate-java-task.mjs";
import { serializeModelToolResult } from "./eval-tool-wire.mjs";

test("anchor paths become file locators and both arms receive generic answer conventions", () => {
  assert.equal(EVAL_PROTOCOL_VERSION, "eval-protocol/v1.7");
  assert.deepEqual(normalizeTaskAnchor({ path: "a/B.java", line: 7 }), { path: "a/B.java", file: "a/B.java", line: 7, column: 1 });
  assert.equal(normalizeTaskAnchor({ file: "a.java", path: "b.java", line: 2 }).file, "a.java");
  assert.match(EVAL_SYSTEM_PROMPT, /simple identifiers/);
  assert.match(EVAL_SYSTEM_PROMPT, /shortest available route to exact source/);
  assert.match(EVAL_SYSTEM_PROMPT, /specific missing fact/);
  assert.match(EVAL_SYSTEM_PROMPT, /step by step/);
});

test("compact discovery keeps ambiguous identities and exact received source receipts", () => {
  const text = "  void apply() {\r\n    work();\r\n  }\r\n";
  const raw = { schemaVersion: "java-discovery/v1", repoHash: "repo", generation: 3, scopeState: "READY", candidates: ["one", "two"].map(module => ({
    declaration: { id: "long-encoded-identity".repeat(40), name: "apply", fqn: "demo.Shared#apply", kind: "method", module,
      relativePath: `${module}/Shared.java`, sourceRoot: `${module}/src`, signature: "apply()", contentHash: "a".repeat(64), selection: { line: 4, column: 8 } },
    matchedBy: ["identifier"], binding: "source-declaration", previewKind: "source", preview: text,
    evidenceRange: { relativePath: `${module}/Shared.java`, contentHash: "a".repeat(64), startLine: 4, endLine: 6 }
  })) };
  const projected = projectDiscoveryForModel(raw);
  assert.ok(JSON.stringify(projected).length < JSON.stringify(raw).length / 2);
  assert.deepEqual(projected.candidates.map(c => c.declaration.module), ["one", "two"]);
  assert.equal(raw.candidates[0].declaration.contentHash, "a".repeat(64), "audit raw is unchanged");
  const wire = serializeModelToolResult("java_symbol", projected);
  assert.deepEqual(wire.slices, ["one", "two"].map(module => ({ path: `${module}/Shared.java`, startLine: 4, endLine: 6, text,
    fileContentHash: "a".repeat(64), sliceHash: createHash("sha256").update(text).digest("hex") })));
});

test("remaining source budget clips whole CRLF/UTF-8 lines and preserves file hash and range", () => {
  const text = "// 汉字\r\nvoid x() {}\r\nlast();\n";
  const first = "// 汉字\r\n";
  const result = boundSourceResult("read", { path: "A.java", startLine: 4, endLine: 6, text, contentHash: "f".repeat(64) },
    { lines: 10, bytes: Buffer.byteLength(first) });
  assert.equal(result.text, first);
  assert.equal(result.endLine, 4);
  assert.equal(result.nextStartLine, 5);
  assert.equal(result.truncated, true);
  const slices = serializeModelToolResult("read", result).slices;
  assert.deepEqual(slices, [{ path: "A.java", startLine: 4, endLine: 4, text: first, fileContentHash: "f".repeat(64),
    sliceHash: createHash("sha256").update(first).digest("hex") }]);
  assert.equal(boundSourceResult("read", result, { lines: 0, bytes: 100 }).text, "");
});

test("discovery budget charges each preview again and omits zero-line previews explicitly", () => {
  const candidate = { declaration: { name: "x", relativePath: "A.java" }, previewKind: "source", preview: "x\ny\n",
    evidenceRange: { relativePath: "A.java", contentHash: "a".repeat(64), startLine: 3, endLine: 4 } };
  const result = boundSourceResult("java_symbol", { schemaVersion: "java-discovery/v1", candidates: [candidate, candidate] }, { lines: 2, bytes: 100 });
  assert.equal(result.candidates[0].preview, "x\ny\n");
  assert.equal(result.candidates[1].previewOmitted, "SOURCE_BUDGET");
  assert.equal(result.candidates[1].declaration.contentHash, "a".repeat(64));
  assert.equal(result.truncated, true);
  assert.equal(serializeModelToolResult("java_symbol", result).slices.length, 1);
  const xml = { ...candidate, declaration: { ...candidate.declaration, contentHash: "b".repeat(64) },
    evidenceRange: { ...candidate.evidenceRange, relativePath: "mapper.xml" } };
  const omitted = boundSourceResult("java_symbol", projectDiscoveryForModel({ candidates: [xml] }), { lines: 0, bytes: 0 });
  assert.equal(omitted.candidates[0].declaration.contentHash, "b".repeat(64), "XML evidence hash must not replace Java declaration hash");
});

test("candidate receipts validate exact before/after snapshots separately from the final tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-receipts-"));
  try {
    const snapshots = path.join(dir, "snapshots");
    await mkdir(snapshots);
    const before = "class A { int x = 1; }\n";
    const after = "class A { int x = 2; }\n";
    writeFileSync(path.join(dir, "A.java"), after);
    const events = [before, after].map((text, index) => {
      const hash = createHash("sha256").update(text).digest("hex");
      writeFileSync(path.join(snapshots, hash), text);
      return { type: "SOURCE_RECEIVED", callId: String(index), path: "A.java", startLine: 1, endLine: 1, text, fileContentHash: hash };
    });
    const diagnostic = diagnoseCandidateReceipts(events, { candidateRoot: dir, snapshotRoot: snapshots });
    assert.equal(diagnostic.status, "VALID");
    assert.deepEqual(diagnostic.rows.map(row => row.finalCandidateMatches), [false, true]);
    assert.equal(diagnoseCandidateReceipts([{ ...events[0], text: "fabricated" }], { candidateRoot: dir, snapshotRoot: snapshots }).status, "INVALID");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("live control enforces cumulative source budget, logs raw/model/completion, and normalizes anchor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-v13-"));
  try {
    const fixture = path.join(dir, "fixture");
    await mkdir(fixture);
    writeFileSync(path.join(fixture, "A.java"), "class A {\n  int n = 1;\n}\n");
    const requests = [];
    const output = path.join(dir, "run");
    const run = await runLiveEvalRun({ tasks: [{ id: "Q", corpus: "c", kind: "qa", query: "Return member name.",
      anchors: [{ path: "A.java", line: 2 }], budget: { max_lines: 2, max_bytes: 100 }, output_contract: { answer_keys: { member: "string" } } }],
      gold: new Map([["Q", { answer: { member: "n" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 2 }] }]]), arms: ["control"], repoRoots: { c: fixture }, outputDir: output,
      chatRequestConfig: { chatTemplateKwargs: { enable_thinking: false } },
      chat: async request => {
        requests.push(request);
        const index = requests.length;
        return { choices: [{ finish_reason: index <= 2 ? "tool_calls" : "stop", message: index <= 2
          ? { role: "assistant", content: "", tool_calls: [{ id: `read-${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "A.java", maxLines: 10 }) } }] }
          : { role: "assistant", content: "draft", tool_calls: [{ id: "submit", type: "function", function: { name: "submit_answer", arguments: '{"member":"n"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
      } });
    assert.equal(run.runs[0].attemptState, "COMPLETED");
    assert.match(requests[0].messages[1].content, /Anchor file: A.java/);
    assert.deepEqual(requests[0].chatTemplateKwargs, { enable_thinking: false });
    const received = run.runs[0].sourceReceived.filter(e => e.type === "SOURCE_RECEIVED");
    assert.equal(received.reduce((sum, e) => sum + e.endLine - e.startLine + 1, 0), 2);
    const journal = readFileSync(path.join(output, "raw-tool-results.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(journal[0].rawResult.endLine, 3);
    assert.equal(journal[0].modelResult.endLine, 2);
    assert.equal(journal[1].sourceSlices.length, 0);
    assert.equal(journal[1].rawResult.error, "SOURCE_BUDGET_EXHAUSTED");
    assert.equal(journal[1].modelResult.terminal, true);
    assert.equal(run.runs[0].sourceReceived.filter(e => e.type === "SOURCE_FETCHED").length, 1);
    assert.ok(run.runs[0].submission.acceptedAnswer);
    assert.equal(run.runs[0].taskSuccess, true);
    assert.equal(run.runs[0].submission.receipts.flatMap(receipt => receipt.slices).length, received.length);
    assert.equal(readFileSync(path.join(output, "model-completions.jsonl"), "utf8").trim().split("\n").length, 3);
    assert.equal(run.runs[0].finalAnswerMode, "SUBMITTED");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("main forwards env reasoning settings to actual request and audited config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-main-config-"));
  const previousFetch = globalThis.fetch;
  try {
    const fixture = path.join(dir, "fixture");
    await mkdir(fixture);
    writeFileSync(path.join(fixture, "A.java"), "class A {}\n");
    const tasks = path.join(dir, "tasks.jsonl");
    const gold = path.join(dir, "gold.jsonl");
    writeFileSync(tasks, JSON.stringify({ id: "Q", corpus: "c", kind: "qa", query: "Return member name.", output_contract: { answer_keys: { member: "string" } } }) + "\n");
    writeFileSync(gold, JSON.stringify({ id: "Q", answer: { member: "x" } }) + "\n");
    const sent = [];
    globalThis.fetch = async (_url, request) => {
      sent.push(JSON.parse(request.body));
      return { ok: true, text: async () => JSON.stringify({ id: "offline", model: "fake", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", tool_calls: [{ id: "submit", type: "function", function: { name: "submit_answer", arguments: '{"member":"x"}' } }] } }] }) };
    };
    const output = path.join(dir, "run");
    assert.equal(await main(["--tasks", tasks, "--gold", gold, "--output", output, "--arms", "control", "--repo-roots", `c=${fixture}`],
      { OPENAI_BASE_URL: "http://offline.invalid/v1", OPENAI_API_KEY: "fake", OPENAI_MODEL: "fake", OPENAI_REASONING_EFFORT: "medium" }), 0);
    assert.equal(sent[0].reasoning_effort, "medium");
    assert.equal(sent[0].max_tokens, 2048);
    assert.deepEqual(sent[0].chat_template_kwargs, { enable_thinking: false });
    const payload = JSON.parse(readFileSync(path.join(output, "model-payloads.jsonl"), "utf8").trim());
    assert.deepEqual(payload.requestConfig, { max_tokens: 2048, reasoning_effort: "medium", chat_template_kwargs: { enable_thinking: false } });
  } finally {
    globalThis.fetch = previousFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("both arms receive the same public schema and roles while factual scoring remains strict", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-public-contract-"));
  try {
    const fixture = path.join(dir, "fixture"); await mkdir(fixture);
    writeFileSync(path.join(fixture, "A.java"), "class A {}\n");
    const fields = { method: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$", description: "Simple method identifier." } };
    const publicAnswerContract = { version: "public-qa/v1.0", sha256: "c".repeat(64), tasks: new Map([["Q", fields]]) };
    const tasks = [{ id: "Q", corpus: "c", kind: "qa", query: "Return method.", output_contract: { answer_keys: { method: "string" } } }];
    const requests = [];
    const run = await runLiveEvalRun({ tasks, publicAnswerContract, gold: new Map([["Q", { answer: { method: "correct" } }]]),
      arms: ["product", "control"], repoRoots: { c: fixture }, outputDir: path.join(dir, "run"),
      openSessionImpl: async () => ({ close: async () => {} }),
      chat: async request => {
        requests.push(request);
        return { choices: [{ message: { tool_calls: [{ id: "submit", type: "function", function: { name: "submit_answer", arguments: '{"method":"wrong"}' } }] } }] };
      } });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools.find(t => t.function.name === "submit_answer"), requests[1].tools.find(t => t.function.name === "submit_answer"));
    assert.deepEqual(requests[0].messages.slice(0, 2), requests[1].messages.slice(0, 2));
    assert.match(requests[0].messages[1].content, /Simple method identifier/);
    assert.equal(requests[0].messages.some(m => m.content.includes('"correct"')), false);
    for (const row of run.runs) {
      assert.deepEqual(row.publicAnswerContract, { version: publicAnswerContract.version, sha256: publicAnswerContract.sha256, applied: true });
      assert.equal(row.taskSuccess, false, "public syntax validity cannot correct factual values");
      assert.ok(row.submission.acceptedAnswer);
    }
    const pack = assemblePack({ status: "MEASURED", arms: ["product", "control"], repeats: 1, runs: run.runs, publicAnswerContract });
    assert.deepEqual(pack.publicAnswerContract, { version: publicAnswerContract.version, sha256: publicAnswerContract.sha256 });
    assert.deepEqual(pack.packs[0].publicAnswerContract, run.runs[0].publicAnswerContract);
    await assert.rejects(runLiveEvalRun({ tasks, publicAnswerContract: { ...publicAnswerContract, tasks: new Map() },
      outputDir: path.join(dir, "missing"), chat: async () => { throw new Error("should not dispatch"); } }), /missing task: Q/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("live repair exposes replace success and validates both source versions without rescoring", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-replace-receipts-"));
  try {
    const fixture = path.join(dir, "fixture");
    await mkdir(fixture);
    writeFileSync(path.join(fixture, "A.java"), "class A { int n = 1; }\n");
    let round = 0;
    const requests = [];
    const output = path.join(dir, "run");
    const run = await runLiveEvalRun({ tasks: [{ id: "R", corpus: "c", kind: "repair", query: "Change initial n to 2.",
      budget: { max_lines: 1, max_bytes: 1 } }],
      arms: ["control"], repoRoots: { c: fixture }, outputDir: output, kitRoot: dir,
      repairJudge: async () => ({ state: "VALIDATED_SUCCESS", validatedSuccess: true }),
      chat: async request => {
        requests.push(request);
        round += 1;
        if (round === 4) return { choices: [{ finish_reason: "stop", message: { content: "", tool_calls: [{ id: "submit", type: "function", function: { name: "submit_answer", arguments: '{"patchApplied":true,"summary":"Updated n."}' } }] } }] };
        const name = round === 2 ? "replace_file" : "read";
        const args = round === 2 ? { path: "A.java", before: "n = 1", after: "n = 2" } : { path: "A.java" };
        return { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: `c${round}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
      } });
    const written = requests[2].messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content)).find(result => result.written);
    assert.equal(written?.written, true);
    assert.equal(written.replacements, 1);
    const diagnostic = run.runs[0].candidateReceiptValidation;
    assert.equal(diagnostic.status, "VALID");
    assert.deepEqual(diagnostic.rows.map(row => row.finalCandidateMatches), [false, true], "legacy repair budgets do not clip source");
    assert.equal(run.runs[0].taskSuccess, true, "success still comes from the external repair judge");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("backend detection: no credentials is null, OpenAI triple is openai-api, codex cli wins otherwise", () => {
  assert.equal(detectBackend({}, { hasCodexCli: () => false }), null);
  assert.equal(detectBackend({ OPENAI_API_KEY: "k" }, { hasCodexCli: () => false }), null);
  const api = detectBackend({
    OPENAI_API_KEY: "k",
    OPENAI_BASE_URL: "https://api.example/v1",
    OPENAI_MODEL: "gpt-test"
  }, { hasCodexCli: () => false });
  assert.deepEqual(api, { kind: "openai-api", model: "gpt-test", baseUrl: "https://api.example/v1" });
  const cli = detectBackend({}, { hasCodexCli: () => true });
  assert.equal(cli.kind, "codex-cli");
});

test("backendDeficit lists exactly the missing authorizations", () => {
  const missing = backendDeficit({}, { hasCodexCli: () => false });
  assert.ok(missing.includes("OPENAI_API_KEY"));
  assert.ok(missing.includes("OPENAI_BASE_URL"));
  assert.ok(missing.includes("OPENAI_MODEL"));
  assert.ok(missing.some(item => item.includes("codex")));
  assert.deepEqual(backendDeficit({
    OPENAI_API_KEY: "k",
    OPENAI_BASE_URL: "https://api.example/v1",
    OPENAI_MODEL: "m"
  }, { hasCodexCli: () => false }), []);
  assert.deepEqual(backendDeficit({}, { hasCodexCli: () => true }), [], "codex CLI alone satisfies the deficit");
});

test("BLOCKED_AUTH pack: every task UNMEASURED, no success rate, null usage, exit 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-blocked-"));
  try {
    await mkdir(path.join(dir, "tasks"), { recursive: true });
    const tasksFile = path.join(dir, "tasks", "dev.jsonl");
    writeFileSync(tasksFile, [
      JSON.stringify({ id: "T-A", corpus: "c1", kind: "qa", query: "q1" }),
      JSON.stringify({ id: "T-B", corpus: "c2", kind: "repair", query: "q2" })
    ].join("\n") + "\n", "utf8");
    const output = path.join(dir, "out");
    const env = { MXBAI_API_KEY: "x" }; // a key for another provider is not a backend
    const code = await main([
      "--tasks", tasksFile,
      "--output", output,
      "--arms", "product,control",
      "--repeats", "3"
    ], env);
    assert.equal(code, 2, "a missing backend measured nothing: never exit 0");
    const pack = JSON.parse(await readFileSync(path.join(output, "results-pack.json"), "utf8"));
    assert.equal(pack.schemaVersion, EVAL_PACK_SCHEMA_VERSION);
    assert.equal(pack.status, "BLOCKED_AUTH");
    assert.match(pack.identity.tasksSha256, /^[0-9a-f]{64}$/);
    assert.equal(pack.identity.scheduleSha256, createHash("sha256").update(readFileSync(path.join(output, "schedule.jsonl"))).digest("hex"));
    assert.ok(pack.blockedReasons.length > 0);
    // 2 tasks x 2 arms x 3 repeats = 12 denominator entries, all UNMEASURED
    assert.equal(pack.denominator, 12);
    // Nothing was measured: no rate at all (0 would read as a measured failure).
    assert.equal(pack.taskSuccessRate, null);
    assert.equal(pack.conditionalAccuracy, null, "nothing measured: no conditional rate");
    for (const runPack of pack.packs) {
      assert.equal(runPack.taskOutcome, "UNMEASURED");
      assert.equal(runPack.taskSuccess, null);
      assert.equal(runPack.usage, null, "missing usage stays null; never bytes/4");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--dataset: a MAC-10 split is scheduled under its dataset identity; tasks or gold outside the dataset are refused", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-dataset-"));
  t.after(() => removeTree(dir));
  const fixture = await evalFixture(dir);
  const datasetDir = path.join(dir, "dataset");
  const manifest = await convertDataset({ curationFile: fixture.curationFile, inputsFile: fixture.inputsFile, candidateFiles: [fixture.candidatesFile], out: datasetDir });
  const tasksFile = path.join(datasetDir, "tasks-dev.jsonl");
  const goldFile = path.join(datasetDir, "private/gold-dev.jsonl");
  const output = path.join(dir, "out");
  const args = ["--dataset", path.join(datasetDir, "dataset-manifest.json"), "--tasks", tasksFile, "--gold", goldFile, "--arms", "product,control", "--repeats", "1", "--dry-run"];
  assert.equal(await main([...args, "--output", output], {}), 0, "a dry run froze the schedule");
  const pack = JSON.parse(readFileSync(path.join(output, "results-pack.json"), "utf8"));
  assert.equal(pack.status, "DRY_RUN");
  assert.equal(pack.taskSuccessRate, null);
  assert.deepEqual([pack.identity.datasetId, pack.identity.datasetDigest, pack.identity.split], [manifest.datasetId, manifest.datasetDigest, "dev"]);
  assert.equal(pack.identity.goldSha256, createHash("sha256").update(readFileSync(goldFile)).digest("hex"));
  const scheduled = readFileSync(path.join(output, "schedule.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).taskId);
  assert.deepEqual([...new Set(scheduled)].sort(), readFileSync(tasksFile, "utf8").trim().split("\n").map(line => JSON.parse(line).taskId).sort());
  const directoryServer = path.join(dir, "out-directory-server");
  assert.equal(await main([...args, "--require-identity", "--repo-roots", `fixture=${fixture.repoRoot}`,
    "--server-js", fixture.repoRoot, "--output", directoryServer], {}), 2);
  assert.equal(existsSync(directoryServer), false, "an invalid server must be rejected before the schedule is written");
  const serverFile = path.join(dir, "server.js");
  writeFileSync(serverFile, "// fixture server\n");
  const strictArgs = ["--require-identity", "--repo-roots", `fixture=${fixture.repoRoot}`, "--server-js", serverFile];
  const verified = path.join(dir, "out-verified");
  assert.equal(await main([...args, ...strictArgs, "--output", verified], {}), 0, "MAC-10 corpusId resolves in strict dry-run");
  const verifiedPack = JSON.parse(readFileSync(path.join(verified, "results-pack.json"), "utf8"));
  assert.deepEqual(verifiedPack.identity.identityCheck, { status: "VERIFIED", problems: [] });
  assert.equal(verifiedPack.identity.driver.serverJsSha256, createHash("sha256").update(readFileSync(serverFile)).digest("hex"));
  const invalidRepeats = path.join(dir, "out-invalid-repeats");
  for (const repeats of ["NaN", "Infinity", "1.5", "0"]) {
    assert.equal(await main([...args.map((arg, i) => args[i - 1] === "--repeats" ? repeats : arg), ...strictArgs,
      "--output", invalidRepeats], {}), 2);
    assert.equal(existsSync(invalidRepeats), false);
  }
  const unsupportedLive = path.join(dir, "out-live");
  assert.equal(await main([...args.filter(arg => arg !== "--dry-run"), ...strictArgs, "--output", unsupportedLive], {
    OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: "http://fake.invalid", OPENAI_MODEL: "fixture"
  }), 2, "native MAC-10 rows require an adapter before live evaluation");
  assert.equal(existsSync(unsupportedLive), false);
  // A task file that is not a part of the named dataset is refused before anything is scheduled.
  const foreign = path.join(dir, "foreign.jsonl");
  writeFileSync(foreign, readFileSync(tasksFile, "utf8").trim().split("\n").slice(1).join("\n") + "\n");
  assert.equal(await main([...args.map(item => item === tasksFile ? foreign : item), "--output", path.join(dir, "out-foreign")], {}), 2);
  assert.equal(existsSync(path.join(dir, "out-foreign/schedule.jsonl")), false);
  // Parts of the dataset in the wrong role: the other split's gold, or a gold file given as the tasks.
  assert.equal(await main([...args.map(item => item === goldFile ? path.join(datasetDir, "private/gold-holdout.jsonl") : item), "--output", path.join(dir, "out-split")], {}), 2);
  assert.equal(await main([...args.map(item => item === tasksFile ? goldFile : item), "--output", path.join(dir, "out-role")], {}), 2);
  assert.equal(existsSync(path.join(dir, "out-split")) || existsSync(path.join(dir, "out-role")), false);

  // The comparator takes the evaluator's own pack and schedule: unmeasured stays UNMEASURED, measured is compared.
  const goldBytes = readFileSync(goldFile);
  const scheduleBytes = readFileSync(path.join(output, "schedule.jsonl"));
  const unmeasured = pairedCompare({ manifest, goldBytes, scheduleBytes, pack, baseline: "control", candidate: "product" });
  assert.equal(unmeasured.status, "UNMEASURED", JSON.stringify(unmeasured.errors));
  const measured = { ...pack, status: "MEASURED", packs: pack.packs.map(row => ({ ...row, taskOutcome: "MEASURED", taskSuccess: row.arm === "product" })) };
  const compared = pairedCompare({ manifest, goldBytes, scheduleBytes, pack: measured, baseline: "control", candidate: "product" });
  assert.equal(compared.status, "COMPARED", JSON.stringify(compared.errors));
  assert.deepEqual([compared.tasks, compared.meanDelta, compared.metric], [3, 1, "task success"]);
  assert.deepEqual(Object.keys(compared.byCorpus), ["fixture"]);
  assert.equal(pairedCompare({ manifest, goldBytes, scheduleBytes: Buffer.from(scheduleBytes.toString().split("\n").slice(1).join("\n")), pack: measured, baseline: "control", candidate: "product" }).status, "REFUSED");
});

test("SOURCE_FETCHED: java_symbol preview becomes a raw tool_response event with sha256 + range", () => {
  const discovery = JSON.stringify({
    schemaVersion: "java-discovery/v1",
    candidates: [
      {
        declaration: {
          name: "OrderService",
          relativePath: "src/main/java/x/OrderService.java",
          contentHash: "abc",
          signature: "void submit()",
          selection: { line: 10, column: 5 }
        },
        preview: "public void submit() {\n    queue.offer(order);\n}\n",
        previewKind: "source",
        evidenceRange: { startLine: 10, endLine: 12 }
      }
    ]
  });
  const events = extractSourceEvents({
    callId: "call-1",
    toolName: "java_symbol",
    result: [{ type: "text", text: discovery }]
  });
  assert.equal(events.length, 1);
  const event = events[0];
  // Raw tool output is FETCHED, never RECEIVED: only a payload-attached
  // slice (recordModelDelivery) can be credited as received.
  assert.equal(event.type, "SOURCE_FETCHED");
  assert.equal(event.fileContentHash, "abc");
  assert.equal(event.callId, "call-1");
  assert.equal(event.path, "src/main/java/x/OrderService.java");
  assert.equal(event.origin, "tool_response");
  assert.equal(event.startLine, 10);
  assert.equal(event.endLine, 12);
  assert.equal(event.contentHash, createHash("sha256").update("public void submit() {\n    queue.offer(order);\n}\n", "utf8").digest("hex"));
});

test("SOURCE_FETCHED: the read tool is explicit_read, no phantom line; summaries create no event", () => {
  const readEvents = extractSourceEvents({
    callId: "call-2",
    toolName: "read",
    result: { path: "src/main/java/x/Payment.java", text: "line1\nline2\nline3", startLine: 4 }
  });
  assert.equal(readEvents.length, 1);
  assert.equal(readEvents[0].origin, "explicit_read");
  assert.equal(readEvents[0].startLine, 4);
  assert.equal(readEvents[0].endLine, 6);
  // a trailing newline does not create a phantom line
  const trailing = extractSourceEvents({ callId: "c", toolName: "read", result: { path: "A.java", text: "a\nb\n", startLine: 1 } });
  assert.equal(trailing[0].endLine, 2);

  // A model-facing summary that merely names a path is not source.
  const summary = extractSourceEvents({
    callId: "call-3",
    toolName: "java_symbol",
    result: [{ type: "text", text: "Found OrderService in src/main/java/x/OrderService.java (summary)" }]
  });
  assert.equal(summary.length, 0);

  // A discovery payload without a preview carries locator evidence only.
  const noPreview = extractSourceEvents({
    callId: "call-4",
    toolName: "java_symbol",
    result: JSON.stringify({
      schemaVersion: "java-discovery/v1",
      candidates: [{ declaration: { relativePath: "a/B.java", selection: { line: 1, column: 1 } } }]
    })
  });
  assert.equal(noPreview.length, 0);
});

test("SOURCE_FETCHED: a pre-parsed discovery payload (live session path) still records", () => {
  const payload = {
    schemaVersion: "java-discovery/v1",
    candidates: [{
      declaration: { relativePath: "a/B.java", selection: { line: 3, column: 1 } },
      preview: "class B {\n}",
      previewKind: "source",
      evidenceRange: { startLine: 3, endLine: 4 }
    }]
  };
  const events = extractSourceEvents({ callId: "call-9", toolName: "java_symbol", result: payload });
  assert.equal(events.length, 1);
  assert.equal(events[0].contentHash, createHash("sha256").update("class B {\n}", "utf8").digest("hex"));
  assert.equal(events[0].origin, "tool_response");
});

test("Q-track scoring: strict JSON, exact keys, no partial credit", () => {
  const gold = { storageType: "Set<String>", method: "accept" };
  assert.equal(scoreQaAnswer(gold, JSON.stringify(gold)).status, "CORRECT");
  assert.equal(scoreQaAnswer(gold, JSON.stringify(gold)).correct, true);
  assert.equal(scoreQaAnswer(gold, JSON.stringify({ storageType: "List<String>", method: "accept" })).status, "WRONG_ANSWER");
  assert.equal(scoreQaAnswer(gold, JSON.stringify({ storageType: "Set<String>" })).status, "INCOMPLETE_ANSWER");
  assert.equal(scoreQaAnswer(gold, "not json").status, "INVALID_ANSWER");
  assert.equal(scoreQaAnswer(gold, "[]").status, "INVALID_ANSWER");
  // R02: markdown fences are a format failure under strict JSON - never
  // stripped, never a pass.
  assert.equal(scoreQaAnswer(gold, "```json\n" + JSON.stringify(gold) + "\n```").status, "INVALID_ANSWER");
  // R02: the answer key set comes from frozen gold; extra keys are rejected.
  assert.equal(scoreQaAnswer(gold, JSON.stringify({ ...gold, extra: 1 })).status, "EXTRA_KEYS");
});

test("scoreRunOutcome: failures stay UNMEASURED in the denominator; qa outcomes are external", () => {
  const task = { id: "T-A", kind: "qa" };
  const failed = scoreRunOutcome({ task, goldRow: { answer: { a: "1" } }, run: { stopReason: "FAILED_RUNTIME", finalContent: "" } });
  assert.equal(failed.taskOutcome, "UNMEASURED");
  assert.equal(failed.taskSuccess, null);
  const qaGood = scoreRunOutcome({
    task,
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: JSON.stringify({ a: "1" }),
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
    }
  });
  assert.equal(qaGood.taskOutcome, "MEASURED");
  assert.equal(qaGood.taskSuccess, true);
  // the same window merely FETCHED (never attached to a request) is no evidence
  const qaFetchedOnly = scoreRunOutcome({
    task,
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: JSON.stringify({ a: "1" }),
      sourceReceived: [{ type: "SOURCE_FETCHED", path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
    }
  });
  assert.equal(qaFetchedOnly.taskSuccess, false);
  assert.equal(qaFetchedOnly.answerStatus, "MISSING_REQUIRED_EVIDENCE");
  // received source over the task budget fails, as in the frozen kit
  const qaOverBudget = scoreRunOutcome({
    task: { ...task, budget: { max_lines: 1, max_bytes: 16000 } },
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: JSON.stringify({ a: "1" }),
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 2, text: "t\nu\n", origin: "explicit_read" }]
    }
  });
  assert.equal(qaOverBudget.taskSuccess, false);
  assert.equal(qaOverBudget.answerStatus, "RECEIVED_OVER_BUDGET");
  // correct answer without the required frozen source is NOT a success
  const qaNoEvidence = scoreRunOutcome({
    task,
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: { stopReason: "MODEL_STOP", finalContent: JSON.stringify({ a: "1" }), sourceReceived: [] }
  });
  assert.equal(qaNoEvidence.taskSuccess, false);
  assert.equal(qaNoEvidence.answerStatus, "MISSING_REQUIRED_EVIDENCE");
  // gold without a frozen answer is a protocol gap, not a measured failure
  const qaNoGold = scoreRunOutcome({ task, goldRow: null, run: { stopReason: "MODEL_STOP", finalContent: "{}" } });
  assert.equal(qaNoGold.taskOutcome, "UNMEASURED");
  assert.equal(qaNoGold.taskSuccess, null);
  const repairWithoutJudge = scoreRunOutcome({
    task: { id: "T-B", kind: "repair" },
    goldRow: null,
    run: { stopReason: "MODEL_STOP", finalContent: "{}" }
  });
  assert.equal(repairWithoutJudge.taskOutcome, "UNMEASURED");
  const repairValidated = scoreRunOutcome({
    task: { id: "T-B", kind: "repair" },
    goldRow: null,
    run: { stopReason: "MODEL_STOP", finalContent: '{"patchApplied":false}' },
    repairVerdict: { state: "VALIDATED_SUCCESS", validatedSuccess: true }
  });
  assert.equal(repairValidated.taskSuccess, true, "the frozen judge, not patchApplied, decides");
});

test("recorded-run replay: pack invariants hold for a mix of measured and failed runs", () => {
  const pack = assemblePack({
    status: "MEASURED",
    backend: { kind: "openai-api", model: "gpt-test" },
    datasetHash: "dh",
    arms: ["product", "control"],
    repeats: 1,
    runs: [
      { taskId: "T-A", arm: "product", repeat: 1, taskOutcome: "MEASURED", taskSuccess: true, usage: { status: "MEASURED", promptTokens: 100, completionTokens: 20 } },
      { taskId: "T-A", arm: "control", repeat: 1, taskOutcome: "MEASURED", taskSuccess: false, usage: { status: "UNMEASURED" } },
      { taskId: "T-B", arm: "product", repeat: 1, taskOutcome: "UNMEASURED", taskSuccess: null, timedOut: true, usage: undefined }
    ]
  });
  assert.equal(pack.denominator, 3, "timeout/error runs stay in the denominator");
  assert.equal(pack.taskSuccessRate, 1 / 3, "gate metric is successes / scheduled");
  assert.equal(pack.conditionalAccuracy, 0.5, "conditional accuracy is context, not the gate");
  assert.equal(pack.measuredAttempts, 2);
  assert.equal(pack.packs[0].usage.inputTokens, 100);
  assert.equal(pack.packs[0].usage.outputTokens, 20);
  assert.equal(pack.packs[1].usage, null, "UNMEASURED usage stays null");
  assert.equal(pack.packs[2].usage, null);
  assert.equal(pack.packs[2].timedOut, true);
});

test("strict MAC-10 packs expose setup blocks and unjudged slots in their status", () => {
  const planned = [{ taskId: "T-A", arm: "b0", repeat: 1 }];
  const common = { status: "MEASURED", arms: ["b0"], repeats: 1, planned, identity: { evalProtocol: "eval-protocol/v1.8" } };
  for (const [attemptState, status] of [["BLOCKED_SETUP", "BLOCKED_SETUP"], ["COMPLETED", "INCOMPLETE"]]) {
    const pack = assemblePack({ ...common, runs: [{ ...planned[0], attemptState, taskSuccess: null }] });
    assert.equal(pack.status, status);
    assert.equal(pack.taskSuccessRate, null);
    assert.equal(pack.schedule.endToEndSuccessRate, null);
  }
  const measured = assemblePack({ ...common, runs: [{ ...planned[0], attemptState: "COMPLETED", taskSuccess: false }] });
  assert.equal(measured.status, "MEASURED");
  assert.equal(measured.taskSuccessRate, 0);
});

test("task and gold loaders read the frozen jsonl pair", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-load-"));
  try {
    const tasksFile = path.join(dir, "dev.jsonl");
    const goldFile = path.join(dir, "gold.jsonl");
    writeFileSync(tasksFile, JSON.stringify({ id: "T-A", corpus: "c1", kind: "qa", query: "q" }) + "\n", "utf8");
    writeFileSync(goldFile, JSON.stringify({ id: "T-A", answer: { a: "1" } }) + "\n", "utf8");
    const tasks = loadTaskFile(tasksFile);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "T-A");
    const gold = loadGoldFile(goldFile);
    assert.deepEqual(gold.get("T-A").answer, { a: "1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("zero line or byte source budgets stop read invocation while preserving argument errors", async () => {
  let calls = 0;
  const toolSet = { tools: [{ function: { name: "read", parameters: { properties: { path: { type: "string" }, startLine: { type: "integer" }, maxLines: { type: "integer" } }, required: ["path"] } } }], invoke: async () => { calls++; return {}; } };
  for (const remaining of [{ lines: 0, bytes: 10 }, { lines: 5, bytes: 0 }]) {
    const result = await invokeWithSourceBudget(toolSet, "read", { path: "A.java" }, remaining);
    assert.equal(result.error, "SOURCE_BUDGET_EXHAUSTED");
    assert.equal(result.terminal, true);
    assert.deepEqual(JSON.parse(serializeModelToolResult("read", result).content), result);
  }
  assert.match((await invokeWithSourceBudget(toolSet, "read", { path: 1 }, { lines: 0, bytes: 0 })).error, /string/);
  assert.match((await invokeWithSourceBudget(toolSet, "read", { path: "A", unknown: 1 }, { lines: 0, bytes: 0 })).error, /unknown/);
  assert.equal(calls, 0);
});

test("byte budget too small for next whole line stays explicitly limited on wire", () => {
  const limited = boundSourceResult("read", { path: "A.java", startLine: 4, text: "汉字\r\n", contentHash: "f".repeat(64) }, { lines: 3, bytes: 1 });
  const wire = serializeModelToolResult("read", limited);
  assert.deepEqual(wire.slices, []);
  const payload = JSON.parse(wire.content);
  assert.equal(payload.text, "");
  assert.equal(payload.sourceBudgetLimited, true);
  assert.equal(payload.terminal, undefined);
  assert.equal(payload.sourceBudgetReason, "NEXT_LINE_EXCEEDS_REMAINING_BYTES");
  assert.equal(payload.nextStartLine, 4);
  assert.deepEqual(payload.remainingSourceBudget, { lines: 3, bytes: 1 });
});

test("both eval arms share public submission schema; product preview is explicit and typed wrong values still fail", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-submit-arms-"));
  try {
    const fixture = path.join(dir, "fixture");
    await mkdir(fixture);
    writeFileSync(path.join(fixture, "A.java"), "class A {}\n");
    const requests = [], symbolArgs = [];
    const result = await runLiveEvalRun({ tasks: [{ id: "Q", corpus: "c", kind: "qa", query: "Return member.", output_contract: { answer_keys: { member: "string" } } }],
      gold: new Map([["Q", { answer: { member: "correct" } }]]), arms: ["product", "control"], repoRoots: { c: fixture }, outputDir: path.join(dir, "run"),
      openSessionImpl: async () => ({ symbol: async args => { symbolArgs.push(args); return { schemaVersion: "java-discovery/v1", candidates: [] }; }, close: async () => {} }),
      chat: async request => {
        requests.push(request);
        const product = request.tools.some(t => t.function.name === "java_symbol");
        const previous = request.messages.filter(m => m.role === "tool").length;
        const name = product && previous < 2 ? "java_symbol" : "submit_answer";
        const args = name === "submit_answer" ? { member: "wrong" } : { query: "A", ...(previous === 1 ? { preview: "head" } : {}) };
        return { choices: [{ message: { role: "assistant", content: "draft", tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
      } });
    const schemas = requests.map(r => r.tools.find(t => t.function.name === "submit_answer").function.parameters);
    for (const schema of schemas) assert.deepEqual(schema, schemas[0]);
    assert.deepEqual(schemas[0].required, ["member"]);
    assert.equal(schemas[0].additionalProperties, false);
    assert.deepEqual(symbolArgs.map(a => a.preview), ["none", "head"]);
    assert.deepEqual(EVAL_JAVA_SYMBOL_TOOL.function.parameters.properties.limit, { type: "integer", minimum: 1, maximum: 20 });
    for (const row of result.runs) {
      assert.equal(row.finalAnswerMode, "SUBMITTED");
      assert.equal(row.taskSuccess, false);
      assert.equal(row.answerStatus, "WRONG_ANSWER");
      assert.deepEqual(row.submission.acceptedAnswer, { member: "wrong" });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("missing or invalid submit retains failed rows and gives no answer or evidence credit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-no-submit-"));
  try {
    const fixture = path.join(dir, "fixture");
    await mkdir(fixture);
    writeFileSync(path.join(fixture, "A.java"), "class A {}\n");
    for (const invalid of [false, true]) {
      const requests = [];
      const result = await runLiveEvalRun({ tasks: [{ id: "Q", corpus: "c", kind: "qa", query: "Return member.", output_contract: { answer_keys: { member: "string" } } }],
        gold: new Map([["Q", { answer: { member: "correct" } }]]), arms: ["control"], repoRoots: { c: fixture }, outputDir: path.join(dir, String(invalid)),
        chat: async request => { requests.push(request); return { choices: [{ message: { role: "assistant", content: '{"member":"correct"}',
          ...(invalid ? { tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name: "submit_answer", arguments: '{"member":1}' } }] } : {}) } }] }; } });
      assert.equal(requests.length, 2);
      const row = result.runs[0];
      assert.equal(row.finalAnswerMode, "NO_SUBMISSION");
      assert.equal(row.finalAnswer, "");
      assert.equal(row.taskSuccess, false);
      assert.deepEqual(row.sourceReceived.filter(event => event.type === "SOURCE_RECEIVED" || event.type === "SOURCE_FETCHED"), []);
      assert.equal(row.submission.recoveryCount, 1);
      assert.equal(row.submission.acceptedAnswer, null);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("evidence profiles declare honest exact schemas and preserve default tool surface", () => {
  assert.deepEqual(productTools().map(t => t.function.name), ["java_symbol"]);
  assert.deepEqual(productTools("evidence").map(t => t.function.name), ["java_symbol", "java_evidence"]);
  const [exact, evidence] = productTools("exact-evidence");
  assert.equal(exact.function.parameters.properties.terms, undefined);
  assert.deepEqual(exact.function.parameters.properties.searchMode.enum, ["exact"]);
  assert.ok(validateProductArguments(exact, { query: "A", searchMode: "text" }));
  assert.ok(validateProductArguments(exact, { query: "A", searchMode: "auto" }));
  assert.ok(validateProductArguments(exact, { query: "A", terms: ["x"] }));
  for (const line of [0, -1, 1.5, "1"]) assert.ok(validateProductArguments(evidence, { file: "A.java", line, column: 1 }));
  assert.equal(validateProductArguments(evidence, { file: "A.java", line: 1, column: 1 }), null);
  assert.throws(() => productTools("unknown"));
});

test("evidence units share repeated source budget and clipped ranges cannot claim completeness", () => {
  const unit = { relation: "result-map-type", sourceKind: "mybatis", path: "a.xml", contentHash: "f".repeat(64),
    startLine: 2, endLine: 3, text: "汉字\r\nx\r\n", complete: true };
  const raw = { schemaVersion: "java-evidence-unit/v1", generation: 7, scopeState: "PARTIAL", omitted: [{ reason: "STALE" }], units: [unit, unit] };
  const result = boundSourceResult("java_evidence", raw, { lines: 3, bytes: 100 });
  assert.equal(result.units[1].text, "汉字\r\n");
  assert.equal(result.units[1].complete, false);
  assert.equal(result.units[1].originalEndLine, 3);
  assert.equal(result.units[1].endLine, 2);
  assert.equal(result.scopeState, "PARTIAL");
  const wire = serializeModelToolResult("java_evidence", result);
  assert.equal(wire.slices.length, 2);
  assert.equal(wire.slices[1].text, "汉字\r\n");
  assert.equal(extractSourceEvents({ callId: "e", toolName: "java_evidence", result: raw }).length, 2);
  const omitted = { ...raw, units: [{ ...unit, text: "", complete: false }] };
  assert.equal(extractSourceEvents({ callId: "e", toolName: "java_evidence", result: omitted }).length, 0);
  assert.equal(serializeModelToolResult("java_evidence", omitted).slices.length, 0);
});

test("all evaluation profiles enforce dispatch contracts, budget bypass and immutable typed scoring", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-evidence-profile-"));
  try {
    const fixture = path.join(dir, "fixture"); await mkdir(fixture);
    writeFileSync(path.join(fixture, "A.java"), "class A {}\n");
    for (const productProfile of ["broad", "evidence", "exact-evidence"]) {
      const calls = [], requests = []; let opens = 0;
      const result = await runLiveEvalRun({ productProfile, tasks: [{ id: "Q", corpus: "c", kind: "qa", query: "Return member.",
        budget: { max_lines: 1, max_bytes: 100 }, output_contract: { answer_keys: { member: "string" } } }],
        gold: new Map([["Q", { answer: { member: "correct" } }]]), arms: ["product", "control"], repoRoots: { c: fixture }, outputDir: path.join(dir, productProfile),
        openSessionImpl: async () => { opens++; return { symbol: async args => { calls.push(args); return { schemaVersion: "java-discovery/v1", candidates: [] }; },
          evidence: async args => { calls.push(args); return { schemaVersion: "java-evidence-unit/v1", scopeState: "READY", units: [{ path: "A.java", startLine: 1, endLine: 1,
            text: "class A {}\n", contentHash: createHash("sha256").update("class A {}\n").digest("hex"), complete: true }] }; }, close: async () => {} }; },
        chat: async request => {
          requests.push(request); const step = request.messages.filter(m => m.role === "tool").length;
          const actions = [{ name: "java_symbol", args: { query: "A", searchMode: "text" } }, { name: "java_symbol", args: { query: "A" } },
            { name: "java_evidence", args: { file: "A.java", line: 0, column: 1 } },
            { name: "java_evidence", args: { file: "A.java", line: 1, column: 1 } },
            { name: "java_evidence", args: { file: "A.java", line: 1, column: 1 } }];
          const action = actions[step] ?? { name: "submit_answer", args: { member: "wrong" } };
          return { choices: [{ message: { tool_calls: [{ id: `c${requests.length}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] } }] };
        } });
      assert.equal(opens, 1, "native control never opens a product session");
      assert.equal(result.productProfile, productProfile);
      const symbol = calls.filter(c => c.query);
      assert.equal(symbol.length, productProfile === "exact-evidence" ? 1 : 2);
      if (productProfile === "exact-evidence") assert.equal(symbol[0].searchMode, "exact");
      assert.equal(calls.filter(c => c.file).length, productProfile === "broad" ? 0 : 1, "invalid/exhausted evidence never fetches source");
      for (const row of result.runs) assert.equal(row.taskSuccess, false, "wrong submitted value is not normalized");
      const productRequests = requests.filter(r => r.tools.some(t => t.function.name === "java_symbol"));
      assert.equal(productRequests[0].tools.some(t => t.function.name === "java_evidence"), productProfile !== "broad");
      const audit = readFileSync(path.join(dir, productProfile, "model-payloads.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      assert.ok(audit.every(r => r.productProfile === productProfile && r.attempt.productProfile === productProfile));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Q01 strict QA controls: no type coercion, duplicate keys and unread source are refused by the one scorer", () => {
  // 06 §6.2 item 2: the existing scorer is the adapter; these controls pin it rather than adding a second comparator.
  const gold = { nullable: false, count: 2, method: "accept" };
  assert.equal(scoreQaAnswer(gold, JSON.stringify(gold)).status, "CORRECT");
  for (const coerced of [{ ...gold, nullable: "false" }, { ...gold, count: "2" }, { ...gold, nullable: 0 }, { ...gold, method: null }]) {
    assert.equal(scoreQaAnswer(gold, JSON.stringify(coerced)).status, "WRONG_ANSWER", JSON.stringify(coerced));
  }
  const duplicate = scoreQaAnswer(gold, '{"nullable":true,"nullable":false,"count":2,"method":"accept"}');
  assert.equal(duplicate.status, "INVALID_ANSWER", "JSON.parse would keep the last value; the scorer must not");
  assert.equal(duplicate.reason, "duplicate_keys");
  assert.equal(scoreQaAnswer(gold, JSON.stringify({ ...gold, note: "" })).status, "EXTRA_KEYS");
  assert.equal(scoreQaAnswer(gold, { ...gold }).status, "INVALID_ANSWER", "a pre-parsed object is not the raw model answer");
  // A correct answer is still not a success without the frozen evidence having been received.
  const unread = scoreRunOutcome({ task: { id: "T-Q", kind: "qa" },
    goldRow: { answer: gold, required_evidence: [{ path: "A.java", start_line: 1, end_line: 2 }] },
    run: { stopReason: "MODEL_STOP", finalContent: JSON.stringify(gold),
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 1, text: "class A {\n", origin: "explicit_read" }] } });
  assert.equal(unread.taskSuccess, false);
  assert.equal(unread.answerStatus, "MISSING_REQUIRED_EVIDENCE", "one unread required line fails the answer");
});
