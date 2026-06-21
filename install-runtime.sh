#!/usr/bin/env bash
# input: Local Java/JDT LS/Node environment plus optional CODEX_JAVA_LSP_RUNTIME_DIR.
# output: Builds one user-level MCP runtime and registers the codex-java-lsp Codex MCP server.
# pos: One-time installer shared by all explicitly enabled Java projects/worktrees.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_NAME="${SERVER_NAME:-codex-java-lsp}"
JDTLS_BIN="${JDTLS_BIN:-$(command -v jdtls || true)}"
RUNTIME_DIR="${CODEX_JAVA_LSP_RUNTIME_DIR:-$HOME/Library/Application Support/codex-java-lsp-mcp}"
OS_NAME="$(uname -s 2>/dev/null || printf 'unknown')"

if [[ "$OS_NAME" != "Darwin" ]]; then
  echo "codex-java-lsp currently supports macOS only; detected $OS_NAME." >&2
  exit 1
fi

for command_name in node npm codex; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required." >&2
    exit 1
  fi
done

if [[ -z "$JDTLS_BIN" ]]; then
  echo "jdtls was not found. Install it with: brew install jdtls" >&2
  exit 1
fi

echo "Java: $(java -version 2>&1 | head -n 1 || true)" >&2
echo "JDT LS: $JDTLS_BIN" >&2
echo "MCP runtime: $RUNTIME_DIR" >&2
echo "Projects config: ${JAVA_LSP_PROJECTS_JSON:-$HOME/.config/codex-java-lsp/projects.json}" >&2

mkdir -p "$RUNTIME_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude .nyc_output \
  --exclude .npm \
  --exclude "*.tsbuildinfo" \
  --exclude "*.tgz" \
  --exclude "*.log" \
  --exclude ".env" \
  --exclude ".env.*" \
  "$SCRIPT_DIR/" "$RUNTIME_DIR/"

cd "$RUNTIME_DIR"
rm -rf dist
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
npm run build

chmod +x "$RUNTIME_DIR/run.sh" "$RUNTIME_DIR/install-hook.sh" "$RUNTIME_DIR/register-alias.sh"
if [[ -f "$RUNTIME_DIR/dist/hooks/hook-gate.js" ]]; then
  chmod +x "$RUNTIME_DIR/dist/hooks/hook-gate.js"
fi

codex mcp remove "$SERVER_NAME" >/dev/null 2>&1 || true

CODEX_ARGS=(
  mcp add "$SERVER_NAME"
  --env "JDTLS_BIN=$JDTLS_BIN"
)

for env_name in \
  JAVA_HOME \
  JDTLS_JAVA_HOME \
  JAVA_LSP_PROJECTS_JSON \
  JAVA_LSP_PROJECT_JAVA_HOME \
  JDTLS_EXTRA_ARGS \
  JAVA_LSP_JDTLS_XMX \
  JAVA_LSP_MAX_ACTIVE_REPOS \
  JAVA_LSP_IDLE_TTL_MS \
  JAVA_LSP_AUTOBUILD \
  JAVA_LSP_IMPORT_CONCURRENCY \
  JAVA_LSP_RG_CONCURRENCY \
  JAVA_LSP_DOCUMENT_SYMBOL_TIMEOUT_MS \
  JAVA_LSP_DOCUMENT_SYMBOL_ATTEMPT_TIMEOUT_MS \
  JAVA_LSP_DOCUMENT_SYMBOL_GLOBAL_CONCURRENCY \
  JAVA_LSP_DOCUMENT_SYMBOL_PER_REPO_CONCURRENCY \
  JAVA_LSP_PROGRESS_IDLE_MS \
  JAVA_LSP_MIN_SEMANTIC_WAIT_MS \
  JAVA_LSP_LOMBOK_JAR \
  JDTLS_FILEWATCH
do
  if [[ -n "${!env_name:-}" ]]; then
    CODEX_ARGS+=(--env "$env_name=${!env_name}")
  fi
done

CODEX_ARGS+=(-- "$RUNTIME_DIR/run.sh")
codex "${CODEX_ARGS[@]}"

echo "Registered Codex MCP server: $SERVER_NAME" >&2
echo "Runtime installed at: $RUNTIME_DIR" >&2
echo "Enable projects with: $RUNTIME_DIR/register-alias.sh --enable-lsp <id> <absolute-root>" >&2
