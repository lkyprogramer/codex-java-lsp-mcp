#!/usr/bin/env bash
# Production-TTL D1 soak: wait for prewarm, then sample phys_footprint and live RSS
# (daemon + children) for 30 minutes. Does not mutate LaunchAgent TTLs.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin"

SOAK_S="${JAVA_LSP_D1_SOAK_S:-1800}"
SAMPLE_S="${JAVA_LSP_D1_SAMPLE_S:-60}"
PREWARM_WAIT_S="${JAVA_LSP_D1_PREWARM_WAIT_S:-180}"
LIVE_GATE_MIB="${JAVA_LSP_D1_LIVE_GATE_MIB:-700}"
FOOT_GATE_MIB="${JAVA_LSP_D1_FOOT_GATE_MIB:-1024}"
FOOT_ATTR_MIB="${JAVA_LSP_D1_FOOT_ATTR_MIB:-1152}"
LABEL="${LAUNCH_AGENT_LABEL:-com.lky.codex-java-lsp-mcp}"
RUNTIME_DIR="${CODEX_JAVA_LSP_RUNTIME_DIR:-$HOME/Library/Application Support/codex-java-lsp-mcp}"
DAEMONCTL="$RUNTIME_DIR/daemonctl.sh"
LOG_DIR="${CODEX_JAVA_LSP_LOG_DIR:-$HOME/Library/Logs/codex-java-lsp-mcp}"
STDERR_LOG="$LOG_DIR/daemon.stderr.log"
OUT_DIR="${JAVA_LSP_D1_OUT_DIR:-$PWD/docs/phase-d}"
OUT_JSON="$OUT_DIR/d1-controlled-soak.json"
OUT_LOG="$OUT_DIR/d1-controlled-soak.log"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$OUT_LOG"; }

daemon_pid() {
  launchctl print "gui/$UID/$LABEL" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/{print $3; exit}'
}

live_rss_kib() {
  local pid="$1"
  ps -axo pid=,ppid=,rss= | awk -v root="$pid" '
    { pid=$1; ppid=$2; rss=$3; pids[pid]=1; parent[pid]=ppid; mem[pid]=rss }
    END {
      total=0
      for (pid in pids) {
        cur=pid
        ok=0
        for (i=0; i<32 && cur!=""; i++) {
          if (cur==root) { ok=1; break }
          cur=parent[cur]
        }
        if (ok) total += mem[pid]
      }
      print total
    }
  '
}

footprint_fields() {
  local pid="$1"
  footprint -p "$pid" 2>/dev/null | awk '
    $1 == "phys_footprint:" { cur=$2 }
    $1 == "phys_footprint_peak:" { peak=$2 }
    /MALLOC_SMALL/ && /dirty/ { small=$0 }
    END { if (cur == "") print "null null"; else print cur, (peak == "" ? "null" : peak) }
  '
}

mkdir -p "$OUT_DIR"
: >"$OUT_LOG"

if [[ ! -x "$DAEMONCTL" ]]; then
  echo "managed daemon is not installed" >&2
  exit 2
fi

log "restart for controlled D1 soak (production TTLs)"
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

SOAK_START=$SECONDS
SAMPLES=()
while (( SECONDS - SOAK_START <= SOAK_S )); do
  elapsed=$((SECONDS - SOAK_START))
  fields="$(footprint_fields "$PID")"
  cur="${fields%% *}"
  peak="${fields##* }"
  rss_kib="$(live_rss_kib "$PID")"
  live_mib="$(python3 -c "print(round($rss_kib / 1024.0, 1))")"
  log "t=${elapsed}s pid=$PID phys_mib=$cur peak_mib=$peak live_rss_mib=$live_mib"
  SAMPLES+=("$elapsed,$cur,$peak,$live_mib")
  if (( elapsed >= SOAK_S )); then
    break
  fi
  sleep "$SAMPLE_S"
done

python3 - "$OUT_JSON" "$LIVE_GATE_MIB" "$FOOT_GATE_MIB" "$FOOT_ATTR_MIB" "$PID" "$SOAK_S" "${SAMPLES[@]}" <<'PY'
import json, sys
out, live_gate, foot_gate, foot_attr, pid, soak_s, *rows = sys.argv[1:]
samples = []
for row in rows:
    elapsed, cur, peak, live = row.split(",", 3)
    samples.append({
        "elapsedS": int(elapsed),
        "physMiB": None if cur == "null" else float(cur),
        "peakMiB": None if peak == "null" else float(peak),
        "liveRssMiB": None if live == "null" else float(live),
    })
phys = [s["physMiB"] for s in samples if s["physMiB"] is not None]
live = [s["liveRssMiB"] for s in samples if s["liveRssMiB"] is not None]
end_phys = phys[-1] if phys else None
end_live = live[-1] if live else None
live_ok = end_live is not None and end_live <= float(live_gate)
if end_phys is None:
    result = "FAIL"
    attribution = None
elif end_phys <= float(foot_gate) and live_ok:
    result = "PASS"
    attribution = None
elif end_phys <= float(foot_attr) and live_ok:
    result = "PASS"
    attribution = "MALLOC arena dirty pages; live RSS within 700 MiB"
else:
    result = "FAIL"
    attribution = None
payload = {
    "schema": "d1-controlled-soak/v1",
    "method": "production TTLs, wait prewarm finished, sample footprint and daemon+children RSS for 30 minutes",
    "soakS": int(soak_s),
    "liveGateMiB": float(live_gate),
    "footGateMiB": float(foot_gate),
    "footAttrMiB": float(foot_attr),
    "pid": int(pid),
    "samples": samples,
    "endPhysMiB": end_phys,
    "endLiveRssMiB": end_live,
    "peakPhysMiB": max(s["peakMiB"] for s in samples if s["peakMiB"] is not None) if samples else None,
    "attribution": attribution,
    "result": result,
}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
print(json.dumps({k: payload[k] for k in ("result", "endPhysMiB", "endLiveRssMiB", "attribution")}, indent=2))
raise SystemExit(0 if result == "PASS" else 1)
PY
