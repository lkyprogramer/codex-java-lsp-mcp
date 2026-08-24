# Shared HTTP daemon canary runbook

This runbook is deliberately isolated from the installed `codex-java-lsp` stdio MCP. Do not use an existing Java worktree, its cache, or its ownership directory for this canary.

## Preconditions

- The source worktree passes `npm run build`, `npm test`, and `npm audit --omit=dev`.
- The existing Codex registration remains stdio. Do **not** call the production `--activate-http` path for this canary.
- Create a temporary Java fixture containing an empty `projects.json`; only enable LSP for that fixture if semantic validation is intended.
- Pick two unused ports: one fixed daemon port and one distinct candidate port.

## Isolated managed daemon

Use a separate runtime, LaunchAgent label, logs, cache, ownership directory, and Codex home. The explicit `CODEX_HOME` prevents `codex mcp add` from changing the normal user configuration.

`install-runtime.sh` additionally isolates both its candidate smoke process and
release test suite into separate installer-created temporary cache, ownership,
projects, XDG, `CODEX_HOME` and `HOME` roots, then removes each exact temporary root
after that process stops. The explicit canary paths below are therefore
reserved for the managed daemon only.

```bash
CANARY_ROOT="$(mktemp -d /tmp/codex-java-lsp-canary.XXXXXX)"
CANARY_PORT=38456                 # replace with an unused port
CANARY_CANDIDATE_PORT=38457       # must differ from CANARY_PORT
CANARY_LABEL="com.lky.codex-java-lsp-mcp.canary.$CANARY_PORT"

mkdir -p "$CANARY_ROOT/cache" "$CANARY_ROOT/ownership" "$CANARY_ROOT/codex-home" "$CANARY_ROOT/LaunchAgents" \
  "$CANARY_ROOT/fixture/src/main/java/canary"
printf '{"aliases":[]}\n' > "$CANARY_ROOT/projects.json"
printf '<project><modelVersion>4.0.0</modelVersion></project>\n' > "$CANARY_ROOT/fixture/pom.xml"
printf 'package canary; class Fixture {}\n' > "$CANARY_ROOT/fixture/src/main/java/canary/Fixture.java"

CODEX_JAVA_LSP_RUNTIME_DIR="$CANARY_ROOT/runtime" \
CODEX_JAVA_LSP_LOG_DIR="$CANARY_ROOT/logs" \
CODEX_JAVA_LSP_LAUNCH_AGENTS_DIR="$CANARY_ROOT/LaunchAgents" \
CODEX_JAVA_LSP_LAUNCH_AGENT_LABEL="$CANARY_LABEL" \
JAVA_LSP_HTTP_PORT="$CANARY_PORT" \
JAVA_LSP_HTTP_CANARY_PORT="$CANARY_CANDIDATE_PORT" \
JAVA_LSP_CACHE_BASE="$CANARY_ROOT/cache" \
JAVA_LSP_OWNERSHIP_BASE="$CANARY_ROOT/ownership" \
JAVA_LSP_PROJECTS_JSON="$CANARY_ROOT/projects.json" \
./install-runtime.sh

"$CANARY_ROOT/runtime/daemonctl.sh" status
"$CANARY_ROOT/runtime/daemonctl.sh" smoke
```

`daemon.env` contains an installer-generated `JAVA_LSP_HTTP_INSTANCE_ID`. Its
value must equal `/healthz.instanceId`; this proves the fixed port belongs to
the current canary release rather than a residual process:

```bash
CANARY_INSTANCE_ID="$(bash -c 'source "$1"; printf "%s" "$JAVA_LSP_HTTP_INSTANCE_ID"' _ "$CANARY_ROOT/runtime/state/daemon.env")"
curl --fail --silent "http://127.0.0.1:$CANARY_PORT/healthz" |
  node -e 'const expected=process.argv[1]; let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { const health=JSON.parse(input); if (health.status !== "ok" || health.instanceId !== expected) process.exit(1); });' \
  "$CANARY_INSTANCE_ID"
```

At this point the normal Codex MCP registration must still be untouched. The installer creates an HTTP daemon only; it has not run `codex mcp remove` or `codex mcp add`.

## Isolated Codex CLI registration

Only after the managed daemon health and smoke succeed, register it in the temporary Codex home:

```bash
CODEX_HOME="$CANARY_ROOT/codex-home" \
codex mcp add codex-java-lsp --url "http://127.0.0.1:$CANARY_PORT/mcp"

CODEX_HOME="$CANARY_ROOT/codex-home" \
CODEX_JAVA_LSP_RUNTIME_DIR="$CANARY_ROOT/runtime" \
./check-codex-mcp.sh --fast
```

If the CLI canary must run non-interactively, add this only to
`$CANARY_ROOT/codex-home/config.toml` (never to the normal Codex home):

```toml
approvals_reviewer = "auto_review"

[mcp_servers.codex-java-lsp]
approval_mode = "auto"
```

Use the temporary `CODEX_HOME` registration to prove the CLI config shape only. It may not contain the
user's OAuth credentials, so do not copy credentials or any normal Codex state into it just to run a
task. For the real CLI host gate, run a fresh ephemeral task with `--ignore-user-config` and an
in-memory one-shot MCP override; authentication continues to use the normal authenticated CLI, but
no normal config file is read or written and the only MCP server is the canary URL:

```bash
codex exec --ephemeral --ignore-user-config --approve-for-me \
  --skip-git-repo-check -C "$CANARY_ROOT/fixture" \
  -c 'mcp_servers.codex-java-lsp={url="http://127.0.0.1:'"$CANARY_PORT"'/mcp"}' \
  'Use only codex-java-lsp MCP tools. Call java_status with this exact repoRoot and start=true.'
```

Preserve the task identifier, Codex/CLI version, daemon build SHA, and response evidence. The task
must prove 7 tools, `java_status(start=true)`, a fast-path tool call, client close, and a call after
the daemon is restarted. It is not enough to create a new SDK client.

```bash
"$CANARY_ROOT/runtime/daemonctl.sh" restart
"$CANARY_ROOT/runtime/daemonctl.sh" smoke
```

## Crash and worktree gates

Use only the canary PID and port:

```bash
CANARY_JDT_PID="$(node "$CANARY_ROOT/runtime/current/dist/smoke-http.js" \
  --url "http://127.0.0.1:$CANARY_PORT/mcp" \
  --repo-root "$CANARY_ROOT/fixture" --start \
  | node -e 'let text=""; process.stdin.on("data", c => text += c); process.stdin.on("end", () => { const result=JSON.parse(text); if (!Number.isInteger(result.jdtlsPid)) process.exit(1); process.stdout.write(String(result.jdtlsPid)); });')"
CANARY_PID="$(launchctl print "gui/$(id -u)/$CANARY_LABEL" | awk '/^[[:space:]]*pid = [0-9]+/{print $3; exit}')"
kill -9 "$CANARY_PID"
"$CANARY_ROOT/runtime/daemonctl.sh" wait-ready
node "$CANARY_ROOT/runtime/current/dist/smoke-http.js" \
  --url "http://127.0.0.1:$CANARY_PORT/mcp" \
  --repo-root "$CANARY_ROOT/fixture" --start
if kill -0 "$CANARY_JDT_PID" 2>/dev/null; then
  echo "Old JDT PID survived daemon crash recovery: $CANARY_JDT_PID" >&2
  exit 1
fi
```

For worktree validation, use two linked worktrees made from a disposable fixture. Validate all of the following:

1. Two clients using one canonical root share a single runtime.
2. Two linked worktrees get different repo hashes, JDT data roots, SourceIndex roots, watcher roots, and ownership leases.
3. Neither canary client performs a semantic call while a stdio owner still holds that fixture root.
4. JDT count stays within `JAVA_LSP_MAX_ACTIVE_REPOS`.

## Desktop release gate

Desktop is not covered by an SDK smoke or an isolated `codex mcp` config. Before production activation, a user must create a **new** Desktop/Codex task and record:

1. all seven tools listed and callable;
2. a call after the old 15-minute idle window;
3. a call after `kill -9` and launchd recovery;
4. two tasks on one disposable worktree and two tasks on different linked worktrees;
5. config change followed by the required Desktop restart.

If any item fails, keep the stdio idle-TTL hotfix active. Do not try to run stdio and HTTP semantic calls against the same canonical root as a fallback. Before production activation, write an attestation JSON outside the runtime (a protected release-evidence directory is recommended) using this exact schema, replacing the placeholders with the actual records:

```json
{
  "schemaVersion": 1,
  "buildSha": "<daemon health buildSha>",
  "instanceId": "<daemon health instanceId>",
  "attestedAt": "<ISO-8601 timestamp>",
  "codexCli": { "taskId": "<fresh CLI task id>", "allSevenTools": true, "restartRecovery": true, "crashRecovery": true },
  "codexDesktop": { "taskId": "<fresh Desktop task id>", "allSevenTools": true, "restartRecovery": true, "crashRecovery": true, "idleWindowRecovery": true },
  "oldStdioOwnersCleared": true,
  "worktreeIsolationVerified": true
}
```

The installer rejects missing, stale, or mismatched evidence. It never treats an SDK-only smoke as a substitute for a Codex host task.

## Cleanup and rollback

```bash
"$CANARY_ROOT/runtime/daemonctl.sh" stop
launchctl bootout "gui/$(id -u)/$CANARY_LABEL" 2>/dev/null || true
```

Remove or archive the canary root only after confirming its LaunchAgent is no longer loaded. The production stdio registration, projects configuration, cache, and ownership data remain untouched.
