import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { combineMeasurements, reanalyzeWithSupplements, requireMeasuredShortfall } from "./ilv2-mac-system-loop-reanalyze.mjs";
import { LIMITS } from "./ilv2-mac-system-loop.mjs";
import { sha256 } from "./ilv2-mac-contracts.mjs";

const valid = (value = 1, kind) => ({ category: "VALID", verdict: "VALID", value, kind, loadStart: { load1: 1 }, loadEnd: { load1: 1 } });
const busy = () => ({ ...valid(), category: "ENVIRONMENT", verdict: "INVALID_EXPERIMENT", loadEnd: { load1: 20 }, reason: "host load" });
const group = (attempts, limit, minSamples, extra = {}) => ({ attempts, limit, minSamples, p: 0.95, ...extra });
const hardGates = Object.fromEntries(["correctness", "isolation", "requestDeadline", "resources", "noStarvation"].map(key => [key, "PASS"]));
function report(name, performance) {
  return { evidence: name, inputs: { "calls.jsonl": name }, recorded: { status: "FAIL" }, hardGates,
    heartbeatSamples: [], verdict: { performance } };
}

test("G11 primary exit one admits only the sole recorded measurement-completion assertion", () => {
  const source = Buffer.from("not ok 1 - G11 system loop\n    incomplete performance measurements: full\n  code: 'ERR_ASSERTION'\n  expected: true\n  actual: false\n  operator: 'strictEqual'\n# tests 1\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n");
  const primary = { hardGates, recorded: { hardGates, incompleteMeasurements: ["full"] }, recordedEnvelope: { measurementComplete: false } };
  const result = { mainError: "node exited with 1 (no signal)", identity: { runtime: { execPath: "node" } } };
  const command = { status: "FAIL", exitCode: 1, signal: null, error: null, stdoutSha256: sha256(source) };
  assert.doesNotThrow(() => requireMeasuredShortfall(primary, result, command, source));
  assert.throws(() => requireMeasuredShortfall({ ...primary, recorded: { ...primary.recorded, hardGates: { ...hardGates, correctness: "FAIL" } } }, result, command, source), /recorded failure/);
  for (const changed of [source.toString().replace("incomplete performance measurements: full", "unexpected failure"),
    source.toString().replace("# cancelled 0", "# cancelled 1"), `${source}not ok 2 - extra\n`]) {
    const bytes = Buffer.from(changed);
    assert.throws(() => requireMeasuredShortfall(primary, result, { ...command, stdoutSha256: sha256(bytes) }, bytes), /sole measurement/);
  }
  assert.throws(() => requireMeasuredShortfall(primary, result, command, Buffer.from("tampered")), /stdout identity/);
});

test("G11 supplementation retains every invalid and slow attempt without double counting", () => {
  const primary = report("main", { full: group([valid(100), valid(200), busy()], LIMITS.fullMs, 3, { p: 0.5 }) });
  const extra = report("supplement", { full: group([valid(400000), valid(500000)], LIMITS.fullMs, 3, { p: 0.5 }) });
  const result = combineMeasurements([primary, extra]);
  assert.equal(result.performance.full.validN, 4);
  assert.equal(result.performance.full.invalidN, 1);
  assert.equal(result.performance.full.attemptedN, 5);
  assert.equal(result.performance.full.max, 500000);
  assert.equal(result.performance.full.value, 200);
  assert.deepEqual(result.performance.full.attempts.map(row => row.evidence), ["main", "main", "main", "supplement", "supplement"]);
  assert.throws(() => combineMeasurements([primary, primary]), /duplicate evidence/);
  assert.throws(() => combineMeasurements([primary, { ...primary, evidence: "copied-evidence" }]), /duplicate recorded/);
  assert.throws(() => combineMeasurements([primary, { ...primary, evidence: "changed-summary", inputs: { ...primary.inputs, "g11-analysis.json": "new-summary" } }]), /duplicate recorded/);
  primary.hardGates = { ...hardGates, requestDeadline: "FAIL" };
  assert.equal(combineMeasurements([primary, extra]).status, "FAIL", "supplements cannot replace a failed primary hard gate");
});

test("G11 supplementation keeps missing evidence blocking and Java XML counts separate", () => {
  const opts = { minByKind: { java: 20, xml: 10 } };
  const primary = report("main", { editFirstCorrect: group([
    ...Array.from({ length: 13 }, () => valid(1, "java")), ...Array.from({ length: 6 }, () => valid(1, "xml")), busy()
  ], LIMITS.editP95Ms, 30, opts) });
  const extra = report("extra", { editFirstCorrect: group([
    ...Array.from({ length: 7 }, () => valid(1, "java")), ...Array.from({ length: 4 }, () => valid(5000, "xml"))
  ], LIMITS.editP95Ms, 30, opts) });
  const complete = combineMeasurements([primary, extra]);
  assert.equal(complete.measurementComplete, true);
  assert.equal(complete.performance.editFirstCorrect.verdict, "FAIL", "valid slow XML remains in p95");
  assert.deepEqual(complete.performance.editFirstCorrect.countsByKind, { java: 20, xml: 10 });
  extra.verdict.performance.editFirstCorrect.attempts.push({ ...valid(Infinity, "java"), category: "MISSING_EVIDENCE", verdict: "FAIL" });
  assert.equal(combineMeasurements([primary, extra]).measurementComplete, false);
  extra.verdict.performance.editFirstCorrect.attempts = Array.from({ length: 11 }, () => valid(1, "java"));
  assert.equal(combineMeasurements([primary, extra]).measurementComplete, false, "extra Java cannot replace XML");
});

test("G11 supplementation rejects aliased evidence and changed compiled product bytes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac11-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = path.join(root, "old", "result", "0.evidence"), alias = path.join(root, "alias");
  const current = path.join(root, "new", "candidate"), previous = path.join(root, "old", "candidate");
  await Promise.all([evidence, path.join(current, "dist"), path.join(previous, "dist")].map(dir => mkdir(dir, { recursive: true })));
  await symlink(evidence, alias, "dir");
  await assert.rejects(reanalyzeWithSupplements(evidence, [alias], current), /duplicate evidence/);
  const identity = { source: "source", candidateSource: "source", runtime: { runtimeManifestSha256: "runtime" }, native: { sourceDigest: "native" } };
  await writeFile(path.join(current, "..", "validation-candidate.json"), JSON.stringify({ identity }));
  await writeFile(path.join(evidence, "..", "result.json"), JSON.stringify({ identity, candidateRoot: previous }));
  await writeFile(path.join(evidence, "run-plan.json"), JSON.stringify({ quick: false, input: { head: "input" } }));
  await writeFile(path.join(current, "dist", "runtime.js"), "export const value=2;");
  await writeFile(path.join(previous, "dist", "runtime.js"), "export const value=1;");
  await assert.rejects(reanalyzeWithSupplements(evidence, [], current), /compiled product differs/);
  await writeFile(path.join(previous, "dist", "runtime.js"), "export const value=2;");
  await Promise.all([current, previous].map(dir => mkdir(path.join(dir, "dist", "native"))));
  const currentIdentity = { ...identity, native: { ...identity.native, binarySha256: sha256("current-native") } };
  const previousIdentity = { ...identity, native: { ...identity.native, binarySha256: sha256("old-native") } };
  await writeFile(path.join(current, "..", "validation-candidate.json"), JSON.stringify({ identity: currentIdentity }));
  await writeFile(path.join(evidence, "..", "result.json"), JSON.stringify({ identity: previousIdentity, candidateRoot: previous }));
  await writeFile(path.join(current, "dist", "native", "ilv2-mac"), "current-native");
  await writeFile(path.join(previous, "dist", "native", "ilv2-mac"), "old-native");
  await assert.rejects(reanalyzeWithSupplements(evidence, [], current), /native binary identity differs/);
  await writeFile(path.join(evidence, "..", "result.json"), JSON.stringify({ identity: currentIdentity, candidateRoot: previous }));
  await assert.rejects(reanalyzeWithSupplements(evidence, [], current), /actual native bytes differ/);
});

test("G11 recorded evidence completes the gate only after verified supplementation", {
  skip: !process.env.ILV2_MAC11_EVIDENCE_PLAN && "No recorded evidence plan selected"
}, async () => {
  const plan = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(process.env.ILV2_MAC11_EVIDENCE_PLAN, "utf8")));
  const result = await reanalyzeWithSupplements(plan.primary, plan.supplements);
  const output = path.join(process.env.ILV2_EVIDENCE_ROOT, "g11-combined-proof.json");
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  assert.equal(result.measurementComplete, true, `Incomplete: ${result.incompleteMeasurements.join(", ")}`);
  assert.equal(result.status, "PASS");
});
