import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BENCHMARK_RECORD_SCHEMA,
  buildBenchmarkRecord,
  recordBenchmarkRun,
  validateBenchmarkRecord
} from "./record-independent-benchmark.mjs";

test("benchmark record holds run identity only and never gold", () => {
  const record = buildBenchmarkRecord({
    arm: "A0",
    evaluationMode: "retrieval",
    datasetHash: "a".repeat(64),
    corpusHash: "b".repeat(64),
    sourceSha: "d86dba38fccc9bf4b6d83703c9effacedbe9a972",
    nodeVersion: "v22.19.0",
    javaVersion: "javac 25.0.1",
    artifacts: [{ name: "probe", file: "/tmp/probe.json", sha256: "c".repeat(64), bytes: 123 }]
  });
  assert.equal(record.schema, BENCHMARK_RECORD_SCHEMA);
  assert.equal(record.scope, "RUN_IDENTITY_ONLY");
  assert.equal(record.goldStatus, "NOT_HELD");
  assert.equal(record.taskOutcome.status, "UNMEASURED");
  assert.equal(record.taskOutcome.authority, "external-evaluator");
  assert.deepEqual(validateBenchmarkRecord(record).errors, []);
});

test("gold or label fields are rejected even when nested in artifact metadata", () => {
  assert.throws(() => buildBenchmarkRecord({
    arm: "A0",
    evaluationMode: "retrieval",
    artifacts: [{ name: "p", file: "f", sha256: "c".repeat(64), bytes: 1, metadata: { gold: { answer: 1 } } }]
  }), /gold\/label fields/);
});

test("invalid arm, evaluation mode, or hashes are rejected", () => {
  assert.throws(() => buildBenchmarkRecord({ arm: "", evaluationMode: "retrieval" }), /arm is required/);
  assert.throws(() => buildBenchmarkRecord({ arm: "A0", evaluationMode: "vibe" }), /evaluationMode/);
  assert.throws(() => buildBenchmarkRecord({ arm: "A0", evaluationMode: "retrieval", datasetHash: "nope" }), /datasetHash/);
  assert.throws(() => buildBenchmarkRecord({ arm: "A0", evaluationMode: "retrieval", sourceSha: "HEAD" }), /sourceSha/);
});

test("recordBenchmarkRun hashes raw artifacts and writes a validated record without contents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "independent-benchmark-record-"));
  const probe = path.join(dir, "probe.json");
  await writeFile(probe, '{"schema":"product-regression-probe/v1","passed":3,"failed":9}\n');
  const output = path.join(dir, "record.json");
  const { record } = await recordBenchmarkRun({
    output,
    arm: "A0",
    evaluationMode: "retrieval",
    datasetHash: "a".repeat(64),
    corpusHash: "b".repeat(64),
    sourceSha: "d86dba3",
    nodeVersion: "v22.19.0",
    artifacts: [["probe", probe]]
  });
  assert.match(record.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(record.artifacts[0].bytes, (await readFile(probe, "utf8")).length);
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.schema, BENCHMARK_RECORD_SCHEMA);
  assert.equal(written.goldStatus, "NOT_HELD");
  assert.equal(JSON.stringify(written).includes("product-regression-probe"), false, "artifact contents must never enter the record");
});