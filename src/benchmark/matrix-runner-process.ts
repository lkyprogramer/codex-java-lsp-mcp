// input: none (module-level factory).
// output: a real, spawn-backed CommandRunner for matrix-runner.ts.
// pos: Task 32 Step 6. Kept separate from matrix-runner.ts so that file stays free of
//      node:child_process - matrix-runner.test.ts imports only the pure module and never
//      pulls in process-spawning code, matching the plan's "no real business repo or JDT
//      is required" test requirement.
import { spawn } from "node:child_process";
import type { CommandRunner } from "./matrix-runner.js";

export const spawnCommandRunner: CommandRunner = (command, args, env) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", chunk => stdoutChunks.push(chunk));
  child.stderr.on("data", chunk => stderrChunks.push(chunk));
  child.once("error", reject);
  child.once("exit", code => {
    resolve({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode: code ?? 1
    });
  });
});
