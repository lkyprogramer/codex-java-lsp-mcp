import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule, parseCli, runAttempt, runStartedAttempt, withFreshWorkspace } from "./semantic-first-touch.js";
import * as semanticFirstTouch from "./semantic-first-touch.js";
import type { JdtlsSession } from "../jdtls-session.js";

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 }
};

test("isMainModule recognizes an entrypoint reached through a filesystem symlink", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "first-touch-main-"));
  const realDirectory = path.join(directory, "real");
  const aliasDirectory = path.join(directory, "alias");
  const entrypoint = path.join(realDirectory, "semantic-first-touch.js");
  mkdirSync(realDirectory);
  writeFileSync(entrypoint, "// fixture\n");
  symlinkSync(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");

  try {
    assert.equal(isMainModule(path.join(aliasDirectory, "semantic-first-touch.js"), pathToFileURL(entrypoint).toString()), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parseCli accepts a full flag set and applies defaults for --prepare/--runs/--timeout-ms", () => {
  const cli = parseCli([
    "--repo-root", "/tmp/repo",
    "--project-id", "cipherlink",
    "--workspace-state", "fresh",
    "--operation", "references"
  ]);
  assert.deepEqual(cli, {
    repoRoot: "/tmp/repo",
    projectId: "cipherlink",
    workspaceState: "fresh",
    prepare: "none",
    operation: "references",
    runs: 10,
    timeoutMs: 60000,
    output: undefined
  });
});

test("parseCli accepts every documented flag explicitly", () => {
  const cli = parseCli([
    "--repo-root", "/tmp/repo",
    "--project-id", "lishuedu",
    "--workspace-state", "reused",
    "--prepare", "progress-idle",
    "--operation", "type-hierarchy",
    "--runs", "5",
    "--timeout-ms", "15000",
    "--output", "out.json"
  ]);
  assert.deepEqual(cli, {
    repoRoot: "/tmp/repo",
    projectId: "lishuedu",
    workspaceState: "reused",
    prepare: "progress-idle",
    operation: "type-hierarchy",
    runs: 5,
    timeoutMs: 15000,
    output: "out.json"
  });
});

test("parseCli rejects a missing required flag", () => {
  assert.throws(
    () => parseCli(["--project-id", "cipherlink", "--workspace-state", "fresh", "--operation", "references"]),
    /--repo-root is required/
  );
});

test("parseCli rejects an invalid --workspace-state", () => {
  assert.throws(
    () => parseCli(["--repo-root", "/tmp/repo", "--project-id", "x", "--workspace-state", "warm", "--operation", "references"]),
    /--workspace-state must be one of: fresh, reused/
  );
});

test("parseCli rejects an invalid --prepare", () => {
  assert.throws(
    () => parseCli(["--repo-root", "/tmp/repo", "--project-id", "x", "--workspace-state", "fresh", "--prepare", "eager", "--operation", "references"]),
    /--prepare must be one of: none, progress-idle, document-symbol/
  );
});

test("parseCli rejects an invalid --operation", () => {
  assert.throws(
    () => parseCli(["--repo-root", "/tmp/repo", "--project-id", "x", "--workspace-state", "fresh", "--operation", "hover"]),
    /--operation must be one of: definition, implementation, references, type-hierarchy/
  );
});

test("parseCli rejects a non-positive --runs", () => {
  assert.throws(
    () => parseCli(["--repo-root", "/tmp/repo", "--project-id", "x", "--workspace-state", "fresh", "--operation", "references", "--runs", "0"]),
    /--runs must be a positive integer/
  );
});

test("parseCli rejects a flag missing its value", () => {
  assert.throws(
    () => parseCli(["--repo-root", "/tmp/repo", "--project-id", "x", "--workspace-state"]),
    /--workspace-state requires a value/
  );
});

test("runAttempt counts only real in-repository locations as repo-contained", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "first-touch-repo-"));
  const session = {
    rawDefinition: async () => [
      { uri: pathToFileURL(path.join(repoRoot, "src", "InRepo.java")).toString(), range },
      { uri: pathToFileURL(path.join(tmpdir(), "OutsideRepo.java")).toString(), range },
      { uri: "jdt://contents/java.base/java/lang/String.class", range }
    ],
    drainPhaseMetrics: () => ({})
  } as unknown as JdtlsSession;

  const attempt = await runAttempt(
    session,
    {
      repoRoot,
      projectId: "fixture",
      workspaceState: "fresh",
      prepare: "none",
      operation: "definition",
      timeoutMs: 100
    } as Parameters<typeof runAttempt>[1],
    { file: path.join(repoRoot, "src", "Anchor.java"), line: 0, column: 0, scenarioId: "fixture-definition" },
    "deadbeef",
    0
  );

  assert.equal(attempt.resultFiles, 3);
  assert.equal(attempt.repoContainedFiles, 1);
  assert.equal(attempt.outsideRepoFiles, 1);
  assert.equal(attempt.suppressedLocations, 1);
  assert.equal(attempt.cacheHit, "unavailable");
  assert.equal(attempt.shared, "unavailable");
  assert.equal((attempt as unknown as { backendSettlement: string }).backendSettlement, "unavailable");
});

test("runAttempt buckets cancellation settlement observed for its own operation", async () => {
  let drainCalls = 0;
  const session = {
    rawDefinition: async () => [],
    drainPhaseMetrics: () => drainCalls++ === 0
      ? { ensureStart: 12 }
      : { "textDocument/definition": 100, cancelBackendSettlementMs: 300 }
  } as unknown as JdtlsSession;

  const attempt = await runAttempt(
    session,
    { repoRoot: "/repo", projectId: "fixture", workspaceState: "fresh", prepare: "none", operation: "definition", timeoutMs: 100 },
    { file: "/repo/src/Anchor.java", line: 0, column: 0, scenarioId: "fixture-definition" },
    "deadbeef",
    12
  );

  assert.equal(attempt.backendSettlement, "within_1s");
  assert.deepEqual(attempt.sessionPhaseMs, {
    ensureStart: 12,
    "textDocument/definition": 100,
    cancelBackendSettlementMs: 300
  });
});

test("type hierarchy edges contribute their endpoint locations to containment evidence", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "first-touch-hierarchy-"));
  const session = {
    rawTypeHierarchy: async () => ({
      edges: [{
        depth: 1,
        from: { uri: pathToFileURL(path.join(repoRoot, "src", "Parent.java")).toString(), range },
        to: { uri: pathToFileURL(path.join(tmpdir(), "External.java")).toString(), range }
      }]
    }),
    drainPhaseMetrics: () => ({})
  } as unknown as JdtlsSession;

  const attempt = await runAttempt(
    session,
    { repoRoot, projectId: "fixture", workspaceState: "fresh", prepare: "none", operation: "type-hierarchy", timeoutMs: 100 },
    { file: path.join(repoRoot, "src", "Anchor.java"), line: 0, column: 0, scenarioId: "fixture-type-hierarchy" },
    "deadbeef",
    0
  );

  assert.equal(attempt.resultFiles, 1);
  assert.equal(attempt.repoContainedFiles, 1);
  assert.equal(attempt.outsideRepoFiles, 1);
});

test("withFreshWorkspace retains a failed operation workspace for log evidence", async () => {
  const workspace = await withFreshWorkspace(async cacheRoot => {
    writeFileSync(path.join(cacheRoot, "jdtls.log"), "request failed\n");
    return { completion: "FAILED" };
  });

  try {
    assert.equal(workspace.failed, true);
    assert.equal(existsSync(path.join(workspace.cacheRoot, "jdtls.log")), true);
  } finally {
    rmSync(workspace.cacheRoot, { recursive: true, force: true });
  }
});

test("a timeout normalized by runAttempt still retains fresh workspace evidence", async () => {
  const session = {
    rawDefinition: async () => {
      const error = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
      throw error;
    },
    drainPhaseMetrics: () => ({})
  } as unknown as JdtlsSession;
  const workspace = await withFreshWorkspace(async cacheRoot => {
    writeFileSync(path.join(cacheRoot, "jdtls.log"), "timed out\n");
    return runAttempt(
      session,
      { repoRoot: cacheRoot, projectId: "fixture", workspaceState: "fresh", prepare: "none", operation: "definition", timeoutMs: 100 },
      { file: path.join(cacheRoot, "Anchor.java"), line: 0, column: 0, scenarioId: "fixture-definition" },
      "deadbeef",
      0
    );
  });

  try {
    assert.equal(workspace.result.completion, "PARTIAL_TIMEOUT");
    assert.equal(workspace.failed, true);
    assert.equal(existsSync(path.join(workspace.cacheRoot, "jdtls.log")), true);
  } finally {
    rmSync(workspace.cacheRoot, { recursive: true, force: true });
  }
});

test("a failed ensureStarted still stops the fresh session before preserving its workspace", async () => {
  let stops = 0;
  const session = {
    ensureStarted: async () => { throw new Error("start failed"); },
    stop: async () => { stops += 1; }
  } as unknown as JdtlsSession;
  const runner = (semanticFirstTouch as unknown as {
    runStartedAttempt?: (
      session: JdtlsSession,
      cli: Parameters<typeof runAttempt>[1],
      anchor: Parameters<typeof runAttempt>[2],
      repoCommit: string
    ) => Promise<unknown>;
  }).runStartedAttempt;

  if (!runner) assert.fail("fresh attempts must use a start/stop wrapper");
  await assert.rejects(
    runner(
      session,
      { repoRoot: "/repo", projectId: "fixture", workspaceState: "fresh", prepare: "none", operation: "definition", timeoutMs: 100 },
      { file: "/repo/src/Anchor.java", line: 0, column: 0, scenarioId: "fixture-definition" },
      "deadbeef"
    ),
    /start failed/
  );
  assert.equal(stops, 1);
});

test("runStartedAttempt reports a timed-out backend that never settled before session stop", async () => {
  let stops = 0;
  const session = {
    ensureStarted: async () => undefined,
    rawDefinition: async () => {
      const error = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
      throw error;
    },
    drainPhaseMetrics: () => ({}),
    stop: async () => { stops += 1; }
  } as unknown as JdtlsSession;

  const attempt = await runStartedAttempt(
    session,
    { repoRoot: "/repo", projectId: "fixture", workspaceState: "fresh", prepare: "none", operation: "definition", timeoutMs: 20 },
    { file: "/repo/src/Anchor.java", line: 0, column: 0, scenarioId: "fixture-definition" },
    "deadbeef"
  );

  assert.equal(stops, 1);
  assert.equal(attempt.completion, "PARTIAL_TIMEOUT");
  assert.equal(attempt.backendSettlement, "never_before_session_stop");
});

test("writeJsonAtomically commits a complete JSON payload at the requested output path", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "first-touch-output-"));
  const output = path.join(directory, "attempts.json");
  const contents = JSON.stringify({ attempts: [{ scenarioId: "fixture-definition" }] }, null, 2);
  const writer = (semanticFirstTouch as unknown as {
    writeJsonAtomically?: (target: string, payload: string) => Promise<void>;
  }).writeJsonAtomically;

  if (!writer) assert.fail("semantic-first-touch must expose an atomic JSON writer for --output");
  try {
    await writer(output, contents);
    assert.equal(readFileSync(output, "utf8"), contents);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { attempts: [{ scenarioId: "fixture-definition" }] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
