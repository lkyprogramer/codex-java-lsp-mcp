import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finishCloseout, validateCloseout } from "./ilv2-mac-closeout.mjs";
import { sha256 } from "./ilv2-mac-contracts.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-closeout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "run-root.txt"), root + "\n");
  for (const name of ["raw", "tmp", "carry", "closeout"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "raw", "result.json"), '{"actual":"evidence"}\n');
  await writeFile(path.join(root, "tmp", "bulk"), "temporary");
  await symlink(path.join(root, "tmp", "bulk"), path.join(root, "tmp", "internal-link"));
  await writeFile(path.join(root, "carry", "input"), "next consumer");
  return { runRoot: root, gateId: "G02C", closeoutDirectory: path.join(root, "closeout"), processes: [], launchdJobs: [], artifacts: [
    { path: path.join(root, "run-root.txt"), class: "LOCAL" },
    { path: path.join(root, "raw"), class: "RAW", recursive: true, expiresAtGate: "G02C" },
    { path: path.join(root, "tmp"), class: "BULK", recursive: true, expiresAtGate: "G02C" },
    { path: path.join(root, "carry"), class: "INPUT", recursive: true, carryOver: true, consumer: "MAC-03", expiresAtGate: "G03" },
    { path: path.join(root, "closeout"), class: "LOCAL", recursive: true }
  ] };
}

test("finish physically verifies one archive and removes only expired registered data", async t => {
  const manifest = await fixture(t);
  const result = await finishCloseout(manifest);
  assert.equal(result.status, "PASS"); assert.equal(result.gatePassClaim, false);
  assert.equal(result.archive.physicalVerification, "PASS"); assert.equal(result.archive.fileCount, 1);
  assert.equal(sha256(await readFile(result.archive.path)), result.archive.sha256);
  assert.equal((await validateCloseout(manifest)).status, "PASS");
  assert.equal(await readFile(path.join(manifest.runRoot, "carry/input"), "utf8"), "next consumer");
  assert.deepEqual(result.unregisteredPaths, []); assert.equal(result.expiredResidualBytes, 0);
  await assert.rejects(finishCloseout(manifest), /already exists/);
});

test("live process or unproven group prevents deletion and gate claims", async t => {
  const manifest = await fixture(t);
  manifest.processes = [{ pid: process.pid }];
  await assert.rejects(finishCloseout(manifest), /still alive/);
  assert.equal(await readFile(path.join(manifest.runRoot, "raw/result.json"), "utf8"), '{"actual":"evidence"}\n');
  manifest.processes = [{ pid: 1, pgid: 1, ownedGroup: true }];
  await assert.rejects(finishCloseout(manifest), /invalid owned pid/);
});

test("unknown files, external links and retained children cannot be pruned", async t => {
  const manifest = await fixture(t), root = manifest.runRoot;
  await writeFile(path.join(root, "unknown"), "unregistered");
  await assert.rejects(finishCloseout(manifest), /unregistered/);
  await rm(path.join(root, "unknown"));
  await symlink(os.tmpdir(), path.join(root, "tmp/escape"));
  await assert.rejects(finishCloseout(manifest), /outside managed root/);
  await rm(path.join(root, "tmp/escape"));
  manifest.artifacts.push({ path: path.join(root, "tmp/bulk"), class: "LOCAL" });
  await assert.rejects(finishCloseout(manifest), /overlapping/);
  assert.equal(await readFile(path.join(root, "tmp/bulk"), "utf8"), "temporary");
});
