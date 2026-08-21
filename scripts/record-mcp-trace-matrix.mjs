#!/usr/bin/env node
// input: Six source-locked local task traces plus an exact MCP tools/list payload.
// output: A replayable, hash-bound MCP request/tool/read trace matrix with deterministic TTFUC evidence.
// pos: V3.2-07a local-only trace contract; it never calls a model or claims TaskSuccess.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TRACE_MATRIX_SCHEMA_VERSION = "java-intelligence-v32-mcp-trace-matrix/v2";
export const TRACE_EVENT_SCHEMA_VERSION = "java-intelligence-v32-mcp-trace-events/v2";
const PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
const EVENT_TYPES = new Set(["mcp_request", "tool_call", "tool_result", "mcp_response", "file_read"]);
const COMPLETIONS = new Set(["COMPLETE", "PARTIAL", "FAILED"]);

export async function loadTraceTasks(goldenDir = path.join(scriptRoot, "golden")) {
  const tasks = [];
  const goldenFiles = [];
  for (const projectId of PROJECTS) {
    const file = path.resolve(goldenDir, `${projectId}.scenarios.jsonl`);
    const bytes = await readFile(file);
    const rows = parseJsonLines(bytes.toString("utf8"), file);
    const holdouts = rows.filter(row => row.evaluationSplit === "holdout");
    if (rows.length !== 10 || holdouts.length !== 2) {
      throw new TraceValidationError(`${file}: trace contract requires 10 scenarios with exactly 2 holdouts`);
    }
    goldenFiles.push({ projectId, file, bytes: bytes.length, sha256: sha256(bytes) });
    for (const row of holdouts) {
      const requiredContextFiles = uniqueStrings([
        ...(row.golden?.mustHit ?? []),
        ...(row.golden?.taskBlocking ?? [])
      ]).sort();
      if (!fullGitObjectId(row.repoCommit) || requiredContextFiles.length === 0) {
        throw new TraceValidationError(`${file}: ${row.id} must bind a full repo commit and required context`);
      }
      const keywords = Array.isArray(row.anchor?.taskKeywords) ? row.anchor.taskKeywords : [];
      const taskText = [row.name, ...keywords].filter(item => typeof item === "string" && item.trim()).join(" ").slice(0, 500);
      tasks.push({
        taskId: `${projectId}:${row.id}`,
        projectId,
        scenarioId: row.id,
        repoCommit: row.repoCommit,
        anchor: row.anchor,
        taskText,
        requiredContextFiles
      });
    }
  }
  if (tasks.length !== 6) throw new TraceValidationError("trace contract must freeze exactly six holdout tasks");
  return { tasks, goldenFiles };
}

export async function buildTraceMatrix({
  goldenDir,
  eventsText,
  toolSchema,
  runtimeIdentity,
  inputFile,
  repositories,
  artifactRoot
} = {}) {
  const { tasks, goldenFiles } = await loadTraceTasks(goldenDir);
  const runtime = validateRuntimeIdentity(runtimeIdentity);
  const tools = validateToolSchema(toolSchema);
  const repositoryLocks = await validateTraceRepositories(tasks, repositories);
  const events = await validateTraceEventArtifacts(
    parseTraceEvents(eventsText),
    repositoryLocks,
    path.resolve(artifactRoot ?? (inputFile ? path.dirname(inputFile) : "."))
  );
  const expectedTaskIds = tasks.map(task => task.taskId).sort();
  const actualTaskIds = [...new Set(events.map(event => event.taskId))].sort();
  if (!sameStringArray(actualTaskIds, expectedTaskIds)) {
    throw new TraceValidationError("event input must contain exactly the six frozen task ids");
  }

  const traces = tasks.map(task => buildTaskTrace(task, events.filter(event => event.taskId === task.taskId), tools));
  const replayPayload = {
    schemaVersion: TRACE_MATRIX_SCHEMA_VERSION,
    runtime,
    toolSchemaSha256: sha256(stableJson(tools)),
    golden: goldenFiles.map(file => ({ projectId: file.projectId, sha256: file.sha256 })),
    repositories: Object.fromEntries(PROJECTS.map(projectId => [projectId, publicRepositoryLock(repositoryLocks[projectId])])),
    tasks: traces.map(trace => ({
      task: trace.task,
      events: trace.events,
      ttfuc: trace.ttfuc,
      completion: trace.completion,
      freshness: trace.freshness
    }))
  };
  return {
    schemaVersion: TRACE_MATRIX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceLock: {
      runtime,
      goldenFiles,
      repositories: Object.fromEntries(PROJECTS.map(projectId => [projectId, repositoryLocks[projectId]])),
      toolSchema: {
        sha256: replayPayload.toolSchemaSha256,
        tools: tools.map(tool => tool.name),
        canonical: tools
      },
      eventsInput: {
        file: inputFile ? path.resolve(inputFile) : "IN_MEMORY",
        bytes: Buffer.byteLength(eventsText ?? "", "utf8"),
        sha256: sha256(eventsText ?? "")
      }
    },
    tasks: traces,
    modelEvaluation: {
      status: "BLOCKED_EXTERNAL",
      modelUsage: unmeasured("no model client is used by the local recorder"),
      taskSuccess: unmeasured("TaskSuccess requires the authorized external Agent evaluation"),
      blindReview: unmeasured("blind review has not been authorized or executed"),
      manualCorrections: unmeasured("no model task execution exists in the local trace")
    },
    replaySha256: sha256(stableJson(replayPayload))
  };
}

export async function verifyTraceReplay(trace, inputs) {
  if (!trace || trace.schemaVersion !== TRACE_MATRIX_SCHEMA_VERSION || !sha256Value(trace.replaySha256)) {
    throw new TraceValidationError("trace matrix schema or replay hash is invalid");
  }
  const replay = await buildTraceMatrix(inputs);
  if (replay.replaySha256 !== trace.replaySha256) {
    throw new TraceValidationError("source-locked trace replay differs from the recorded request/tool/read sequence");
  }
  return {
    schemaVersion: "java-intelligence-v32-mcp-trace-replay-receipt/v1",
    verifiedAt: new Date().toISOString(),
    traceReplaySha256: trace.replaySha256,
    eventsInputSha256: replay.sourceLock.eventsInput.sha256,
    toolSchemaSha256: replay.sourceLock.toolSchema.sha256,
    tasks: replay.tasks.length,
    passed: true
  };
}

function buildTaskTrace(task, events, tools) {
  const toolNames = new Set(tools.map(tool => tool.name));
  const requests = new Map();
  const observedContext = new Set();
  const completion = [];
  const freshness = [];
  let previousWallTimeMs = -1;
  let ttfuc;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1) {
      throw new TraceValidationError(`${task.taskId}: event sequence must be contiguous and 1-based`);
    }
    if (!(Number.isFinite(event.wallTimeMs) && event.wallTimeMs >= previousWallTimeMs)) {
      throw new TraceValidationError(`${task.taskId}: wallTimeMs must be finite, non-negative and monotonic`);
    }
    previousWallTimeMs = event.wallTimeMs;
    if (event.type === "mcp_request") {
      requireRequestIdentity(event, task.taskId);
      if (requests.has(event.requestId)) throw new TraceValidationError(`${task.taskId}: duplicate request ${event.requestId}`);
      requests.set(event.requestId, { state: "requested", toolName: event.toolName, contextFiles: [] });
    } else if (event.type === "tool_call") {
      const request = requireRequest(requests, event, "requested", task.taskId);
      if (!toolNames.has(event.toolName) || event.toolName !== request.toolName) {
        throw new TraceValidationError(`${task.taskId}: tool_call does not match the frozen tools/list schema`);
      }
      request.state = "called";
    } else if (event.type === "tool_result") {
      const request = requireRequest(requests, event, "called", task.taskId);
      if (!COMPLETIONS.has(event.completion)) throw new TraceValidationError(`${task.taskId}: invalid completion`);
      validateFreshness(event.freshness, task.taskId);
      request.contextFiles = validateSourceRecords(event.contextFiles, task.taskId, "contextFiles").map(record => record.file);
      completion.push({ requestId: event.requestId, toolName: request.toolName, completion: event.completion });
      freshness.push({ requestId: event.requestId, ...event.freshness });
      request.state = "result";
    } else if (event.type === "mcp_response") {
      const request = requireRequest(requests, event, "result", task.taskId);
      if (typeof event.isError !== "boolean" || !sha256Value(event.responseSha256)
        || !Number.isInteger(event.serializedBytes) || event.serializedBytes < 0
        || typeof event.responseArtifact !== "string" || !event.responseArtifact) {
        throw new TraceValidationError(`${task.taskId}: invalid MCP response evidence`);
      }
      for (const file of request.contextFiles) observedContext.add(file);
      request.state = "responded";
    } else if (event.type === "file_read") {
      requireRequest(requests, event, "responded", task.taskId);
      const [record] = validateSourceRecords([event], task.taskId, "file_read");
      observedContext.add(record.file);
    }
    if (!ttfuc && task.requiredContextFiles.every(file => observedContext.has(file))) {
      ttfuc = {
        status: "MEASURED",
        wallTimeMs: event.wallTimeMs,
        sequence: event.sequence,
        eventType: event.type,
        requiredFiles: task.requiredContextFiles.length
      };
    }
  }
  if (events.length === 0 || requests.size === 0 || [...requests.values()].some(request => request.state !== "responded")) {
    throw new TraceValidationError(`${task.taskId}: every trace needs at least one fully settled MCP tool request`);
  }
  return {
    task,
    events,
    traceSha256: sha256(stableJson(events)),
    completion,
    freshness,
    ttfuc: ttfuc ?? {
      status: "UNREACHED",
      reason: "the local trace never accumulated every frozen must/task-blocking context file",
      requiredFiles: task.requiredContextFiles.length,
      observedFiles: [...observedContext].filter(file => task.requiredContextFiles.includes(file)).length
    },
    modelUsage: unmeasured("local MCP traces contain no model usage API"),
    taskSuccess: unmeasured("local deterministic replay does not evaluate task correctness")
  };
}

function parseTraceEvents(text = "") {
  const rows = parseJsonLines(text, "<events>");
  for (const event of rows) {
    if (event.schemaVersion !== TRACE_EVENT_SCHEMA_VERSION || typeof event.taskId !== "string"
      || !EVENT_TYPES.has(event.type) || !Number.isInteger(event.sequence) || event.sequence < 1
      || !(typeof event.wallTimeMs === "number" && Number.isFinite(event.wallTimeMs) && event.wallTimeMs >= 0)) {
      throw new TraceValidationError("invalid local MCP trace event envelope");
    }
  }
  return rows;
}

function requireRequestIdentity(event, taskId) {
  if (typeof event.requestId !== "string" || !event.requestId || typeof event.toolName !== "string" || !event.toolName
    || event.method !== "tools/call" || !sha256Value(event.argumentsSha256)
    || typeof event.argumentsArtifact !== "string" || !event.argumentsArtifact
    || !Number.isInteger(event.argumentsBytes) || event.argumentsBytes < 0) {
    throw new TraceValidationError(`${taskId}: invalid MCP request evidence`);
  }
}

function requireRequest(requests, event, expectedState, taskId) {
  const request = requests.get(event.requestId);
  if (!request || request.state !== expectedState) {
    throw new TraceValidationError(`${taskId}: ${event.type} is out of order for request ${String(event.requestId)}`);
  }
  return request;
}

function validateFreshness(value, taskId) {
  if (!value || !Number.isInteger(value.startGeneration) || value.startGeneration < 0
    || !Number.isInteger(value.endGeneration) || value.endGeneration < value.startGeneration
    || typeof value.changedDuringRequest !== "boolean") {
    throw new TraceValidationError(`${taskId}: invalid freshness evidence`);
  }
  if (value.changedDuringRequest !== (value.endGeneration !== value.startGeneration)) {
    throw new TraceValidationError(`${taskId}: changedDuringRequest contradicts the recorded generations`);
  }
}

function validateSourceRecords(records, taskId, label) {
  if (!Array.isArray(records)) throw new TraceValidationError(`${taskId}: ${label} must be an array`);
  return records.map(record => {
    if (!record || typeof record !== "object"
      || typeof record.file !== "string" || !record.file || path.isAbsolute(record.file)
      || record.file.split(/[\\/]+/).includes("..")
      || !sha256Value(record.contentSha256)
      || !Number.isInteger(record.bytes) || record.bytes < 0) {
      throw new TraceValidationError(`${taskId}: ${label} must contain source-locked repository file records`);
    }
    return { ...record, file: record.file.replaceAll("\\", "/") };
  });
}

async function validateTraceRepositories(tasks, repositories) {
  const result = {};
  for (const projectId of PROJECTS) {
    const root = repositories?.[projectId];
    if (typeof root !== "string" || !root) {
      throw new TraceValidationError(`trace repository root is required for ${projectId}`);
    }
    const resolvedRoot = path.resolve(root);
    const [head, tree, status] = await Promise.all([
      gitAt(resolvedRoot, ["rev-parse", "HEAD^{commit}"]),
      gitAt(resolvedRoot, ["rev-parse", "HEAD^{tree}"]),
      gitAt(resolvedRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    ]);
    if (status.length > 0) throw new TraceValidationError(`${projectId}: trace repository must be clean`);
    const expectedCommits = new Set(tasks.filter(task => task.projectId === projectId).map(task => task.repoCommit));
    if (expectedCommits.size !== 1 || !expectedCommits.has(head.trim())) {
      throw new TraceValidationError(`${projectId}: trace repository HEAD does not match the frozen task commit`);
    }
    result[projectId] = {
      root: resolvedRoot,
      head: head.trim(),
      tree: tree.trim(),
      clean: true,
      statusSha256: sha256(status)
    };
  }
  return result;
}

async function validateTraceEventArtifacts(events, repositoryLocks, artifactRoot) {
  const sourceCache = new Map();
  const artifactCache = new Map();
  const verified = [];
  for (const event of events) {
    const projectId = event.taskId.split(":", 1)[0];
    const repository = repositoryLocks[projectId];
    if (!repository) throw new TraceValidationError(`${event.taskId}: no source repository lock`);
    if (event.type === "tool_result") {
      const contextFiles = validateSourceRecords(event.contextFiles, event.taskId, "contextFiles");
      for (const record of contextFiles) await verifySourceRecord(repository, record, sourceCache, event.taskId);
      verified.push({ ...event, contextFiles });
      continue;
    }
    if (event.type === "file_read") {
      const [record] = validateSourceRecords([event], event.taskId, "file_read");
      await verifySourceRecord(repository, record, sourceCache, event.taskId);
      verified.push({ ...event, ...record });
      continue;
    }
    if (event.type === "mcp_request") {
      const evidence = await verifyArtifactRecord({
        artifactRoot,
        relativeFile: event.argumentsArtifact,
        expectedSha256: event.argumentsSha256,
        expectedBytes: event.argumentsBytes,
        label: `${event.taskId}: MCP arguments`,
        cache: artifactCache
      });
      verified.push({ ...event, argumentsArtifact: evidence.file });
      continue;
    }
    if (event.type === "mcp_response") {
      const evidence = await verifyArtifactRecord({
        artifactRoot,
        relativeFile: event.responseArtifact,
        expectedSha256: event.responseSha256,
        expectedBytes: event.serializedBytes,
        label: `${event.taskId}: MCP response`,
        cache: artifactCache
      });
      verified.push({ ...event, responseArtifact: evidence.file });
      continue;
    }
    verified.push(event);
  }
  return verified;
}

async function verifySourceRecord(repository, record, cache, taskId) {
  const key = `${repository.head}:${record.file}`;
  let bytes = cache.get(key);
  if (!bytes) {
    try {
      bytes = await gitBlob(repository.root, repository.head, record.file);
    } catch (error) {
      throw new TraceValidationError(`${taskId}: cannot read frozen source blob ${record.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    cache.set(key, bytes);
  }
  if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.contentSha256) {
    throw new TraceValidationError(`${taskId}: source blob evidence does not match ${record.file}`);
  }
}

async function verifyArtifactRecord({ artifactRoot, relativeFile, expectedSha256, expectedBytes, label, cache }) {
  if (typeof relativeFile !== "string" || !relativeFile || path.isAbsolute(relativeFile)
    || relativeFile.split(/[\\/]+/).includes("..") || !sha256Value(expectedSha256)
    || !Number.isInteger(expectedBytes) || expectedBytes < 0) {
    throw new TraceValidationError(`${label} artifact record is invalid`);
  }
  const file = path.resolve(artifactRoot, relativeFile);
  const relative = path.relative(artifactRoot, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TraceValidationError(`${label} artifact escapes its root`);
  }
  let bytes = cache.get(file);
  if (!bytes) {
    try {
      bytes = await readFile(file);
    } catch (error) {
      throw new TraceValidationError(`${label} artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    cache.set(file, bytes);
  }
  if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256) {
    throw new TraceValidationError(`${label} artifact hash/size mismatch`);
  }
  return { file: relativeFile.replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: expectedSha256 };
}

function publicRepositoryLock(repository) {
  return {
    head: repository.head,
    tree: repository.tree,
    clean: repository.clean,
    statusSha256: repository.statusSha256
  };
}

async function gitAt(root, args) {
  try {
    const result = await exec("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    throw new TraceValidationError(`cannot inspect trace repository ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function gitBlob(root, commit, relativeFile) {
  const result = await exec("git", ["-C", root, "show", `${commit}:${relativeFile}`], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024
  });
  return result.stdout;
}

function validateToolSchema(value) {
  const tools = Array.isArray(value) ? value : value?.tools;
  if (!Array.isArray(tools) || tools.length === 0) throw new TraceValidationError("tool schema must be an exact tools/list payload");
  const normalized = tools.map(tool => {
    if (!tool || typeof tool.name !== "string" || !tool.name || !tool.inputSchema || typeof tool.inputSchema !== "object") {
      throw new TraceValidationError("every frozen tool requires a name and inputSchema");
    }
    return tool;
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(normalized.map(tool => tool.name)).size !== normalized.length) throw new TraceValidationError("tool schema contains duplicates");
  return normalized;
}

function validateRuntimeIdentity(value) {
  if (!value || !fullGitObjectId(value.commit) || !fullGitObjectId(value.executableTree)) {
    throw new TraceValidationError("runtime identity requires full commit and executable tree ids");
  }
  return { commit: value.commit, executableTree: value.executableTree };
}

async function currentRuntimeIdentity() {
  const [commit, executableTree] = await Promise.all([
    git("rev-parse", "HEAD^{commit}"),
    git("write-tree")
  ]);
  return { commit: commit.trim(), executableTree: executableTree.trim() };
}

async function git(...args) {
  const result = await exec("git", ["-C", scriptRoot, ...args], { encoding: "utf8" });
  return result.stdout;
}

function parseJsonLines(text, file) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new TraceValidationError(`${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === "string" && value.length > 0))];
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unmeasured(reason) {
  return { status: "UNMEASURED", reason };
}

function fullGitObjectId(value) {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function sha256Value(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeExclusive(file, value) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function parseCli(args) {
  const mode = args.shift();
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new TraceValidationError(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  if (mode !== "record" && mode !== "replay") throw new TraceValidationError("mode must be record or replay");
  const events = required(options.get("--events"), "--events");
  const toolSchema = required(options.get("--tool-schema"), "--tool-schema");
  return {
    mode,
    events,
    toolSchema,
    goldenDir: options.get("--golden-dir") ?? path.join(scriptRoot, "golden"),
    artifactRoot: options.get("--artifact-root") ?? path.dirname(path.resolve(events)),
    repositories: {
      lishuedu: required(options.get("--lishuedu"), "--lishuedu"),
      cipherlink: required(options.get("--cipherlink"), "--cipherlink"),
      "exam-parent-v3": required(options.get("--exam-parent-v3"), "--exam-parent-v3")
    },
    output: mode === "record" ? required(options.get("--output"), "--output") : options.get("--output"),
    trace: mode === "replay" ? required(options.get("--trace"), "--trace") : undefined
  };
}

function required(value, name) {
  if (!value) throw new TraceValidationError(`${name} is required`);
  return value;
}

function printUsage() {
  console.log("Usage: node scripts/record-mcp-trace-matrix.mjs record|replay --events FILE.jsonl --artifact-root DIR --tool-schema tools-list.json --lishuedu DIR --cipherlink DIR --exam-parent-v3 DIR [--output FILE] [--trace FILE]");
}

export class TraceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "TraceValidationError";
  }
}

async function main() {
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new TraceValidationError("MCP trace recording/replay must run inside run-isolated-validation.mjs");
  }
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  for (const file of [cli.events, cli.toolSchema, ...(cli.trace ? [cli.trace] : [])]) {
    if (!existsSync(file)) throw new TraceValidationError(`input does not exist: ${file}`);
  }
  const eventsText = await readFile(cli.events, "utf8");
  const toolSchema = JSON.parse(await readFile(cli.toolSchema, "utf8"));
  const inputs = {
    goldenDir: cli.goldenDir,
    eventsText,
    toolSchema,
    runtimeIdentity: await currentRuntimeIdentity(),
    inputFile: cli.events,
    artifactRoot: cli.artifactRoot,
    repositories: cli.repositories
  };
  if (cli.mode === "record") {
    const trace = await buildTraceMatrix(inputs);
    await writeExclusive(cli.output, trace);
    console.log(JSON.stringify({ status: "RECORDED_LOCAL_ONLY", output: path.resolve(cli.output), replaySha256: trace.replaySha256 }));
    return;
  }
  const trace = JSON.parse(await readFile(cli.trace, "utf8"));
  const receipt = await verifyTraceReplay(trace, inputs);
  if (cli.output) await writeExclusive(cli.output, receipt);
  console.log(JSON.stringify(receipt));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
