import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, realpath, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderLaunchAgent } from "./render-launch-agent-plist.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("LaunchAgent renderer escapes absolute paths and daemon environment values", () => {
  const template = `__LABEL__|__RUNNER__|__RUNTIME_DIR__|__LOG_DIR__|__ENVIRONMENT_ENTRIES__|__CACHE_ROOT__|__SERVER_ENTRY__`;
  const rendered = renderLaunchAgent(template, {
    label: "com.lky.codex-java-lsp-mcp",
    runner: "/Users/example/Library/Application Support/codex & java/run-daemon.sh",
    runtimeDir: "/Users/example/Library/Application Support/codex & java",
    logDir: "/Users/example/Library/Logs/codex & java",
    cacheRoot: "/cache", serverEntry: "/release/dist/http-server.js",
    environment: new Map([
      ["JAVA_LSP_HTTP_PORT", "38456"],
      ["JDTLS_EXTRA_ARGS", "--jvm-arg=-Dname=a&b"]
    ])
  });
  assert.equal(rendered.includes("__"), false);
  assert.match(rendered, /codex &amp; java/);
  assert.match(rendered, /a&amp;b/);
  assert.match(rendered, /<key>JAVA_LSP_HTTP_PORT<\/key>/);
  assert.throws(() => renderLaunchAgent(template, {
    label: "bad\nlabel",
    runner: "/runner",
    runtimeDir: "/runtime",
    logDir: "/logs",
    cacheRoot: "/cache", serverEntry: "/release/dist/http-server.js",
    environment: {}
  }), /Invalid LaunchAgent label/);
});

test("LaunchAgent launches the fixed native owner with immutable entry and recovery settings", () => {
  const template = readFileSync(path.join(projectRoot, "macos/com.lky.codex-java-lsp-mcp.plist.template"), "utf8");
  assert.match(template, /<key>Program<\/key>\s*<string>__RUNNER__<\/string>/);
  assert.match(template, /<string>owner<\/string>/);
  assert.match(template, /<key>ThrottleInterval<\/key>\s*<integer>1<\/integer>/);
  assert.match(template, /<key>AbandonProcessGroup<\/key>\s*<false\/>/);
});

test("stable daemon runner enters the native owner with canonical cache and immutable release", async t => {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "codex-java-lsp-runner-")));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const release = path.join(fixture, "releases", "one");
  await mkdir(path.join(release, "dist"), { recursive: true });
  await mkdir(path.join(fixture, "launcher/dist/native"), { recursive: true });
  await mkdir(path.join(fixture, "state"));
  await writeFile(path.join(fixture, "state/daemon.env"), `JAVA_LSP_CACHE_BASE=${shellValue(fixture + "/cache")}\nJAVA_LSP_CACHE_ROOT=${shellValue(fixture + "/cache")}\nJAVA_LSP_SERVICE_STATE_ROOT=${shellValue(fixture + "/state")}\nGRADLE_USER_HOME=${shellValue(fixture + "/state/jdt-gradle-home")}\n`);
  await writeFile(path.join(release, "dist/http-server.js"), "// fixture\n");
  await symlink("releases/one", path.join(fixture, "current"));
  const capture = path.join(fixture, "arguments.txt");
  const native = path.join(fixture, "launcher/dist/native/ilv2-mac");
  await writeFile(native, `#!/bin/bash\nprintf '%s\\n' "$@" > "${capture}"\n`);
  await chmod(native, 0o755);
  await writeFile(path.join(fixture, "run-daemon.sh"), await readFile(path.join(projectRoot, "run-daemon.sh")));
  await chmod(path.join(fixture, "run-daemon.sh"), 0o755);
  await run(path.join(fixture, "run-daemon.sh"), [], { JAVA_LSP_HTTP_PORT: "6553" });
  assert.deepEqual((await readFile(capture, "utf8")).trim().split("\n"), ["owner", fixture + "/cache", release + "/dist/http-server.js"]);
});

test("stable hook runner resolves only the current immutable release", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-hook-runner-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const release = path.join(fixture, "releases", "one");
  await mkdir(path.join(release, "dist", "hooks"), { recursive: true });
  await writeFile(path.join(release, "dist", "hooks", "hook-gate.js"), "// fixture\n");
  await symlink("releases/one", path.join(fixture, "current"));
  const capture = path.join(fixture, "node-argument.txt");
  const fakeNode = path.join(fixture, "fake-node.sh");
  await writeFile(fakeNode, `#!/usr/bin/env bash\nprintf '%s' "$1" > "${capture}"\n`);
  await chmod(fakeNode, 0o755);
  await writeFile(path.join(fixture, "run-hook-gate.sh"), await readFile(path.join(projectRoot, "run-hook-gate.sh"), "utf8"));
  await chmod(path.join(fixture, "run-hook-gate.sh"), 0o755);
  await run(path.join(fixture, "run-hook-gate.sh"), [], { NODE_BIN: fakeNode });
  assert.equal(await readFile(capture, "utf8"), path.join(fixture, "current", "dist", "hooks", "hook-gate.js"));
});

test("hook installer configures the stable release-following hook runner", () => {
  const installer = readFileSync(path.join(projectRoot, "install-hook.sh"), "utf8");
  assert.match(installer, /hook="\$runtime_dir\/run-hook-gate\.sh"/);
  assert.match(installer, /command="\$quoted_hook"/);
  assert.doesNotMatch(installer, /dist\/hooks\/hook-gate\.js/);
});

test("runtime installer atomically manages both stable hook entrypoints", () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  for (const artifact of ["run-hook-gate.sh", "install-hook.sh"]) {
    const escaped = artifact.replaceAll(".", "\\.");
    assert.match(installer, new RegExp(`\\$RUNTIME_DIR/${escaped}`));
    assert.match(installer, new RegExp(`\\$RELEASE_DIR/${escaped}`));
    assert.match(installer, new RegExp(`\\$ROLLBACK_DIR/${escaped}\\.marker`));
  }
});

test("HTTP entrypoint remains executable through the stable current symlink", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-http-current-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const port = await unusedPort();
  await symlink(projectRoot, path.join(fixture, "release"));
  await symlink("release", path.join(fixture, "current"));
  const cache = path.join(fixture, "cache");
  const ownership = path.join(fixture, "ownership");
  const projects = path.join(fixture, "projects.json");
  await mkdir(cache);
  await mkdir(ownership);
  await writeFile(projects, '{"aliases":[]}\n');
  const child = spawn(process.execPath, [path.join(fixture, "current", "dist", "http-server.js")], {
    env: {
      ...process.env,
      JAVA_LSP_HTTP_PORT: String(port),
      JAVA_LSP_CACHE_BASE: cache,
      JAVA_LSP_OWNERSHIP_BASE: ownership,
      JAVA_LSP_PROJECTS_JSON: projects,
      JDTLS_BIN: "/nonexistent"
    },
    stdio: "ignore"
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForHttp(`http://127.0.0.1:${port}/readyz`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
});

test("installer refuses an existing pre-MAC-17 runtime without a verified owner bundle", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-unverified-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  await mkdir(state);
  await writeFile(path.join(state, "daemon.env"), "# pre-MAC-17 runtime\n");
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  const start = installer.indexOf("assert_existing_managed_config_is_compatible() {");
  const end = installer.indexOf("\nbackup_file_for_rollback()", start);
  const check = installer.slice(start, end);
  await assert.rejects(run("bash", ["-c", `${check}\nassert_existing_managed_config_is_compatible`], {
    RUNTIME_DIR: root, STATE_DIR: state, CURRENT_LINK: path.join(root, "current"), HTTP_PORT: "6553", LAUNCH_AGENT_LABEL: "com.example.isolated", LAUNCH_AGENT_PLIST: path.join(root, "agent.plist")
  }), /Existing runtime has no verified MAC-17 owner bundle/);
  assert.equal(await readFile(path.join(state, "daemon.env"), "utf8"), "# pre-MAC-17 runtime\n");
});

test("installer refuses concurrent release changes and leaves the existing lock intact", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-installer-lock-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const runtime = path.join(fixture, "runtime");
  const lock = path.join(runtime, "state", "install.lock");
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, "owner"), "existing-installer\n");
  const binDir = path.join(fixture, "bin");
  await mkdir(binDir);
  await writeFile(path.join(binDir, "jdtls"), "#!/usr/bin/env bash\n");
  await chmod(path.join(binDir, "jdtls"), 0o755);
  await assert.rejects(
    run(path.join(projectRoot, "install-runtime.sh"), [], {
      PATH: `${binDir}:${process.env.PATH}`,
      CODEX_JAVA_LSP_RUNTIME_DIR: runtime,
      CODEX_JAVA_LSP_LAUNCH_AGENTS_DIR: path.join(fixture, "LaunchAgents"),
      CODEX_JAVA_LSP_LOG_DIR: path.join(fixture, "logs"),
      JDTLS_BIN: path.join(binDir, "jdtls")
    }),
    /Another installer owns/
  );
  assert.equal(await readFile(path.join(lock, "owner"), "utf8"), "existing-installer\n");
});

test("installer release tests isolate cache, ownership, projects, and XDG state from the managed daemon", () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  assert.match(installer, /run_release_tests_in_isolated_environment\(\)/);
  assert.match(installer, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/codex-java-lsp-install-test\.XXXXXX"/);
  assert.match(installer, /"JAVA_LSP_CACHE_BASE=\$test_cache"/);
  assert.match(installer, /"JAVA_LSP_OWNERSHIP_BASE=\$test_ownership"/);
  assert.match(installer, /"JAVA_LSP_PROJECTS_JSON=\$test_projects"/);
  assert.match(installer, /"XDG_CONFIG_HOME=\$INSTALL_TEST_ROOT\/config"/);
  assert.match(installer, /"CODEX_HOME=\$INSTALL_TEST_ROOT\/codex-home"/);
  assert.match(installer, /"HOME=\$INSTALL_TEST_ROOT\/home"/);
  assert.match(installer, /cd "\$SCRIPT_DIR"\n    exec env \\/);
  assert.match(installer, /cleanup_install_test_environment[\s\S]*release_install_lock/);
});

test("installer candidate smoke isolates its process state from the managed daemon", () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  assert.match(installer, /run_candidate_smoke\(\)/);
  assert.match(installer, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/codex-java-lsp-candidate-test\.XXXXXX"/);
  assert.match(installer, /"JAVA_LSP_CACHE_BASE=\$candidate_cache"/);
  assert.match(installer, /"JAVA_LSP_OWNERSHIP_BASE=\$candidate_ownership"/);
  assert.match(installer, /"JAVA_LSP_PROJECTS_JSON=\$candidate_projects"/);
  assert.match(installer, /"XDG_CONFIG_HOME=\$CANDIDATE_TEST_ROOT\/config"/);
  assert.match(installer, /"CODEX_HOME=\$CANDIDATE_TEST_ROOT\/codex-home"/);
  assert.match(installer, /"HOME=\$CANDIDATE_TEST_ROOT\/home"/);
  assert.match(installer, /env -u JDTLS_DATA_DIR -u JDTLS_LOG_DIR/);
  assert.match(installer, /cleanup_candidate\n\s*cleanup_candidate_test_environment/);
});

test("installer binds the canonical owner cache and independent persistent service state", () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  assert.match(installer, /codex-java-lsp-ilv2/);
  assert.match(installer, /JAVA_LSP_CACHE_BASE="\$\(cd "\$JAVA_LSP_CACHE_BASE" && pwd -P\)"/);
  assert.match(installer, /"JAVA_LSP_CACHE_ROOT=\$JAVA_LSP_CACHE_BASE"/);
  assert.match(installer, /"JAVA_LSP_SERVICE_STATE_ROOT=\$STATE_DIR"/);
  assert.match(installer, /MANAGED_GRADLE_HOME="\$STATE_DIR\/jdt-gradle-home"/);
  assert.match(installer, /"GRADLE_USER_HOME=\$MANAGED_GRADLE_HOME"/);
  assert.doesNotMatch(installer, /codex mcp|activate-http|copy_legacy_release_if_needed|verify_stdio_handoff/);
  assert.match(installer, /merge_project_jdk_env/);
  assert.match(installer, /inherit_managed_environment/);
});

test("isolated Gradle install leaves a failed activation stopped", async () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  const start = installer.indexOf("if ! managed_daemonctl start || ! managed_daemonctl smoke; then");
  assert.ok(start >= 0);
  const end = installer.indexOf("\nfi\n", start);
  assert.ok(end > start);
  const failureBranch = installer.slice(start, end + "\nfi".length);
  const shell = [
    "set -euo pipefail",
    "INSTALL_WITH_GRADLE=true",
    'managed_daemonctl() { echo "call: $1" >&2; [[ "$1" != "smoke" ]]; }',
    'restore_previous_release() { echo "unexpected restore" >&2; }',
    'restore_previous_managed_configuration() { echo "unexpected restore" >&2; }',
    failureBranch
  ].join("\n");
  await assert.rejects(run("/bin/bash", ["-c", shell]), error => {
    const calls = error.message.match(/\bcall: [a-z]+/g);
    assert.deepEqual(calls, ["call: start", "call: smoke", "call: stop"]);
    assert.match(error.message, /The new service is stopped/);
    assert.doesNotMatch(error.message, /unexpected restore/);
    return true;
  });
});

test("installer handles an empty project JDK override list under nounset", () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  const guards = installer.match(/if \(\( \$\{#PROJECT_JDK_ENV\[@\]\} > 0 \)\); then/g) || [];
  assert.equal(guards.length, 3, "every empty-array expansion must be guarded when install-runtime.sh uses set -u");
});

test("installer rejects dirty release provenance before assembling a new immutable release", () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  assert.match(installer, /assert_clean_release_source\(\)/);
  assert.match(installer, /verify-clean-source-tree\.mjs/);
  assert.match(installer, /assert_clean_release_source\ncopy_release/);
});

test("runtime installer excludes eval dumps from immutable releases and prunes unreferenced copies", () => {
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  const rsyncFn = extractBashFunction(installer, "rsync_source_tree");
  for (const name of ["artifacts", "graphify-out", ".workflow", "node_modules", "dist", ".git"]) {
    assert.match(rsyncFn, new RegExp(`--exclude ${escapeRegex(name)}(?: |$)`, "m"));
  }
  assert.match(installer, /rsync_source_tree "\$SCRIPT_DIR\/" "\$RELEASE_DIR\/"/);
  assert.match(installer, /prune_unreferenced_releases\(\)/);
  assert.match(installer, /prune_unreferenced_releases \|\| true\n\necho "HTTP daemon is healthy/);
});

test("prune_unreferenced_releases keeps current and previous-current only", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-prune-releases-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const releases = path.join(fixture, "releases");
  await mkdir(path.join(releases, "keep-current"), { recursive: true });
  await mkdir(path.join(releases, "keep-previous"), { recursive: true });
  await mkdir(path.join(releases, "garbage-one"), { recursive: true });
  await mkdir(path.join(releases, "garbage-two"), { recursive: true });
  await writeFile(path.join(releases, "keep-current", "marker"), "current\n");
  await writeFile(path.join(releases, "keep-previous", "marker"), "previous\n");
  await writeFile(path.join(releases, "garbage-one", "blob"), "x");
  await symlink("releases/keep-current", path.join(fixture, "current"));
  await mkdir(path.join(fixture, "state"));
  await symlink("releases/keep-previous", path.join(fixture, "state", "previous-current"));
  const installer = readFileSync(path.join(projectRoot, "install-runtime.sh"), "utf8");
  const script = [
    "set -euo pipefail",
    `RUNTIME_DIR=${shellValue(fixture)}`,
    "RELEASES_DIR=\"$RUNTIME_DIR/releases\"",
    "STATE_DIR=\"$RUNTIME_DIR/state\"",
    "CURRENT_LINK=\"$RUNTIME_DIR/current\"",
    extractBashFunction(installer, "release_link_id"),
    extractBashFunction(installer, "prune_unreferenced_releases"),
    "prune_unreferenced_releases"
  ].join("\n");
  await run("bash", ["-c", script]);
  assert.equal(await readlink(path.join(fixture, "current")), "releases/keep-current");
  assert.equal(await readlink(path.join(fixture, "state", "previous-current")), "releases/keep-previous");
  assert.equal(await readFile(path.join(releases, "keep-current", "marker"), "utf8"), "current\n");
  assert.equal(await readFile(path.join(releases, "keep-previous", "marker"), "utf8"), "previous\n");
  await assert.rejects(readFile(path.join(releases, "garbage-one", "blob")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(releases, "garbage-two", "marker")), { code: "ENOENT" });
});

test("daemon controller defaults to its own runtime root, starts only its configured LaunchAgent, and waits for the fixed URL", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-daemonctl-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const stateDir = path.join(fixture, "state");
  const binDir = path.join(fixture, "bin");
  const calls = path.join(fixture, "calls.txt");
  await mkdir(path.join(fixture, "current", "dist"), { recursive: true });
  await mkdir(binDir);
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, "daemon.env"), [
    `RUNTIME_DIR_FROM_STATE=${shellValue(fixture)}`,
    "LAUNCH_AGENT_LABEL=com.example.codex-java-lsp",
    `LAUNCH_AGENT_PLIST=${shellValue(path.join(fixture, "agent.plist"))}`,
    "JAVA_LSP_HTTP_PORT=38456",
    "JAVA_LSP_HTTP_INSTANCE_ID=managed-fixture",
    `NODE_BIN=${shellValue(process.execPath)}`
  ].join("\n"));
  const launchctl = path.join(binDir, "launchctl");
  const curl = path.join(binDir, "curl");
  await writeFile(launchctl, `#!/usr/bin/env bash\nprintf 'launchctl %s\\n' \"$*\" >> \"${calls}\"\nif [[ \"$1\" == print ]]; then exit 1; fi\nexit 0\n`);
  await writeFile(curl, `#!/usr/bin/env bash\nprintf 'curl %s\\n' \"$*\" >> \"${calls}\"\nprintf '{\"status\":\"ok\",\"instanceId\":\"managed-fixture\"}'\n`);
  await chmod(launchctl, 0o755);
  await chmod(curl, 0o755);
  await writeFile(path.join(fixture, "daemonctl.sh"), await readFile(path.join(projectRoot, "daemonctl.sh"), "utf8"));
  await chmod(path.join(fixture, "daemonctl.sh"), 0o755);
  await run(path.join(fixture, "daemonctl.sh"), ["start"], {
    // A launchd canary exports its own runtime path. Clear it so this fixture
    // proves the controller falls back to its script directory instead.
    CODEX_JAVA_LSP_RUNTIME_DIR: "",
    LAUNCHCTL_BIN: launchctl,
    CURL_BIN: curl
  });
  const callLog = await readFile(calls, "utf8");
  assert.match(callLog, /launchctl bootstrap gui\/\d+ .*agent\.plist/);
  assert.doesNotMatch(callLog, /launchctl kickstart/);
  assert.match(callLog, /curl .*http:\/\/127\.0\.0\.1:38456\/readyz/);
});

test("daemon controller restart bootstraps an absent LaunchAgent instead of treating it as unknown", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-daemonctl-restart-absent-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const stateDir = path.join(fixture, "state");
  const binDir = path.join(fixture, "bin");
  const calls = path.join(fixture, "calls.txt");
  await mkdir(stateDir);
  await mkdir(binDir);
  await writeFile(path.join(stateDir, "daemon.env"), [
    `RUNTIME_DIR_FROM_STATE=${shellValue(fixture)}`,
    "LAUNCH_AGENT_LABEL=com.example.codex-java-lsp",
    `LAUNCH_AGENT_PLIST=${shellValue(path.join(fixture, "agent.plist"))}`,
    "JAVA_LSP_HTTP_PORT=38456",
    "JAVA_LSP_HTTP_INSTANCE_ID=managed-fixture",
    `NODE_BIN=${shellValue(process.execPath)}`
  ].join("\n"));
  const launchctl = path.join(binDir, "launchctl");
  const curl = path.join(binDir, "curl");
  await writeFile(launchctl, `#!/usr/bin/env bash
printf 'launchctl %s\\n' "$*" >> "${calls}"
if [[ "$1" == print || "$1" == bootout ]]; then echo 'Could not find service' >&2; exit 113; fi
exit 0
`);
  await writeFile(curl, "#!/usr/bin/env bash\nprintf '{\"status\":\"ok\",\"instanceId\":\"managed-fixture\"}'\n");
  await chmod(launchctl, 0o755);
  await chmod(curl, 0o755);
  await writeFile(path.join(fixture, "daemonctl.sh"), await readFile(path.join(projectRoot, "daemonctl.sh"), "utf8"));
  await chmod(path.join(fixture, "daemonctl.sh"), 0o755);
  await run(path.join(fixture, "daemonctl.sh"), ["restart"], {
    CODEX_JAVA_LSP_RUNTIME_DIR: fixture,
    LAUNCHCTL_BIN: launchctl,
    CURL_BIN: curl
  });
  const callLog = await readFile(calls, "utf8");
  assert.match(callLog, new RegExp(`launchctl bootstrap gui/${process.getuid()} ${escapeRegex(path.join(fixture, "agent.plist"))}`));
  assert.doesNotMatch(callLog, /launchctl kickstart/);
});

test("daemon controller refuses a health response from a different managed instance", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-daemonctl-instance-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const stateDir = path.join(fixture, "state");
  const binDir = path.join(fixture, "bin");
  await mkdir(stateDir);
  await mkdir(binDir);
  await writeFile(path.join(stateDir, "daemon.env"), [
    `RUNTIME_DIR_FROM_STATE=${shellValue(fixture)}`,
    "LAUNCH_AGENT_LABEL=com.example.codex-java-lsp",
    `LAUNCH_AGENT_PLIST=${shellValue(path.join(fixture, "agent.plist"))}`,
    "JAVA_LSP_HTTP_PORT=38456",
    "JAVA_LSP_HTTP_INSTANCE_ID=managed-expected",
    `NODE_BIN=${shellValue(process.execPath)}`,
  ].join("\n"));
  const launchctl = path.join(binDir, "launchctl");
  const curl = path.join(binDir, "curl");
  await writeFile(launchctl, "#!/usr/bin/env bash\nexit 0\n");
  await writeFile(curl, "#!/usr/bin/env bash\nprintf '{\"status\":\"ok\",\"instanceId\":\"managed-stale\"}'\n");
  await chmod(launchctl, 0o755);
  await chmod(curl, 0o755);
  await writeFile(path.join(fixture, "daemonctl.sh"), await readFile(path.join(projectRoot, "daemonctl.sh"), "utf8"));
  await chmod(path.join(fixture, "daemonctl.sh"), 0o755);
  await assert.rejects(
    run(path.join(fixture, "daemonctl.sh"), ["status"], {
      CODEX_JAVA_LSP_RUNTIME_DIR: fixture,
      LAUNCHCTL_BIN: launchctl,
      CURL_BIN: curl,
    }),
    /HTTP daemon instance differs from the managed release/,
  );
});

test("daemon controller fails closed when launchctl cannot establish service state", async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-daemonctl-state-error-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const stateDir = path.join(fixture, "state");
  const binDir = path.join(fixture, "bin");
  await mkdir(stateDir);
  await mkdir(binDir);
  await writeFile(path.join(stateDir, "daemon.env"), [
    `RUNTIME_DIR_FROM_STATE=${shellValue(fixture)}`,
    "LAUNCH_AGENT_LABEL=com.example.codex-java-lsp",
    `LAUNCH_AGENT_PLIST=${shellValue(path.join(fixture, "agent.plist"))}`,
    "JAVA_LSP_HTTP_PORT=38456",
    "JAVA_LSP_HTTP_INSTANCE_ID=managed-expected",
    `NODE_BIN=${shellValue(process.execPath)}`,
  ].join("\n"));
  const launchctl = path.join(binDir, "launchctl");
  const curl = path.join(binDir, "curl");
  await writeFile(launchctl, "#!/usr/bin/env bash\nif [[ \"$1\" == print ]]; then echo permission denied >&2; exit 78; fi\nexit 0\n");
  await writeFile(curl, "#!/usr/bin/env bash\nprintf '{\"status\":\"ok\",\"instanceId\":\"managed-expected\"}'\n");
  await chmod(launchctl, 0o755);
  await chmod(curl, 0o755);
  await writeFile(path.join(fixture, "daemonctl.sh"), await readFile(path.join(projectRoot, "daemonctl.sh"), "utf8"));
  await chmod(path.join(fixture, "daemonctl.sh"), 0o755);
  await assert.rejects(
    run(path.join(fixture, "daemonctl.sh"), ["start"], {
      CODEX_JAVA_LSP_RUNTIME_DIR: fixture,
      LAUNCHCTL_BIN: launchctl,
      CURL_BIN: curl,
    }),
    /Unable to determine managed LaunchAgent state/
  );
});

test("daemon controller refuses release rollback when bootout fails for a loaded service", async t => {
  const fixture = await createReleaseRollbackFixture(t, { loaded: true, bootoutFails: true });
  await assert.rejects(
    run(path.join(fixture.root, "daemonctl.sh"), ["rollback-release"], {
      CODEX_JAVA_LSP_RUNTIME_DIR: fixture.root,
      LAUNCHCTL_BIN: fixture.launchctl,
      CURL_BIN: fixture.curl,
    }),
    /Failed to bootout managed LaunchAgent/
  );
  assert.equal(await readlink(path.join(fixture.root, "current")), "releases/new");
  assert.equal(await readFile(path.join(fixture.root, "state", "daemon.env"), "utf8"), fixture.newState);
});

test("daemon controller refuses a release rollback whose predecessor points back to current", async t => {
  const fixture = await createReleaseRollbackFixture(t);
  await rm(path.join(fixture.root, "state", "previous-current"));
  await symlink("releases/new", path.join(fixture.root, "state", "previous-current"));
  await assert.rejects(
    run(path.join(fixture.root, "daemonctl.sh"), ["rollback-release"], {
      CODEX_JAVA_LSP_RUNTIME_DIR: fixture.root,
      LAUNCHCTL_BIN: fixture.launchctl,
      CURL_BIN: fixture.curl,
    }),
    /Previous immutable release resolves to the current release/
  );
  assert.equal(await readlink(path.join(fixture.root, "current")), "releases/new");
  await assert.rejects(readFile(fixture.calls, "utf8"), { code: "ENOENT" });
});

test("daemon controller restores the predecessor managed configuration before release rollback bootstrap", async t => {
  const fixture = await createReleaseRollbackFixture(t);
  await run(path.join(fixture.root, "daemonctl.sh"), ["rollback-release"], {
    CODEX_JAVA_LSP_RUNTIME_DIR: fixture.root,
    LAUNCHCTL_BIN: fixture.launchctl,
    CURL_BIN: fixture.curl,
  });
  assert.equal(await readlink(path.join(fixture.root, "current")), "releases/old");
  assert.equal(await readFile(path.join(fixture.root, "state", "daemon.env"), "utf8"), fixture.oldState);
  assert.equal(await readFile(path.join(fixture.root, "launcher/identity"), "utf8"), "old launcher\n");
  assert.equal(await readFile(path.join(fixture.root, "run-daemon.sh"), "utf8"), "old daemon runner\n");
  assert.equal(await readFile(path.join(fixture.root, "run.sh"), "utf8"), "old stdio runner\n");
  const callLog = await readFile(fixture.calls, "utf8");
  assert.match(callLog, new RegExp(`launchctl bootout gui/${process.getuid()}/com.example.codex-java-lsp`));
  assert.match(callLog, new RegExp(`launchctl bootstrap gui/${process.getuid()} ${escapeRegex(fixture.plist)}`));
  assert.match(callLog, /node .*smoke-http\.js/);
  assert.equal(await readlink(path.join(fixture.root, "state", "previous-current")), "releases/older");
});

test("daemon controller restores an absent predecessor pointer after first-release rollback", async t => {
  const fixture = await createReleaseRollbackFixture(t);
  await rm(path.join(fixture.rollbackDir, "previous-current"));
  await writeFile(path.join(fixture.rollbackDir, "previous-current.marker"), "absent\n");
  await run(path.join(fixture.root, "daemonctl.sh"), ["rollback-release"], {
    CODEX_JAVA_LSP_RUNTIME_DIR: fixture.root,
    LAUNCHCTL_BIN: fixture.launchctl,
    CURL_BIN: fixture.curl,
  });
  await assert.rejects(readlink(path.join(fixture.root, "state", "previous-current")), { code: "ENOENT" });
});

test("daemon controller fails closed before stopping a release without a complete predecessor configuration", async t => {
  const fixture = await createReleaseRollbackFixture(t);
  await rm(path.join(fixture.rollbackDir, "run.sh.marker"));
  await assert.rejects(
    run(path.join(fixture.root, "daemonctl.sh"), ["rollback-release"], {
      CODEX_JAVA_LSP_RUNTIME_DIR: fixture.root,
      LAUNCHCTL_BIN: fixture.launchctl,
      CURL_BIN: fixture.curl,
    }),
    /exited 2: No complete managed predecessor configuration/,
  );
  assert.equal(await readlink(path.join(fixture.root, "current")), "releases/new");
  await assert.rejects(readFile(fixture.calls, "utf8"), { code: "ENOENT" });
});

test("daemon controller fails closed before stopping when the predecessor lacks a managed instance identity", async t => {
  const fixture = await createReleaseRollbackFixture(t);
  const legacyState = fixture.oldState.replace("JAVA_LSP_HTTP_INSTANCE_ID=managed-old\n", "");
  await writeFile(path.join(fixture.rollbackDir, "daemon.env"), legacyState);
  await assert.rejects(
    run(path.join(fixture.root, "daemonctl.sh"), ["rollback-release"], {
      CODEX_JAVA_LSP_RUNTIME_DIR: fixture.root,
      LAUNCHCTL_BIN: fixture.launchctl,
      CURL_BIN: fixture.curl,
    }),
    /Predecessor managed state is incompatible with safe HTTP release rollback/,
  );
  assert.equal(await readlink(path.join(fixture.root, "current")), "releases/new");
  await assert.rejects(readFile(fixture.calls, "utf8"), { code: "ENOENT" });
});

async function createReleaseRollbackFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-java-lsp-release-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const rollbackDir = path.join(stateDir, "rollback-new");
  const binDir = path.join(root, "bin");
  const plist = path.join(root, "agent.plist");
  const calls = path.join(root, "calls.txt");
  const node = path.join(binDir, "node");
  const launchctl = path.join(binDir, "launchctl");
  const curl = path.join(binDir, "curl");
  await mkdir(path.join(root, "releases", "new", "dist"), { recursive: true });
  await mkdir(path.join(root, "releases", "old", "dist"), { recursive: true });
  await mkdir(path.join(root, "releases", "older", "dist"), { recursive: true });
  await mkdir(rollbackDir, { recursive: true });
  for (const version of ["new", "old"]) {
    const scripts = path.join(root, "releases", version, "scripts");
    await mkdir(scripts);
    await writeFile(path.join(scripts, "managed-owner-launcher.mjs"), `import {cp,rm} from 'node:fs/promises'; const [command,src,dst]=process.argv.slice(2); if(command==='replace'){await rm(dst,{recursive:true,force:true});await cp(src,dst,{recursive:true});}`);
  }
  await mkdir(path.join(rollbackDir, "launcher"));
  await writeFile(path.join(rollbackDir, "launcher/identity"), "old launcher\n");
  await mkdir(path.join(root, "launcher"));
  await writeFile(path.join(root, "launcher/identity"), "new launcher\n");
  await writeFile(path.join(rollbackDir, "launcher.marker"), "present\n");
  await mkdir(binDir);
  await symlink("releases/new", path.join(root, "current"));
  await symlink("releases/old", path.join(stateDir, "previous-current"));
  await symlink("releases/older", path.join(rollbackDir, "previous-current"));
  await writeFile(path.join(rollbackDir, "previous-current.marker"), "present\n");
  await writeFile(path.join(root, "releases", "new", "dist", "build-stamp.json"), '{"gitSha":"new"}\n');
  await writeFile(path.join(root, "releases", "old", "dist", "build-stamp.json"), '{"gitSha":"old"}\n');
  await writeFile(plist, "new plist\n");
  const oldState = [
    `RUNTIME_DIR_FROM_STATE=${shellValue(root)}`,
    "LAUNCH_AGENT_LABEL=com.example.codex-java-lsp",
    `LAUNCH_AGENT_PLIST=${shellValue(plist)}`,
    "JAVA_LSP_HTTP_PORT=38456",
    "JAVA_LSP_HTTP_INSTANCE_ID=managed-old",
    `NODE_BIN=${shellValue(node)}`,
  ].join("\n") + "\n";
  const newState = oldState.replace("JAVA_LSP_HTTP_PORT=38456", "JAVA_LSP_HTTP_PORT=6553").replace("managed-old", "managed-new");
  await writeFile(path.join(stateDir, "daemon.env"), newState);
  await writeFile(path.join(root, "run-daemon.sh"), "new daemon runner\n");
  await writeFile(path.join(root, "run.sh"), "new stdio runner\n");
  await writeFile(path.join(root, "daemonctl.sh"), await readFile(path.join(projectRoot, "daemonctl.sh"), "utf8"));
  await chmod(path.join(root, "daemonctl.sh"), 0o755);
  for (const [name, contents] of [
    ["daemon.env", oldState],
    ["target-launch-agent.plist", "old plist\n"],
    ["run-daemon.sh", "old daemon runner\n"],
    ["run.sh", "old stdio runner\n"],
    ["daemonctl.sh", await readFile(path.join(projectRoot, "daemonctl.sh"), "utf8")],
  ]) {
    await writeFile(path.join(rollbackDir, name), contents);
    await writeFile(path.join(rollbackDir, `${name}.marker`), "present\n");
  }
  await writeFile(launchctl, `#!/usr/bin/env bash
printf 'launchctl %s\\n' "$*" >> "${calls}"
if [[ "$1" == print ]]; then ${options.loaded ? "exit 0" : "exit 1"}; fi
if [[ "$1" == bootout ]]; then ${options.bootoutFails ? "exit 1" : "exit 0"}; fi
`);
  await writeFile(curl, `#!/usr/bin/env bash\nprintf 'curl %s\\n' "$*" >> "${calls}"\nprintf '{"status":"ok","instanceId":"managed-old"}'\n`);
  await writeFile(node, `#!/usr/bin/env bash\nprintf 'node %s\\n' "$*" >> "${calls}"\nif [[ "$1" == -e ]]; then printf 'old'; elif [[ "$1" == *managed-owner-launcher.mjs ]]; then exec "${process.execPath}" "$@"; fi\n`);
  await chmod(launchctl, 0o755);
  await chmod(curl, 0o755);
  await chmod(node, 0o755);
  return { root, rollbackDir, plist, calls, launchctl, curl, oldState, newState };
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${output}`)));
  });
}

function shellValue(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBashFunction(source, name) {
  const match = source.match(new RegExp(`^${escapeRegex(name)}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  if (!match) {
    throw new Error(`install-runtime.sh is missing ${name}()`);
  }
  return match[0];
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate an isolated HTTP test port."));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHttp(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The child process has not bound the isolated port yet.
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
