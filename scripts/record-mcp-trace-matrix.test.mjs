import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildTraceMatrix,
  loadTraceTasks,
  TRACE_EVENT_SCHEMA_VERSION,
  TraceValidationError,
  verifyTraceReplay
} from "./record-mcp-trace-matrix.mjs";

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceGoldenDir = path.join(projectRoot, "golden");
const runtimeIdentity = { commit: "a".repeat(40), executableTree: "b".repeat(40) };
const toolSchema = {
  tools: ["java_status", "java_impact", "java_symbol", "java_diagnostics", "java_runtime"].map(name => ({
    name,
    description: `${name} fixture`,
    inputSchema: { type: "object", properties: {} }
  }))
};

let fixture;

before(async () => {
  fixture = await createSourceLockedFixture();
});

after(async () => {
  if (fixture) await rm(fixture.root, { recursive: true, force: true });
});

test("local MCP trace freezes six source-locked holdouts and replays exact request/response/tool/read evidence", async () => {
  const loaded = await loadTraceTasks(fixture.goldenDir);
  const eventsText = await eventsFor(loaded.tasks);
  const inputs = traceInputs(eventsText);

  const trace = await buildTraceMatrix(inputs);
  const receipt = await verifyTraceReplay(trace, inputs);

  assert.equal(trace.tasks.length, 6);
  assert.equal(new Set(trace.tasks.map(row => row.task.projectId)).size, 3);
  assert.ok(trace.tasks.every(row => row.ttfuc.status === "MEASURED"));
  assert.ok(trace.tasks.every(row => row.ttfuc.eventType === "mcp_response"));
  assert.ok(trace.tasks.every(row => row.events.map(event => event.type).join(",") === "mcp_request,tool_call,tool_result,mcp_response"));
  assert.equal(trace.modelEvaluation.status, "BLOCKED_EXTERNAL");
  assert.equal(trace.modelEvaluation.modelUsage.status, "UNMEASURED");
  assert.equal(trace.modelEvaluation.taskSuccess.status, "UNMEASURED");
  assert.equal(receipt.passed, true);
  assert.equal(receipt.traceReplaySha256, trace.replaySha256);
});

test("local MCP trace replay rejects valid but different source-locked event timing", async () => {
  const loaded = await loadTraceTasks(fixture.goldenDir);
  const eventsText = await eventsFor(loaded.tasks);
  const trace = await buildTraceMatrix(traceInputs(eventsText));
  const rows = parseEvents(eventsText);
  rows.at(-1).wallTimeMs += 1;

  await assert.rejects(
    () => verifyTraceReplay(trace, traceInputs(serializeEvents(rows))),
    error => error instanceof TraceValidationError && /replay differs/.test(error.message)
  );
});

test("local MCP trace rejects an out-of-order or stale freshness event", async () => {
  const loaded = await loadTraceTasks(fixture.goldenDir);
  const rows = parseEvents(await eventsFor(loaded.tasks));
  rows[1].type = "tool_result";
  rows[1].completion = "COMPLETE";
  rows[1].freshness = { startGeneration: 1, endGeneration: 1, changedDuringRequest: true };
  rows[1].contextFiles = rows[2].contextFiles;

  await assert.rejects(
    () => buildTraceMatrix(traceInputs(serializeEvents(rows))),
    error => error instanceof TraceValidationError && /out of order|contradicts/.test(error.message)
  );
});

test("local MCP trace rejects a repository at the wrong frozen commit and forged source bytes", async () => {
  const loaded = await loadTraceTasks(fixture.goldenDir);
  const eventsText = await eventsFor(loaded.tasks);
  await assert.rejects(
    () => buildTraceMatrix({
      ...traceInputs(eventsText),
      repositories: { ...fixture.repositories, cipherlink: fixture.repositories.lishuedu }
    }),
    error => error instanceof TraceValidationError && /HEAD does not match/.test(error.message)
  );

  const rows = parseEvents(eventsText);
  rows.find(row => row.type === "tool_result").contextFiles[0].contentSha256 = "d".repeat(64);
  await assert.rejects(
    () => buildTraceMatrix(traceInputs(serializeEvents(rows))),
    error => error instanceof TraceValidationError && /source blob evidence does not match/.test(error.message)
  );
});

test("local MCP trace rejects a forged response artifact and file reads before the MCP response settles", async () => {
  const loaded = await loadTraceTasks(fixture.goldenDir);
  const rows = parseEvents(await eventsFor(loaded.tasks));
  const response = rows.find(row => row.type === "mcp_response");
  response.responseSha256 = "e".repeat(64);
  await assert.rejects(
    () => buildTraceMatrix(traceInputs(serializeEvents(rows))),
    error => error instanceof TraceValidationError && /MCP response artifact hash\/size mismatch/.test(error.message)
  );

  const ordered = parseEvents(await eventsFor(loaded.tasks));
  const firstResponseIndex = ordered.findIndex(row => row.type === "mcp_response");
  const result = ordered[firstResponseIndex - 1];
  const earlyRead = {
    schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
    taskId: result.taskId,
    sequence: result.sequence + 1,
    wallTimeMs: result.wallTimeMs + 0.5,
    type: "file_read",
    requestId: result.requestId,
    ...result.contextFiles[0]
  };
  ordered.splice(firstResponseIndex, 0, earlyRead);
  renumberTask(ordered, result.taskId);
  await assert.rejects(
    () => buildTraceMatrix(traceInputs(serializeEvents(ordered))),
    error => error instanceof TraceValidationError && /file_read is out of order/.test(error.message)
  );
});

function traceInputs(eventsText) {
  return {
    goldenDir: fixture.goldenDir,
    eventsText,
    toolSchema,
    runtimeIdentity,
    inputFile: path.join(fixture.artifactRoot, "events.jsonl"),
    artifactRoot: fixture.artifactRoot,
    repositories: fixture.repositories
  };
}

async function eventsFor(tasks) {
  const rows = [];
  for (const task of tasks) {
    const requestId = `request-${task.taskId}`;
    const slug = task.taskId.replaceAll(/[^a-zA-Z0-9.-]/g, "-");
    const argumentsEvidence = await writeArtifact(`requests/${slug}.json`, JSON.stringify({ taskId: task.taskId, tool: "java_impact" }));
    const contextFiles = await Promise.all(task.requiredContextFiles.map(file => sourceRecord(task.projectId, file)));
    const responseEvidence = await writeArtifact(`responses/${slug}.json`, JSON.stringify({
      taskId: task.taskId,
      completion: "COMPLETE",
      contextFiles: contextFiles.map(record => record.file)
    }));
    rows.push(
      {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        taskId: task.taskId,
        sequence: 1,
        wallTimeMs: 0,
        type: "mcp_request",
        requestId,
        method: "tools/call",
        toolName: "java_impact",
        argumentsArtifact: argumentsEvidence.file,
        argumentsSha256: argumentsEvidence.sha256,
        argumentsBytes: argumentsEvidence.bytes
      },
      {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        taskId: task.taskId,
        sequence: 2,
        wallTimeMs: 1,
        type: "tool_call",
        requestId,
        toolName: "java_impact"
      },
      {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        taskId: task.taskId,
        sequence: 3,
        wallTimeMs: 10,
        type: "tool_result",
        requestId,
        completion: "COMPLETE",
        freshness: { startGeneration: 1, endGeneration: 1, changedDuringRequest: false },
        contextFiles
      },
      {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        taskId: task.taskId,
        sequence: 4,
        wallTimeMs: 11,
        type: "mcp_response",
        requestId,
        isError: false,
        responseArtifact: responseEvidence.file,
        responseSha256: responseEvidence.sha256,
        serializedBytes: responseEvidence.bytes
      }
    );
  }
  return serializeEvents(rows);
}

async function createSourceLockedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-trace-source-lock-"));
  const goldenDir = path.join(root, "golden");
  const artifactRoot = path.join(root, "artifacts");
  await Promise.all([mkdir(goldenDir, { recursive: true }), mkdir(artifactRoot, { recursive: true })]);
  const repositories = {};
  for (const projectId of ["lishuedu", "cipherlink", "exam-parent-v3"]) {
    const sourceRows = (await readFile(path.join(sourceGoldenDir, `${projectId}.scenarios.jsonl`), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    const requiredFiles = [...new Set(sourceRows
      .filter(row => row.evaluationSplit === "holdout")
      .flatMap(row => [...row.golden.mustHit, ...row.golden.taskBlocking]))].sort();
    const repoRoot = path.join(root, "repositories", projectId);
    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["config", "user.name", "Trace Test"]);
    await git(repoRoot, ["config", "user.email", "trace@example.invalid"]);
    for (const file of requiredFiles) {
      const target = path.join(repoRoot, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${projectId}:${file}\n`);
    }
    await git(repoRoot, ["add", "."]);
    await git(repoRoot, ["commit", "-qm", "trace source"]);
    const commit = (await git(repoRoot, ["rev-parse", "HEAD^{commit}"])).trim();
    repositories[projectId] = repoRoot;
    await writeFile(path.join(goldenDir, `${projectId}.scenarios.jsonl`), `${sourceRows
      .map(row => JSON.stringify({ ...row, repoCommit: commit }))
      .join("\n")}\n`);
  }
  return { root, goldenDir, artifactRoot, repositories };
}

async function sourceRecord(projectId, file) {
  const bytes = await readFile(path.join(fixture.repositories[projectId], file));
  return { file, contentSha256: sha256(bytes), bytes: bytes.byteLength };
}

async function writeArtifact(relativeFile, contents) {
  const bytes = Buffer.from(contents);
  const target = path.join(fixture.artifactRoot, relativeFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { file: relativeFile, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function parseEvents(text) {
  return text.trim().split("\n").map(line => JSON.parse(line));
}

function serializeEvents(rows) {
  return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}

function renumberTask(rows, taskId) {
  let sequence = 0;
  for (const row of rows) if (row.taskId === taskId) row.sequence = ++sequence;
}

async function git(root, args) {
  const result = await exec("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
