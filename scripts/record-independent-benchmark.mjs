#!/usr/bin/env node
// input: explicit run-identity flags plus raw artifact files (probe JSON, preflight, result packs).
// output: independent-benchmark-record/v1 — run identity only. Never holds gold, answers, or result contents.
// pos: T01 independent benchmark identity recorder for the devkit. Scoring belongs to the external harness only.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BENCHMARK_RECORD_SCHEMA = "independent-benchmark-record/v1";
export const BENCHMARK_EVALUATION_MODES = Object.freeze(["retrieval", "structured-qa", "agent"]);
const HEX64 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{7,40}$/;
const FORBIDDEN_KEYS = new Set([
  "gold",
  "answer",
  "answers",
  "referencepatch",
  "reference_patch",
  "musthit",
  "must_hit",
  "taskblocking",
  "labels",
  "frozenassertions"
]);

function forbiddenKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenKeys(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) out.add(key);
      forbiddenKeys(item, out);
    }
  }
  return out;
}

// Build a run-identity record. The record describes which source/data/toolchain
// produced a run; it never carries task gold, answers, or measured outcomes.
export function buildBenchmarkRecord({
  arm,
  evaluationMode,
  datasetHash = null,
  corpusHash = null,
  sourceSha = null,
  nodeVersion = null,
  javaVersion = null,
  artifacts = []
} = {}) {
  if (typeof arm !== "string" || !arm) throw new Error("arm is required");
  if (!BENCHMARK_EVALUATION_MODES.includes(evaluationMode)) {
    throw new Error(`evaluationMode must be one of: ${BENCHMARK_EVALUATION_MODES.join(", ")}`);
  }
  if (datasetHash !== null && !HEX64.test(datasetHash)) {
    throw new Error("datasetHash must be a 64-char lowercase hex digest");
  }
  if (corpusHash !== null && !/^[a-f0-9]{8,128}$/.test(corpusHash)) {
    throw new Error("corpusHash must be a lowercase hex digest");
  }
  if (sourceSha !== null && !GIT_OBJECT_ID.test(sourceSha)) {
    throw new Error("sourceSha must be a git object id");
  }
  const forbidden = new Set();
  for (const artifact of artifacts) {
    for (const key of forbiddenKeys(artifact?.metadata ?? {})) forbidden.add(key);
  }
  if (forbidden.size > 0) {
    throw new Error(`record may not carry gold/label fields: ${[...forbidden].sort().join(", ")}`);
  }
  return {
    schema: BENCHMARK_RECORD_SCHEMA,
    scope: "RUN_IDENTITY_ONLY",
    arm,
    evaluationMode,
    datasetHash,
    corpusHash,
    sourceSha,
    toolchain: { node: nodeVersion, javac: javaVersion },
    artifacts: artifacts.map(artifact => ({
      name: artifact.name,
      file: artifact.file,
      sha256: artifact.sha256,
      bytes: artifact.bytes
    })),
    goldStatus: "NOT_HELD",
    taskOutcome: { status: "UNMEASURED", authority: "external-evaluator" },
    note: "Run identity only; results and scoring belong to the external harness."
  };
}

export function validateBenchmarkRecord(record) {
  const errors = [];
  if (record?.schema !== BENCHMARK_RECORD_SCHEMA) errors.push("schema mismatch");
  if (record?.scope !== "RUN_IDENTITY_ONLY") errors.push("scope must be RUN_IDENTITY_ONLY");
  if (!BENCHMARK_EVALUATION_MODES.includes(record?.evaluationMode)) errors.push("invalid evaluationMode");
  if (record?.datasetHash !== null && !HEX64.test(record?.datasetHash ?? "")) errors.push("datasetHash must be 64-char hex");
  if (record?.sourceSha !== null && !GIT_OBJECT_ID.test(record?.sourceSha ?? "")) errors.push("sourceSha must be a git object id");
  if (record?.taskOutcome?.status !== "UNMEASURED" || record?.taskOutcome?.authority !== "external-evaluator") {
    errors.push("taskOutcome must be UNMEASURED with authority external-evaluator");
  }
  if (record?.goldStatus !== "NOT_HELD") errors.push("record must not hold gold");
  if (forbiddenKeys(record).size > 0) errors.push(`gold/label fields present: ${[...forbiddenKeys(record)].join(", ")}`);
  for (const artifact of record?.artifacts ?? []) {
    if (typeof artifact?.name !== "string" || !artifact.name) errors.push("artifact needs a name");
    if (!HEX64.test(artifact?.sha256 ?? "")) errors.push(`artifact ${artifact?.name} needs a sha256 digest`);
  }
  return { pass: errors.length === 0, errors };
}

export async function hashArtifact(file) {
  const bytes = await readFile(file);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

// Record a run from explicit flags plus raw artifact files. The record contains
// artifact digests only, never artifact contents, and is validated before write.
export async function recordBenchmarkRun({
  output,
  arm,
  evaluationMode,
  datasetHash = null,
  corpusHash = null,
  sourceSha = null,
  nodeVersion = null,
  javaVersion = null,
  artifacts = []
}) {
  const resolved = [];
  for (const [name, file] of artifacts) {
    const { sha256, bytes } = await hashArtifact(file);
    resolved.push({ name, file: path.resolve(file), sha256, bytes });
  }
  const record = buildBenchmarkRecord({
    arm,
    evaluationMode,
    datasetHash,
    corpusHash,
    sourceSha,
    nodeVersion,
    javaVersion,
    artifacts: resolved
  });
  const check = validateBenchmarkRecord(record);
  if (!check.pass) throw new Error(`record validation failed: ${check.errors.join("; ")}`);
  const out = path.resolve(output);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  return { record, output: out };
}

function parseArtifactFlag(raw) {
  const separator = raw.indexOf("=");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(`--artifact expects name=file, got: ${raw}`);
  }
  return [raw.slice(0, separator), raw.slice(separator + 1)];
}

async function main(argv) {
  const option = name => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const repeated = name => {
    const out = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === name && argv[index + 1]) out.push(argv[index + 1]);
    }
    return out;
  };
  const output = option("--output");
  if (!output) throw new Error("Usage: node scripts/record-independent-benchmark.mjs --output <file> --arm <A0> --evaluation-mode retrieval [--dataset-hash <64hex>] [--corpus-hash <hex>] [--source-sha <git-id>] [--node <v>] [--javac <v>] [--artifact name=file]...");
  const { record, output: written } = await recordBenchmarkRun({
    output,
    arm: option("--arm"),
    evaluationMode: option("--evaluation-mode"),
    datasetHash: option("--dataset-hash") ?? null,
    corpusHash: option("--corpus-hash") ?? null,
    sourceSha: option("--source-sha") ?? null,
    nodeVersion: option("--node") ?? null,
    javaVersion: option("--javac") ?? null,
    artifacts: repeated("--artifact").map(parseArtifactFlag)
  });
  console.log(JSON.stringify(record, null, 2));
  process.stderr.write(`[independent-benchmark] record written: ${written}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`[independent-benchmark] ${error.message}\n`);
    process.exitCode = 1;
  });
}