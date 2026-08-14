#!/usr/bin/env bash
# input: Current Codex MCP registration, optional repo selector, and installed runtime state.
# output: Transport-aware readiness verdict or explicit stdio/managed-HTTP smoke result.
# pos: Doctor command; HTTP checks only connect to the managed daemon and never start an ad-hoc server.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_NAME="${SERVER_NAME:-codex-java-lsp}"
RUNTIME_DIR="${CODEX_JAVA_LSP_RUNTIME_DIR:-$HOME/Library/Application Support/codex-java-lsp-mcp}"
MODE="fast"
REPO_ROOT=""
PROJECT_ID=""
REQUIRE_LSP="false"
failures=0
warnings=0

usage() {
  cat <<'EOF'
Usage:
  ./check-codex-mcp.sh [--fast|--smoke|--stdio-smoke] [--repo-root <absolute-root> | --alias <id>] [--require-lsp]

Modes:
  --fast          Verify the active registration without starting a process. Default.
  --smoke         For HTTP, connect to the already managed daemon. For stdio, run compatibility smoke.
  --stdio-smoke   Explicitly spawn the stdio compatibility smoke, even if HTTP is registered.
  --require-lsp   In smoke mode, request java_status(start=true) for an explicit repo/alias.

Exit codes:
  0  The requested check passed.
  2  The MCP/LSP capability is unavailable; fall back to rg/build/log evidence.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) MODE="fast"; shift ;;
    --smoke) MODE="smoke"; shift ;;
    --stdio-smoke) MODE="stdio-smoke"; shift ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --alias) PROJECT_ID="${2:-}"; shift 2 ;;
    --require-lsp) REQUIRE_LSP="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

ok() { printf 'OK   %s\n' "$1"; }
warn() { warnings=$((warnings + 1)); printf 'WARN %s\n' "$1"; }
fail() { failures=$((failures + 1)); printf 'FAIL %s\n' "$1"; }

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    ok "$name found: $(command -v "$name")"
  else
    fail "$name not found"
  fi
}

json_field() {
  local expression="$1"
  node -e "let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => input += part); process.stdin.on('end', () => { const value = JSON.parse(input); const result = ($expression); if (typeof result !== 'string') process.exit(3); process.stdout.write(result); });"
}

run_stdio_smoke() {
  local runtime="$1"
  if [[ ! -f "$runtime/dist/smoke.js" || ! -f "$runtime/dist/server.js" ]]; then
    fail "stdio compatibility runtime is not built: $runtime"
    return
  fi
  local env_args=("JDTLS_BIN=$JDTLS_BIN" "JAVA_LSP_SMOKE_START=$REQUIRE_LSP")
  if [[ -n "$REPO_ROOT" ]]; then env_args+=("JAVA_LSP_SMOKE_REPO_ROOT=$REPO_ROOT"); fi
  if [[ -n "$PROJECT_ID" ]]; then env_args+=("JAVA_LSP_SMOKE_PROJECT_ID=$PROJECT_ID"); fi
  if env "${env_args[@]}" "$NODE_BIN" "$runtime/dist/smoke.js"; then
    ok "stdio MCP compatibility smoke passed"
  else
    fail "stdio MCP compatibility smoke failed"
  fi
}

if [[ -n "$REPO_ROOT" && -n "$PROJECT_ID" ]]; then
  fail "--repo-root and --alias are mutually exclusive"
fi
if [[ "$REQUIRE_LSP" == "true" && -z "$REPO_ROOT" && -z "$PROJECT_ID" ]]; then
  fail "--require-lsp requires --repo-root or --alias"
fi

OS_NAME="$(uname -s 2>/dev/null || printf 'unknown')"
if [[ "$OS_NAME" != "Darwin" ]]; then
  printf 'NOT READY: codex-java-lsp currently supports macOS only; detected %s.\n' "$OS_NAME"
  exit 2
fi
ok "platform supported: macOS"

for command_name in node codex curl; do check_command "$command_name"; done
if [[ "$MODE" == "stdio-smoke" ]]; then check_command npm; fi
NODE_BIN="$(command -v node 2>/dev/null || true)"

JDTLS_BIN="${JDTLS_BIN:-$(command -v jdtls 2>/dev/null || true)}"
if [[ -n "$JDTLS_BIN" && -x "$JDTLS_BIN" ]]; then
  ok "jdtls found: $JDTLS_BIN"
else
  fail "jdtls not found or not executable; install with: brew install jdtls"
fi

if java_line="$(java -version 2>&1 | head -n 1)"; then
  ok "java available: $java_line"
else
  fail "java is not available"
fi

if [[ -z "$NODE_BIN" ]] || ! command -v codex >/dev/null 2>&1; then
  fail "Cannot inspect Codex MCP registration without node and codex."
  printf '\nNOT READY: %s failure(s), %s warning(s). Fall back to rg/build/log evidence.\n' "$failures" "$warnings"
  exit 2
fi

mcp_json="$(codex mcp get "$SERVER_NAME" --json 2>&1)"
mcp_status=$?
if [[ $mcp_status -ne 0 ]]; then
  fail "Codex MCP server is not registered: $SERVER_NAME"
  printf '\nNOT READY: %s failure(s), %s warning(s). Fall back to rg/build/log evidence.\n' "$failures" "$warnings"
  exit 2
fi

transport_type="$(printf '%s' "$mcp_json" | json_field 'value.transport?.type')" || {
  fail "Codex MCP registration is malformed: $SERVER_NAME"
  transport_type=""
}

if [[ "$transport_type" == "streamable_http" ]]; then
  http_url="$(printf '%s' "$mcp_json" | json_field 'value.transport?.url')" || http_url=""
  if [[ -z "$http_url" ]]; then
    fail "HTTP MCP registration has no URL."
  elif ! "$NODE_BIN" -e '
    const url = new URL(process.argv[1]);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) process.exit(1);
  ' "$http_url"; then
    fail "HTTP MCP URL is not an exact loopback /mcp endpoint: $http_url"
  else
    ok "Codex MCP uses managed HTTP: $http_url"
  fi

  state_file="$RUNTIME_DIR/state/daemon.env"
  if [[ ! -f "$state_file" ]]; then
    fail "managed HTTP state is missing: $state_file"
  else
    # This is installer-owned mode-0600 state, not an arbitrary config file.
    # shellcheck disable=SC1090
    source "$state_file"
    expected_url="http://127.0.0.1:${JAVA_LSP_HTTP_PORT:-}/mcp"
    if [[ "$http_url" != "$expected_url" ]]; then
      fail "Codex HTTP URL differs from managed fixed port: expected $expected_url"
    fi
    if [[ ! -f "$RUNTIME_DIR/current/dist/http-server.js" ]]; then
      fail "current immutable HTTP release is missing dist/http-server.js"
    else
      ok "current immutable HTTP release is built"
    fi
    if [[ ! -f "${LAUNCH_AGENT_PLIST:-}" ]]; then
      fail "LaunchAgent plist is missing: ${LAUNCH_AGENT_PLIST:-<empty>}"
    elif launchctl print "gui/$UID/${LAUNCH_AGENT_LABEL:-}" >/dev/null 2>&1; then
      ok "LaunchAgent loaded: ${LAUNCH_AGENT_LABEL:-}"
    else
      fail "LaunchAgent is not loaded: ${LAUNCH_AGENT_LABEL:-}"
    fi
    health_url="http://127.0.0.1:${JAVA_LSP_HTTP_PORT:-}/healthz"
    if health_payload="$(curl --fail --silent --show-error --max-time 2 "$health_url")"; then
      expected_build="$("$NODE_BIN" -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).gitSha)' "$RUNTIME_DIR/current/dist/build-stamp.json" 2>/dev/null || true)"
      health_build="$(printf '%s' "$health_payload" | "$NODE_BIN" -e '
        const expectedInstance = process.argv[1];
        let input = "";
        process.stdin.on("data", part => input += part);
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          if (typeof value.buildSha !== "string" || value.status !== "ok" || value.instanceId !== expectedInstance) process.exit(1);
          process.stdout.write(value.buildSha);
        });
      ' "${JAVA_LSP_HTTP_INSTANCE_ID:-}" 2>/dev/null || true)"
      if [[ -z "$health_build" ]]; then
        fail "HTTP daemon health response is malformed or belongs to a different managed instance."
      elif [[ "$health_build" != "$expected_build" ]]; then
        fail "HTTP daemon build SHA differs from current release: daemon=$health_build current=$expected_build"
      else
        ok "HTTP daemon healthy with current build: $health_build"
      fi
    else
      fail "HTTP daemon down: $health_url"
    fi

    if [[ "$MODE" == "smoke" && $failures -eq 0 ]]; then
      smoke_args=("$RUNTIME_DIR/current/dist/smoke-http.js" --url "$http_url" --expect-build "$expected_build")
      if [[ -n "$REPO_ROOT" ]]; then smoke_args+=(--repo-root "$REPO_ROOT"); fi
      if [[ -n "$PROJECT_ID" ]]; then smoke_args+=(--project-id "$PROJECT_ID"); fi
      if [[ "$REQUIRE_LSP" == "true" ]]; then smoke_args+=(--start); fi
      if "$NODE_BIN" "${smoke_args[@]}"; then
        ok "managed HTTP MCP smoke passed"
      else
        if [[ "$REQUIRE_LSP" == "true" ]]; then
          fail "managed HTTP semantic smoke failed (JDT unavailable or selector rejected)"
        else
          fail "managed HTTP MCP smoke failed"
        fi
      fi
    fi
    if [[ "$MODE" == "stdio-smoke" && $failures -eq 0 ]]; then
      run_stdio_smoke "$RUNTIME_DIR/current"
    fi
  fi
elif [[ "$transport_type" == "stdio" ]]; then
  registered_command="$(printf '%s' "$mcp_json" | json_field 'value.transport?.command')" || registered_command=""
  if [[ -n "$registered_command" && -x "$registered_command" ]]; then
    ok "Codex MCP uses stdio command: $registered_command"
    registered_dir="$(cd "$(dirname "$registered_command")" && pwd)"
    if [[ -f "$registered_dir/dist/server.js" || -f "$registered_dir/current/dist/server.js" ]]; then
      ok "registered stdio runtime is built"
    else
      fail "registered stdio runtime is missing dist/server.js"
    fi
  else
    fail "registered stdio command is missing or not executable: ${registered_command:-<empty>}"
  fi
  if [[ "$MODE" == "smoke" || "$MODE" == "stdio-smoke" ]]; then
    run_stdio_smoke "$SCRIPT_DIR"
  fi
else
  fail "Unsupported Codex MCP transport: ${transport_type:-<empty>}"
fi

if [[ $failures -ne 0 ]]; then
  printf '\nNOT READY: %s failure(s), %s warning(s). Fall back to rg/build/log evidence.\n' "$failures" "$warnings"
  exit 2
fi

printf '\nREADY: codex-java-lsp checks passed with %s warning(s).\n' "$warnings"
if [[ "$transport_type" == "streamable_http" ]]; then
  printf 'Managed daemon control: %s/daemonctl.sh status\n' "$RUNTIME_DIR"
else
  printf 'Enable a project with: ./register-alias.sh --enable-lsp <id> <absolute-root>\n'
fi
