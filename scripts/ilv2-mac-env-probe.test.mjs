import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyTccLog, pathChecks, probeLaunchd } from "./ilv2-mac-env-probe.mjs";

test("TCC prompts are attributed only to this job's subjects", () => {
  const binary = "/w/runs/x/candidate/dist/native/ilv2-mac";
  const text = [
    `tccd[1]: [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=57041.203, service=kTCCServiceSystemPolicyDocumentsFolder, subject=${binary},`,
    "tccd[1]: [com.apple.TCC:access] AUTHREQ_PROMPTING: msgID=1.1, service=kTCCServiceSystemPolicyDownloadsFolder, subject=/Applications/Other.app,",
    "tccd[1]: [com.apple.TCC:access] REQUEST: unrelated",
    `tccd[1]: [com.apple.TCC:access] AUTHREQ_RESULT: msgID=9.9, authValue=2, service=kTCCServiceSystemPolicyDocumentsFolder, subject=${binary},`
  ].join("\n");
  const own = classifyTccLog(text, [binary]);
  assert.equal(own.status, "BLOCKED_ENV_TCC");
  assert.deepEqual(own.services, ["kTCCServiceSystemPolicyDocumentsFolder"]);
  assert.equal(own.unattributedCount, 1);
  // An allowed access (authValue=2) is not a prompt, and a PID token is delimited.
  assert.equal(classifyTccLog(`AUTHREQ_PROMPTING: pid=2310, service=kTCCServiceSystemPolicyDocumentsFolder`, ["pid=231,"]).status, null);
  const other = classifyTccLog(text, ["/w/runs/other/ilv2-mac", null]);
  assert.equal(other.status, null);
  assert.equal(other.unattributedCount, 2);
});

test("path checks flag managed paths inside protected folders and skip unset ones", () => {
  const rows = pathChecks({ workRoot: "/h/Developer/ilv2-work", runRoot: "/h/Documents/evidence/run", tmpdir: undefined }, "/h");
  assert.deepEqual(rows.map(row => [row.name, row.protectedFolder]), [["workRoot", null], ["runRoot", "/h/Documents"]]);
});

test("isolated launchd owner launcher reaches frozen Node and reads within budget", { timeout: 30000 }, async () => {
  const target = path.join(os.tmpdir(), `env-probe-target-${process.pid}.txt`);
  await writeFile(target, "probe\n");
  const result = await probeLaunchd({ timeoutMs: 5000, readTarget: target });
  assert.equal(result.status, "READY", JSON.stringify(result));
  assert.equal(result.execPath, process.execPath);
  assert.equal(result.read.type, "read");
  assert.equal(result.read.bytes, 6);
  assert.ok(result.readyMs < 5000);
  assert.equal(result.closeout.absent, true);
  assert.deepEqual(result.closeout.residualProcesses, []);
});
