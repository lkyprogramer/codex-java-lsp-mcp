import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execute, sha256, writeJson, verifyFrozenInput, verifyRuntime, cliOptions } from "./ilv2-mac-contracts.mjs";
import { validateCloseout } from "./ilv2-mac-closeout.mjs";
import { scanStaged } from "./ilv2-mac-staged-scan.mjs";

async function directory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function gitRepository(t) {
  const root = await directory(t, "ilv2-input-test-");
  const git = args => execute("git", ["--no-optional-locks", "-C", root, ...args]);
  await git(["init", "-q"]); await git(["config", "user.name", "Fixture"]); await git(["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(root, "Fixture.java"), "class Fixture {}\n");
  await git(["add", "Fixture.java"]); await git(["commit", "-qm", "fixture"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const manifestFile = path.join(await directory(t, "ilv2-manifest-test-"), "input.json");
  const bytes = await readFile(path.join(root, "Fixture.java"));
  await writeJson(manifestFile, { schema: "ilv2-mac-input/v1", repoRoot: root, head, files: [{ path: "Fixture.java", size: bytes.length, sha256: sha256(bytes) }] });
  return { root, git, record: { repoRoot: root, head, manifest: manifestFile, manifestSha256: sha256(await readFile(manifestFile)) } };
}
test("actual executable, versions, binary and OS identity are checked", async t => {
  const root = await directory(t, "ilv2-runtime-test-");
  const file = path.join(root, "runtime.json");
  const manifest = { schema: "ilv2-mac-runtime/v1", execPath: process.execPath, nodeRealpath: await realpath(process.execPath), nodeSha256: sha256(await readFile(process.execPath)), arch: process.arch,
    versions: { ...process.versions }, os: (await execute("/usr/bin/sw_vers", [])).stdout };
  await writeJson(file, manifest); assert.equal((await verifyRuntime(file)).execPath, process.execPath);
  for (const field of ["execPath", "nodeRealpath", "nodeSha256", "arch", "os"]) {
    await writeJson(file, { ...manifest, [field]: "drift" }); await assert.rejects(verifyRuntime(file), /runtime drift/);
  }
  await writeJson(file, { ...manifest, versions: { ...manifest.versions, sqlite: "different" } });
  await assert.rejects(verifyRuntime(file), /versions/);
});
test("HEAD unchanged but missing input is rejected", async t => {
  const { root, record, git } = await gitRepository(t);
  assert.equal((await verifyFrozenInput(record)).inputFiles, 1);
  await rm(path.join(root, "Fixture.java"));
  assert.equal((await git(["rev-parse", "HEAD"])).stdout.trim(), record.head);
  await assert.rejects(verifyFrozenInput(record), /worktree/);
});
test("clean HEAD with changed frozen content hash is rejected", async t => {
  const { record } = await gitRepository(t);
  const manifest = JSON.parse(await readFile(record.manifest)); manifest.files[0].sha256 = "wrong";
  await writeJson(record.manifest, manifest); record.manifestSha256 = sha256(await readFile(record.manifest));
  await assert.rejects(verifyFrozenInput(record), /bytes changed/);
});
test("every manifest-declared environment input is checked even outside the default file classifier", async t => {
  const { root, record, git } = await gitRepository(t);
  const bytes = Buffer.from("[fixture]\nmode = 'synthetic'\n");
  await writeFile(path.join(root, "config.toml"), bytes); await git(["add", "config.toml"]); await git(["commit", "-qm", "fixture environment"]);
  record.head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const manifest = JSON.parse(await readFile(record.manifest));
  manifest.head = record.head; manifest.files.push({ path: "config.toml", size: bytes.length, sha256: sha256(bytes) });
  await writeJson(record.manifest, manifest); record.manifestSha256 = sha256(await readFile(record.manifest));
  assert.equal((await verifyFrozenInput(record)).inputFiles, 2);
  await rm(path.join(root, "config.toml")); await assert.rejects(verifyFrozenInput(record), /worktree/);
});
test("broken Git object fails the frozen-input preflight", async t => {
  const { root, record, git } = await gitRepository(t);
  const blob = (await git(["rev-parse", "HEAD:Fixture.java"])).stdout.trim();
  const object = path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
  await rm(object);
  await writeFile(object, "broken");
  await assert.rejects(verifyFrozenInput(record), /fsck/);
});
test("ignored extra Java is not omitted from the actual input census", async t => {
  const { root, record, git } = await gitRepository(t);
  await writeFile(path.join(root, ".git", "info", "exclude"), "Ignored.java\n");
  await writeFile(path.join(root, "Ignored.java"), "class Ignored {}\n");
  assert.equal((await git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout, "");
  await assert.rejects(verifyFrozenInput(record), /census/);
});
test("scanner inspects staged blobs even when working text is clean, without leaking matches", async t => {
  const { root, git } = await gitRepository(t);
  const sensitive = "SYNTHETIC_PRIVATE_MARKER_123456";
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "note.md"), sensitive); await git(["add", "docs/note.md"]);
  await writeFile(path.join(root, "docs", "note.md"), "clean workspace\n");
  const result = await scanStaged(root, { rules: [{ id: "fixture-private", source: sensitive }] });
  assert.equal(result.status, "FAIL"); assert.equal(result.findings[0].path, "docs/note.md");
  assert.equal(JSON.stringify(result).includes(sensitive), false);
  const cli = fileURLToPath(new URL("./ilv2-mac-staged-scan.mjs", import.meta.url));
  const policy = path.join(await directory(t, "ilv2-policy-test-"), "policy.json");
  await writeJson(policy, { rules: [{ id: "fixture-private", source: sensitive }] });
  const output = await new Promise(resolve => {
    const child = spawn(process.execPath, [cli, "--repo", root, "--policy", policy]); const chunks = [];
    child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => chunks.push(chunk));
    child.on("close", code => resolve({ code, output: Buffer.concat(chunks).toString() }));
  });
  assert.equal(output.code, 1); assert.equal(output.output.includes(sensitive), false);
});
test("a reviewed exclusion is exact to path, blob, rule and count; binaries remain rejected", async t => {
  const { root, git } = await gitRepository(t);
  await writeFile(path.join(root, "note.md"), "fixture-private"); await git(["add", "note.md"]);
  const rules = [{ id: "fixture-private", source: "fixture-private" }];
  const scan = await scanStaged(root, { rules });
  const exclusion = { path: "note.md", blobSha256: scan.files[0].sha256, rule: "fixture-private", count: 1, reason: "Synthetic placeholder reviewed in this fixture" };
  assert.equal((await scanStaged(root, { rules, exclusions: [exclusion] })).status, "PASS");
  await writeFile(path.join(root, "note.md"), "fixture-private twice fixture-private"); await git(["add", "note.md"]);
  await assert.rejects(scanStaged(root, { rules, exclusions: [exclusion] }), /stale/);
  await writeFile(path.join(root, "raw.gz"), Buffer.from([31, 139, 0])); await git(["add", "raw.gz"]);
  assert.equal((await scanStaged(root, { rules })).findings.some(item => item.rule === "binary-or-raw"), true);
});
test("closeout rejects unregistered, zero-byte and nonzero expired remnants", async t => {
  const root = await directory(t, "ilv2-closeout-test-");
  await writeFile(path.join(root, "unknown.json"), "{}");
  const manifest = { runRoot: root, gateId: "G01", artifacts: [] };
  assert.equal((await validateCloseout(manifest)).status, "FAIL");
  manifest.artifacts.push({ path: path.join(root, "unknown.json"), class: "LOCAL" });
  assert.equal((await validateCloseout(manifest)).status, "PASS");
  await writeFile(path.join(root, "zero.txt"), "");
  manifest.artifacts.push({ path: path.join(root, "zero.txt"), class: "RAW", expiresAtGate: "G01" });
  const result = await validateCloseout(manifest); assert.equal(result.status, "FAIL"); assert.equal(result.expiredResidualBytes, 0); assert.equal(result.expiredResidualPaths.length, 1);
  manifest.artifacts[1] = { ...manifest.artifacts[1], carryOver: true, consumer: "MAC-02", expiresAtGate: "G02" };
  assert.equal((await validateCloseout(manifest)).status, "PASS");
  manifest.artifacts[1].expiresAtGate = "G01";
  await assert.rejects(validateCloseout(manifest), /later/);
});
test("RAW and BULK without an expiry or explicit later carry-over cannot pass closeout", async t => {
  const root = await directory(t, "ilv2-closeout-expiry-test-");
  const file = path.join(root, "residual.txt"); await writeFile(file, "remaining");
  for (const category of ["RAW", "BULK", "INPUT"]) {
    const manifest = { runRoot: root, gateId: "G01", artifacts: [{ path: file, class: category }] };
    await assert.rejects(validateCloseout(manifest), /expiry gate/);
    manifest.artifacts[0].expiresAtGate = "G02";
    await assert.rejects(validateCloseout(manifest), /carry-over/);
    manifest.artifacts[0].carryOver = true;
    await assert.rejects(validateCloseout(manifest), /consumer/);
    manifest.artifacts[0].consumer = "MAC-02";
    assert.equal((await validateCloseout(manifest)).status, "PASS");
  }
});
test("broker announces a new managed root before clone work, and SIGKILL cannot lose parent ownership", async t => {
  const root = await directory(t, "ilv2-broker-test-");
  await mkdir(path.join(root, "tmp")); await writeFile(path.join(root, "run-root.txt"), `${root}\n`);
  const module = pathToFileURL(fileURLToPath(new URL("./ilv2-mac-contracts.mjs", import.meta.url))).href;
  const code = `import {createRegisteredBrokerRoot} from ${JSON.stringify(module)}; await createRegisteredBrokerRoot('broker-child-'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ILV2_RUN_ROOT: root, TMPDIR: path.join(root, "tmp") } });
  const closed = new Promise(resolve => child.once("close", resolve));
  const output = await new Promise((resolve, reject) => { child.stderr.once("data", chunk => resolve(chunk.toString())); child.once("error", reject); });
  const created = JSON.parse(output.trim()); assert.equal(created.event, "broker-root-created"); assert.equal(created.parentRunRoot, root);
  child.kill("SIGKILL"); await closed;
  const children = await readdir(path.join(root, "tmp")); assert.equal(children.length, 1);
  assert.equal(created.root, path.join(root, "tmp", children[0]));
});
test("SIGKILL after directory creation but before announcement remains under the preregistered parent", async t => {
  const root = await directory(t, "ilv2-broker-preoutput-test-");
  await mkdir(path.join(root, "tmp")); await writeFile(path.join(root, "run-root.txt"), `${root}\n`);
  const module = new URL("./ilv2-mac-contracts.mjs", import.meta.url).href;
  const code = `import {createRegisteredBrokerRoot} from ${JSON.stringify(module)}; console.error=()=>{process.send('before-output');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}; await createRegisteredBrokerRoot('unannounced-child-');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ILV2_RUN_ROOT: root, TMPDIR: path.join(root, "tmp") }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  await new Promise(resolve => child.once("message", resolve));
  const children = await readdir(path.join(root, "tmp")); assert.equal(children.length, 1);
  child.kill("SIGKILL"); await closed;
  assert.equal(output, "");
  assert.equal((await readFile(path.join(root, "run-root.txt"), "utf8")).trim(), root);
});
test("duplicate CLI options are rejected", () => assert.throws(() => cliOptions(["--out", "one", "--out", "two"], ["--out"]), /invalid/));
