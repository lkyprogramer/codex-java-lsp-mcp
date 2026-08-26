#!/usr/bin/env bash
# Temporarily shrink index-idle TTL to 60s, wait for cold pins to close, probe
# D3-idle (hot ≤3s / cold ≤15s, 0 isError), then restore production TTLs.
set -euo pipefail
export PATH="/opt/homebrew/bin:${HOME}/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin${PATH:+:$PATH}"

INDEX_IDLE_TTL_MS="${JAVA_LSP_D3_IDLE_TTL_MS:-60000}"
PREWARM_WAIT_S="${JAVA_LSP_D3_PREWARM_WAIT_S:-180}"
SETTLE_S="${JAVA_LSP_D3_SETTLE_S:-70}"
LABEL="${LAUNCH_AGENT_LABEL:-com.lky.codex-java-lsp-mcp}"
PLIST="${CODEX_JAVA_LSP_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$LABEL.plist"
RUNTIME_DIR="${CODEX_JAVA_LSP_RUNTIME_DIR:-$HOME/Library/Application Support/codex-java-lsp-mcp}"
DAEMONCTL="$RUNTIME_DIR/daemonctl.sh"
LOG_DIR="${CODEX_JAVA_LSP_LOG_DIR:-$HOME/Library/Logs/codex-java-lsp-mcp}"
STDERR_LOG="$LOG_DIR/daemon.stderr.log"
OUT_DIR="${JAVA_LSP_D3_OUT_DIR:-$PWD/docs/phase-d}"
OUT_JSON="$OUT_DIR/d3-idle.json"
OUT_LOG="$OUT_DIR/d3-idle.log"
BACKUP="$PLIST.d3-idle.bak.$$"
PB=/usr/libexec/PlistBuddy
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
restored=0

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$OUT_LOG"; }

daemon_pid() {
  launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/{print $3; exit}'
}

set_ttl() {
  local key="$1" value="$2"
  "$PB" -c "Delete :EnvironmentVariables:$key" "$PLIST" >/dev/null 2>&1 || true
  "$PB" -c "Add :EnvironmentVariables:$key string $value" "$PLIST"
}

restore_production_ttls() {
  if (( restored )); then
    return 0
  fi
  restored=1
  if [[ -f "$BACKUP" ]]; then
    log "restoring production LaunchAgent plist"
    cp -p "$BACKUP" "$PLIST"
    rm -f "$BACKUP"
    if ! "$DAEMONCTL" restart; then
      log "FAILED to restart daemon after restoring production TTLs"
      return 1
    fi
    log "production TTLs restored pid=$(daemon_pid)"
  fi
}

trap 'restore_production_ttls || true' EXIT

mkdir -p "$OUT_DIR"
: >"$OUT_LOG"

if [[ ! -f "$PLIST" || ! -x "$DAEMONCTL" ]]; then
  echo "managed daemon is not installed" >&2
  exit 2
fi

log "backup $PLIST"
cp -p "$PLIST" "$BACKUP"
set_ttl JAVA_LSP_INDEX_IDLE_TTL_MS "$INDEX_IDLE_TTL_MS"
plutil -lint "$PLIST" >/dev/null

log "restart with indexIdle=${INDEX_IDLE_TTL_MS}ms"
"$DAEMONCTL" restart
PID="$(daemon_pid)"
if [[ -z "$PID" ]]; then
  log "daemon pid missing after restart"
  exit 1
fi
log "pid=$PID"

LOG_MARK="$(wc -l <"$STDERR_LOG" | tr -d ' ')"
T0=$SECONDS
PREWARM_DONE_AT=""
while (( SECONDS - T0 < PREWARM_WAIT_S )); do
  new_logs="$(tail -n +"$((LOG_MARK + 1))" "$STDERR_LOG" 2>/dev/null || true)"
  if grep -q 'pinned repo prewarm finished' <<<"$new_logs"; then
    PREWARM_DONE_AT=$((SECONDS - T0))
    log "prewarm finished at t=${PREWARM_DONE_AT}s"
    break
  fi
  sleep 2
done
if [[ -z "$PREWARM_DONE_AT" ]]; then
  log "prewarm did not finish within ${PREWARM_WAIT_S}s"
  exit 1
fi

log "waiting ${SETTLE_S}s for cold index-idle close"
sleep "$SETTLE_S"

log "probing D3-idle"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
if [[ -z "$NODE_BIN" ]]; then
  log "node not found on PATH"
  exit 2
fi
if ! "$NODE_BIN" "$ROOT/scripts/d3-idle-probe.mjs" "$OUT_JSON" | tee -a "$OUT_LOG"; then
  log "D3-idle probe FAIL"
  restore_production_ttls
  trap - EXIT
  exit 1
fi

log "D3-idle probe PASS"
restore_production_ttls
trap - EXIT
