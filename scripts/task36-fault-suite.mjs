#!/usr/bin/env node
// input: Existing compiled Task 36 fault-injection tests and an optional JSON output path.
// output: A SHA256-bound per-case manifest and aggregate gate result.
// pos: The single reproducible authority runner for Task 36 fault-injection acceptance.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectedSubtests } from "./task36-tap-evidence.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CASE_TIMEOUT_MS = 30_000;
const CASE_KILL_GRACE_MS = 250;

const REQUIRED_CASES = [
  {
    id: "concurrent-jdt-start",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^concurrent ensureStarted shares one transactional start$",
    expectedInvariant: "concurrent callers share exactly one transactional JDT start"
  },
  {
    id: "initialize-timeout",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^a short caller deadline does not cancel a shared JDT startup$",
    expectedInvariant: "one initialize caller timing out does not cancel shared startup"
  },
  {
    id: "child-exits-initialize",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^failed initialize disposes the attempt and permits a clean retry$",
    expectedInvariant: "an initialize failure disposes its child and permits a clean retry"
  },
  {
    id: "child-exits-ready",
    testFile: "dist/jdtls-session.test.js",
    testNamePattern: "^a READY child that exits marks the session BROKEN and restartable$",
    expectedInvariant: "a READY child exit marks the session BROKEN and restartable"
  },
  {
    id: "rg-partial-timeout",
    testFile: "dist/search/rg-runner.test.js",
    testNamePattern: "^rg timeout returns partial evidence but is not complete$",
    expectedInvariant: "timeout returns PARTIAL_TIMEOUT rather than COMPLETE"
  },
  {
    id: "rg-partial-limit",
    testFile: "dist/search/rg-runner.test.js",
    testNamePattern: "^the match cap makes the result PARTIAL_LIMIT$",
    expectedInvariant: "a match limit returns PARTIAL_LIMIT rather than COMPLETE",
    accepted_variance: "limit seam only; this does not claim a real OS ENOBUFS condition"
  },
  {
    id: "java-index-crash",
    testFile: "dist/java-index/sql/sql-client-lifecycle.test.js",
    testNamePattern: "^failed sibling reconcile marks DEGRADED$",
    expectedInvariant: "a worker crash rejects pending requests and degrades the client"
  },
  {
    id: "snapshot-corruption",
    testFile: "dist/java-index/sql/sql-client-lifecycle.test.js",
    testNamePattern: "^failed sibling copy does not leave dest and allows a later open$",
    expectedInvariant: "a corrupt sibling snapshot falls back to an empty OPEN store"
  },
  {
    id: "watcher-error",
    testFile: "dist/repo-change-coordinator.test.js",
    testNamePattern: "^degrade catches an async listener rejection and records the listener failure$",
    expectedInvariant: "a watcher listener error is recorded without escaping the coordinator"
  },
  {
    id: "dirty-reconcile",
    testFile: "dist/repo-runtime-manager.test.js",
    testNamePattern: "^reconcileIfDirty leaves dirty set when reconcile fails, without failing the request$",
    expectedInvariant: "failed dirty reconciliation remains dirty for a later retry"
  },
  {
    id: "outside-repo-result",
    testFile: "dist/semantic-location.test.js",
    testNamePattern: "^semantic locations outside canonical repo root are rejected$",
    expectedInvariant: "outside-repository semantic results are rejected"
  },
  {
    id: "semantic-one-waiter-cancel",
    testFile: "dist/semantic-gateway.test.js",
    testNamePattern: "^one caller deadline does not cancel another caller sharing backend work$",
    expectedInvariant: "one cancelled semantic waiter does not cancel shared backend work"
  },
  {
    id: "semantic-all-cancel",
    testFile: "dist/semantic-gateway.test.js",
    testNamePattern: "^the last hierarchy waiter returns without post-deadline settlement grace when it aborts the transport$",
    expectedInvariant: "the final cancelled waiter aborts backend transport, returns at its own deadline, and cannot populate the complete cache"
  }
];

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();

  const cases = [];
  for (const definition of REQUIRED_CASES) {
    cases.push(await runCase(definition, cli.caseTimeoutMs));
  }

  const payload = {
    schemaVersion: 1,
    manifest: {
      authority: "existing-dist-tests",
      runner: "node --test",
      caseTimeoutMs: cli.caseTimeoutMs,
      generatedAt: new Date().toISOString()
    },
    gate: {
      requiredCaseCount: REQUIRED_CASES.length,
      passed: cases.every(item => item.status === "passed")
    },
    cases
  };

  if (cli.output) await writeJsonAtomically(cli.output, payload);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!payload.gate.passed) process.exitCode = 1;
}

async function runCase(definition, timeoutMs) {
  const args = ["--test", `--test-name-pattern=${definition.testNamePattern}`, definition.testFile];
  const result = await spawnAndCapture(process.execPath, args, timeoutMs);
  const tapOutput = Buffer.concat([result.stdout, result.stderr]);
  const testCount = tapCount(tapOutput, "tests");
  const passedTestCount = tapCount(tapOutput, "pass");
  const failedTestCount = tapCount(tapOutput, "fail");
  const selectedTests = selectedSubtests(tapOutput.toString("utf8"), definition.testNamePattern);
  const selectedTestNames = selectedTests.map(test => test.name);
  const status = result.exitCode === 0
    && result.signal === null
    && selectedTests.length === 1
    && selectedTests.every(test => test.status === "passed" && test.directive === undefined)
    && testCount === 1
    && passedTestCount === 1
    && failedTestCount === 0
    ? "passed"
    : "failed";

  return {
    ...definition,
    command: process.execPath,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    testCount,
    passedTestCount,
    failedTestCount,
    selectedTestCount: selectedTests.length,
    selectedTestNames,
    selectedTestResults: selectedTests,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    status
  };
}

function spawnAndCapture(command, args, timeoutMs) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { cwd: SCRIPT_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let spawnError;
    let timedOut = false;
    let killTimer;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), CASE_KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", error => { spawnError = error; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (spawnError) stderr.push(Buffer.from(`${spawnError.message}\n`));
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    });
  });
}

function tapCount(output, label) {
  const matches = [...output.toString("utf8").matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, "gm"))];
  return matches.length === 0 ? null : Number(matches.at(-1)[1]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomically(file, value) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseCli(argv) {
  let output;
  let caseTimeoutMs = DEFAULT_CASE_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--output") {
      output = argv[++index];
      if (!output || output.startsWith("--")) throw new Error("--output requires a file path");
      continue;
    }
    if (argument === "--case-timeout-ms") {
      const raw = argv[++index];
      caseTimeoutMs = Number(raw);
      if (!Number.isInteger(caseTimeoutMs) || caseTimeoutMs <= 0) {
        throw new Error("--case-timeout-ms requires a positive integer");
      }
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { help: false, output, caseTimeoutMs };
}

function printUsage() {
  console.log("usage: node scripts/task36-fault-suite.mjs [--output <result.json>] [--case-timeout-ms <ms>]");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
