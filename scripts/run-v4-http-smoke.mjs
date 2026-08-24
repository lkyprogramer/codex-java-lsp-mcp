#!/usr/bin/env node
// input: compiled dist/http-server.js plus an explicit loopback port.
// output: two sequential five-tool HTTP smokes against a just-started daemon.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.JAVA_LSP_HTTP_PORT || "38477");
const url = `http://127.0.0.1:${port}/mcp`;

async function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", code => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

async function waitForReady(server, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fetch(url, { method: "GET" });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  server.kill("SIGTERM");
  throw new Error("HTTP daemon did not accept connections");
}

async function main() {
  const server = spawn(process.execPath, [path.join(root, "dist", "http-server.js")], {
    cwd: root,
    env: { ...process.env, JAVA_LSP_HTTP_PORT: String(port) },
    stdio: "inherit"
  });
  try {
    await waitForReady(server);
    await run(process.execPath, [path.join(root, "dist", "smoke-http.js"), "--url", url]);
    await run(process.execPath, [path.join(root, "dist", "smoke-http.js"), "--url", url]);
  } finally {
    server.kill("SIGTERM");
    await new Promise(resolve => server.once("exit", resolve));
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
