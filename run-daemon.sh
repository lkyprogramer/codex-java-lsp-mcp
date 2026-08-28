#!/usr/bin/env bash
# input: Stable runtime root with current release symlink and launchd-provided absolute Node/JDT LS paths.
# output: Replaces this process with the current release's loopback HTTP daemon.
# pos: Stable LaunchAgent target; releases are never executed through a mutable release path.
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_DIR="$RUNTIME_DIR/current"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "codex-java-lsp daemon requires an absolute executable NODE_BIN." >&2
  exit 1
fi

if [[ ! -L "$CURRENT_DIR" || ! -f "$CURRENT_DIR/dist/http-server.js" ]]; then
  echo "codex-java-lsp daemon current release is missing dist/http-server.js: $CURRENT_DIR" >&2
  exit 1
fi

if [[ -z "${JAVA_LSP_HTTP_PORT:-}" ]]; then
  echo "codex-java-lsp daemon requires JAVA_LSP_HTTP_PORT." >&2
  exit 1
fi

# Pin watchers plus JavaIndex verification can hold thousands of source FDs;
# the default macOS nofile (often 256/10240) makes spawn() fail with EBADF.
ulimit -n 65536 2>/dev/null || true

# 768 caps the HTTP isolate only. JavaIndex runs in forked children with
# --max-old-space-size=1536; Worker threads would inherit 768 and a hydrate
# OOM would abort this daemon.
# FSX0: 12 FATALs peaked at 848MB with JsonStringify on the native stack.
# Do not raise to 1024 unless a post-FSX1 near-heap snapshot names a new
# legitimate retainer. --heapsnapshot-near-heap-limit is evidence-only.
exec "$NODE_BIN" --max-old-space-size=768 "$CURRENT_DIR/dist/http-server.js"
