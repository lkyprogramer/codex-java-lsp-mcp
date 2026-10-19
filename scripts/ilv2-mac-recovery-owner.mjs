// MAC-09 launchd entry (createOwnerFixture `entry`): the real HTTP daemon, dist/http-server.js,
// under the owner launcher. Each incarnation first records `ready` with whether any earlier
// incarnation's process group was still alive when this one got the owner lock.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.argv[2];
const options = JSON.parse(readFileSync(path.join(root, "options.json"), "utf8"));
const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
let earlier = [];
try { earlier = readFileSync(path.join(root, "timeline.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === "ready"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const alive = group => { try { process.kill(-group, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
appendFileSync(path.join(root, "timeline.jsonl"), `${JSON.stringify({ type: "ready", pid: process.pid, pgid, at: performance.timeOrigin + performance.now(),
  previousGroupsAlive: earlier.filter(row => alive(row.pgid)).map(row => row.pgid) })}\n`);
Object.assign(process.env, options.daemonEnv);
// The daemon starts only when it is the entry module (argv[1] ends with /http-server.js).
process.argv[1] = path.join(options.sourceRoot, "dist/http-server.js");
await import(process.argv[1]);
