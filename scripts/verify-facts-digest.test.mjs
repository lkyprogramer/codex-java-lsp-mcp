import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFactsDigestCli } from "./verify-facts-digest.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "verify-facts-digest.mjs");

test("parseFactsDigestCli reads three-repo flags and timeout", () => {
  const cli = parseFactsDigestCli([
    "--lishuedu", "/tmp/l",
    "--cipherlink", "/tmp/c",
    "--exam-parent-v3", "/tmp/e",
    "--output", "{state}/digest.json",
    "--timeout-ms", "90000"
  ]);
  assert.equal(cli.help, false);
  assert.equal(cli.timeoutMs, 90_000);
  assert.equal(cli.output, "{state}/digest.json");
  assert.equal(cli.repositories.lishuedu, "/tmp/l");
  assert.equal(cli.repositories.cipherlink, "/tmp/c");
  assert.equal(cli.repositories["exam-parent-v3"], "/tmp/e");
});

test("parseFactsDigestCli rejects a dangling flag", () => {
  assert.throws(() => parseFactsDigestCli(["--output"]), /invalid argument/);
});

test("verify-facts-digest refuses to run outside isolated validation", async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--help"], {
      env: { ...process.env, JAVA_LSP_ISOLATED_VALIDATION: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  // --help returns before the isolation gate.
  assert.equal(result.code, 0);

  const blocked = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      script,
      "--lishuedu", "/tmp/l",
      "--cipherlink", "/tmp/c",
      "--exam-parent-v3", "/tmp/e",
      "--output", "/tmp/out.json"
    ], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "JAVA_LSP_ISOLATED_VALIDATION")),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /isolated validation/);
});
