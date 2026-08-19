import assert from "node:assert/strict";
import test from "node:test";
import { blockedExternalResult } from "./run-agent-trace-matrix.mjs";
import { PUBLIC_JAVA_TOOLS } from "../dist/mcp-server-factory.js";
import {
  ATTESTED_PUBLIC_TOOLS,
  attestV5rRelease,
  buildReleaseAttestation,
  mergeToMainAllowed
} from "./v5r-release-attestation.mjs";

test("release attestation keeps TaskSuccess UNMEASURED and mergeToMain false", async () => {
  const attestation = await attestV5rRelease({});
  assert.equal(attestation.liveTrace.status, "BLOCKED_EXTERNAL");
  assert.equal(attestation.taskSuccess.status, "UNMEASURED");
  assert.equal(attestation.modelUsage.status, "UNMEASURED");
  assert.equal(attestation.taskSuccess.status === 0, false);
  assert.equal(attestation.mergeToMain, false);
  assert.equal(mergeToMainAllowed(attestation), false);
  assert.equal(attestation.fourthRepo.frozen, false);
  assert.equal(attestation.leaveOneRepoOut.matrix, "UNMEASURED");
  assert.equal(attestation.gateProfiles.profilesDiffer, true);
  assert.equal(ATTESTED_PUBLIC_TOOLS.includes("java_context"), false);
  assert.deepEqual(ATTESTED_PUBLIC_TOOLS, [...PUBLIC_JAVA_TOOLS]);
});

test("mergeToMainAllowed does not treat UNMEASURED or 0 as a pass", () => {
  const blocked = blockedExternalResult();
  assert.equal(mergeToMainAllowed({
    liveTrace: blocked,
    taskSuccess: { status: "UNMEASURED" },
    fourthRepo: { frozen: false },
    releaseGates: "offline-only"
  }), false);
  assert.equal(mergeToMainAllowed({
    liveTrace: { status: "CALIBRATED_LIVE" },
    taskSuccess: { status: 0 },
    fourthRepo: { frozen: true },
    releaseGates: "green"
  }), false);
});

test("buildReleaseAttestation never sets mergeToMain true", () => {
  const attestation = buildReleaseAttestation({
    dated: "2026-08-19",
    liveTrace: blockedExternalResult(),
    fourthRepo: { status: "UNMEASURED", frozen: false },
    leaveOneRepoOut: { folds: 3, matrix: "UNMEASURED" }
  });
  assert.equal(attestation.mergeToMain, false);
  assert.equal(attestation.rollback.mergeToMain, false);
});
