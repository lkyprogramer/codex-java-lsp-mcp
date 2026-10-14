// Bounded test supervisor. No service starts before transactional registration.
import { spawn } from "node:child_process";
import { requireValue } from "./ilv2-mac-contracts.mjs";

let child;
let stopping = false;
let timer;
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) { process.exit(0); return; }
  // The launcher is the leader of this run's dedicated group. Keep it alive
  // through escalation even if the direct service exits before its descendants.
  process.kill(-process.pid, "SIGTERM");
  timer = setTimeout(() => process.kill(-process.pid, "SIGKILL"), 1500);
}
requireValue(typeof process.send === "function", "fixture launcher requires a controller IPC channel");
process.once("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.once("message", message => {
  if (stopping) return;
  try {
    requireValue(message.type === "start" && Array.isArray(message.argv) && message.argv[0] === process.execPath, "invalid fixture launch commit");
    child = spawn(message.argv[0], message.argv.slice(1), { env: message.env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", () => { process.exitCode = 2; stop(); });
    child.once("close", () => stop());
    child.once("spawn", () => {
      if (!process.connected) { stop(); return; }
      process.send({ type: "started", pid: child.pid, pgid: process.pid }, error => { if (error) stop(); });
    });
  } catch { process.exit(2); }
});
