#!/usr/bin/env bash
# Temporarily shrink hibernate + index-idle TTLs on the live LaunchAgent, sample
# phys_footprint after those timers fire, then restore production TTLs.
# Does not rebuild a release. Matches D1 idle shape: JDT idle TTL stays at the
# production 45 min default (a 30 min soak would not have stopped JDT anyway).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin"

HIBERNATE_TTL_MS="${JAVA_LSP_SOAK_HIBERNATE_TTL_MS:-2000}"
INDEX_IDLE_TTL_MS="${JAVA_LSP_SOAK_INDEX_IDLE_TTL_MS:-4000}"
PREWARM_WAIT_S="${JAVA_LSP_SOAK_PREWARM_WAIT_S:-180}"
GATE_MIB="${JAVA_LSP_SOAK_GATE_MIB:-1024}"
LABEL="${LAUNCH_AGENT_LABEL:-com.lky.codex-java-lsp-mcp}"
PLIST="${CODEX_JAVA_LSP_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/$LABEL.plist"
RUNTIME_DIR="${CODEX_JAVA_LSP_RUNTIME_DIR:-$HOME/Library/Application Support/codex-java-lsp-mcp}"
DAEMONCTL="$RUNTIME_DIR/daemonctl.sh"
LOG_DIR="${CODEX_JAVA_LSP_LOG_DIR:-$HOME/Library/Logs/codex-java-lsp-mcp}"
STDERR_LOG="$LOG_DIR/daemon.stderr.log"
OUT_DIR="${JAVA_LSP_SOAK_OUT_DIR:-$PWD/docs/phase-d}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_JSON="$OUT_DIR/d1-fast-idle-soak.json"
OUT_LOG="$OUT_DIR/d1-fast-idle-soak.log"
BACKUP="$PLIST.d1-fast-soak.bak.$$"
SETTLE_EXTRA_S="${JAVA_LSP_SOAK_SETTLE_EXTRA_S:-40}"
SETTLE_S=$((INDEX_IDLE_TTL_MS / 1000 + SETTLE_EXTRA_S))
PB=/usr/libexec/PlistBuddy
restored=0

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$OUT_LOG"; }

daemon_pid() {
  launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/{print $3; exit}'
}

footprint_fields() {
  local pid="$1"
  footprint -p "$pid" 2>/dev/null | awk '
    $1 == "phys_footprint:" { cur=$2 }
    $1 == "phys_footprint_peak:" { peak=$2 }
    END { if (cur == "") print "null null"; else print cur, (peak == "" ? "null" : peak) }
  '
}

plist_env() {
  launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk '
    /JAVA_LSP_HIBERNATE_TTL_MS|JAVA_LSP_INDEX_IDLE_TTL_MS|JAVA_LSP_IDLE_TTL_MS/ { print }
  '
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
    plist_env | tee -a "$OUT_LOG" || true
  fi
}

trap 'restore_production_ttls || true' EXIT

mkdir -p "$OUT_DIR"
: >"$OUT_LOG"

if [[ ! -f "$PLIST" || ! -x "$DAEMONCTL" ]]; then
  echo "managed daemon is not installed" >&2
  exit 2
fi
if [[ ! -x "$PB" ]]; then
  echo "PlistBuddy is required" >&2
  exit 2
fi

log "backup $PLIST"
cp -p "$PLIST" "$BACKUP"
set_ttl JAVA_LSP_HIBERNATE_TTL_MS "$HIBERNATE_TTL_MS"
set_ttl JAVA_LSP_INDEX_IDLE_TTL_MS "$INDEX_IDLE_TTL_MS"
plutil -lint "$PLIST" >/dev/null

log "restart with hibernate=${HIBERNATE_TTL_MS}ms indexIdle=${INDEX_IDLE_TTL_MS}ms"
"$DAEMONCTL" restart
PID="$(daemon_pid)"
if [[ -z "$PID" ]]; then
  log "daemon pid missing after restart"
  exit 1
fi
log "pid=$PID env:"
plist_env | tee -a "$OUT_LOG"

LOG_MARK="$(wc -l <"$STDERR_LOG" | tr -d ' ')"
SAMPLES=()
T0=$SECONDS
DEADLINE=$((T0 + PREWARM_WAIT_S + SETTLE_S))
PREWARM_DONE_AT=""
QUIET_SINCE=""
LAST_JUMP_AT=0
PREV_MIB=""
PREV_LOG_LEN="$LOG_MARK"

while (( SECONDS < DEADLINE )); do
  elapsed=$((SECONDS - T0))
  fields="$(footprint_fields "$PID")"
  cur="${fields%% *}"
  peak="${fields##* }"
  health="$(curl -sS --max-time 2 "http://127.0.0.1:38456/healthz" 2>/dev/null || echo '{"status":"down"}')"
  new_logs="$(tail -n +"$((LOG_MARK + 1))" "$STDERR_LOG" 2>/dev/null || true)"
  if grep -q 'pinned repo prewarm finished' <<<"$new_logs"; then
    PREWARM_DONE_AT="${PREWARM_DONE_AT:-$elapsed}"
  fi
  log_len="$(wc -l <"$STDERR_LOG" | tr -d ' ')"
  if [[ "$log_len" != "$PREV_LOG_LEN" ]]; then
    PREV_LOG_LEN="$log_len"
    QUIET_SINCE=""
  else
    QUIET_SINCE="${QUIET_SINCE:-$elapsed}"
  fi
  if [[ "$cur" != "null" && -n "$PREV_MIB" ]]; then
    python3 - "$cur" "$PREV_MIB" <<'PY' && LAST_JUMP_AT="$elapsed" || true
import sys
cur, prev = float(sys.argv[1]), float(sys.argv[2])
raise SystemExit(0 if abs(cur - prev) >= 20 else 1)
PY
  fi
  PREV_MIB="$cur"
  line="t=${elapsed}s pid=$PID phys_mib=$cur peak_mib=$peak health=$health"
  log "$line"
  SAMPLES+=("$elapsed,$cur,$peak")

  if [[ -n "$PREWARM_DONE_AT" ]] && (( elapsed >= PREWARM_DONE_AT + SETTLE_S )); then
    log "stop: prewarm finished + settle ${SETTLE_S}s"
    break
  fi
  sleep 2
done

python3 - "$OUT_JSON" "$GATE_MIB" "$HIBERNATE_TTL_MS" "$INDEX_IDLE_TTL_MS" "$PID" "${SAMPLES[@]}" <<'PY'
import json, sys
out, gate, hibernate, index_idle, pid, *rows = sys.argv[1:]
samples = []
for row in rows:
    elapsed, cur, peak = row.split(",", 2)
    samples.append({
        "elapsedS": int(elapsed),
        "physMiB": None if cur == "null" else float(cur),
        "peakMiB": None if peak == "null" else float(peak),
    })
phys = [s["physMiB"] for s in samples if s["physMiB"] is not None]
peaks = [s["peakMiB"] for s in samples if s["peakMiB"] is not None]
end = phys[-1] if phys else None
plateau = phys[-3:] if len(phys) >= 3 else phys
payload = {
    "schema": "d1-fast-idle-soak/v1",
    "method": "temporarily set JAVA_LSP_HIBERNATE_TTL_MS and JAVA_LSP_INDEX_IDLE_TTL_MS on the live LaunchAgent, wait for prewarm plus those timers, sample footprint -p phys_footprint, restore production plist",
    "gateMiB": int(gate),
    "hibernateTtlMs": int(hibernate),
    "indexIdleTtlMs": int(index_idle),
    "idleTtlMs": "production-default",
    "pid": int(pid),
    "samples": samples,
    "endMiB": end,
    "plateauMiB": plateau,
    "peakMiB": max(peaks) if peaks else None,
    "result": "PASS" if end is not None and end <= int(gate) else "FAIL",
}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
print(json.dumps({k: payload[k] for k in ("result", "endMiB", "peakMiB", "gateMiB")}, indent=2))
PY

log "wrote $OUT_JSON"
restore_production_ttls
trap - EXIT
