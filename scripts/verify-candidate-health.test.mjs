import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./verify-candidate-health.mjs", import.meta.url));

function check(payload, expectedInstanceId = "candidate-expected") {
  return spawnSync(process.execPath, [scriptPath, expectedInstanceId], {
    encoding: "utf8",
    input: payload,
  });
}

test("candidate readiness accepts only the candidate's own healthy payload", () => {
  const accepted = check(JSON.stringify({ status: "ok", instanceId: "candidate-expected" }));
  assert.equal(accepted.status, 0, accepted.stderr);

  const staleCandidate = check(JSON.stringify({ status: "ok", instanceId: "stale-candidate" }));
  assert.equal(staleCandidate.status, 1, staleCandidate.stderr);

  const malformed = check("not-json");
  assert.equal(malformed.status, 1, malformed.stderr);
});
