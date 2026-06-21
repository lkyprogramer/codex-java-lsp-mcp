#!/usr/bin/env bash
# input: Codex MCP stdio invocation plus optional JAVA_LSP_* / JDTLS_* environment.
# output: Starts the built codex-java-lsp MCP server over stdio.
# pos: User-level runtime entrypoint; repo resolution happens inside the MCP server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS_NAME="$(uname -s 2>/dev/null || printf 'unknown')"

if [[ "$OS_NAME" != "Darwin" ]]; then
  echo "codex-java-lsp currently supports macOS only; detected $OS_NAME. Fall back to rg/build/log evidence." >&2
  exit 2
fi

if [[ ! -f "$SCRIPT_DIR/dist/server.js" ]]; then
  echo "Missing dist/server.js. Run npm install && npm run build in $SCRIPT_DIR first." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/dist/server.js"
