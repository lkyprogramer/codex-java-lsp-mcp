// input: A human-recorded Codex CLI/Desktop release-gate attestation and the installed daemon identity.
// output: Exit 0 only when the attestation is current and bound to this exact release.
// pos: Production transport-switch gate; a health check alone cannot prove host-task compatibility.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_ATTESTATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function verifyHttpActivationAttestation(filePath, expected) {
  if (!path.isAbsolute(filePath)) {
    throw new Error("HTTP activation attestation path must be absolute.");
  }
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`HTTP activation attestation does not exist: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`HTTP activation attestation must be a regular file: ${filePath}`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`HTTP activation attestation is not valid JSON: ${filePath}`);
  }
  if (value?.schemaVersion !== 1) {
    throw new Error("HTTP activation attestation must use schemaVersion=1.");
  }
  if (value.buildSha !== expected.buildSha || value.instanceId !== expected.instanceId) {
    throw new Error("HTTP activation attestation is not bound to the current daemon build and instance.");
  }
  verifyTaskGate(value.codexCli, "Codex CLI");
  verifyTaskGate(value.codexDesktop, "Codex Desktop", { requireIdleWindow: true });
  if (value.oldStdioOwnersCleared !== true || value.worktreeIsolationVerified !== true) {
    throw new Error("HTTP activation attestation must confirm old stdio-owner clearance and worktree isolation.");
  }
  const attestedAt = Date.parse(value.attestedAt);
  if (!Number.isFinite(attestedAt) || attestedAt > Date.now() + 5 * 60 * 1000 || Date.now() - attestedAt > MAX_ATTESTATION_AGE_MS) {
    throw new Error("HTTP activation attestation must contain an attestedAt timestamp no older than seven days.");
  }
  return value;
}

function verifyTaskGate(gate, label, options = {}) {
  if (!gate || typeof gate.taskId !== "string" || !gate.taskId.trim()
    || gate.allSevenTools !== true || gate.restartRecovery !== true || gate.crashRecovery !== true
    || (options.requireIdleWindow && gate.idleWindowRecovery !== true)) {
    const requirements = options.requireIdleWindow
      ? "taskId, allSevenTools=true, restartRecovery=true, crashRecovery=true, and idleWindowRecovery=true"
      : "taskId, allSevenTools=true, restartRecovery=true, and crashRecovery=true";
    throw new Error(`${label} activation evidence must include ${requirements}.`);
  }
}

function main(args) {
  if (args.length !== 3) {
    throw new Error("Usage: verify-http-activation-attestation.mjs <attestation.json> <build-sha> <instance-id>");
  }
  verifyHttpActivationAttestation(args[0], { buildSha: args[1], instanceId: args[2] });
}

if (process.argv[1]?.endsWith("verify-http-activation-attestation.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("[codex-java-lsp] HTTP activation gate failed", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
