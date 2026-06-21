#!/usr/bin/env bash
# input: A project id and absolute Java repo root.
# output: Upserts ~/.config/codex-java-lsp/projects.json with an optional LSP allowlist entry.
# pos: Small operator helper for explicit per-project LSP enablement.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./register-alias.sh --enable-lsp <id> <absolute-root> [--layout-profile ddd-gradle|maven-reactor|generic-java]
  ./register-alias.sh --disable-lsp <id> <absolute-root> [--layout-profile ddd-gradle|maven-reactor|generic-java]

Environment:
  JAVA_LSP_PROJECTS_JSON  Override config path. Defaults to ~/.config/codex-java-lsp/projects.json.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 3 ]]; then
  usage >&2
  exit 2
fi

mode="$1"
id="$2"
root="$3"
layout_profile=""
shift 3

case "$mode" in
  --enable-lsp)
    enabled="true"
    ;;
  --disable-lsp)
    enabled="false"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

while [[ $# -gt 0 ]]; do
  case "$1" in
    --layout-profile)
      layout_profile="${2:-}"
      shift 2
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

node --input-type=module - "$id" "$root" "$enabled" "$layout_profile" <<'NODE'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const [, , id, inputRoot, enabledRaw, layoutProfile] = process.argv;
if (!path.isAbsolute(inputRoot)) {
  throw new Error(`root must be absolute: ${inputRoot}`);
}
if (!existsSync(inputRoot)) {
  throw new Error(`root does not exist: ${inputRoot}`);
}
if (layoutProfile && !["ddd-gradle", "maven-reactor", "generic-java"].includes(layoutProfile)) {
  throw new Error(`invalid layout profile: ${layoutProfile}`);
}

const configPath = process.env.JAVA_LSP_PROJECTS_JSON || path.join(homedir(), ".config", "codex-java-lsp", "projects.json");
const root = realpathSync.native(inputRoot);
const existingContent = existsSync(configPath) ? readFileSync(configPath, "utf8").trim() : "";
const config = existsSync(configPath)
  ? (existingContent ? JSON.parse(existingContent) : { aliases: [], defaults: {} })
  : { aliases: [], defaults: {} };
config.aliases ||= [];
config.defaults ||= {};

const existingIndex = config.aliases.findIndex(alias => alias.id === id);
const next = {
  id,
  root,
  lspEnabled: enabledRaw === "true",
  ...(layoutProfile ? { layoutProfile } : {})
};
if (existingIndex >= 0) {
  config.aliases[existingIndex] = { ...config.aliases[existingIndex], ...next };
} else {
  config.aliases.push(next);
}

mkdirSync(path.dirname(configPath), { recursive: true });
const tmpPath = `${configPath}.${process.pid}.tmp`;
writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`);
renameSync(tmpPath, configPath);
console.error(`Updated ${configPath}`);
console.log(JSON.stringify(next));
NODE
