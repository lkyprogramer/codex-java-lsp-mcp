# V1-R acceptance — daemon stability and memory (2026-08-26)

Branch `codex/frontier-r1`. Live release `f6cb33421b32-20260826T113824Z` (`http://127.0.0.1:38456/mcp`, hot-set `hydrate:true`, worker isolate cap **1536**, snapshot schema v5, isolate recycle on hibernate + index-idle close of hot pins, prewarm holds `refCount`, freemem pressure skips hot-set). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe: `scripts/probe-daemon-acceptance.mjs`. Fast D1 soak: `scripts/d1-fast-idle-soak.sh`. S4 closeout: `docs/phase-d/s4-chunked-snapshot-closeout.json`.

Isolated T0: 1274 + 280 pass, exit 0. `gate:pr` 1274 pass, exit 0. Install copies exclude `artifacts/` / `graphify-out/`; live `releases/` is two 90MB dirs.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D1 steady footprint ≤ 1024 MiB (dual-hot) after idle-close | PASS | `f6cb334` fast soak (hibernate 2s + index-idle 4s + 40s settle, wait for `prewarm finished`): peak **1676 MiB** (hydrate), end **942 MiB** ≤ 1024. Production TTLs restored after. |
| D2 storm healthz P99 < 100 ms, 0 timeouts | PASS | `f6cb334` probe: 12 samples, 0 timeouts, P99 19.4 ms. OPEN/hydrate can still stall healthz; not a merge blocker per §8.2. |
| D3a hot pin first impact P95 ≤ 3 s | PASS | After prewarm on `f6cb334`: lishuedu **38 ms**, lishu-v2 **32 ms**, 0 toolFail. Follow-ups 12–15 ms. (`0401d04` / `009a3ff` failed at 8457 / 8573 ms because macOS `os.freemem()` pressure recycled the oldest hot pin.) |
| D3b cold pin first impact no tool fail | PASS | cipherlink 1872 ms, exam-parent-v3 1833 ms, 0 toolFail. |
| D3c non-hot on-demand hydrate ≤ 12 s | PASS | Same cold-pin first impacts: 1872 / 1833 ms, both ≤ 12 s, 0 toolFail. |
| D4 query timeout does not restart worker | PASS | Unit: QUERY/STATUS `terminations === 0`. Live short-deadline during the D3c on-demand pair hit 1504 ms; not a worker restart. |
| D5 cold-build peak ≤ 4 GiB + 10 min fallback to D1 | PASS | Deleted lishuedu snapshot, restarted, sampled daemon+descendants: **peak 2165 MiB ≤ 4 GiB**, **end 170 MiB after 10 min ≤ 1024**. Curve: scratch `live/d5.json`. |
| D6 unregistered `java_status` ≤ 3 s | PASS | `f6cb334` probe `fixtures/generic-java`: 113 ms. |
| D7 worktree seed reusedFiles ≥ 0.9, no child, ≤ 15 s | PASS | `f6cb334`: `SEEDED_DEGRADED`, reused 1413 / denom 1493, status 13462 ms, no child. |
| identity vs `main` first-plan content | PASS (content) / FAIL (formal floors) | Unchanged: recall/pRead/token P50 **delta 0**; `rReadMust` / `range*` / `holdoutRReadMust` fail on **both** arms (pre-existing, not a cutover blocker per §8.2). |

## Overall

**COMPLETE** on `f6cb334`. Hydrate 三连 14.1 / 15.1 / 22.2 s, 0 OOM, 0 recycle-during-prewarm. D1 942 / D3a 38+32 / D3c 1872+1833 / D5 peak 2165 end 170. Identity formal floors remain pre-existing. Do not merge `main` unless asked. Rollback: `daemonctl.sh rollback-release` → `009a3ff641cc-20260826T112416Z`.
