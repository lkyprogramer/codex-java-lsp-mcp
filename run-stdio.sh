#!/usr/bin/env bash
# input: Stable runtime root with current immutable release symlink.
# output: Replaces this process with the stdio server from the current release.
# pos: Compatibility entrypoint for pre-HTTP Codex registrations and generated rollback commands.
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_DIR="$RUNTIME_DIR/current"

if [[ ! -L "$CURRENT_DIR" || ! -x "$CURRENT_DIR/run.sh" ]]; then
  echo "codex-java-lsp stdio current release is missing run.sh: $CURRENT_DIR" >&2
  exit 1
fi

exec "$CURRENT_DIR/run.sh"
