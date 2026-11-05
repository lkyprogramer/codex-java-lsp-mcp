import { appendFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertOwnerLock, ownerChildStdio } from "../dist/mac-platform/owner-lock.js";

assertOwnerLock();
const root = process.argv[2], depth = Number(process.argv[3]);
const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
appendFileSync(path.join(root, "timeline.jsonl"), `${JSON.stringify({ type: "descendant", depth, pid: process.pid, pgid, at: performance.timeOrigin + performance.now() })}\n`);
if (depth > 1) spawn(process.execPath, [fileURLToPath(import.meta.url), root, String(depth - 1)], { env: process.env, stdio: ownerChildStdio(["ignore", "inherit", "inherit"]) });
setInterval(() => {}, 1000);
