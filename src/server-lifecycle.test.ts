import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  McpServerLifecycle,
  type ServerShutdownReason
} from "./server-lifecycle.js";

test("transport end and close share one shutdown", async () => {
  const stdin = new PassThrough();
  const shutdownReasons: ServerShutdownReason[] = [];
  const exitCodes: number[] = [];
  const lifecycle = new McpServerLifecycle({
    stdin,
    shutdown: async reason => { shutdownReasons.push(reason); },
    exit: code => { exitCodes.push(code); }
  });

  lifecycle.start();
  stdin.emit("end");
  stdin.emit("close");
  await lifecycle.shutdown("sigterm");

  assert.deepEqual(shutdownReasons, ["stdio_end"]);
  assert.deepEqual(exitCodes, [0]);
});

test("an open stdio connection never self-shuts down", async () => {
  const shutdownReasons: ServerShutdownReason[] = [];
  const lifecycle = new McpServerLifecycle({
    stdin: new PassThrough(),
    shutdown: async reason => { shutdownReasons.push(reason); },
    exit: () => undefined
  });

  lifecycle.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(shutdownReasons, []);
});

test("stdio subprocess survives the retired idle TTL and reaps its child only after stdin closes", { timeout: 10000 }, async () => {
  const lifecycleUrl = new URL("./server-lifecycle.js", import.meta.url).href;
  const script = `
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { McpServerLifecycle } from ${JSON.stringify(lifecycleUrl)};
    const managedChild = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    const keepAlive = setInterval(() => undefined, 1000);
    const lifecycle = new McpServerLifecycle({
      stdin: process.stdin,
      shutdown: async reason => {
        managedChild.kill("SIGTERM");
        await once(managedChild, "exit");
        clearInterval(keepAlive);
        console.error("SHUTDOWN:" + reason);
      }
    });
    process.stdin.resume();
    lifecycle.start();
    console.log("READY:" + managedChild.pid);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, JAVA_LSP_SERVER_IDLE_TTL_MS: "100" }
  });
  let managedPid: number | undefined;
  let stderr = "";
  try {
    managedPid = await waitForReady(child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });

    await delay(350);
    assert.equal(child.exitCode, null, "an open stdio transport must outlive the retired server idle TTL");

    child.stdin.end();
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.match(stderr, /SHUTDOWN:stdio_end/);
    assert.throws(() => process.kill(managedPid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
    if (managedPid !== undefined) {
      try {
        process.kill(managedPid, "SIGKILL");
      } catch {
        // Already reaped by the lifecycle under test.
      }
    }
  }
});

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<number> {
  child.stdout.setEncoding("utf8");
  let output = "";
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for lifecycle subprocess readiness.")), 5000);
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/READY:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code, signal) => {
      if (!/READY:\d+/.test(output)) {
        clearTimeout(timer);
        reject(new Error(`Lifecycle subprocess exited before readiness (code=${code}, signal=${signal}).`));
      }
    });
  });
}
