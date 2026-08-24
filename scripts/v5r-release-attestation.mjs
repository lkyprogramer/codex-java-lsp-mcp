#!/usr/bin/env node
// input: Gate profiles, agent-trace blocker, leave-one-repo-out folds, git identity.
// output: Phase 7 release attestation. mergeToMain is false until live TaskSuccess exists.
// pos: V5R Phase 7. Never invents TaskSuccess=0. Never merges main.
import { blockedExternalResult, parseAgentTraceCli, runAgentTraceMatrix } from "./run-agent-trace-matrix.mjs";
import { GATE_PROFILES } from "./run-v4-gates.mjs";
import { leaveOneRepoOutManifest } from "./leave-one-repo-out.mjs";

export const V5R_RELEASE_ATTESTATION_SCHEMA = "v5r-release-attestation/v1";
export const ATTESTED_PUBLIC_TOOLS = ["java_status", "java_impact", "java_symbol", "java_diagnostics", "java_runtime"];

export function mergeToMainAllowed(attestation) {
  return attestation.liveTrace?.status === "CALIBRATED_LIVE"
    && attestation.taskSuccess?.status === "MEASURED"
    && attestation.fourthRepo?.frozen === true
    && attestation.releaseGates === "green";
}

export function buildReleaseAttestation(input) {
  const attestation = {
    schemaVersion: V5R_RELEASE_ATTESTATION_SCHEMA,
    dated: input.dated,
    head: input.head,
    commitTree: input.commitTree,
    liveTrace: input.liveTrace,
    taskSuccess: input.liveTrace?.taskSuccess ?? { status: "UNMEASURED" },
    modelUsage: input.liveTrace?.modelUsage ?? { status: "UNMEASURED" },
    fourthRepo: input.fourthRepo,
    leaveOneRepoOut: input.leaveOneRepoOut,
    gateProfiles: {
      prSteps: GATE_PROFILES.pr.steps.length,
      nightlySteps: GATE_PROFILES.nightly.steps.length,
      releaseSteps: GATE_PROFILES.release.steps.length,
      profilesDiffer: JSON.stringify(GATE_PROFILES.pr.steps) !== JSON.stringify(GATE_PROFILES.nightly.steps)
        && JSON.stringify(GATE_PROFILES.nightly.steps) !== JSON.stringify(GATE_PROFILES.release.steps)
    },
    publicTools: [...ATTESTED_PUBLIC_TOOLS],
    releaseGates: input.releaseGates ?? "offline-only",
    rollback: {
      dualWorkerSweep: "deleted-on-FAIL",
      mergeToMain: false,
      continuationLive: "UNMEASURED"
    },
    mergeToMain: false
  };
  if (mergeToMainAllowed(attestation)) {
    throw new Error("mergeToMainAllowed is true only after CALIBRATED_LIVE TaskSuccess; do not set mergeToMain from this helper");
  }
  return attestation;
}

export async function attestV5rRelease(env = process.env) {
  const liveTrace = await runAgentTraceMatrix(parseAgentTraceCli([], env));
  const leaveOne = leaveOneRepoOutManifest();
  return buildReleaseAttestation({
    dated: "2026-08-19",
    liveTrace,
    fourthRepo: leaveOne.fourthRepo,
    leaveOneRepoOut: {
      schemaVersion: leaveOne.schemaVersion,
      folds: leaveOne.folds.length,
      matrix: "UNMEASURED"
    },
    releaseGates: "offline-only"
  });
}

export { blockedExternalResult, GATE_PROFILES };
