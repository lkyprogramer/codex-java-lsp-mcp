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

exec node "$@"
