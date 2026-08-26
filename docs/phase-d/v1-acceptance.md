# V1-R / §9 acceptance — daemon stability and memory (2026-08-26)

Branch `codex/frontier-r1`. Live release `b180ec21a6ea-20260826T150751Z` (`http://127.0.0.1:38456/mcp`, hot-set `hydrate:true`, worker isolate cap **1536**, snapshot schema v5, **hot-set exempt from hibernate recycle and index-idle close**, cold-start omits `deadlineMs` → 15s public budget). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe: `scripts/d3-idle-probe.sh`, `scripts/d4-clean-probe.mjs`, `scripts/d1-controlled-soak.sh`. Identity: `/tmp/codex-java-lsp-matrix-s4-identity-20260826T152100`.

Isolated T0: 1279 + 280 pass, exit 0 on `b180ec2`. `gate:pr` 1279 pass. LaunchAgent has **no** soak TTL leftovers.

## §9.2 dispositions

D2 1 Hz×90 追认 PASS. ingest 空数组+onDuplicate 追认. Decision A 未采用追认. D8 satisfied-by-proxy. 24h 遥测 / W2 / floors 不阻塞.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D3-idle hot ≤ 3s, 0 isError | PASS | After 60s index-idle, `minimal`/`fast`: lishuedu **177 ms**, lishu-v2 **191 ms**, 0 isError. TTL restored. |
| D3-idle cold ≤ 15s, 0 isError | PASS | cipherlink **6468 ms**, exam-parent-v3 **2718 ms**, 0 isError, no warming stub. |
| D4 retry ≤ 500 ms, 0 restart | PASS | Warm lishuedu, avoid D3c: short 22 ms, retry **63 ms**, 0 isError. |
| identity vs `main` `--runs 2` | PASS (content) / FAIL (formal floors) | old=`c8f8fd8` new=`b22dce4`. recall/pRead/token P50 **delta 0** on all three frozen clones. `passed=false` is floors on both arms (§8.2). |
| D1 dual-metric (accelerated 3 min) | PARTIAL | Production TTLs, no LaunchAgent mutation. After prewarm, 180s samples: live RSS **39.2 MiB ≤ 700**. phys_footprint **1179 MiB** (peak 1356). **FAIL vs 1024**; **not** in 1024–1152 attribution window. Arena: MALLOC_LARGE dirty 310 MiB + MALLOC_SMALL dirty 243 MiB; daemon RSS 53 MiB. First 30 min soak was aborted (contaminated by identity) then replaced per user request. |
| D1 30 min production soak | SKIPPED | User directed a few-minute soak. 20 min index-idle is a no-op for hot pins after M2b. |

Prior V1-R numbers on `f6cb334` (D3a 38/32, D3c 1872/1833, D5 2165/170, firstHydrate 6570–8422, D2 90-sample P99 31 ms) are unchanged as historical.

## Overall

**M2b + S5 landed and live.** D3-idle / D4 / identity content are green. **D1 footprint 1179 > 1152 is the remaining §9.4 merge blocker** (live RSS already ≤ 700). Do not merge `main` unless asked. Rollback: `daemonctl.sh rollback-release`.
