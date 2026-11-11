// post-ILV2 Q10, Mac only and model-free: the MAC-10 LIVE adapter on the frozen dataset named by ILV2_MAC10_DATASET,
// with the real APFS materialization, the real product server (dist/server.js), the real index readiness wait and
// the real javac/java oracle. The "model" is a scripted chat that plays the gold (allowed only because no model is
// measured here): it proves every slot can succeed end to end, and that an untouched repair fails. Only aggregate
// states reach ILV2_EVIDENCE_ROOT; tasks, gold and sources stay in the private run root.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute, readJson } from "./ilv2-mac-contracts.mjs";
import { readJsonl, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { runLiveEvalRun } from "./evaluate-java-task.mjs";
import { prepareMac10Live } from "./eval-mac10-live.mjs";

const DATASET = process.env.ILV2_MAC10_DATASET;
const INPUTS = process.env.ILV2_MAC10_INPUTS;
const SERVER_JS = path.resolve("dist/server.js");

const toolCall = (id, name, args) => ({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
const scripted = steps => {
  let index = 0;
  return async () => steps[Math.min(index++, steps.length - 1)];
};

test("MAC-10 LIVE adapter on the frozen dataset: real corpora, product server, readiness wait and oracle with a scripted model", { skip: !DATASET && "ILV2_MAC10_DATASET is not set" }, async t => {
  assert.ok(INPUTS, "ILV2_MAC10_INPUTS is required with ILV2_MAC10_DATASET");
  assert.ok(existsSync(SERVER_JS), "dist/server.js is required (npm run build)");
  const { root, manifest } = await verifyDataset(DATASET);
  const curation = JSON.parse(await readFile(path.join(root, "private/curation.json"), "utf8"));
  const pinned = new Set(curation.tasks.filter(task => task.pinnedDev).map(task => task.id));
  const devTasks = await readJsonl(path.join(root, manifest.parts["tasks-dev"].file));
  const chainIds = devTasks.filter(task => pinned.has(task.taskId)).map(task => task.taskId);
  assert.ok(chainIds.length > 0, "the dataset pins dev tasks");
  const work = await mkdtemp(path.join(os.tmpdir(), "mac10-live-chain-"));
  t.after(() => removeTree(work));
  const live = await prepareMac10Live({ datasetFile: DATASET, tasksFile: path.join(root, manifest.parts["tasks-dev"].file), goldFile: path.join(root, manifest.parts["gold-dev"].file),
    inputsFile: INPUTS, outputDir: path.join(work, "prepared"), taskIds: chainIds, toolchainsFile: process.env.ILV2_TOOLCHAINS, sourceBudget: null });
  const inputs = new Map((await readJson(INPUTS)).map(record => [record.name, record]));
  const common = { gold: live.gold, repoRoots: live.repoRoots, publicAnswerContract: live.publicAnswerContract, repairJudge: live.repairJudge,
    serverJs: SERVER_JS, env: process.env, indexReadyTimeoutMs: 900000 };
  const summary = [];
  for (const task of live.tasks) {
    const gold = live.gold.get(task.id);
    if (task.kind === "qa") {
      // B2 path: outline and evidence on the real product, then exact reads of every required range.
      // XML-only tasks have no Java file to outline; they still exercise the readiness wait and the reads.
      const first = gold.required_evidence.find(item => item.path.endsWith(".java"));
      const steps = [...(first ? [toolCall("o", "java_outline", { file: first.path, nearLine: first.start_line })] : []),
        ...gold.required_evidence.map((item, i) => toolCall(`r${i}`, "read", { path: item.path, startLine: item.start_line, maxLines: item.end_line - item.start_line + 1 })),
        toolCall("s", "submit_answer", gold.answer)];
      const out = path.join(work, `qa-${task.id}`);
      const row = (await runLiveEvalRun({ ...common, tasks: [task], arms: ["b2"], outputDir: out, chat: scripted(steps) })).runs[0];
      assert.equal(row.attemptState, "COMPLETED", `${task.id}: ${row.error ?? ""}`);
      assert.ok(row.indexReadyMs?.length === 1, `${task.id}: the product session waited for a FRESH index`);
      assert.equal(row.taskSuccess, true, `${task.id}: ${row.answerStatus} ${JSON.stringify(row.missingEvidence ?? [])}`);
      const outline = readFileSync(path.join(out, "raw-tool-results.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.toolName === "java_outline");
      if (first) {
        assert.notEqual(outline?.rawResult?.scopeState, "NOT_READY", `${task.id}: outline ran on a ready index`);
        assert.ok(Array.isArray(outline?.rawResult?.entries) && outline.rawResult.entries.length > 0, `${task.id}: outline returned declarations`);
      }
      summary.push({ kind: "qa", arm: "b2", taskSuccess: row.taskSuccess, indexReadyMs: row.indexReadyMs[0], outlineEntries: outline?.rawResult?.entries?.length ?? null });
    } else {
      // Control path: write the frozen fix (passes) and leave the pre-state untouched (fails), judged by the real oracle.
      const oracle = await readJson(path.join(root, gold.repairOracle));
      const record = inputs.get(oracle.corpusId);
      const { stdout: fixed } = await execute("git", ["--no-optional-locks", "-C", record.repoRoot, "show", `${oracle.head}:${oracle.file}`], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
      const submit = toolCall("s", "submit_answer", { patchApplied: true, summary: "scripted" });
      const pass = (await runLiveEvalRun({ ...common, tasks: [task], arms: ["control"], outputDir: path.join(work, `fix-${task.id}`),
        chat: scripted([toolCall("w", "write_file", { path: oracle.file, content: fixed }), submit]) })).runs[0];
      assert.equal(pass.repairJudge?.state, "VALIDATED_SUCCESS", `${task.id}: ${JSON.stringify(pass.repairJudge)}`);
      // Product arm: the session (and its re-open after the write) must leave nothing but the repaired file in the candidate.
      const product = (await runLiveEvalRun({ ...common, tasks: [task], arms: ["b2"], outputDir: path.join(work, `fix-b2-${task.id}`),
        chat: scripted([toolCall("w", "write_file", { path: oracle.file, content: fixed }), submit]) })).runs[0];
      assert.equal(product.repairJudge?.state, "VALIDATED_SUCCESS", `${task.id} b2: ${JSON.stringify(product.repairJudge)}`);
      assert.equal(product.indexReadyMs?.length, 2, `${task.id} b2: initial session and the re-open after the write both waited`);
      assert.deepEqual(JSON.parse(readFileSync(product.repairJudge.judgeArtifactPath, "utf8")).changed, [oracle.file]);
      const fail = (await runLiveEvalRun({ ...common, tasks: [task], arms: ["control"], outputDir: path.join(work, `none-${task.id}`), chat: scripted([submit]) })).runs[0];
      assert.equal(fail.repairJudge?.state, "TEST_FAILED", `${task.id}: ${JSON.stringify(fail.repairJudge)}`);
      assert.equal(fail.taskSuccess, false);
      summary.push({ kind: "repair", control: { fixed: pass.repairJudge.state, untouched: fail.repairJudge.state }, b2: { fixed: product.repairJudge.state, indexReadyMs: product.indexReadyMs } });
    }
  }
  if (process.env.ILV2_EVIDENCE_ROOT) {
    await writeFile(path.join(process.env.ILV2_EVIDENCE_ROOT, "mac10-live-chain.json"), `${JSON.stringify({ schema: "post-ilv2/mac10-live-chain/v1",
      datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, adapter: live.identity.adapter, java: live.identity.java, tasks: chainIds.length, slots: summary }, null, 2)}\n`);
  }
});
