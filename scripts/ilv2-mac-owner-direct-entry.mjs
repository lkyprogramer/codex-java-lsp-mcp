// G01's bounded supervisor is used only for non-launchd primitive tests.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const launch = JSON.parse(readFileSync(path.join(process.argv[2], "native-launch.json"), "utf8"));
const child = spawn(launch.binary, launch.args, { env: process.env, stdio: ["ignore", "inherit", "inherit"] });
child.once("error", () => process.exit(2));
child.once("close", (code, signal) => process.exit(signal ? 2 : code));
