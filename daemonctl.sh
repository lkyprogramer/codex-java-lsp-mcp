#!/usr/bin/env bash
# input: Installed immutable runtime state, LaunchAgent plist, and one daemon control command.
# output: Controlled launchd lifecycle, readiness checks, and explicit release/stdio rollback actions.
# pos: User-level daemon control plane; never starts a second ad-hoc production daemon.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The stable controller is installed at the runtime root. Prefer that directory
# over a global default so an isolated canary cannot accidentally act on the
# user's live daemon when invoked as "$CANARY_ROOT/runtime/daemonctl.sh".
RUNTIME_DIR="${CODEX_JAVA_LSP_RUNTIME_DIR:-$SCRIPT_DIR}"
STATE_FILE="$RUNTIME_DIR/state/daemon.env"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-$(command -v launchctl || true)}"
CURL_BIN="${CURL_BIN:-$(command -v curl || true)}"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "Missing daemon state: $STATE_FILE. Run install-runtime.sh first." >&2
  exit 2
fi

# The installer owns this mode-0600 file and writes shell-escaped assignments only.
# shellcheck disable=SC1090
source "$STATE_FILE"

if [[ "${RUNTIME_DIR_FROM_STATE:-}" != "$RUNTIME_DIR" ]]; then
  echo "Daemon state runtime directory does not match CODEX_JAVA_LSP_RUNTIME_DIR." >&2
  exit 2
fi
if [[ -z "$LAUNCHCTL_BIN" || ! -x "$LAUNCHCTL_BIN" ]]; then
  echo "launchctl is required." >&2
  exit 2
fi
if [[ -z "$CURL_BIN" || ! -x "$CURL_BIN" ]]; then
  echo "curl is required." >&2
  exit 2
fi
if [[ ! "${JAVA_LSP_HTTP_INSTANCE_ID:-}" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
  echo "Managed daemon state is missing a valid HTTP instance identifier; reinstall before controlling this daemon." >&2
  exit 2
fi

TARGET="gui/$UID/$LAUNCH_AGENT_LABEL"
HEALTH_URL="http://127.0.0.1:$JAVA_LSP_HTTP_PORT/healthz"
READY_URL="http://127.0.0.1:$JAVA_LSP_HTTP_PORT/readyz"

usage() {
  cat <<'EOF'
Usage: daemonctl.sh <status|start|stop|restart|wait-ready|smoke|rollback-release|rollback-stdio>

Commands:
  status            Print LaunchAgent and health status without starting a daemon.
  start             Bootstrap an absent service (RunAtLoad) or kickstart a loaded one, then wait for /readyz.
  stop              bootout the managed daemon and wait for its recorded PID to exit.
  restart           stop, then start the current immutable release.
  wait-ready        Wait for the already managed daemon; never starts a process.
  smoke             Connect to the already managed daemon and validate HTTP MCP tools.
  rollback-release  Stop, atomically restore the previous release and its managed config, then start it.
  rollback-stdio    Stop HTTP first, restore saved stdio registration, or reverse to HTTP+smoke if that restoration fails.
EOF
}

service_pid() {
  "$LAUNCHCTL_BIN" print "$TARGET" 2>/dev/null \
    | awk '/^[[:space:]]*pid = [0-9]+/{print $3; exit}'
}

# 0=loaded, 1=definitely absent, 2=launchctl itself could not establish state.
# Only an absent target is safe to bootstrap; an unknown control-plane state must
# never be treated as a stopped daemon during a release or transport transition.
service_state() {
  local output
  if output="$("$LAUNCHCTL_BIN" print "$TARGET" 2>&1)"; then
    return 0
  fi
  if [[ -z "$output" || "$output" == *"Could not find service"* || "$output" == *"No such process"* ]]; then
    return 1
  fi
  echo "Unable to determine managed LaunchAgent state for $TARGET: $output" >&2
  return 2
}

wait_for_pid_exit() {
  local pid="$1"
  local deadline=$((SECONDS + 40))
  while kill -0 "$pid" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for daemon PID $pid to exit." >&2
      return 1
    fi
    sleep 1
  done
}

wait_for_service_unloaded() {
  local deadline=$((SECONDS + 40)) state
  while true; do
    if service_state; then
      :
    else
      state=$?
      if [[ "$state" == "1" ]]; then
        return 0
      fi
      return 1
    fi
    if (( SECONDS >= deadline )); then
      echo "Timed out waiting for LaunchAgent $TARGET to unload." >&2
      return 1
    fi
    sleep 1
  done
}

wait_ready() {
  local deadline=$((SECONDS + 45))
  local health_payload=""
  until health_payload="$("$CURL_BIN" --fail --silent --show-error --max-time 2 "$READY_URL" 2>/dev/null)" \
    && health_matches_managed_instance "$health_payload"; do
    if (( SECONDS >= deadline )); then
      echo "HTTP daemon is down or not ready at $READY_URL." >&2
      return 1
    fi
    sleep 1
  done
}

health_matches_managed_instance() {
  local payload="$1"
  "$NODE_BIN" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const health = JSON.parse(input);
        if (health.status !== "ok" || health.instanceId !== process.argv[1]) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    });
  ' "$JAVA_LSP_HTTP_INSTANCE_ID" <<<"$payload"
}

read_managed_health() {
  local health_payload=""
  if ! health_payload="$("$CURL_BIN" --fail --silent --show-error --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
    echo "HTTP daemon down: $HEALTH_URL" >&2
    return 1
  fi
  if ! health_matches_managed_instance "$health_payload"; then
    echo "HTTP daemon instance differs from the managed release; refusing to use $HEALTH_URL." >&2
    return 1
  fi
  printf '%s' "$health_payload"
}

stop_daemon() {
  local pid loaded="false" state
  pid="$(service_pid || true)"
  if service_state; then
    loaded="true"
  else
    state=$?
    if [[ "$state" != "1" ]]; then
      return 1
    fi
  fi
  if ! "$LAUNCHCTL_BIN" bootout "$TARGET" >/dev/null 2>&1; then
    if [[ "$loaded" == "true" ]]; then
      echo "Failed to bootout managed LaunchAgent: $TARGET" >&2
      return 1
    fi
    # A missing target is already stopped; any other bootout error is unsafe.
    if service_state; then
      echo "Failed to bootout managed LaunchAgent: $TARGET" >&2
      return 1
    else
      state=$?
    fi
    if [[ "$state" != "1" ]]; then
      return 1
    fi
  fi
  wait_for_service_unloaded
  if [[ -n "$pid" ]]; then
    wait_for_pid_exit "$pid"
  fi
}

start_daemon() {
  local state
  if service_state; then
    "$LAUNCHCTL_BIN" kickstart -k "$TARGET"
  else
    state=$?
    if [[ "$state" != "1" ]]; then
      return 1
    fi
    "$LAUNCHCTL_BIN" bootstrap "gui/$UID" "$LAUNCH_AGENT_PLIST"
  fi
  wait_ready
}

status() {
  local state
  if service_state; then
    echo "LaunchAgent loaded: $TARGET"
  else
    state=$?
    if [[ "$state" == "1" ]]; then
      echo "LaunchAgent not loaded: $TARGET"
    else
      return 1
    fi
  fi
  if read_managed_health; then
    echo
  else
    return 1
  fi
}

smoke() {
  local expected_build
  read_managed_health >/dev/null
  expected_build="$("$NODE_BIN" -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).gitSha)' "$RUNTIME_DIR/current/dist/build-stamp.json")"
  "$NODE_BIN" "$RUNTIME_DIR/current/dist/smoke-http.js" --url "http://127.0.0.1:$JAVA_LSP_HTTP_PORT/mcp" --expect-build "$expected_build"
}

rollback_release() {
  if [[ ! -L "$RUNTIME_DIR/state/previous-current" ]]; then
    echo "No previous immutable release is recorded." >&2
    exit 2
  fi
  local current_target current_build rollback_dir
  current_target="$(readlink "$RUNTIME_DIR/current")"
  case "$current_target" in
    releases/*)
      current_build="${current_target#releases/}"
      ;;
    *)
      echo "Current release link is not an immutable releases/<build-id> target: $current_target" >&2
      exit 2
      ;;
  esac
  if [[ "$(readlink "$RUNTIME_DIR/state/previous-current")" == "$current_target" ]]; then
    echo "Previous immutable release resolves to the current release; refusing unsafe rollback." >&2
    exit 2
  fi
  rollback_dir="$RUNTIME_DIR/state/rollback-$current_build"
  assert_release_rollback_backup "$rollback_dir"
  assert_predecessor_managed_state "$rollback_dir/daemon.env"
  stop_daemon
  local staged="$RUNTIME_DIR/.current.rollback.$$"
  ln -s "$(readlink "$RUNTIME_DIR/state/previous-current")" "$staged"
  mv -f -h "$staged" "$RUNTIME_DIR/current"
  if ! restore_release_managed_configuration "$rollback_dir"; then
    echo "Release link was restored, but its managed configuration could not be restored; leaving daemon stopped." >&2
    exit 1
  fi
  # Reload the predecessor's label, plist, port, and Node path before bootstrap.
  # The controller may have restored itself on disk, but this process continues
  # with the already-loaded safe rollback implementation.
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  if [[ "${RUNTIME_DIR_FROM_STATE:-}" != "$RUNTIME_DIR" ]]; then
    echo "Restored daemon state runtime directory does not match CODEX_JAVA_LSP_RUNTIME_DIR." >&2
    exit 1
  fi
  start_daemon
  smoke
}

assert_release_rollback_backup() {
  local rollback_dir="$1"
  local required_marker
  for required_marker in \
    daemon.env.marker \
    target-launch-agent.plist.marker \
    run-daemon.sh.marker \
    run.sh.marker \
    daemonctl.sh.marker
  do
    if [[ ! -f "$rollback_dir/$required_marker" || "$(<"$rollback_dir/$required_marker")" != "present" ]]; then
      echo "No complete managed predecessor configuration is available for release rollback: $rollback_dir" >&2
      exit 2
    fi
  done
  local predecessor_marker
  predecessor_marker="$rollback_dir/previous-current.marker"
  if [[ ! -f "$predecessor_marker" || ( "$(<"$predecessor_marker")" != "present" && "$(<"$predecessor_marker")" != "absent" ) ]]; then
    echo "No valid predecessor pointer backup is available for release rollback: $rollback_dir" >&2
    exit 2
  fi
}

assert_predecessor_managed_state() {
  local predecessor_state="$1"
  local predecessor_runtime predecessor_instance
  predecessor_runtime="$(bash -c 'source "$1"; printf "%s" "${RUNTIME_DIR_FROM_STATE:-}"' _ "$predecessor_state")"
  predecessor_instance="$(bash -c 'source "$1"; printf "%s" "${JAVA_LSP_HTTP_INSTANCE_ID:-}"' _ "$predecessor_state")"
  if [[ "$predecessor_runtime" != "$RUNTIME_DIR" || ! "$predecessor_instance" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
    echo "Predecessor managed state is incompatible with safe HTTP release rollback; leaving the current daemon untouched." >&2
    exit 2
  fi
}

restore_release_file() {
  local target="$1"
  local backup="$2"
  local marker="$3"
  local staged="${target}.restore.$$"
  cp -p "$backup" "$staged" || return 1
  mv -f "$staged" "$target" || return 1
}

restore_release_link() {
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

restore_release_managed_configuration() {
  local rollback_dir="$1"
  restore_release_file \
    "$RUNTIME_DIR/state/daemon.env" \
    "$rollback_dir/daemon.env" \
    "$rollback_dir/daemon.env.marker" || return 1
  restore_release_file \
    "$LAUNCH_AGENT_PLIST" \
    "$rollback_dir/target-launch-agent.plist" \
    "$rollback_dir/target-launch-agent.plist.marker" || return 1
  restore_release_file \
    "$RUNTIME_DIR/run-daemon.sh" \
    "$rollback_dir/run-daemon.sh" \
    "$rollback_dir/run-daemon.sh.marker" || return 1
  restore_release_file \
    "$RUNTIME_DIR/run.sh" \
    "$rollback_dir/run.sh" \
    "$rollback_dir/run.sh.marker" || return 1
  restore_release_file \
    "$RUNTIME_DIR/daemonctl.sh" \
    "$rollback_dir/daemonctl.sh" \
    "$rollback_dir/daemonctl.sh.marker" || return 1
  restore_release_link \
    "$RUNTIME_DIR/state/previous-current" \
    "$rollback_dir/previous-current" \
    "$rollback_dir/previous-current.marker" || return 1
  if [[ -f "$rollback_dir/previous-launch-agent.path" ]]; then
    local previous_plist
    previous_plist="$(<"$rollback_dir/previous-launch-agent.path")"
    if [[ ! -f "$rollback_dir/previous-launch-agent.plist.marker" || "$(<"$rollback_dir/previous-launch-agent.plist.marker")" != "present" ]]; then
      return 1
    fi
    restore_release_file \
      "$previous_plist" \
      "$rollback_dir/previous-launch-agent.plist" \
      "$rollback_dir/previous-launch-agent.plist.marker" || return 1
  fi
}

rollback_stdio() {
  local rollback_script="$RUNTIME_DIR/state/rollback-stdio-mcp.sh"
  local reverse_rollback="$RUNTIME_DIR/state/rollback-http-mcp.sh"
  if [[ ! -x "$rollback_script" ]]; then
    echo "No saved stdio rollback command is available: $rollback_script" >&2
    exit 2
  fi
  stop_daemon
  if "$rollback_script"; then
    echo "Stdio registration restored. Restart Codex/Desktop before opening a new task."
    return
  fi

  echo "Stdio registration restoration failed after HTTP daemon stop; attempting bounded HTTP reverse recovery." >&2
  if [[ ! -x "$reverse_rollback" ]]; then
    echo "No saved HTTP reverse-recovery command is available: $reverse_rollback. Daemon remains stopped." >&2
    exit 1
  fi
  if ! "$reverse_rollback"; then
    echo "HTTP MCP registration could not be restored. Daemon remains stopped." >&2
    exit 1
  fi
  if ! start_daemon || ! smoke; then
    echo "HTTP registration was restored, but the managed daemon could not be restarted and smoked. Daemon state requires manual repair." >&2
    exit 1
  fi
  echo "Stdio restoration failed; HTTP configuration and managed daemon were restored." >&2
  exit 1
}

command_name="${1:-}"
case "$command_name" in
  status) status ;;
  start) start_daemon ;;
  stop) stop_daemon ;;
  restart) stop_daemon; start_daemon ;;
  wait-ready) wait_ready ;;
  smoke) smoke ;;
  rollback-release) rollback_release ;;
  rollback-stdio) rollback_stdio ;;
  --help|-h|"") usage ;;
  *) usage >&2; exit 2 ;;
esac
