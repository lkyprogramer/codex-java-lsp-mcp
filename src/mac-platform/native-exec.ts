import { spawn } from "node:child_process";
import { ownerChildStdio } from "./owner-lock.js";

/** Each native process is bounded separately; settle only after actual close. */
export function executeMacNativeProcess(file: string, args: string[], { timeout = 5000, maxBuffer = 64 * 1024 } = {}): Promise<{ stdout: string; stderr: string }> {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 5000 || !Number.isInteger(maxBuffer) || maxBuffer <= 0 || maxBuffer > 64 * 1024) throw new Error("bounded native execution required");
  const child = spawn(file, args, { stdio: ownerChildStdio(["ignore", "pipe", "pipe"]) });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outBytes = 0, errBytes = 0;
    let failure: Error | undefined;
    const terminate = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => terminate(new Error("native process deadline exceeded")), timeout);
    child.stdout!.on("data", (bytes: Buffer) => {
      outBytes += bytes.length;
      if (outBytes > maxBuffer) terminate(new Error("native stdout exceeds limit"));
      else stdout.push(bytes);
    });
    child.stderr!.on("data", (bytes: Buffer) => {
      errBytes += bytes.length;
      if (errBytes > maxBuffer) terminate(new Error("native stderr exceeds limit"));
      else stderr.push(bytes);
    });
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (failure || code !== 0) reject(Object.assign(failure ?? new Error(`native process exited ${code ?? signal}`), output));
      else resolve(output);
    });
  });
}
