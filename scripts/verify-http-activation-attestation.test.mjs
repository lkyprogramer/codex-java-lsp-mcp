import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyHttpActivationAttestation } from "./verify-http-activation-attestation.mjs";

test("HTTP activation attestation is build and instance bound", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-activation-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = path.join(directory, "attestation.json");
  await writeFile(evidence, JSON.stringify({
    schemaVersion: 1,
    buildSha: "build-a",
    instanceId: "managed-a",
    attestedAt: new Date().toISOString(),
    codexCli: { taskId: "cli-task", allSevenTools: true, restartRecovery: true, crashRecovery: true },
    codexDesktop: { taskId: "desktop-task", allSevenTools: true, restartRecovery: true, crashRecovery: true, idleWindowRecovery: true },
    oldStdioOwnersCleared: true,
    worktreeIsolationVerified: true
  }));
  assert.equal(
    verifyHttpActivationAttestation(evidence, { buildSha: "build-a", instanceId: "managed-a" }).buildSha,
    "build-a"
  );
  assert.throws(
    () => verifyHttpActivationAttestation(evidence, { buildSha: "build-b", instanceId: "managed-a" }),
    /not bound to the current daemon build and instance/
  );
});

test("HTTP activation attestation rejects missing host evidence", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-activation-gate-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = path.join(directory, "attestation.json");
  await writeFile(evidence, JSON.stringify({
    schemaVersion: 1,
    buildSha: "build-a",
    instanceId: "managed-a",
    attestedAt: new Date().toISOString(),
    codexCli: { taskId: "cli-task", allSevenTools: true, restartRecovery: true, crashRecovery: true },
    codexDesktop: { taskId: "desktop-task", allSevenTools: true, restartRecovery: false, crashRecovery: true, idleWindowRecovery: true },
    oldStdioOwnersCleared: false,
    worktreeIsolationVerified: false
  }));
  assert.throws(
    () => verifyHttpActivationAttestation(evidence, { buildSha: "build-a", instanceId: "managed-a" }),
    /Codex Desktop activation evidence/
  );
});
