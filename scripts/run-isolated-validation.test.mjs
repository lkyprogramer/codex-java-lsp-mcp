import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { isolatedValidationEnvironment } from "./run-isolated-validation.mjs";

test("isolated validation never inherits or accepts overrides for active LSP state directories", () => {
  const root = "/tmp/v32-isolated";
  const env = isolatedValidationEnvironment(root, {
    TASK_MARKER: "yes",
    HOME: "/active/home",
    JAVA_LSP_CACHE_ROOT: "/active/cache",
    XDG_CACHE_HOME: "/active/xdg",
    XDG_CONFIG_HOME: "/active/xdg-config",
    XDG_DATA_HOME: "/active/xdg-data",
    XDG_STATE_HOME: "/active/xdg-state",
    TMPDIR: "/active/tmp",
    JDTLS_DATA_DIR: "/active/jdt-workspace",
    JDTLS_LOG_DIR: "/active/jdt-logs",
    JAVA_LSP_PROJECTS_JSON: "/active/projects.json",
    JAVA_LSP_ISOLATED_VALIDATION: "0",
    JAVA_TOOL_OPTIONS: "-Duser.home=/active/home",
    _JAVA_OPTIONS: "-Djava.io.tmpdir=/active/tmp",
    JDK_JAVA_OPTIONS: "-Duser.home=/active/home",
    MAVEN_OPTS: "-Dmaven.repo.local=/active/m2",
    GRADLE_OPTS: "-Dgradle.user.home=/active/gradle",
    NODE_OPTIONS: "--require=/active/mutator.cjs",
    NODE_PATH: "/active/node_modules",
    NODE_REPL_HISTORY: "/active/node-repl-history",
    NODE_V8_COVERAGE: "/active/coverage",
    NODE_COMPILE_CACHE: "/active/compile-cache",
    NODE_REDIRECT_WARNINGS: "/active/node-warnings.log"
  });
  assert.equal(env.HOME, path.join(root, "home"));
  assert.equal(env.JAVA_LSP_CACHE_ROOT, path.join(root, "cache"));
  assert.equal(env.XDG_CACHE_HOME, path.join(root, "xdg-cache"));
  assert.equal(env.XDG_CONFIG_HOME, path.join(root, "xdg-config"));
  assert.equal(env.XDG_DATA_HOME, path.join(root, "xdg-data"));
  assert.equal(env.XDG_STATE_HOME, path.join(root, "xdg-state"));
  assert.equal(env.TMPDIR, path.join(root, "tmp"));
  assert.equal(env.JDTLS_DATA_DIR, path.join(root, "cache", "jdt-workspace"));
  assert.equal(env.JDTLS_LOG_DIR, path.join(root, "cache", "jdt-logs"));
  assert.equal(env.JAVA_LSP_PROJECTS_JSON, path.join(root, "projects.json"));
  assert.equal(env.JAVA_LSP_ISOLATED_VALIDATION, "1");
  assert.equal(env.JAVA_TOOL_OPTIONS, undefined);
  assert.equal(env._JAVA_OPTIONS, undefined);
  assert.equal(env.JDK_JAVA_OPTIONS, undefined);
  assert.equal(env.MAVEN_OPTS, undefined);
  assert.equal(env.GRADLE_OPTS, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NODE_REPL_HISTORY, undefined);
  assert.equal(env.NODE_V8_COVERAGE, undefined);
  assert.equal(env.NODE_COMPILE_CACHE, undefined);
  assert.equal(env.NODE_REDIRECT_WARNINGS, undefined);
  assert.equal(env.GRADLE_USER_HOME, path.join(root, "gradle-home"));
  assert.equal(env.MAVEN_USER_HOME, path.join(root, "maven-home"));
  assert.equal(env.JDTLS_BIN, "/usr/bin/false");
  assert.equal(env.TASK_MARKER, "yes");
});

test("isolated validation drops inherited repo selectors and benchmark cache overrides", () => {
  const previous = {
    smoke: process.env.JAVA_LSP_SMOKE_REPO_ROOT,
    benchmark: process.env.JAVA_LSP_BENCH_REPO_ROOT,
    indexCache: process.env.JAVA_LSP_BENCH_INDEX_CACHE_DIR,
    lishuedu: process.env.LISHUEDU_ROOT,
    extraArgs: process.env.JDTLS_EXTRA_ARGS,
    resourceTelemetry: process.env.JAVA_LSP_RESOURCE_TELEMETRY_FILE
  };
  process.env.JAVA_LSP_SMOKE_REPO_ROOT = "/active/smoke-repo";
  process.env.JAVA_LSP_BENCH_REPO_ROOT = "/active/benchmark-repo";
  process.env.JAVA_LSP_BENCH_INDEX_CACHE_DIR = "/active/index-cache";
  process.env.LISHUEDU_ROOT = "/active/lishuedu";
  process.env.JDTLS_EXTRA_ARGS = "-data /active/jdt";
  process.env.JAVA_LSP_RESOURCE_TELEMETRY_FILE = "/active/telemetry.json";
  try {
    const env = isolatedValidationEnvironment("/tmp/v32-isolated", {
      JAVA_LSP_RESOURCE_TELEMETRY_FILE: "/also-active/telemetry.json",
      JAVA_LSP_BENCH_INDEX_CACHE_DIR: "/also-active/index-cache",
      JAVA_LSP_ISOLATED_REPO_ROOT: "/also-active/repo",
      JAVA_LSP_ISOLATED_REPO_WORKTREE: "1",
      JAVA_LSP_REPO_ROOT: "/also-active/repo",
      JAVA_LSP_SMOKE_REPO_ROOT: "/also-active/repo"
    });
    assert.equal(env.JAVA_LSP_SMOKE_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_BENCH_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_BENCH_INDEX_CACHE_DIR, undefined);
    assert.equal(env.LISHUEDU_ROOT, undefined);
    assert.equal(env.JDTLS_EXTRA_ARGS, undefined);
    assert.equal(env.JAVA_LSP_RESOURCE_TELEMETRY_FILE, undefined);
    assert.equal(env.JAVA_LSP_BENCH_INDEX_CACHE_DIR, undefined);
    assert.equal(env.JAVA_LSP_ISOLATED_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_ISOLATED_REPO_WORKTREE, undefined);
    assert.equal(env.JAVA_LSP_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_SMOKE_REPO_ROOT, undefined);
  } finally {
    restore("JAVA_LSP_SMOKE_REPO_ROOT", previous.smoke);
    restore("JAVA_LSP_BENCH_REPO_ROOT", previous.benchmark);
    restore("JAVA_LSP_BENCH_INDEX_CACHE_DIR", previous.indexCache);
    restore("LISHUEDU_ROOT", previous.lishuedu);
    restore("JDTLS_EXTRA_ARGS", previous.extraArgs);
    restore("JAVA_LSP_RESOURCE_TELEMETRY_FILE", previous.resourceTelemetry);
  }
});

test("isolated validation accepts only candidate-cwd repo selector overrides", () => {
  const safe = isolatedValidationEnvironment("/tmp/v32-isolated", { JAVA_LSP_SMOKE_REPO_ROOT: "." });
  const unsafe = isolatedValidationEnvironment("/tmp/v32-isolated", { JAVA_LSP_SMOKE_REPO_ROOT: "/active/repo" });
  assert.equal(safe.JAVA_LSP_SMOKE_REPO_ROOT, ".");
  assert.equal(unsafe.JAVA_LSP_SMOKE_REPO_ROOT, undefined);
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
