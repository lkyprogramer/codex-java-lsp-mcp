import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  bindCommandToIsolatedRepository,
  isolatedJdtBenchmarkEnvironment,
  replaceRepoPlaceholder
} from "./run-isolated-jdt-benchmark.mjs";

test("real JDT benchmark environment forces private runtime state and detached repo selectors", () => {
  const root = "/tmp/v32-jdt-isolated";
  const repoRoot = "/tmp/v32-jdt-isolated/repo";
  const env = isolatedJdtBenchmarkEnvironment(root, repoRoot, {
    JDTLS_BIN: "/opt/jdtls",
    HOME: "/active/home",
    JDTLS_DATA_DIR: "/active/workspace",
    JAVA_LSP_CACHE_ROOT: "/active/cache",
    JAVA_LSP_BENCH_REPO_ROOT: "/active/repo",
    JAVA_LSP_BENCH_INDEX_CACHE_DIR: "/active/index-cache",
    JAVA_TOOL_OPTIONS: "-Duser.home=/active/home",
    NODE_OPTIONS: "--require=/active/mutator.cjs",
    NODE_PATH: "/active/node_modules",
    NODE_V8_COVERAGE: "/active/coverage",
    _JAVA_OPTIONS: "-Djava.io.tmpdir=/active/tmp",
    JDTLS_EXTRA_ARGS: "-data /active/workspace --jvm-arg=-Xms1g",
    JAVA_LSP_RESOURCE_TELEMETRY_FILE: "/active/telemetry.json"
  });

  assert.equal(env.JAVA_LSP_CACHE_ROOT, path.join(root, "cache"));
  assert.equal(env.HOME, path.join(root, "jdt-home"));
  assert.equal(env.XDG_CACHE_HOME, path.join(root, "xdg-cache"));
  assert.equal(env.XDG_CONFIG_HOME, path.join(root, "xdg-config"));
  assert.equal(env.XDG_DATA_HOME, path.join(root, "xdg-data"));
  assert.equal(env.XDG_STATE_HOME, path.join(root, "xdg-state"));
  assert.equal(env.JDTLS_DATA_DIR, path.join(root, "cache", "jdt-workspace"));
  assert.equal(env.JDTLS_LOG_DIR, path.join(root, "cache", "jdt-logs"));
  assert.equal(env.JAVA_LSP_BENCH_REPO_ROOT, repoRoot);
  assert.equal(env.JAVA_LSP_BENCH_INDEX_CACHE_DIR, undefined);
  assert.equal(env.JAVA_TOOL_OPTIONS, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NODE_V8_COVERAGE, undefined);
  assert.equal(env._JAVA_OPTIONS, undefined);
  assert.equal(env.GRADLE_USER_HOME, path.join(root, "gradle-home"));
  assert.equal(env.MAVEN_USER_HOME, path.join(root, "maven-home"));
  assert.equal(env.JAVA_LSP_ISOLATED_VALIDATION, "1");
  assert.equal(env.JAVA_LSP_ISOLATED_REPO_WORKTREE, "1");
  assert.equal(env.JAVA_LSP_ISOLATED_REPO_ROOT, repoRoot);
  assert.equal(env.JDTLS_BIN, "/opt/jdtls");
  assert.match(env.JDTLS_EXTRA_ARGS, /-Duser\.home=\/tmp\/v32-jdt-isolated\/jdt-home/);
  assert.doesNotMatch(env.JDTLS_EXTRA_ARGS, /active|Xms1g|-data/);
  assert.equal(env.JAVA_LSP_RESOURCE_TELEMETRY_FILE, undefined);
});

test("real JDT benchmark binds the command repo root to the detached clone", () => {
  assert.deepEqual(
    bindCommandToIsolatedRepository(
      ["node", "tool.js", "--repo-root", "{repo}", "--output", "{repo}/out.json"],
      "/tmp/repo"
    ),
    ["node", "tool.js", "--repo-root", "/tmp/repo", "--output", "/tmp/repo/out.json"]
  );
  assert.throws(
    () => bindCommandToIsolatedRepository(["node", "tool.js", "--repo-root", "/active/repo"], "/tmp/repo"),
    /--repo-root \{repo\}/
  );
  assert.throws(
    () => bindCommandToIsolatedRepository(["node", "tool.js"], "/tmp/repo"),
    /exactly one --repo-root \{repo\}/
  );
  assert.throws(
    () => bindCommandToIsolatedRepository(
      ["node", "tool.js", "--repo-root", "{repo}", "--repo-root", "/active/repo"],
      "/tmp/repo"
    ),
    /exactly one --repo-root \{repo\}/
  );
  assert.throws(
    () => bindCommandToIsolatedRepository(["node", "tool.js", "--repo-root=/active/repo"], "/tmp/repo"),
    /must not use --repo-root=/
  );
  assert.throws(
    () => bindCommandToIsolatedRepository(
      ["node", "tool.js", "--repo-root", "{repo}", "--index-cache-dir", "/active/cache"],
      "/tmp/isolated/repo",
      "/tmp/isolated"
    ),
    /must use a \{repo\} or \{state\} placeholder/
  );
  assert.deepEqual(
    bindCommandToIsolatedRepository(
      ["node", "tool.js", "--repo-root", "{repo}", "--index-cache-dir", "{state}/index"],
      "/tmp/isolated/repo",
      "/tmp/isolated"
    ),
    ["node", "tool.js", "--repo-root", "/tmp/isolated/repo", "--index-cache-dir", "/tmp/isolated/index"]
  );
});

test("real JDT benchmark replaces every repo placeholder without shell interpolation", () => {
  assert.deepEqual(
    replaceRepoPlaceholder(["node", "tool.js", "--repo-root", "{repo}", "--output", "{repo}/out.json"], "/tmp/repo"),
    ["node", "tool.js", "--repo-root", "/tmp/repo", "--output", "/tmp/repo/out.json"]
  );
});
