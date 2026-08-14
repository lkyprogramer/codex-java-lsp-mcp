// input: The compiled test suite and the caller's ambient shell environment.
// output: A child test process whose runtime/cache/config state is confined to one temporary root.
// pos: Repository-wide verification boundary; tests must never touch a user's managed MCP runtime.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEST_ROOT_PREFIX = "codex-java-lsp-test-";

export function createIsolatedTestEnvironment(parentEnvironment = process.env) {
  const root = mkdtempSync(path.join(tmpdir(), TEST_ROOT_PREFIX));
  const cache = path.join(root, "cache");
  const ownership = path.join(root, "ownership");
  const xdgConfig = path.join(root, "xdg-config");
  const codexHome = path.join(root, "codex-home");
  const home = path.join(root, "home");
  const projects = path.join(root, "projects.json");
  mkdirSync(cache, { recursive: true });
  mkdirSync(ownership, { recursive: true });
  mkdirSync(xdgConfig, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(projects, '{"aliases":[]}\n', { encoding: "utf8", mode: 0o600, flag: "wx" });

  let cleaned = false;
  const environment = { ...parentEnvironment };
  // These are mutable runtime roots. Never let tests inherit an open stdio
  // server's JDT workspace/log base, even though streamable_http rejects them.
  for (const name of [
    "JAVA_LSP_CACHE_BASE",
    "JAVA_LSP_OWNERSHIP_BASE",
    "JAVA_LSP_PROJECTS_JSON",
    "JDTLS_DATA_DIR",
    "JDTLS_LOG_DIR",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
    "HOME"
  ]) {
    delete environment[name];
  }
  Object.assign(environment, {
    JAVA_LSP_CACHE_BASE: cache,
    JAVA_LSP_OWNERSHIP_BASE: ownership,
    JAVA_LSP_PROJECTS_JSON: projects,
    XDG_CONFIG_HOME: xdgConfig,
    CODEX_HOME: codexHome,
    HOME: home
  });

  return {
    root,
    environment,
    cleanup() {
      if (cleaned) return;
      // root is obtained exclusively from mkdtempSync above, never an env/config value.
      rmSync(root, { recursive: true, force: true });
      cleaned = true;
    }
  };
}

export function runIsolatedTests(arguments_ = process.argv.slice(2)) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const result = spawnSync(process.execPath, [
      "--test",
      ...arguments_,
      "dist/**/*.test.js",
      "scripts/**/*.test.mjs"
    ], {
      cwd: process.cwd(),
      env: isolated.environment,
      stdio: "inherit"
    });
    if (result.error) {
      throw result.error;
    }
    return result.status ?? 1;
  } finally {
    isolated.cleanup();
  }
}

function isMainModule() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMainModule()) {
  process.exitCode = runIsolatedTests();
}
