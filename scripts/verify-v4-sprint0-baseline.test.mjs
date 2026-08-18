import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  V4_SPRINT0_IDENTITY_COMMIT,
  V4_SPRINT0_PRODUCTION_TREE,
  verifyV4Sprint0Baseline
} from "./verify-v4-sprint0-baseline.mjs";

test("Sprint0' verifier accepts a non-empty hash-bound manifest", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-sprint0-ok-"));
  const bundle = await writeManifest(root, {});
  const result = verifyV4Sprint0Baseline(bundle.manifestFile);
  assert.equal(result.passed, true);
  assert.equal(result.identity.commit, V4_SPRINT0_IDENTITY_COMMIT);
  assert.ok(result.artifacts.every(item => item.bytes > 0));
});

test("Sprint0' verifier rejects the historical 0-byte baseline failure mode", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-sprint0-empty-"));
  const bundle = await writeManifest(root, { emptySummary: true });
  assert.throws(() => verifyV4Sprint0Baseline(bundle.manifestFile), /zero-byte artifacts are forbidden/);
});

test("Sprint0' verifier rejects SHA drift and missing campaigns", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-sprint0-tamper-"));
  const bundle = await writeManifest(root, {});
  await writeFile(path.join(root, "summaries", "bytes.json"), `${JSON.stringify({ tampered: true }, null, 2)}\n`);
  assert.throws(() => verifyV4Sprint0Baseline(bundle.manifestFile), /hash\/bytes mismatch/);

  const missing = await writeManifest(path.join(root, "missing"), { dropCampaign: "progressive" });
  assert.throws(() => verifyV4Sprint0Baseline(missing.manifestFile), /missing campaigns: progressive/);
});

test("Sprint0' verifier accepts a high-load first-touch sample when memory cleared the floor", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-sprint0-noisy-"));
  const bundle = await writeManifest(root, {
    hostQuiet: {
      loadavg1: 30,
      logicalCpus: 10,
      perCpu: 3,
      maxLoadavgPerCpu: 1.2,
      memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, minAvailableBytes: 4 * 1024 ** 3 },
      passed: true
    }
  });
  assert.equal(verifyV4Sprint0Baseline(bundle.manifestFile).passed, true);
});

test("Sprint0' verifier rejects first-touch captured below the memory floor", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-sprint0-lowmem-"));
  const bundle = await writeManifest(root, {
    hostQuiet: {
      loadavg1: 2,
      logicalCpus: 10,
      perCpu: 0.2,
      maxLoadavgPerCpu: 1.2,
      memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 1024, minAvailableBytes: 4 * 1024 ** 3 },
      passed: true
    }
  });
  assert.throws(() => verifyV4Sprint0Baseline(bundle.manifestFile), /below the available-memory floor/);
});

async function writeManifest(root, {
  emptySummary = false,
  dropCampaign,
  hostQuiet = {
    loadavg1: 2,
    logicalCpus: 10,
    perCpu: 0.2,
    maxLoadavgPerCpu: 1.2,
    memory: { totalBytes: 32 * 1024 ** 3, availableBytes: 8 * 1024 ** 3, minAvailableBytes: 4 * 1024 ** 3 },
    passed: true
  }
} = {}) {
  const summaryDir = path.join(root, "summaries");
  await mkdir(summaryDir, { recursive: true });
  const campaigns = {};
  for (const name of ["cold-matrix", "bytes", "progressive", "first-touch"]) {
    if (name === dropCampaign) continue;
    const relative = path.join("summaries", `${name}.json`);
    const payload = emptySummary && name === "bytes" ? "" : `${JSON.stringify({ campaign: name, ok: true }, null, 2)}\n`;
    await writeFile(path.join(root, relative), payload);
    campaigns[name] = {
      summaries: [descriptor(relative, payload)],
      ...(name === "first-touch" ? { hostQuiet } : {})
    };
  }
  const manifest = {
    schemaVersion: "v4-sprint0-baseline/v1",
    verifierVersion: 1,
    identity: {
      commit: V4_SPRINT0_IDENTITY_COMMIT,
      productionTree: V4_SPRINT0_PRODUCTION_TREE,
      measuredCommit: "eeb6331aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    campaigns
  };
  const manifestFile = path.join(root, "v4-sprint0-manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifestFile };
}

function descriptor(file, payload) {
  const bytes = Buffer.from(payload);
  return {
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
