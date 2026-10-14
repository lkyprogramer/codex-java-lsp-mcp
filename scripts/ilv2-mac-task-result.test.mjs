import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import os from "node:os";
import path from "node:path";
import { buildCloseoutManifest, composeTaskResult, passViolations, readValidationIndex } from "./ilv2-mac-task-result.mjs";

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const identity = (sourceDigest = "s1", nativeSha256 = "n1") => ({ sourceDigest, nativeSha256, nativeSourceDigest: "ns1", runtimeManifestSha256: "r1" });
const indexRow = (name, status, overrides = {}) => ({ schema: "ilv2-validation-index/v1", name, status, mainError: status === "FAIL" ? "exit 1" : null,
  result: `raw/validation/${name}/result.json`, validationRoot: "/v/1", identity: identity(),
  commands: [{ argv: ["node", "--test"], exitCode: status === "FAIL" ? 1 : 0, elapsedMs: 10, pid: 4242, tap: { tests: 2, pass: status === "FAIL" ? 1 : 2, fail: status === "FAIL" ? 1 : 0 } }], ...overrides });

async function runRoot(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-task-result-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "run-root.txt"), `${root}\n`);
  await mkdir(path.join(root, "raw/validation/main/0.evidence"), { recursive: true });
  await mkdir(path.join(root, "tmp/broker"), { recursive: true });
  await writeFile(path.join(root, "raw/validation/main/0.evidence/timeline.jsonl"),
    [{ type: "ready", pid: 5001, pgid: 5001 }, { type: "child", pid: 5002, pgid: 5001 }, { type: "foreign-group", pid: 5003, pgid: 7777 },
      { type: "jdt-spawned", childPid: 5004, parentPid: 4000 }, { type: "residual", daemonPid: 5005 }, { type: "driver", supervisorPid: 5006, jdtPgid: 5006 }].map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(path.join(root, "raw/validation/main/0.evidence/probe.plist"), "<key>Label</key><string>com.lky.ilv2-mac-env.abc</string>");
  await writeFile(path.join(root, "raw/validation/main/0.evidence/prod.json"), json({ label: "com.lky.codex-java-lsp-mcp", pid: 1 }));
  await writeFile(path.join(root, "tmp/broker/broker-root.json"), json({ root: path.join(root, "tmp/broker"), pid: 5000 }));
  await writeFile(path.join(root, "validation-index.jsonl"), [indexRow("main", "SELECTED_COMMANDS_PASSED"), indexRow("red", "FAIL")].map(row => JSON.stringify(row)).join("\n") + "\n");
  return root;
}

test("closeout manifest classifies the run root and inventories owned resources", async t => {
  const root = await runRoot(t);
  const manifest = await buildCloseoutManifest(root, "G03A");
  const byPath = Object.fromEntries(manifest.artifacts.map(row => [path.relative(root, row.path), row]));
  assert.equal(byPath.raw.class, "RAW"); assert.equal(byPath.raw.expiresAtGate, "G03A");
  assert.equal(byPath.tmp.class, "BULK"); assert.equal(byPath.closeout.recursive, true);
  for (const name of ["run-root.txt", "validation-index.jsonl", "task-result.json", "closeout-manifest.json"]) assert.equal(byPath[name].class, "LOCAL");
  // childPid/daemonPid/supervisorPid are ours; a parentPid is not.
  assert.deepEqual(manifest.processes.map(row => [row.pid, row.ownedGroup ?? false]),
    [[4242, false], [5000, false], [5001, true], [5002, false], [5003, false], [5004, false], [5005, false], [5006, true]]);
  assert.deepEqual(manifest.launchdJobs.map(row => row.label), ["com.lky.ilv2-mac-env.abc"]);
  await mkdir(path.join(root, "stray"));
  await assert.rejects(buildCloseoutManifest(root, "G03A"), /unregistered top-level directory stray/);
  const extra = [{ path: path.join(root, "stray"), class: "INPUT", recursive: true, carryOver: true, consumer: "MAC-04", expiresAtGate: "G04" }];
  assert.equal((await buildCloseoutManifest(root, "G03A", { extra })).artifacts.at(-1).class, "INPUT");
});

test("PASS must be supported by one source, real RED tests, closeout and a clean review", async t => {
  const index = await readValidationIndex(await runRoot(t));
  const closeout = { status: "PASS", closeoutId: "G03A", validationIndex: { sha256: index.sha256 }, resourceExit: { status: "PASS" }, archive: { physicalVerification: "PASS" } };
  const review = { status: "PASS", source: "s1", openFindings: [] };
  const verdict = { gateId: "G03A", main: ["main"], expectedRed: ["red"] };
  assert.deepEqual(passViolations({ verdict, index, closeout, review }), []);
  index.byName.set("other", indexRow("other", "SELECTED_COMMANDS_PASSED", { identity: identity("s2") }));
  index.byName.set("compile-red", indexRow("compile-red", "FAIL", { commands: [{ exitCode: 2, tap: null }] }));
  // Exit 0 without tests (build only, or a test pattern that matched nothing) is not a main run.
  index.byName.set("build-only", indexRow("build-only", "SELECTED_COMMANDS_PASSED", { commands: [{ exitCode: 0, tap: null }] }));
  index.byName.set("cancelled", indexRow("cancelled", "SELECTED_COMMANDS_PASSED", { commands: [{ exitCode: 0, tap: { tests: 3, pass: 2, fail: 0, cancelled: 1 } }] }));
  index.byName.set("anonymous", indexRow("anonymous", "SELECTED_COMMANDS_PASSED", { identity: null }));
  for (const name of ["build-only", "cancelled"]) {
    assert.match(passViolations({ verdict: { gateId: "G03A", main: [name] }, index, closeout, review }).join("\n"), new RegExp(`main run ${name} did not run tests cleanly`));
  }
  assert.match(passViolations({ verdict: { gateId: "G03A", main: ["anonymous"] }, index, closeout, review: { ...review, source: undefined } }).join("\n"), /sourceDigest missing[\s\S]*not a clean review/);
  assert.deepEqual(passViolations({ verdict, index, closeout: { ...closeout, closeoutId: "G04" }, review }), ["closeout G04 is not for G03A"]);
  assert.deepEqual(passViolations({ verdict, index, closeout: { ...closeout, validationIndex: { sha256: "older" } }, review, residualDirectories: ["tmp"] }),
    ["validation-index.jsonl changed after closeout", "tmp/ still exists after closeout"]);
  const errors = passViolations({ verdict: { gateId: "G09", main: ["main", "other"], expectedRed: ["compile-red"], independentRerun: [] }, index,
    closeout: { status: "FAIL", resourceExit: { status: "PASS" } }, review: { ...review, source: "old" } });
  for (const pattern of [/other: sourceDigest differs/, /compile-red did not fail a test/, /G09 requires an independent rerun/, /closeout did not pass/, /not a clean review/]) {
    assert.ok(errors.some(error => pattern.test(error)), `${pattern} not in ${JSON.stringify(errors)}`);
  }
  // An independent rebuild may differ in native bytes but not in native source; it must use a new candidate.
  index.byName.set("rebuild", indexRow("rebuild", "SELECTED_COMMANDS_PASSED", { identity: identity("s1", "n2") }));
  assert.deepEqual(passViolations({ verdict: { gateId: "G09", main: ["main"], independentRerun: ["rebuild"] }, index, closeout: { ...closeout, closeoutId: "G09" }, review }),
    ["independent rerun rebuild reused a main candidate"]);
});

test("compose writes a generated result, upserts status.json and refuses unsupported PASS", async t => {
  const root = await runRoot(t);
  const docs = path.join(root, "docs");
  await mkdir(path.join(docs, "flow"), { recursive: true });
  await writeFile(path.join(docs, "status.json"), json({ schema: "ilv2-mac-status/v1", gates: [{ gateId: "G03A", taskId: "MAC-03A", status: "PLAN" }], workflow: [] }));
  await writeFile(path.join(docs, "manual.md"), "see index-lifecycle-v2/mac/status.json\n");
  await mkdir(path.join(docs, "manual"));
  await writeFile(path.join(root, "probe.json"), json({ status: "BLOCKED_ENV_TCC" }));
  const verdictFile = path.join(root, "verdict.json"), outFile = path.join(docs, "flow/task-result.json");
  const options = { runRoot: root, verdictFile, outFile, statusFile: path.join(docs, "status.json"), manualFile: path.join(docs, "manual.md"), manualDir: path.join(docs, "manual") };
  await writeFile(verdictFile, json({ schema: "ilv2-task-verdict/v1", taskId: "WF", workflowId: "WF-1", status: "PASS", main: ["main"], evidence: [{ name: "a4", file: "probe.json" }] }));
  await assert.rejects(composeTaskResult(options), /requires closeout/);
  await mkdir(path.join(root, "closeout"));
  const indexSha256 = sha256(await readFile(path.join(root, "validation-index.jsonl")));
  await writeFile(path.join(root, "closeout/closeout.json"), json({ status: "PASS", closeoutId: "WF-1", validationIndex: { sha256: indexSha256, runs: ["main", "red"] },
    resourceExit: { status: "PASS", processes: [{ pid: 9, pgid: 9, ownedGroup: true }], launchdJobs: [] }, archive: null, unregisteredPaths: [], expiredResidualBytes: 0, carryOver: [] }));
  await assert.rejects(composeTaskResult(options), /raw\/ still exists after closeout/);
  for (const name of ["raw", "tmp"]) await rm(path.join(root, name), { recursive: true });
  const { result, statusCheck } = await composeTaskResult(options);
  assert.equal(result.status, "PASS"); assert.equal(result.identity.sourceDigest, "s1");
  assert.equal(result.closeout.ownedGroups, 1); assert.equal(result.evidence[0].status, "BLOCKED_ENV_TCC");
  assert.equal(result.checks[0].tests, 2); assert.equal(result.independent.review, "NOT_RUN");
  assert.deepEqual(statusCheck.errors, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(docs, "status.json"), "utf8")).workflow, [{ id: "WF-1", status: "PASS", result: "flow/task-result.json" }]);
  await writeFile(verdictFile, json({ schema: "ilv2-task-verdict/v1", taskId: "MAC-03A", gateId: "G03A", status: "PASS", main: ["main"] }));
  await assert.rejects(composeTaskResult({ ...options, outFile: path.join(docs, "flow/gate.json") }), /requires an independent review/);
  // Unknown gate or status is rejected before anything is written.
  for (const verdict of [{ gateId: "G3A", status: "FAIL" }, { gateId: "G03A", status: "DONE" }]) {
    await writeFile(verdictFile, json({ schema: "ilv2-task-verdict/v1", taskId: "MAC-03A", ...verdict }));
    await assert.rejects(composeTaskResult(options), /not a leaf gate|invalid status/);
  }
  assert.equal(JSON.parse(await readFile(outFile, "utf8")).workflowId, "WF-1");
  await writeFile(outFile, json({ status: "PASS", handWritten: true }));
  await writeFile(verdictFile, json({ schema: "ilv2-task-verdict/v1", taskId: "WF", workflowId: "WF-1", status: "FAIL" }));
  await assert.rejects(composeTaskResult(options), /hand-written/);
});
