import assert from "node:assert/strict";
import test from "node:test";
import { parseCli } from "./semantic-first-touch.js";

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
