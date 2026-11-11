// input: evaluate-java-task arm/profile mapping, run identity check, schedule summary and a fake-model
//        B0-vs-B2 run; the java_outline wire and session mapping.
// output: post-ILV2 Q10 no-cost controls. Nothing here calls a model or a product server.
// pos: complements evaluate-java-task.test.mjs; the arms reuse runLiveEvalRun (on runLiveAgentTask), not a new runner.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARM_PROFILES,
  armProfile,
  assemblePack,
  checkRunIdentity,
  main,
  productTools,
  runLiveEvalRun
} from "./evaluate-java-task.mjs";
import { impactSessionFromClient } from "./run-agent-trace-live.mjs";
import { serializeModelToolResult } from "./eval-tool-wire.mjs";

const names = tools => tools.map(tool => tool.function.name);

test("06 §6.4 arms map to profiles on one server: B0 query, B1 + outline, B2 + outline + evidence", () => {
  assert.deepEqual(Object.keys(ARM_PROFILES).sort(), ["b0", "b1", "b2", "control", "product"]);
  assert.equal(armProfile("control"), null);
  assert.equal(armProfile("product", "evidence"), "evidence", "product keeps following --product-profile");
  assert.deepEqual(names(productTools(armProfile("b0"))), ["java_symbol"]);
  assert.deepEqual(names(productTools(armProfile("b1"))), ["java_symbol", "java_outline"]);
  assert.deepEqual(names(productTools(armProfile("b2"))), ["java_symbol", "java_outline", "java_evidence"]);
  assert.throws(() => armProfile("b3"), /unknown arm: b3/);
  assert.throws(() => productTools("latest"), /unknown productProfile/);
  const outline = productTools("outline")[1].function.parameters;
  assert.deepEqual(outline.required, ["file"]);
  assert.equal(outline.additionalProperties, false);
  assert.equal(outline.properties.limit.maximum, 20, "the eval tool advertises the product's outline limit");
  const evidence = productTools(armProfile("b2")).find(tool => tool.function.name === "java_evidence").function;
  assert.match(evidence.description, /Java (?:type|method|declaration)/);
  assert.match(evidence.description, /MyBatis XML/);
});

test("java_outline wire carries declarations but never credits source; other shapes are refused", async () => {
  const outline = { schemaVersion: "java-outline/v1", generation: 3, relativePath: "A.java", contentHash: "f".repeat(64),
    entries: [{ kind: "method", name: "run", signature: "run()", startLine: 2, endLine: 4, selection: { line: 2, column: 8 }, stability: "STABLE", symbolId: "jsym:mac1:ws-00000001:x" }],
    omittedSymbols: 0, scopeState: "READY", reasons: [] };
  const wire = serializeModelToolResult("java_outline", outline);
  assert.deepEqual(wire.slices, []);
  assert.deepEqual(JSON.parse(wire.content).entries, outline.entries);
  assert.equal(JSON.parse(serializeModelToolResult("java_outline", { candidates: [] }).content).error, "UNSUPPORTED_TOOL_RESULT");
  const captured = [];
  const session = impactSessionFromClient({ repoRoot: "/isolated/fixture", client: { async callTool(request) {
    captured.push(request); return { content: [{ type: "text", text: JSON.stringify(outline) }] };
  } } });
  assert.deepEqual(await session.outline({ file: "A.java", nearLine: 3 }), outline);
  await session.outline({ file: "A.java", limit: 5 });
  assert.deepEqual(captured.map(request => request.arguments), [
    { repoRoot: "/isolated/fixture", operation: "outline", file: "A.java", nearLine: 3 },
    { repoRoot: "/isolated/fixture", operation: "outline", file: "A.java", limit: 5 }
  ]);
});

test("run identity fails closed on unknown tasks/arms, an unnamed dataset, unresolved corpora and a missing server", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "corpus-a"));
  await writeFile(path.join(dir, "server.js"), "");
  const tasks = [{ id: "T1", corpus: "a" }, { id: "T2", corpus: "b" }, { id: "T3" }];
  const base = { tasks, allTaskIds: new Set(["T1", "T2", "T3"]), arms: ["b0", "b2"], productProfile: "broad",
    dataset: { datasetId: "mac10", split: "dev" }, repoRoots: { a: path.join(dir, "corpus-a"), b: path.join(dir, "corpus-a") }, serverJs: path.join(dir, "server.js") };
  const verified = checkRunIdentity({ ...base, tasks: tasks.slice(0, 2) });
  assert.equal(verified.status, "VERIFIED");
  assert.deepEqual(verified.problems, []);
  const failed = checkRunIdentity({ ...base, filter: ["T9"], arms: ["b0", "b0", "b7"], dataset: null,
    repoRoots: { a: path.join(dir, "corpus-a"), b: path.join(dir, "server.js") }, serverJs: path.join(dir, "missing.js") });
  assert.equal(failed.status, "FAILED");
  assert.deepEqual(failed.problems, ["UNKNOWN_FILTER_TASK:T9", "DUPLICATE_ARM", "UNKNOWN_ARM:b7", "DATASET_UNNAMED",
    "CORPUS_UNRESOLVED:b", "TASK_WITHOUT_CORPUS:T3", "PRODUCT_SERVER_MISSING"]);
  // A control-only run needs no product server.
  assert.deepEqual(checkRunIdentity({ ...base, tasks: tasks.slice(0, 1), arms: ["control"], serverJs: path.join(dir, "missing.js") }).problems, []);

  // The CLI refuses before freezing a schedule; without --require-identity the check is only recorded.
  const tasksFile = path.join(dir, "tasks.jsonl");
  await writeFile(tasksFile, `${JSON.stringify({ id: "T1", corpus: "a", kind: "qa", query: "q" })}\n`);
  const strict = path.join(dir, "out-strict");
  assert.equal(await main(["--tasks", tasksFile, "--output", strict, "--arms", "b0,b2", "--dry-run", "--require-identity",
    "--repo-roots", `a=${path.join(dir, "corpus-a")}`, "--server-js", path.join(dir, "server.js")], {}), 2);
  await assert.rejects(import("node:fs/promises").then(fs => fs.access(path.join(strict, "schedule.jsonl"))));
  const lenient = path.join(dir, "out-lenient");
  assert.equal(await main(["--tasks", tasksFile, "--output", lenient, "--arms", "b0,b2", "--dry-run",
    "--repo-roots", `a=${path.join(dir, "corpus-a")}`, "--server-js", path.join(dir, "server.js")], {}), 0);
  const pack = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(path.join(lenient, "results-pack.json"), "utf8")));
  assert.deepEqual(pack.identity.identityCheck, { status: "FAILED", problems: ["DATASET_UNNAMED"] });
  assert.deepEqual(pack.identity.armProfiles, { b0: "broad", b2: "outline-evidence" });
  assert.equal(pack.schedule.endToEndSuccessRate, null, "a dry run measured nothing");
  assert.equal(pack.schedule.missing, 2);
});

test("run identity rejects a directory passed as the product server", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-server-directory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const check = checkRunIdentity({ tasks: [{ id: "Q", corpus: "a" }], allTaskIds: new Set(["Q"]), arms: ["b0"],
    dataset: { datasetId: "mac10", split: "dev" }, repoRoots: { a: dir }, serverJs: dir });
  assert.equal(check.status, "FAILED");
  assert.deepEqual(check.problems, ["PRODUCT_SERVER_INVALID"]);
});

test("pack schedule summary: failures stay in the denominator, missing or unjudged slots make the rate null", () => {
  const measured = { status: "MEASURED", promptTokens: 10, completionTokens: 2, totalTokens: 12 };
  const runs = [
    { taskId: "T1", arm: "b0", repeat: 1, attemptState: "COMPLETED", taskSuccess: true, usage: measured },
    { taskId: "T1", arm: "b2", repeat: 1, attemptState: "FAILED_RUNTIME", taskSuccess: null, usage: measured },
    { taskId: "T2", arm: "b0", repeat: 1, attemptState: "COMPLETED", taskSuccess: false, usage: measured },
    { taskId: "T2", arm: "b2", repeat: 1, attemptState: "COMPLETED", taskSuccess: true, timedOut: true, usage: { status: "UNMEASURED" } }
  ];
  const planned = runs.map(({ taskId, arm, repeat }) => ({ taskId, variant: "primary", arm, repeat }));
  const full = assemblePack({ status: "MEASURED", arms: ["b0", "b2"], repeats: 1, runs, planned });
  assert.equal(full.schedule.scheduled, 4);
  assert.equal(full.schedule.successful, 1, "a timed-out slot is not a success even with a recorded answer");
  assert.equal(full.schedule.endToEndSuccessRate, 0.25);
  assert.equal(full.schedule.providerUsage, null, "one attempted slot without usage voids the sum");
  assert.deepEqual(full.schedule.usageCoverage, { measuredSlots: 3, attemptedSlots: 4 });
  assert.equal(full.schedule.byArm.b0.endToEndSuccessRate, 0.5);
  assert.equal(full.schedule.byArm.b0.providerUsage.inputTokens, 20, "same usage field names as the pack rows");
  assert.equal(full.schedule.byArm.b0.providerUsage.rawUsage, undefined);
  const partial = assemblePack({ status: "MEASURED", arms: ["b0", "b2"], repeats: 1, runs: runs.slice(0, 3), planned });
  assert.equal(partial.schedule.missing, 1);
  assert.equal(partial.schedule.endToEndSuccessRate, null);
  const unjudged = assemblePack({ status: "MEASURED", arms: ["b0"], repeats: 1,
    runs: [{ taskId: "T1", arm: "b0", repeat: 1, attemptState: "COMPLETED", taskSuccess: null }], planned: [{ taskId: "T1", variant: "primary", arm: "b0", repeat: 1 }] });
  assert.equal(unjudged.schedule.unjudged, 1);
  assert.equal(unjudged.schedule.endToEndSuccessRate, null);
  // Replayed rows from before attemptState existed keep their judged outcome; arm "" and a missing arm stay distinct.
  const legacy = assemblePack({ status: "MEASURED", arms: ["product"], repeats: 1, runs: [
    { taskId: "T1", arm: "", repeat: 1, taskSuccess: true }, { taskId: "T1", repeat: 1, taskSuccess: false }] });
  assert.deepEqual([legacy.schedule.scheduled, legacy.schedule.completed, legacy.schedule.successful], [2, 2, 1]);
  assert.equal(legacy.schedule.endToEndSuccessRate, legacy.taskSuccessRate);
});

test("a product session that cannot start is a setup block, not a failed task", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-setup-block-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "fixture");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "A.java"), "class A {}\n");
  const run = await runLiveEvalRun({ tasks: [{ id: "Q", corpus: "c", kind: "qa", query: "q", output_contract: { answer_keys: { member: "string" } } }],
    arms: ["b2"], repoRoots: { c: fixture }, outputDir: path.join(dir, "run"),
    openSessionImpl: async () => { throw new Error("server did not start"); },
    chat: async () => { throw new Error("no request may be sent"); } });
  assert.equal(run.runs[0].attemptState, "BLOCKED_SETUP");
  const pack = assemblePack({ status: "MEASURED", arms: ["b2"], repeats: 1, runs: run.runs, planned: [{ taskId: "Q", variant: "primary", arm: "b2", repeat: 1 }] });
  assert.equal(pack.schedule.missing, 1);
  assert.equal(pack.schedule.endToEndSuccessRate, null, "an environment block is not measured as a failure");
});

test("B0 and B2 share native tools and budgets; only B2 sees java_outline/java_evidence, and outline spends no source budget", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-b0-b2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "fixture");
  await mkdir(fixture);
  await writeFile(path.join(fixture, "A.java"), "class A {\n  int n = 1;\n}\n");
  const outlineCalls = [];
  const requests = [];
  const run = await runLiveEvalRun({
    tasks: [{ id: "Q", corpus: "c", kind: "qa", query: "Return member name.", budget: { max_lines: 2, max_bytes: 100 }, output_contract: { answer_keys: { member: "string" } } }],
    gold: new Map([["Q", { answer: { member: "n" }, required_evidence: [{ path: "A.java", start_line: 2, end_line: 2 }] }]]),
    arms: ["b0", "b2"], repoRoots: { c: fixture }, outputDir: path.join(dir, "run"),
    openSessionImpl: async () => ({
      symbol: async () => ({ schemaVersion: "java-discovery/v1", candidates: [] }),
      evidence: async () => { throw new Error("not called"); },
      outline: async args => { outlineCalls.push(args); return { schemaVersion: "java-outline/v1", generation: 1, relativePath: "A.java", contentHash: "f".repeat(64),
        entries: [{ kind: "field", name: "n", signature: "int n", startLine: 2, endLine: 2, selection: { line: 2, column: 3 }, stability: "STABLE" }],
        omittedSymbols: 1, scopeState: "READY", reasons: [] }; },
      close: async () => {}
    }),
    chat: async request => {
      requests.push(request);
      const exposed = request.tools.map(tool => tool.function.name);
      const turn = request.messages.filter(message => message.role === "tool").length;
      const callTool = (name, args) => ({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "",
        tool_calls: [{ id: `${name}-${turn}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
      if (exposed.includes("java_outline") && turn === 0) return callTool("java_outline", { file: "A.java", nearLine: 2 });
      if (turn <= (exposed.includes("java_outline") ? 1 : 0)) return callTool("read", { path: "A.java", startLine: 2, maxLines: 1 });
      return callTool("submit_answer", { member: "n" });
    }
  });
  const exposedByArm = new Map();
  for (const request of requests) {
    const exposed = request.tools.map(tool => tool.function.name).sort();
    exposedByArm.set(exposed.includes("java_outline") ? "b2" : "b0", exposed);
  }
  const native = exposedByArm.get("b0").filter(name => name !== "java_symbol");
  assert.deepEqual(exposedByArm.get("b2").filter(name => !["java_symbol", "java_outline", "java_evidence"].includes(name)), native, "same native tools on both arms");
  assert.deepEqual(outlineCalls, [{ file: "A.java", nearLine: 2 }]);
  for (const row of run.runs) {
    assert.equal(row.attemptState, "COMPLETED", row.arm);
    assert.equal(row.taskSuccess, true, `${row.arm}: the read line, not the outline, is the evidence`);
    assert.equal(row.sourceReceived.filter(event => event.type === "SOURCE_RECEIVED" && event.toolName === "java_outline").length, 0);
    assert.equal(row.armProfile, row.arm === "b0" ? "broad" : "outline-evidence");
  }
});
