#!/usr/bin/env bash
# input: Local Codex/JDT LS/Node environment and optional repo selector.
# output: Fast readiness verdict or MCP smoke result for codex-java-lsp.
# pos: Doctor script agents run before deciding whether to use Java LSP tools.
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
  ./check-codex-mcp.sh [--fast|--smoke] [--repo-root <absolute-root> | --alias <id>] [--require-lsp]

Modes:
  --fast         Check local prerequisites and Codex MCP registration. Default.
  --smoke        Start the MCP server, list tools, call java_status, then java_shutdown.
  --require-lsp  In --smoke mode, call java_status(start=true). The repo/alias must be LSP-enabled.

Exit codes:
  0  The requested check passed.
  2  The MCP/LSP capability is unavailable; fall back to rg/build/log evidence.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast)
      MODE="fast"
      shift
      ;;
    --smoke)
      MODE="smoke"
      shift
      ;;
    --repo-root)
      REPO_ROOT="${2:-}"
      shift 2
      ;;
    --alias)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --require-lsp)
      REQUIRE_LSP="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

ok() {
  printf 'OK   %s\n' "$1"
}

warn() {
  warnings=$((warnings + 1))
  printf 'WARN %s\n' "$1"
}

fail() {
  failures=$((failures + 1))
  printf 'FAIL %s\n' "$1"
}

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    ok "$name found: $(command -v "$name")"
  else
    fail "$name not found"
  fi
}

if [[ -n "$REPO_ROOT" && -n "$PROJECT_ID" ]]; then
  fail "--repo-root and --alias are mutually exclusive"
fi

OS_NAME="$(uname -s 2>/dev/null || printf 'unknown')"
if [[ "$OS_NAME" != "Darwin" ]]; then
  printf 'NOT READY: codex-java-lsp currently supports macOS only; detected %s.\n' "$OS_NAME"
  exit 2
fi
ok "platform supported: macOS"

check_command node
check_command npm
check_command codex

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

if [[ -x "$SCRIPT_DIR/run.sh" ]]; then
  ok "local run.sh executable"
else
  fail "local run.sh is missing or not executable: $SCRIPT_DIR/run.sh"
fi

if [[ -f "$SCRIPT_DIR/dist/server.js" ]]; then
  ok "local build artifact exists: $SCRIPT_DIR/dist/server.js"
else
  warn "local dist/server.js missing; run npm run build for local smoke"
fi

if command -v codex >/dev/null 2>&1; then
  mcp_output="$(codex mcp get "$SERVER_NAME" 2>&1)"
  mcp_status=$?
  if [[ $mcp_status -eq 0 ]]; then
    ok "Codex MCP server registered: $SERVER_NAME"
    if printf '%s\n' "$mcp_output" | grep -q 'enabled: true'; then
      ok "Codex MCP server enabled"
    else
      fail "Codex MCP server is not enabled: $SERVER_NAME"
    fi
    registered_command="$(printf '%s\n' "$mcp_output" | awk -F': ' '/command:/ {print $2; exit}')"
    if [[ -n "$registered_command" && -x "$registered_command" ]]; then
      ok "registered command executable: $registered_command"
      registered_command_dir="$(cd "$(dirname "$registered_command")" && pwd)"
      if [[ -f "$registered_command_dir/dist/server.js" ]]; then
        ok "registered runtime built: $registered_command_dir/dist/server.js"
      else
        fail "registered runtime missing dist/server.js; run: $SCRIPT_DIR/install-runtime.sh"
      fi
      if [[ "$registered_command" != "$RUNTIME_DIR/run.sh" && "$registered_command" != "$SCRIPT_DIR/run.sh" ]]; then
        warn "registered command uses a non-default runtime: $registered_command"
      fi
    else
      fail "registered command is missing or not executable: ${registered_command:-<empty>}"
    fi
  else
    warn "Codex MCP server not registered yet: $SERVER_NAME"
  fi
fi

if [[ $failures -ne 0 ]]; then
  printf '\nNOT READY: %s failure(s), %s warning(s). Fall back to rg/build/log evidence.\n' "$failures" "$warnings"
  exit 2
fi

if [[ "$MODE" == "smoke" ]]; then
  printf '\nRunning MCP smoke test...\n'
  env_args=(
    "JDTLS_BIN=$JDTLS_BIN"
    "JAVA_LSP_SMOKE_START=$REQUIRE_LSP"
  )
  if [[ -n "$REPO_ROOT" ]]; then
    env_args+=("JAVA_LSP_SMOKE_REPO_ROOT=$REPO_ROOT")
  fi
  if [[ -n "$PROJECT_ID" ]]; then
    env_args+=("JAVA_LSP_SMOKE_PROJECT_ID=$PROJECT_ID")
  fi
  if (cd "$SCRIPT_DIR" && env "${env_args[@]}" npm run smoke); then
    ok "MCP smoke test passed"
  else
    fail "MCP smoke test failed"
  fi
fi

if [[ $failures -ne 0 ]]; then
  printf '\nNOT READY: %s failure(s), %s warning(s). Fall back to rg/build/log evidence.\n' "$failures" "$warnings"
  exit 2
fi

printf '\nREADY: codex-java-lsp checks passed with %s warning(s).\n' "$warnings"
printf 'Enable a project with: ./register-alias.sh --enable-lsp <id> <absolute-root>\n'
