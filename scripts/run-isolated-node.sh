#!/bin/sh
# Clear host-controlled Node code-loading and writable-output selectors before
# the JavaScript isolation broker itself starts.
set -eu

unset NODE_OPTIONS
unset NODE_PATH
unset NODE_REPL_HISTORY
unset NODE_V8_COVERAGE
unset NODE_COMPILE_CACHE
unset NODE_REDIRECT_WARNINGS
unset NODE_TEST_CONTEXT

case "${ILV2_NODE_BIN:-}" in
  /*) ;;
  *) echo "ILV2_NODE_BIN must be the frozen absolute Node executable." >&2; exit 2 ;;
esac
case "${ILV2_RUNTIME_MANIFEST:-}" in
  /*) ;;
  *) echo "ILV2_RUNTIME_MANIFEST must be absolute." >&2; exit 2 ;;
esac
[ -x "$ILV2_NODE_BIN" ] || exit 2
bootstrap_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
"$ILV2_NODE_BIN" "$bootstrap_dir/ilv2-mac-runtime.mjs" --verify
exec "$ILV2_NODE_BIN" "$@"
