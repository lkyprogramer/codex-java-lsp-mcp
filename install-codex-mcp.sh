#!/usr/bin/env bash
# input: Local Java/JDT LS/Node environment plus optional runtime installer environment.
# output: Delegates to the user-level codex-java-lsp MCP runtime installer.
# pos: Compatibility entrypoint for installing the Codex MCP bridge.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/install-runtime.sh" "$@"
