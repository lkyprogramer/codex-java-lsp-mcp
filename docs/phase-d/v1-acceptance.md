# V1-R acceptance — daemon stability and memory (2026-08-26)

Branch `codex/frontier-r1`. Live release `eb722cf5bd0b-20260826T091605Z` (`http://127.0.0.1:38456/mcp`, hot-set `hydrate:true`, worker isolate cap **1536**, snapshot schema v5, isolate recycle on hibernate + index-idle close of hot pins). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe: `scripts/probe-daemon-acceptance.mjs`. Fast D1 soak: `scripts/d1-fast-idle-soak.sh`. S4 closeout: `docs/phase-d/s4-chunked-snapshot-closeout.json`.

Isolated T0: 1272 + 278 pass, exit 0. `gate:pr` exit 0.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D1 steady footprint ≤ 1024 MiB (dual-hot) after idle-close | PASS | `eb722cf` fast soak (hibernate 2s + index-idle 4s + 40s settle, wait for `prewarm finished`): peak **927 MiB**, end **639 MiB**, plateau 639. Production TTLs restored after. Recycle drops hydrated isolates (t=9 878 → t=11 588 → t=50 471). |
| D2 storm healthz P99 < 100 ms, 0 timeouts | PASS | Prior V1 gradle storm: 90 samples, 0 timeouts, P99 31.2 ms. Recycle-release probe: 12 samples, 0 timeouts, P99 12.6 ms. OPEN/hydrate can still stall healthz; not a merge blocker per §8.2. |
| D3a hot pin first impact P95 ≤ 3 s | PASS | After prewarm on `eb722cf`: lishuedu **874 ms**, lishu-v2 **50 ms**, 0 toolFail. Follow-ups 16–25 ms. Earlier `1ad5ee8` 三连: 41.6 / 35.8 ms. |
| D3b cold pin first impact no tool fail | PASS | cipherlink 970 ms, exam-parent-v3 2093 ms, 0 toolFail. |
| D3c non-hot on-demand hydrate ≤ 12 s | PASS | Same cold-pin first impacts: 970 / 2093 ms, both ≤ 12 s, 0 toolFail. |
| D4 query timeout does not restart worker | PASS | Unit: QUERY/STATUS `terminations === 0`. Live: short 11 ms then retry 11 ms, no tool error. |
| D5 cold-build peak ≤ 4 GiB + 10 min fallback to D1 | PASS | Deleted lishuedu snapshot, restarted, sampled daemon+cold-build-child: **peak 1358 MiB ≤ 4 GiB**, **end 189 MiB after 10 min ≤ 1024**. Curve: scratch `live/d5.json`. |
| D6 unregistered `java_status` ≤ 3 s | PASS | Recycle-release probe `fixtures/generic-java`: 152 ms. |
| D7 worktree seed reusedFiles ≥ 0.9, no child, ≤ 15 s | PASS | Recycle-release: `SEEDED_DEGRADED`, reused 1414 / denom 1493, status 11588 ms, no child. |
| identity vs `main` first-plan content | PASS (content) / FAIL (formal floors) | Unchanged: recall/pRead/token P50 **delta 0**; `rReadMust` / `range*` / `holdoutRReadMust` fail on **both** arms (pre-existing, not a cutover blocker per §8.2). |

## Overall

**COMPLETE.** S4 chunked snapshots plus isolate recycle (`eb722cf`) meet the revised V1-R gates: D1 639 / D3a 874+50 / D3c 970+2093 / D5 peak 1358 end 189. Identity formal floors remain pre-existing. Do not merge `main` unless asked. Rollback: `daemonctl.sh rollback-release`.
