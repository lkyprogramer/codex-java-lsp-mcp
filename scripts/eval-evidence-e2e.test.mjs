// Offline integration: scripted chat + real MCP evidence operation + original
// PAYMENTS-02 card and frozen judge. No model or historical report is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTaskFile, loadGoldFile, runLiveEvalRun, scoreWithFrozenKit } from "./evaluate-java-task.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kitRoot = path.join(root, "docs/java-specialist-release-audit-v1.1/baseline-kit");
const dataset = path.join(kitRoot, "dataset");
const serverJs = process.env.JSB_EVIDENCE_SERVER_JS ?? path.join(root, "dist/server.js");
const receipt = "src/main/java/lab/payments/Receipt.java";
const assembler = "src/main/java/lab/payments/ReceiptAssembler.java";
const xml = "src/main/resources/mapper/ReceiptMapper.xml";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const call = (name, args, id) => ({ choices: [{ message: { tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });

test("PAYMENTS-02 real MCP type evidence -> exact XML dispatch -> unchanged frozen judge", { timeout: 180_000 }, async t => {
  if (!existsSync(serverJs)) { t.skip("BLOCKED_ENV: compiled candidate server unavailable"); return; }
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); }
  catch { t.skip("BLOCKED_ENV: python3 unavailable"); return; }
  const tasksFile = path.join(dataset, "prompts/dev.jsonl"), goldFile = path.join(dataset, "gold/dev.jsonl");
  const fixture = path.join(dataset, "corpora/payments");
  const protectedFiles = [tasksFile, goldFile, ...[receipt, assembler, xml].map(file => path.join(fixture, file))];
  const before = protectedFiles.map(file => hash(readFileSync(file)));
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "eval-evidence-mcp-"));
  try {
    const tasks = loadTaskFile(tasksFile).filter(task => task.id === "JSB-PAYMENTS-02");
    const requests = [];
    const live = await runLiveEvalRun({ tasks, gold: loadGoldFile(goldFile), arms: ["product"], productProfile: "evidence",
      repoRoots: { payments: fixture }, outputDir, serverJs, maxRounds: 8,
      chat: async request => {
        requests.push(request);
        const previous = request.messages.filter(message => message.role === "tool");
        switch (previous.length) {
          case 0: return call("java_symbol", { query: "lab.payments.Receipt", searchMode: "exact" }, "locate-type");
          case 1: {
            const declaration = JSON.parse(previous[0].content).candidates.find(candidate => candidate.declaration.relativePath === receipt)?.declaration;
            assert.ok(declaration, previous[0].content);
            return call("java_evidence", { file: declaration.relativePath, line: declaration.selection.line, column: declaration.selection.column }, "get-xml");
          }
          case 2: return call("read", { path: receipt, startLine: 3, maxLines: 4 }, "read-receipt");
          case 3: return call("read", { path: assembler, startLine: 1, maxLines: 6 }, "read-assembler");
          default: return call("submit_answer", { field: "amountCents", column: "amount_cents", assembler: "toReceipt" }, "submit");
        }
      } });
    assert.equal(live.runs.length, 1);
    const run = live.runs[0];
    assert.equal(run.attemptState, "COMPLETED", run.error);
    assert.equal(run.taskSuccess, true);
    const wire = requests.flatMap(request => request.messages.filter(message => message.role === "tool" && message.tool_call_id === "get-xml"));
    assert.ok(wire.length > 0);
    const evidence = JSON.parse(wire[0].content);
    assert.equal(evidence.schemaVersion, "java-evidence-unit/v1");
    assert.equal(evidence.scopeState, "READY");
    assert.equal(evidence.supportedScope, "indexed-mybatis-xml-fqn-links");
    assert.equal(evidence.anchor.relativePath, receipt);
    const unit = evidence.units.find(unit => unit.path === xml);
    assert.equal(unit.relation, "result-map-type"); assert.equal(unit.complete, true);
    assert.equal(unit.startLine, 2); assert.equal(unit.endLine, 4);
    const xmlBytes = readFileSync(path.join(fixture, xml));
    const exact = xmlBytes.toString("utf8").split(/(?<=\n)/).slice(1, 4).join("");
    assert.equal(unit.text, exact); assert.equal(unit.contentHash, hash(xmlBytes));
    const received = run.sourceReceived.filter(event => event.type === "SOURCE_RECEIVED" && event.toolName === "java_evidence");
    assert.equal(received.length, 1); assert.equal(received[0].text, exact);
    assert.equal(received[0].fileContentHash, hash(xmlBytes));
    assert.equal(received[0].contentHash, hash(exact));
    assert.equal(received[0].startLine, 2); assert.equal(received[0].endLine, 4);
    const scored = scoreWithFrozenKit({ kitRoot, tasks, runs: live.runs, arms: ["product"], repeats: 1, outputDir, model: null, productProfile: "evidence" });
    assert.equal(scored.kind, "frozen-kit", JSON.stringify(scored));
    assert.equal(run.frozenScore.qaContractPass, true); assert.equal(run.frozenScore.receivedEvidenceComplete, true);
    assert.equal(run.frozenScore.budgetPass, true);
    const frozenPack = JSON.parse(readFileSync(scored.reports.product.packPath, "utf8"));
    assert.equal(frozenPack.run_profile.product_profile, "evidence");
    assert.equal(frozenPack.run_profile.eval_protocol, "eval-protocol/v1.5");
    assert.deepEqual(protectedFiles.map(file => hash(readFileSync(file))), before);
  } finally { rmSync(outputDir, { recursive: true, force: true }); }
});
