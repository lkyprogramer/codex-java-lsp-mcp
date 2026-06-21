#!/usr/bin/env bash
set -euo pipefail

runtime_dir="${CODEX_JAVA_LSP_RUNTIME_DIR:-$HOME/Library/Application Support/codex-java-lsp-mcp}"
hook="$runtime_dir/dist/hooks/hook-gate.js"
quoted_hook="'${hook//\'/\'\\\'\'}'"
command="node $quoted_hook"

cat <<JSON
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "$command",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
JSON
