// Real process fixture for controller death at registration/launch boundaries.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFixtureSlot, fixtureQuotaFile } from "../../scripts/ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT } from "../../scripts/ilv2-mac-contracts.mjs";

const [root, phase, portText, behavior = "correct"] = process.argv.slice(2);
// Keep the controlled fault window alive even when only a DB transaction exists.
process.on("message", () => {});
const sharedLease = await acquireFixtureSlot(MAC_WORK_ROOT);
const lease = await acquireFixtureSlot(root);
if (phase === "uncommitted-quota") {
  await lease.release();
  const db = new DatabaseSync(fixtureQuotaFile(root));
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO fixture_slots(slot,token,pid) VALUES(0,'uncommitted',?)").run(process.pid);
  process.send({ phase });
  await new Promise(() => {});
}
const cwd = path.join(root, "service"); await mkdir(cwd);
const launcher = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/ilv2-mac-fixture-launch.mjs", import.meta.url))], { cwd, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
await once(launcher, "spawn");
if (phase === "before-registration") {
  process.send({ phase, launcherPid: launcher.pid });
  await new Promise(() => {});
}
if (phase === "uncommitted-registration") {
  const db = new DatabaseSync(fixtureQuotaFile(root)); db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE fixture_slots SET child_pid=?,pgid=? WHERE slot=?").run(launcher.pid, launcher.pid, lease.slot);
  process.send({ phase, launcherPid: launcher.pid });
  await new Promise(() => {});
}
await lease.registerChild(launcher.pid, launcher.pid);
await sharedLease.registerChild(launcher.pid, launcher.pid);
if (phase === "before-start") {
  process.send({ phase, launcherPid: launcher.pid });
  await new Promise(() => {});
}
const started = new Promise(resolve => launcher.once("message", resolve));
launcher.send({ type: "start", argv: [process.execPath, fileURLToPath(new URL("./fake-driver.mjs", import.meta.url)), portText, behavior],
  env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, ILV2_EXPECTED_IDENTITY: JSON.stringify({ instanceId: "fixture-crash-window", contractVersion: "ilv2-mac-run/v1" }) } });
const service = await started;
process.send({ phase, launcherPid: launcher.pid, servicePid: service.pid });
await new Promise(() => {});
