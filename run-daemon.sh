#!/usr/bin/env bash
# input: Installed managed environment, fixed native owner bundle, and immutable current release.
# output: Replaces this process with the current release's loopback HTTP daemon.
# pos: Manual entrypoint through the same native owner used by launchd.
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_DIR="$RUNTIME_DIR/current"
set -a
source "$RUNTIME_DIR/state/daemon.env"
set +a
export JAVA_LSP_HTTP_PORT JAVA_LSP_HTTP_INSTANCE_ID
export JAVA_LSP_CACHE_BASE JAVA_LSP_CACHE_ROOT JAVA_LSP_SERVICE_STATE_ROOT GRADLE_USER_HOME
RELEASE_DIR="$(cd "$CURRENT_DIR" && pwd -P)"
if [[ ! -f "$RELEASE_DIR/dist/http-server.js" || -z "${JAVA_LSP_HTTP_PORT:-}" ]]; then
  echo "Managed release or HTTP port is missing." >&2
  exit 1
fi
ulimit -n 65536 2>/dev/null || true
exec "$RUNTIME_DIR/launcher/dist/native/ilv2-mac" owner "$JAVA_LSP_CACHE_BASE" "$RELEASE_DIR/dist/http-server.js"
