#!/usr/bin/env bash
# input: Source checkout and frozen Node/native identity.
# output: Immutable release and native-owner managed loopback daemon.
# pos: User-level installer; it never mutates a running release or changes Codex MCP transport by default.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${CODEX_JAVA_LSP_RUNTIME_DIR:-$HOME/Library/Application Support/codex-java-lsp-mcp}"
LAUNCH_AGENTS_DIR="${CODEX_JAVA_LSP_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${CODEX_JAVA_LSP_LOG_DIR:-$HOME/Library/Logs/codex-java-lsp-mcp}"
LAUNCH_AGENT_LABEL="${CODEX_JAVA_LSP_LAUNCH_AGENT_LABEL:-com.lky.codex-java-lsp-mcp}"
HTTP_PORT="${JAVA_LSP_HTTP_PORT:-38456}"
HTTP_CANARY_PORT="${JAVA_LSP_HTTP_CANARY_PORT:-38457}"
PREFLIGHT_RUNTIME="false"

usage() {
  cat <<'EOF'
Usage: ./install-runtime.sh [--port <fixed-port>] [--canary-port <candidate-port>]
       ./install-runtime.sh --preflight-runtime

ILV2_NODE_BIN and ILV2_RUNTIME_MANIFEST must identify the frozen runtime.
ILV2_CODESIGN_IDENTITY must identify a stable launcher signing identity.
The installer never changes Codex MCP registration.

A release copy excludes eval dumps (artifacts/, graphify-out/, .workflow/). After a
successful current switch the installer keeps current plus previous-current and
deletes every other releases/<id> directory.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preflight-runtime)
      PREFLIGHT_RUNTIME="true"
      shift
      ;;
    --port)
      HTTP_PORT="${2:-}"
      shift 2
      ;;
    --canary-port)
      HTTP_CANARY_PORT="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

OS_NAME="$(uname -s 2>/dev/null || printf 'unknown')"
if [[ "$OS_NAME" != "Darwin" ]]; then
  echo "codex-java-lsp currently supports macOS only; detected $OS_NAME." >&2
  exit 1
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required." >&2
    exit 1
  fi
}

normalize_absolute_path() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "$value" ]]; then
    return
  fi
  if [[ "$value" == "~" ]]; then
    value="$HOME"
  elif [[ "$value" == "~/"* ]]; then
    value="$HOME/${value#\~/}"
  elif [[ "$value" != /* ]]; then
    echo "$name must be absolute or start with ~/." >&2
    exit 1
  fi
  printf -v "$name" '%s' "$value"
  export "$name"
}

validate_port() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 || value > 65535 )); then
    echo "$name must be an integer between 1 and 65535." >&2
    exit 1
  fi
}

unset NODE_OPTIONS NODE_PATH NODE_REPL_HISTORY NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS
if [[ "$PREFLIGHT_RUNTIME" == "true" ]]; then
  exec sh "$SCRIPT_DIR/scripts/run-isolated-node.sh" "$SCRIPT_DIR/scripts/ilv2-mac-runtime.mjs" --identity
fi
sh "$SCRIPT_DIR/scripts/run-isolated-node.sh" "$SCRIPT_DIR/scripts/ilv2-mac-runtime.mjs" --verify
NODE_BIN="$ILV2_NODE_BIN"
NPM_BIN="$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"
if [[ ! -r "$NPM_BIN" ]]; then
  echo "The frozen Node installation must provide npm-cli.js." >&2
  exit 2
fi
export ILV2_NODE_BIN ILV2_RUNTIME_MANIFEST
for command_name in curl rsync launchctl; do
  require_command "$command_name"
done
JDTLS_BIN="${JDTLS_BIN:-$(command -v jdtls || true)}"
if [[ -z "$JDTLS_BIN" || "$JDTLS_BIN" != /* || ! -x "$JDTLS_BIN" ]]; then
  echo "jdtls was not found as an executable absolute path. Install it with: brew install jdtls" >&2
  exit 1
fi

JAVA_LSP_CACHE_BASE="${JAVA_LSP_CACHE_BASE:-$HOME/Library/Caches/codex-java-lsp-ilv2}"
JAVA_LSP_OWNERSHIP_BASE="${JAVA_LSP_OWNERSHIP_BASE:-$JAVA_LSP_CACHE_BASE/.ownership}"
for path_env_name in JAVA_LSP_PROJECTS_JSON JAVA_LSP_CACHE_BASE JAVA_LSP_OWNERSHIP_BASE; do
  normalize_absolute_path "$path_env_name"
done
validate_port "--port / JAVA_LSP_HTTP_PORT" "$HTTP_PORT"
validate_port "--canary-port / JAVA_LSP_HTTP_CANARY_PORT" "$HTTP_CANARY_PORT"
if [[ "$HTTP_PORT" == "$HTTP_CANARY_PORT" ]]; then
  echo "Candidate port must differ from the fixed HTTP daemon port." >&2
  exit 1
fi

RUNTIME_DIR="${RUNTIME_DIR/#\~/$HOME}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR/#\~/$HOME}"
LOG_DIR="${LOG_DIR/#\~/$HOME}"
if [[ "$RUNTIME_DIR" != /* || "$LAUNCH_AGENTS_DIR" != /* || "$LOG_DIR" != /* ]]; then
  echo "Runtime, LaunchAgents, and log directories must be absolute." >&2
  exit 1
fi

RELEASES_DIR="$RUNTIME_DIR/releases"
STATE_DIR="$RUNTIME_DIR/state"
CURRENT_LINK="$RUNTIME_DIR/current"
LAUNCH_AGENT_PLIST="$LAUNCH_AGENTS_DIR/$LAUNCH_AGENT_LABEL.plist"
BUILD_SHA="$(git -C "$SCRIPT_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'source')"
BUILD_ID="${BUILD_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$RELEASES_DIR/$BUILD_ID"
CANDIDATE_LOG="$STATE_DIR/candidate-$BUILD_ID.log"
CANDIDATE_PID=""
CANDIDATE_INSTANCE_ID="candidate-$BUILD_ID-$($NODE_BIN -e 'process.stdout.write(require("node:crypto").randomUUID())')"
MANAGED_INSTANCE_ID="managed-$BUILD_ID-$($NODE_BIN -e 'process.stdout.write(require("node:crypto").randomUUID())')"
ROLLBACK_DIR="$STATE_DIR/rollback-$BUILD_ID"
INSTALL_LOCK_DIR="$STATE_DIR/install.lock"
INSTALL_LOCK_TOKEN="$$-$RANDOM"
INSTALL_TEST_ROOT=""
CANDIDATE_TEST_ROOT=""
PROJECT_JDK_ENV=()

cleanup_candidate() {
  if [[ -z "$CANDIDATE_PID" ]]; then
    return
  fi
  local candidate_pid="$CANDIDATE_PID"
  CANDIDATE_PID=""
  if kill -0 "$candidate_pid" >/dev/null 2>&1; then
    kill -TERM "$candidate_pid" >/dev/null 2>&1 || true
  fi
  wait "$candidate_pid" >/dev/null 2>&1 || true
}

release_install_lock() {
  if [[ ! -f "$INSTALL_LOCK_DIR/owner" || "$(<"$INSTALL_LOCK_DIR/owner")" != "$INSTALL_LOCK_TOKEN" ]]; then
    return
  fi
  unlink "$INSTALL_LOCK_DIR/owner" || return
  rmdir "$INSTALL_LOCK_DIR" || true
}

cleanup_install_test_environment() {
  if [[ -z "$INSTALL_TEST_ROOT" ]]; then
    return
  fi
  # This directory is created by mktemp below and is never a caller-controlled
  # runtime/cache path. Release tests must not inherit the daemon's live cache,
  # ownership, or projects configuration.
  rm -rf -- "$INSTALL_TEST_ROOT"
  INSTALL_TEST_ROOT=""
}

cleanup_candidate_test_environment() {
  if [[ -z "$CANDIDATE_TEST_ROOT" ]]; then
    return
  fi
  # Candidate health checks must not even initialize cache janitors against the
  # managed daemon's state. This path is generated by mktemp below, never read
  # from the caller's environment, and is removed only after the candidate is
  # fully stopped.
  rm -rf -- "$CANDIDATE_TEST_ROOT"
  CANDIDATE_TEST_ROOT=""
}

cleanup_installer() {
  cleanup_candidate
  cleanup_candidate_test_environment
  cleanup_install_test_environment
  if [[ -n "${RELEASE_DIR:-}" && -n "${BUILD_ID:-}" ]]; then
    rm -rf "$RUNTIME_DIR/.launcher.candidate.$BUILD_ID"
    rm -f "$STATE_DIR/.daemon.env.candidate.$BUILD_ID" "$STATE_DIR/.agent.plist.candidate.$BUILD_ID"
  fi
  release_install_lock
}

trap cleanup_installer EXIT

acquire_install_lock() {
  if ! mkdir "$INSTALL_LOCK_DIR" 2>/dev/null; then
    echo "Another installer owns $INSTALL_LOCK_DIR; refusing concurrent release/configuration changes." >&2
    echo "If an earlier installer was interrupted, inspect its owner marker before explicitly removing this isolated lock." >&2
    return 1
  fi
  printf '%s\n' "$INSTALL_LOCK_TOKEN" >"$INSTALL_LOCK_DIR/owner" || {
    rmdir "$INSTALL_LOCK_DIR" || true
    return 1
  }
}

candidate_is_ready() {
  local payload="$1"
  printf '%s' "$payload" | "$NODE_BIN" "$RELEASE_DIR/scripts/verify-candidate-health.mjs" "$CANDIDATE_INSTANCE_ID"
}

wait_for_candidate_ready() {
  local url="$1"
  local deadline=$((SECONDS + 45))
  while true; do
    if [[ -z "$CANDIDATE_PID" ]] || ! kill -0 "$CANDIDATE_PID" >/dev/null 2>&1; then
      echo "Candidate daemon exited before reporting its own readiness: $CANDIDATE_LOG" >&2
      tail -n 80 "$CANDIDATE_LOG" >&2 || true
      return 1
    fi
    local health_payload=""
    if health_payload="$(curl --fail --silent --show-error --max-time 2 "$url" 2>/dev/null)" \
      && candidate_is_ready "$health_payload"; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for this candidate's readiness: $url" >&2
      return 1
    fi
    sleep 1
  done
}

rsync_source_tree() {
  local src="$1"
  local dst="$2"
  shift 2
  rsync -a \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude coverage \
    --exclude .nyc_output \
    --exclude .npm \
    --exclude artifacts \
    --exclude graphify-out \
    --exclude .workflow \
    --exclude .task30-debug.mjs \
    --exclude .DS_Store \
    --exclude "*.tsbuildinfo" \
    --exclude "*.tgz" \
    --exclude "*.log" \
    --exclude .env \
    --exclude ".env.*" \
    "$@" \
    "$src" "$dst"
}

release_link_id() {
  local link="$1"
  local target
  if [[ ! -L "$link" ]]; then
    return 1
  fi
  target="$(readlink "$link")"
  case "$target" in
    releases/*)
      printf '%s' "${target#releases/}"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Rollback only needs current + previous-current. Extra immutable copies are disk waste.
prune_unreferenced_releases() {
  local current_id previous_id dir name
  if ! current_id="$(release_link_id "$CURRENT_LINK")"; then
    echo "Skipping release prune because current is not an immutable releases/<build-id> symlink." >&2
    return 0
  fi
  if [[ ! -d "$RELEASES_DIR/$current_id" ]]; then
    echo "Skipping release prune because current release directory is missing: $current_id" >&2
    return 0
  fi
  previous_id=""
  if previous_id="$(release_link_id "$STATE_DIR/previous-current")"; then
    :
  else
    previous_id=""
  fi
  for dir in "$RELEASES_DIR"/*; do
    [[ -d "$dir" ]] || continue
    name="$(basename "$dir")"
    if [[ "$name" == "$current_id" ]]; then
      continue
    fi
    if [[ -n "$previous_id" && "$name" == "$previous_id" ]]; then
      continue
    fi
    echo "Pruning unreferenced immutable release: $name" >&2
    rm -rf "$dir"
  done
}

assert_clean_release_source() {
  "$NODE_BIN" "$SCRIPT_DIR/scripts/verify-clean-source-tree.mjs" "$SCRIPT_DIR"
}

copy_release() {
  if [[ -e "$RELEASE_DIR" ]]; then
    echo "Refusing to reuse existing release directory: $RELEASE_DIR" >&2
    exit 1
  fi
  mkdir -p "$RELEASE_DIR"
  rsync_source_tree "$SCRIPT_DIR/" "$RELEASE_DIR/"
  (
    cd "$RELEASE_DIR"
    if [[ -f package-lock.json ]]; then
      "$NODE_BIN" "$NPM_BIN" ci
    else
      "$NODE_BIN" "$NPM_BIN" install
    fi
    CODEX_JAVA_LSP_BUILD_SHA="$BUILD_SHA" "$NODE_BIN" "$NPM_BIN" run build
  )
  run_release_tests_in_isolated_environment
  chmod +x "$RELEASE_DIR/run.sh" "$RELEASE_DIR/run-daemon.sh" "$RELEASE_DIR/run-stdio.sh" "$RELEASE_DIR/run-hook-gate.sh" \
    "$RELEASE_DIR/daemonctl.sh" "$RELEASE_DIR/install-hook.sh" "$RELEASE_DIR/register-alias.sh"
}

merge_project_jdk_env() {
  local key="$1"
  local value="$2"
  if [[ ! "$key" =~ ^JAVA_LSP_PROJECT_JAVA_HOME(_[A-Z0-9_]+)?$ || -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *$'\t'* ]]; then
    echo "Unsupported project JDK environment override: $key" >&2
    return 1
  fi
  local entry existing_key existing_value
  if (( ${#PROJECT_JDK_ENV[@]} > 0 )); then
    for entry in "${PROJECT_JDK_ENV[@]}"; do
      existing_key="${entry%%=*}"
      existing_value="${entry#*=}"
      if [[ "$existing_key" == "$key" ]]; then
        if [[ "$existing_value" != "$value" ]]; then
          echo "Conflicting project JDK override for $key between installer environment and managed daemon state." >&2
          return 1
        fi
        return 0
      fi
    done
  fi
  PROJECT_JDK_ENV+=("$key=$value")
}

collect_project_jdk_env() {
  PROJECT_JDK_ENV=()
  local env_name ignored existing_registration key value
  while IFS='=' read -r env_name ignored; do
    if [[ "$env_name" =~ ^JAVA_LSP_PROJECT_JAVA_HOME(_[A-Z0-9_]+)?$ ]]; then
      merge_project_jdk_env "$env_name" "${!env_name}" || return 1
    fi
  done < <(env)

}

run_release_tests_in_isolated_environment() {
  INSTALL_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codex-java-lsp-install-test.XXXXXX")" || return 1
  local test_cache="$INSTALL_TEST_ROOT/cache"
  local test_ownership="$INSTALL_TEST_ROOT/ownership"
  local test_projects="$INSTALL_TEST_ROOT/projects.json"
  mkdir -p "$test_cache" "$test_ownership" "$INSTALL_TEST_ROOT/config" "$INSTALL_TEST_ROOT/codex-home" "$INSTALL_TEST_ROOT/home" || {
    cleanup_install_test_environment
    return 1
  }
  printf '{"aliases":[]}\n' >"$test_projects" || {
    cleanup_install_test_environment
    return 1
  }
  if ! (
    # Isolated npm test git-clones cwd. The immutable release copy has no .git
    # (rsync excludes it), so tests must run from the source checkout. The
    # release is a clean snapshot of that tree.
    cd "$SCRIPT_DIR"
    exec env \
      "JAVA_LSP_CACHE_BASE=$test_cache" \
      "JAVA_LSP_OWNERSHIP_BASE=$test_ownership" \
      "JAVA_LSP_PROJECTS_JSON=$test_projects" \
      "XDG_CONFIG_HOME=$INSTALL_TEST_ROOT/config" \
      "CODEX_HOME=$INSTALL_TEST_ROOT/codex-home" \
      "HOME=$INSTALL_TEST_ROOT/home" \
      "$NODE_BIN" "$NPM_BIN" test
  ); then
    cleanup_install_test_environment
    return 1
  fi
  cleanup_install_test_environment
}

run_candidate_smoke() {
  local candidate_url="http://127.0.0.1:$HTTP_CANARY_PORT"
  local candidate_build
  CANDIDATE_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codex-java-lsp-candidate-test.XXXXXX")" || return 1
  local candidate_cache="$CANDIDATE_TEST_ROOT/cache"
  local candidate_ownership="$CANDIDATE_TEST_ROOT/ownership"
  local candidate_projects="$CANDIDATE_TEST_ROOT/projects.json"
  if ! mkdir -p "$candidate_cache" "$candidate_ownership" "$CANDIDATE_TEST_ROOT/config" "$CANDIDATE_TEST_ROOT/codex-home" "$CANDIDATE_TEST_ROOT/home" \
    || ! printf '{"aliases":[]}\n' >"$candidate_projects"; then
    cleanup_candidate_test_environment
    return 1
  fi
  candidate_cache="$(cd "$candidate_cache" && pwd -P)"
  candidate_build="$("$NODE_BIN" -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).gitSha)' "$RELEASE_DIR/dist/build-stamp.json")"
  (
    cd "$RELEASE_DIR"
    exec env -u JDTLS_DATA_DIR -u JDTLS_LOG_DIR \
      "JAVA_LSP_HTTP_PORT=$HTTP_CANARY_PORT" \
      "JAVA_LSP_HTTP_INSTANCE_ID=$CANDIDATE_INSTANCE_ID" \
      "JAVA_LSP_CACHE_BASE=$candidate_cache" \
      "JAVA_LSP_CACHE_ROOT=$candidate_cache" \
      "JAVA_LSP_SERVICE_STATE_ROOT=$CANDIDATE_TEST_ROOT/service-state" \
      "GRADLE_USER_HOME=$CANDIDATE_TEST_ROOT/service-state/jdt-gradle-home" \
      "JAVA_LSP_OWNERSHIP_BASE=$candidate_ownership" \
      "JAVA_LSP_PROJECTS_JSON=$candidate_projects" \
      "XDG_CONFIG_HOME=$CANDIDATE_TEST_ROOT/config" \
      "CODEX_HOME=$CANDIDATE_TEST_ROOT/codex-home" \
      "HOME=$CANDIDATE_TEST_ROOT/home" \
      "JDTLS_BIN=$JDTLS_BIN" \
      "$RUNTIME_DIR/.launcher.candidate.$BUILD_ID/dist/native/ilv2-mac" owner "$candidate_cache" "$RELEASE_DIR/dist/http-server.js"
  ) >"$CANDIDATE_LOG" 2>&1 &
  CANDIDATE_PID="$!"
  if ! wait_for_candidate_ready "$candidate_url/readyz"; then
    cleanup_candidate
    cleanup_candidate_test_environment
    return 1
  fi
  if ! "$NODE_BIN" "$RELEASE_DIR/dist/smoke-http.js" --url "$candidate_url/mcp" --expect-build "$candidate_build"; then
    cleanup_candidate
    cleanup_candidate_test_environment
    return 1
  fi
  cleanup_candidate
  cleanup_candidate_test_environment
}

assert_existing_managed_config_is_compatible() {
  if [[ ( -f "$STATE_DIR/daemon.env" || -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ) && ! -d "$RUNTIME_DIR/launcher" ]]; then
    echo "Existing runtime has no verified MAC-17 owner bundle; use a new ILV2 runtime directory and retain the old runtime unchanged." >&2
    exit 2
  fi
  if [[ ! -f "$STATE_DIR/daemon.env" ]]; then
    return
  fi
  local previous_port previous_label previous_plist
  previous_port="$(bash -c 'source "$1"; printf "%s" "${JAVA_LSP_HTTP_PORT:-}"' _ "$STATE_DIR/daemon.env")"
  previous_label="$(bash -c 'source "$1"; printf "%s" "${LAUNCH_AGENT_LABEL:-}"' _ "$STATE_DIR/daemon.env")"
  previous_plist="$(bash -c 'source "$1"; printf "%s" "${LAUNCH_AGENT_PLIST:-}"' _ "$STATE_DIR/daemon.env")"
  if [[ -n "$previous_port" && "$previous_port" != "$HTTP_PORT" ]]; then
    echo "Refusing to change the managed fixed HTTP port from $previous_port to $HTTP_PORT during an upgrade." >&2
    echo "Keep the registered URL stable; use an explicit future port-migration procedure instead." >&2
    exit 1
  fi
  if [[ -n "$previous_label" && "$previous_label" != "$LAUNCH_AGENT_LABEL" ]]; then
    echo "Refusing to change the managed LaunchAgent label from $previous_label to $LAUNCH_AGENT_LABEL during an upgrade." >&2
    exit 1
  fi
  if [[ -n "$previous_plist" && "$previous_plist" != "$LAUNCH_AGENT_PLIST" ]]; then
    echo "Refusing to change the managed LaunchAgent plist path during an upgrade." >&2
    exit 1
  fi
}

backup_file_for_rollback() {
  local source="$1"
  local backup="$2"
  local marker="$3"
  if [[ -f "$source" ]]; then
    cp -p "$source" "$backup"
    printf 'present\n' >"$marker"
  else
    printf 'absent\n' >"$marker"
  fi
}

backup_link_for_rollback() {
  local source="$1"
  local backup="$2"
  local marker="$3"
  if [[ -L "$source" ]]; then
    local target
    target="$(readlink "$source")"
    ln -s "$target" "$backup"
    printf 'present\n' >"$marker"
  elif [[ -e "$source" ]]; then
    echo "Expected immutable release pointer to be a symlink: $source" >&2
    return 1
  else
    printf 'absent\n' >"$marker"
  fi
}

backup_managed_configuration() {
  mkdir -p "$ROLLBACK_DIR"
  if [[ -d "$RUNTIME_DIR/launcher" ]]; then
    "$NODE_BIN" "$RELEASE_DIR/scripts/managed-owner-launcher.mjs" verify "$RUNTIME_DIR/.launcher.candidate.$BUILD_ID" "$RUNTIME_DIR/launcher" || return 1
    cp -Rp "$RUNTIME_DIR/launcher" "$ROLLBACK_DIR/launcher" || return 1
    printf 'present\n' >"$ROLLBACK_DIR/launcher.marker"
  else
    printf 'absent\n' >"$ROLLBACK_DIR/launcher.marker"
  fi
  backup_file_for_rollback \
    "$STATE_DIR/daemon.env" \
    "$ROLLBACK_DIR/daemon.env" \
    "$ROLLBACK_DIR/daemon.env.marker"
  backup_file_for_rollback \
    "$LAUNCH_AGENT_PLIST" \
    "$ROLLBACK_DIR/target-launch-agent.plist" \
    "$ROLLBACK_DIR/target-launch-agent.plist.marker"
  # These root-level scripts are the stable launchd/Codex control-plane targets.
  # A release switch is not rollback-safe unless they move with daemon.env/plist.
  backup_file_for_rollback \
    "$RUNTIME_DIR/run-daemon.sh" \
    "$ROLLBACK_DIR/run-daemon.sh" \
    "$ROLLBACK_DIR/run-daemon.sh.marker"
  backup_file_for_rollback \
    "$RUNTIME_DIR/run.sh" \
    "$ROLLBACK_DIR/run.sh" \
    "$ROLLBACK_DIR/run.sh.marker"
  backup_file_for_rollback \
    "$RUNTIME_DIR/run-hook-gate.sh" \
    "$ROLLBACK_DIR/run-hook-gate.sh" \
    "$ROLLBACK_DIR/run-hook-gate.sh.marker"
  backup_file_for_rollback \
    "$RUNTIME_DIR/install-hook.sh" \
    "$ROLLBACK_DIR/install-hook.sh" \
    "$ROLLBACK_DIR/install-hook.sh.marker"
  backup_file_for_rollback \
    "$RUNTIME_DIR/daemonctl.sh" \
    "$ROLLBACK_DIR/daemonctl.sh" \
    "$ROLLBACK_DIR/daemonctl.sh.marker"
  # Keep the predecessor's predecessor. Without this, a failed A -> C upgrade
  # leaves current restored to A but overwrites A's previous-current=B pointer
  # with A, making the next rollback load B's config against A's code.
  backup_link_for_rollback \
    "$STATE_DIR/previous-current" \
    "$ROLLBACK_DIR/previous-current" \
    "$ROLLBACK_DIR/previous-current.marker"
  if [[ -f "$STATE_DIR/daemon.env" ]]; then
    local previous_plist
    previous_plist="$(bash -c 'source "$1"; printf "%s" "${LAUNCH_AGENT_PLIST:-}"' _ "$STATE_DIR/daemon.env")"
    if [[ -n "$previous_plist" && "$previous_plist" != "$LAUNCH_AGENT_PLIST" ]]; then
      printf '%s\n' "$previous_plist" >"$ROLLBACK_DIR/previous-launch-agent.path"
      backup_file_for_rollback \
        "$previous_plist" \
        "$ROLLBACK_DIR/previous-launch-agent.plist" \
        "$ROLLBACK_DIR/previous-launch-agent.plist.marker"
    fi
  fi
}

restore_file_from_rollback() {
  local target="$1"
  local backup="$2"
  local marker="$3"
  if [[ ! -f "$marker" ]]; then
    return
  fi
  if [[ "$(<"$marker")" == "present" ]]; then
    local staged="${target}.restore.$$"
    cp -p "$backup" "$staged" || return 1
    mv -f "$staged" "$target" || return 1
  else
    if [[ -e "$target" || -L "$target" ]]; then
      unlink "$target" || return 1
    fi
  fi
}

restore_link_from_rollback() {
  local target="$1"
  local backup="$2"
  local marker="$3"
  if [[ ! -f "$marker" ]]; then
    return 1
  fi
  local state
  state="$(<"$marker")"
  if [[ "$state" == "present" ]]; then
    if [[ ! -L "$backup" ]]; then
      return 1
    fi
    local staged="${target}.restore.$$"
    ln -s "$(readlink "$backup")" "$staged" || return 1
    mv -f -h "$staged" "$target" || return 1
  elif [[ "$state" == "absent" ]]; then
    if [[ -e "$target" || -L "$target" ]]; then
      unlink "$target" || return 1
    fi
  else
    return 1
  fi
}

restore_previous_managed_configuration() {
  if [[ "$(<"$ROLLBACK_DIR/launcher.marker")" == "present" ]]; then
    local staged_bundle="$RUNTIME_DIR/.launcher.restore.$$"
    cp -Rp "$ROLLBACK_DIR/launcher" "$staged_bundle" || return 1
    "$NODE_BIN" "$RELEASE_DIR/scripts/managed-owner-launcher.mjs" replace "$staged_bundle" "$RUNTIME_DIR/launcher" || return 1
  elif [[ "$(<"$ROLLBACK_DIR/launcher.marker")" == "absent" ]]; then
    rm -rf "$RUNTIME_DIR/launcher" || return 1
  else
    return 1
  fi
  restore_file_from_rollback \
    "$STATE_DIR/daemon.env" \
    "$ROLLBACK_DIR/daemon.env" \
    "$ROLLBACK_DIR/daemon.env.marker" || return 1
  restore_file_from_rollback \
    "$LAUNCH_AGENT_PLIST" \
    "$ROLLBACK_DIR/target-launch-agent.plist" \
    "$ROLLBACK_DIR/target-launch-agent.plist.marker" || return 1
  restore_file_from_rollback \
    "$RUNTIME_DIR/run-daemon.sh" \
    "$ROLLBACK_DIR/run-daemon.sh" \
    "$ROLLBACK_DIR/run-daemon.sh.marker" || return 1
  restore_file_from_rollback \
    "$RUNTIME_DIR/run.sh" \
    "$ROLLBACK_DIR/run.sh" \
    "$ROLLBACK_DIR/run.sh.marker" || return 1
  restore_file_from_rollback \
    "$RUNTIME_DIR/run-hook-gate.sh" \
    "$ROLLBACK_DIR/run-hook-gate.sh" \
    "$ROLLBACK_DIR/run-hook-gate.sh.marker" || return 1
  restore_file_from_rollback \
    "$RUNTIME_DIR/install-hook.sh" \
    "$ROLLBACK_DIR/install-hook.sh" \
    "$ROLLBACK_DIR/install-hook.sh.marker" || return 1
  restore_file_from_rollback \
    "$RUNTIME_DIR/daemonctl.sh" \
    "$ROLLBACK_DIR/daemonctl.sh" \
    "$ROLLBACK_DIR/daemonctl.sh.marker" || return 1
  restore_link_from_rollback \
    "$STATE_DIR/previous-current" \
    "$ROLLBACK_DIR/previous-current" \
    "$ROLLBACK_DIR/previous-current.marker" || return 1
  if [[ -f "$ROLLBACK_DIR/previous-launch-agent.path" ]]; then
    local previous_plist
    previous_plist="$(<"$ROLLBACK_DIR/previous-launch-agent.path")"
    restore_file_from_rollback \
      "$previous_plist" \
      "$ROLLBACK_DIR/previous-launch-agent.plist" \
      "$ROLLBACK_DIR/previous-launch-agent.plist.marker" || return 1
  fi
}

inherit_managed_environment() {
  local key previous
  if [[ ! -f "$STATE_DIR/daemon.env" ]]; then return; fi
  for key in JAVA_LSP_IDLE_TTL_MS JAVA_HOME JDTLS_JAVA_HOME JAVA_LSP_GRADLE_DISTRIBUTIONS JAVA_LSP_PROJECTS_JSON JDTLS_EXTRA_ARGS JAVA_LSP_JDTLS_XMX; do
    if [[ -z "${!key:-}" ]]; then
      previous="$(bash -c 'source "$1"; printf "%s" "${!2:-}"' _ "$STATE_DIR/daemon.env" "$key")"
      if [[ -n "$previous" ]]; then printf -v "$key" '%s' "$previous"; export "$key"; fi
    fi
  done
  local entry
  while IFS=$'\t' read -r key previous; do
    [[ -z "$key" ]] && continue
    merge_project_jdk_env "$key" "$previous" || return 1
  done < <(bash -c 'source "$1"; while IFS= read -r key; do printf "%s\t%s\n" "$key" "${!key}"; done < <(compgen -A variable JAVA_LSP_PROJECT_JAVA_HOME)' _ "$STATE_DIR/daemon.env")
}

write_state() {
  local staged="$STATE_DIR/daemon.env.next.$$"
  (
    umask 077
    {
      printf 'RUNTIME_DIR_FROM_STATE=%q\n' "$RUNTIME_DIR"
      printf 'LAUNCH_AGENT_LABEL=%q\n' "$LAUNCH_AGENT_LABEL"
      printf 'LAUNCH_AGENT_PLIST=%q\n' "$LAUNCH_AGENT_PLIST"
      printf 'JAVA_LSP_HTTP_PORT=%q\n' "$HTTP_PORT"
      printf 'JAVA_LSP_HTTP_INSTANCE_ID=%q\n' "$MANAGED_INSTANCE_ID"
      printf 'JAVA_LSP_CACHE_BASE=%q\n' "$JAVA_LSP_CACHE_BASE"
      printf 'JAVA_LSP_OWNERSHIP_BASE=%q\n' "$JAVA_LSP_OWNERSHIP_BASE"
      printf 'ILV2_NODE_BIN=%q\n' "$ILV2_NODE_BIN"
      printf 'ILV2_RUNTIME_MANIFEST=%q\n' "$ILV2_RUNTIME_MANIFEST"
      printf 'NODE_BIN=%q\n' "$NODE_BIN"
      printf 'JAVA_LSP_CACHE_ROOT=%q\n' "$JAVA_LSP_CACHE_BASE"
      printf 'JAVA_LSP_SERVICE_STATE_ROOT=%q\n' "$STATE_DIR"
      printf 'GRADLE_USER_HOME=%q\n' "$STATE_DIR/jdt-gradle-home"
      local key
      for key in JAVA_HOME JDTLS_BIN JDTLS_JAVA_HOME JAVA_LSP_GRADLE_DISTRIBUTIONS JAVA_LSP_PROJECTS_JSON JDTLS_EXTRA_ARGS JAVA_LSP_JDTLS_XMX; do
        if [[ -n "${!key:-}" ]]; then printf '%s=%q\n' "$key" "${!key}"; fi
      done
      if [[ -n "${JAVA_LSP_IDLE_TTL_MS:-}" ]]; then
        printf 'JAVA_LSP_IDLE_TTL_MS=%q\n' "$JAVA_LSP_IDLE_TTL_MS"
      fi
      if (( ${#PROJECT_JDK_ENV[@]} > 0 )); then
        local entry
        for entry in "${PROJECT_JDK_ENV[@]}"; do
          printf '%s=%q\n' "${entry%%=*}" "${entry#*=}"
        done
      fi
    } >"$staged"
  ) || return 1
  chmod 600 "$staged" || return 1
  mv -f "$staged" "${1:-$STATE_DIR/daemon.env}" || return 1
}

write_launch_agent() {
  local staged="$STATE_DIR/$LAUNCH_AGENT_LABEL.plist.next.$$"
  local daemon_path="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  local environment=(
    "PATH=$daemon_path"
    "NODE_BIN=$NODE_BIN"
    "JDTLS_BIN=$JDTLS_BIN"
    "JAVA_LSP_HTTP_PORT=$HTTP_PORT"
    "JAVA_LSP_HTTP_INSTANCE_ID=$MANAGED_INSTANCE_ID"
    "JAVA_LSP_CACHE_BASE=$JAVA_LSP_CACHE_BASE"
    "JAVA_LSP_CACHE_ROOT=$JAVA_LSP_CACHE_BASE"
    "JAVA_LSP_SERVICE_STATE_ROOT=$STATE_DIR"
    "GRADLE_USER_HOME=$STATE_DIR/jdt-gradle-home"
    "JAVA_LSP_OWNERSHIP_BASE=$JAVA_LSP_OWNERSHIP_BASE"
  )
  local env_name
  for env_name in \
    JAVA_LSP_GRADLE_DISTRIBUTIONS \
    JAVA_HOME \
    JDTLS_JAVA_HOME \
    JAVA_LSP_PROJECTS_JSON \
    JDTLS_EXTRA_ARGS \
    JAVA_LSP_JDTLS_XMX \
    JAVA_LSP_MAX_ACTIVE_REPOS \
    JAVA_LSP_IDLE_TTL_MS \
    JAVA_LSP_RUNTIME_ENTRY_TTL_MS \
    JAVA_LSP_MAX_RUNTIME_ENTRIES \
    JAVA_LSP_CACHE_JANITOR_INTERVAL_MS \
    JAVA_LSP_WORKTREE_CACHE_TTL_DAYS \
    JAVA_LSP_CACHE_UNPINNED_MAX_DIRS \
    JAVA_LSP_CACHE_UNPINNED_MAX_BYTES \
    JAVA_LSP_AUTOBUILD \
    JAVA_LSP_IMPORT_CONCURRENCY \
    JAVA_LSP_RG_CONCURRENCY \
    JAVA_LSP_DOCUMENT_SYMBOL_TIMEOUT_MS \
    JAVA_LSP_DOCUMENT_SYMBOL_ATTEMPT_TIMEOUT_MS \
    JAVA_LSP_DOCUMENT_SYMBOL_GLOBAL_CONCURRENCY \
    JAVA_LSP_DOCUMENT_SYMBOL_PER_REPO_CONCURRENCY \
    JAVA_LSP_PROGRESS_IDLE_MS \
    JAVA_LSP_MIN_SEMANTIC_WAIT_MS \
    JAVA_LSP_LOMBOK_JAR \
    JDTLS_FILEWATCH
  do
    if [[ -n "${!env_name:-}" ]]; then
      environment+=("$env_name=${!env_name}")
    fi
  done
  if (( ${#PROJECT_JDK_ENV[@]} > 0 )); then
    environment+=("${PROJECT_JDK_ENV[@]}")
  fi
  "$NODE_BIN" "$RELEASE_DIR/scripts/render-launch-agent-plist.mjs" \
    "$RELEASE_DIR/macos/com.lky.codex-java-lsp-mcp.plist.template" \
    "$staged" \
    "$LAUNCH_AGENT_LABEL" \
    "$RUNTIME_DIR/launcher/dist/native/ilv2-mac" \
    "$RUNTIME_DIR" \
    "$LOG_DIR" \
    "$JAVA_LSP_CACHE_BASE" \
    "$RELEASE_DIR/dist/http-server.js" \
    "${environment[@]}" || return 1
  chmod 600 "$staged" || return 1
  mv -f "$staged" "${1:-$LAUNCH_AGENT_PLIST}" || return 1
}

install_stable_entrypoints() {
  local staged_daemon="$RUNTIME_DIR/.run-daemon.next.$$"
  local staged_stdio="$RUNTIME_DIR/.run-stdio.next.$$"
  local staged_hook="$RUNTIME_DIR/.run-hook-gate.next.$$"
  local staged_hook_installer="$RUNTIME_DIR/.install-hook.next.$$"
  local staged_ctl="$RUNTIME_DIR/.daemonctl.next.$$"
  cp "$RELEASE_DIR/run-daemon.sh" "$staged_daemon" || return 1
  cp "$RELEASE_DIR/run-stdio.sh" "$staged_stdio" || return 1
  cp "$RELEASE_DIR/run-hook-gate.sh" "$staged_hook" || return 1
  cp "$RELEASE_DIR/install-hook.sh" "$staged_hook_installer" || return 1
  cp "$RELEASE_DIR/daemonctl.sh" "$staged_ctl" || return 1
  chmod 755 "$staged_daemon" "$staged_stdio" "$staged_hook" "$staged_hook_installer" "$staged_ctl" || return 1
  mv -f "$staged_daemon" "$RUNTIME_DIR/run-daemon.sh" || return 1
  mv -f "$staged_stdio" "$RUNTIME_DIR/run.sh" || return 1
  mv -f "$staged_hook" "$RUNTIME_DIR/run-hook-gate.sh" || return 1
  mv -f "$staged_hook_installer" "$RUNTIME_DIR/install-hook.sh" || return 1
  mv -f "$staged_ctl" "$RUNTIME_DIR/daemonctl.sh" || return 1
}

switch_current() {
  local previous_target=""
  if [[ -L "$CURRENT_LINK" ]]; then
    previous_target="$(readlink "$CURRENT_LINK")"
  fi
  # Record the old immutable target before moving `current`: a failure after the
  # current move must always have a known rollback target.
  if [[ -n "$previous_target" ]]; then
    local previous_staged="$STATE_DIR/.previous-current.next.$$"
    ln -s "$previous_target" "$previous_staged" || return 1
    mv -f -h "$previous_staged" "$STATE_DIR/previous-current" || return 1
  fi
  local staged="$RUNTIME_DIR/.current.next.$$"
  ln -s "releases/$BUILD_ID" "$staged" || return 1
  mv -f -h "$staged" "$CURRENT_LINK" || return 1
}

restore_previous_release() {
  if [[ ! -L "$STATE_DIR/previous-current" ]]; then
    if [[ -L "$CURRENT_LINK" && "$(readlink "$CURRENT_LINK")" == "releases/$BUILD_ID" ]]; then
      unlink "$CURRENT_LINK" || return 1
      return
    fi
    echo "No previous immutable release is available for automatic rollback." >&2
    return 1
  fi
  local staged="$RUNTIME_DIR/.current.restore.$$"
  ln -s "$(readlink "$STATE_DIR/previous-current")" "$staged" || return 1
  mv -f -h "$staged" "$CURRENT_LINK" || return 1
}

managed_daemonctl() {
  CODEX_JAVA_LSP_RUNTIME_DIR="$RUNTIME_DIR" "$RUNTIME_DIR/daemonctl.sh" "$@"
}

restore_before_daemon_restart() {
  local phase="$1"
  local current_switched="$2"
  echo "Install failed during $phase; restoring managed files before any daemon restart." >&2
  local rollback_failed="false"
  if [[ "$current_switched" == "true" ]] && ! restore_previous_release; then
    rollback_failed="true"
  fi
  if ! restore_previous_managed_configuration; then
    rollback_failed="true"
  fi
  if [[ "$rollback_failed" == "true" ]]; then
    echo "Managed-file rollback failed; the existing daemon was not restarted." >&2
  fi
  if [[ "$rollback_failed" == "false" && -f "$STATE_DIR/daemon.env" && -L "$CURRENT_LINK" ]]; then
    managed_daemonctl start && managed_daemonctl smoke || true
  fi
  prune_unreferenced_releases || true
  exit 1
}

echo "Java: $(java -version 2>&1 | head -n 1 || true)" >&2
echo "JDT LS: $JDTLS_BIN" >&2
echo "Runtime root: $RUNTIME_DIR" >&2
echo "Fixed HTTP port: $HTTP_PORT; isolated candidate port: $HTTP_CANARY_PORT" >&2

mkdir -p "$RUNTIME_DIR" "$RELEASES_DIR" "$STATE_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"
acquire_install_lock
assert_existing_managed_config_is_compatible
mkdir -p "$JAVA_LSP_CACHE_BASE"
JAVA_LSP_CACHE_BASE="$(cd "$JAVA_LSP_CACHE_BASE" && pwd -P)"
export JAVA_LSP_CACHE_BASE JAVA_LSP_CACHE_ROOT="$JAVA_LSP_CACHE_BASE"
assert_clean_release_source
copy_release
"$NODE_BIN" "$RELEASE_DIR/scripts/managed-owner-launcher.mjs" prepare "$RELEASE_DIR" "$RUNTIME_DIR/.launcher.candidate.$BUILD_ID"
run_candidate_smoke
collect_project_jdk_env
inherit_managed_environment
CANDIDATE_STATE="$STATE_DIR/.daemon.env.candidate.$BUILD_ID"
CANDIDATE_PLIST="$STATE_DIR/.agent.plist.candidate.$BUILD_ID"
write_state "$CANDIDATE_STATE"
write_launch_agent "$CANDIDATE_PLIST"
bash -n "$CANDIDATE_STATE"
/usr/bin/plutil -lint "$CANDIDATE_PLIST"
backup_managed_configuration
if [[ -f "$STATE_DIR/daemon.env" ]]; then managed_daemonctl stop; fi
current_switched="false"
if ! "$NODE_BIN" "$RELEASE_DIR/scripts/managed-owner-launcher.mjs" replace "$RUNTIME_DIR/.launcher.candidate.$BUILD_ID" "$RUNTIME_DIR/launcher"; then restore_before_daemon_restart "launcher update" "$current_switched"; fi
if ! mv -f "$CANDIDATE_STATE" "$STATE_DIR/daemon.env"; then restore_before_daemon_restart "daemon state update" "$current_switched"; fi
if ! mv -f "$CANDIDATE_PLIST" "$LAUNCH_AGENT_PLIST"; then restore_before_daemon_restart "LaunchAgent update" "$current_switched"; fi
if ! install_stable_entrypoints; then restore_before_daemon_restart "stable entrypoint update" "$current_switched"; fi
if ! switch_current; then restore_before_daemon_restart "immutable release switch" "$current_switched"; fi
current_switched="true"

if ! managed_daemonctl start || ! managed_daemonctl smoke; then
  echo "New fixed-port daemon failed after current switch; attempting immutable release rollback." >&2
  if ! managed_daemonctl stop; then
    echo "The failed release could not be confirmed stopped; refusing to restore a different release/configuration over a loaded daemon." >&2
    exit 1
  fi
  restored_release="false"
  if restore_previous_release; then
    restored_release="true"
  fi
  if ! restore_previous_managed_configuration; then
    echo "Failed to restore the previous managed daemon configuration; leaving daemon stopped." >&2
    prune_unreferenced_releases || true
    exit 1
  fi
  if [[ "$restored_release" == "true" ]]; then
    if ! managed_daemonctl start || ! managed_daemonctl smoke; then
      echo "Previous release/configuration could not be restarted; leaving daemon stopped." >&2
    fi
  fi
  prune_unreferenced_releases || true
  exit 1
fi

prune_unreferenced_releases || true

echo "HTTP daemon is healthy, but existing Codex MCP registration was preserved." >&2
echo "Current immutable release: $RUNTIME_DIR/current -> $(readlink "$CURRENT_LINK")" >&2
echo "HTTP smoke: $RUNTIME_DIR/daemonctl.sh smoke" >&2
