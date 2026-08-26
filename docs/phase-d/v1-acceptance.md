# V1-R acceptance — daemon stability and memory (2026-08-26)

Branch `codex/frontier-r1`. Live release `1ad5ee8fdd63-20260826T082846Z` (`http://127.0.0.1:38456/mcp`, hot-set `hydrate:true`, worker isolate cap **1536**). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe: `scripts/probe-daemon-acceptance.mjs`. Fast D1 soak: `scripts/d1-fast-idle-soak.sh`. S4 closeout: `docs/phase-d/s4-chunked-snapshot-closeout.json`.

Isolated T0: 1271 + 278 pass, exit 0. `gate:pr` exit 0.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D1 steady footprint ≤ 1024 MiB (dual-hot) after idle-close | FAIL | Fast soak on `1ad5ee8` with hibernate 2s + index-idle 4s + 40s settle: end **1339 MiB**, peak 1526. A longer idle run reached a **861 MiB** waterline then climbed during cold-pin isolate close. Hot pins are exempt from index-idle close; Worker cannot `--expose-gc`. Files-only 807 on `425fd96` remains the single-hot/files-only reference. |
| D2 storm healthz P99 < 100 ms, 0 timeouts | PASS | Prior V1 gradle storm: 90 samples, 0 timeouts, P99 31.2 ms. S4 probe idle healthz 12 samples P99 2.4 ms. OPEN/hydrate can still stall healthz (fast-soak t=16–37). Not a merge blocker per §8.2. |
| D3a hot pin first impact P95 ≤ 3 s | PASS | After hydrate 三连 on `1ad5ee8` (9.0 / 16.1 / 15.1 s, **zero** `ERR_WORKER_OUT_OF_MEMORY`): lishuedu **41.6 ms**, lishu-v2 **35.8 ms**, 0 toolFail. Follow-ups 13–22 ms. |
| D3b cold pin first impact no tool fail | PASS | cipherlink 689 ms, exam-parent-v3 2004 ms, 0 toolFail. |
| D3c non-hot on-demand hydrate ≤ 12 s | PASS | Same cold-pin first impacts (hibernate after prewarm, then fact query): 689 / 2004 ms, both ≤ 12 s, 0 toolFail. |
| D4 query timeout does not restart worker | PASS | Unit: QUERY/STATUS `terminations === 0`. Live: short 82 ms then retry 8 ms, no tool error. |
| D5 cold-build peak ≤ 4 GiB + 10 min fallback to D1 | PARTIAL | After deleting the lishuedu v5 snapshot and probing: daemon phys_footprint **peak 2572 MiB ≤ 4 GiB**, **end 1648 MiB after 10 min** (FAIL vs D1 1024). Curve: scratch `live/d5.json`. |
| D6 unregistered `java_status` ≤ 3 s | PASS | V1-R probe `fixtures/generic-java`: 132 ms. |
| D7 worktree seed reusedFiles ≥ 0.9, no child, ≤ 15 s | PASS (prior) / FAIL (this probe) | `54b7c09` / V1: SEEDED_DEGRADED reused 1423/1423. V1-R probe with `JAVA_LSP_V1_KEEP_TORNA_SNAP=1` reported `seed: null` (stale v4 snap vs v5 reader). Not an S4 hydrate regression. |
| identity vs `main` first-plan content | PASS (content) / FAIL (formal floors) | Unchanged: recall/pRead/token P50 **delta 0**; `rReadMust` / `range*` / `holdoutRReadMust` fail on **both** arms (pre-existing, not a cutover blocker per §8.2). |

## Overall

**NOT COMPLETE.** S4 chunked snapshots + cap 1536 cleared the D3a OOM: hydrate 三连 green, D3a/D3c/D4/D6 PASS, firstHydrate inside the 10 s budget (four-pin prewarm 9–16 s). D1 still FAIL vs dual-hot 1024 on the fast soak (1339 MiB; GC waterline 861). Do not merge `main` until D1 is honest at 1024 or the gate is re-adjudicated. Rollback: `daemonctl.sh rollback-release`.
