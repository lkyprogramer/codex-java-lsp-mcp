#!/usr/bin/env bash
# input: Stable runtime root with the current immutable release symlink.
# output: Replaces this process with the current release's advisory Codex hook.
# pos: Stable Codex hook target; the hook follows release changes without pointing at mutable dist/.
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_DIR="$RUNTIME_DIR/current"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "codex-java-lsp hook requires an absolute executable NODE_BIN." >&2
  exit 1
fi

if [[ ! -L "$CURRENT_DIR" || ! -f "$CURRENT_DIR/dist/hooks/hook-gate.js" ]]; then
  echo "codex-java-lsp hook current release is missing dist/hooks/hook-gate.js: $CURRENT_DIR" >&2
  exit 1
fi

exec "$NODE_BIN" "$CURRENT_DIR/dist/hooks/hook-gate.js"
