# V1 acceptance — daemon stability and memory (2026-08-25)

Branch `codex/frontier-r1`. Live release `c8fe7c16aaa9-20260825T080518Z` (`http://127.0.0.1:38456/mcp`). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe script: `scripts/probe-daemon-acceptance.mjs`.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D1 steady footprint ≤ 900 MiB after 30 min idle | UNMEASURED | Post-M3 install 421–509 MiB. After M4 fingerprint invalidation, `phys_footprint` 641 MiB with peak 2546 MiB during rebuild; 30-minute idle soak not completed in this session. |
| D2 storm healthz P99 < 100 ms, 0 timeouts | PASS (W1 60-sample) | `docs/phase-d/w1-closeout.json`: 60 samples, 0 timeouts, P99 35.2 ms. V1 120×1s gradle-check not re-run. |
| D3a hot pin first impact P95 ≤ 3 s | PARTIAL | Cipherlink (cold pin) 873 ms then 12 ms on the M-track install. Live lishuedu worker was spent on a restart. M4 rebuild left `lishu-v2` without a snapshot and OOMed the isolate. |
| D3b cold pin first impact no tool fail, no retire | PARTIAL | S3 fail-soft unit tests PASS. Live D4-style `deadlineMs: 1500` on cipherlink returned a compact plan after the rg EBADF wrap (cb6fd56). |
| D4 query timeout does not restart worker; next request ≤ 500 ms | PASS (unit) / PARTIAL (live) | S1 client tests: QUERY/STATUS `terminations === 0`; OPEN still retires. Live retry after 1500 ms deadline was 12 ms on cipherlink before M4 rebuild. |
| D5 cold-build peak ≤ 4 GiB, then back to D1 | PARTIAL | M4 rebuild `phys_footprint_peak` 2546 MiB (< 4 GiB). lishu-v2 worker then hit `ERR_WORKER_OUT_OF_MEMORY` at 1536 MiB isolate. |
| D6 unregistered `java_status` ≤ 3 s | PASS | W1: 442 ms. |
| D7 worktree seed reusedFiles ≥ 0.9, no cold-build child, ≤ 15 s | FAIL | Isolated tests PASS. Live torna probe: see `docs/phase-d/m4-escalation.md`. |
| identity vs `main` first-plan | PENDING | Host 1-minute load was 40–160. Policy still requires the three-repo matrix to run (`docs/phase-v4/three-repo-host-load-policy.md`); it is started from this session or must be started next. Skip is not a pass. |

## Overall

**NOT COMPLETE.** W/S/M code is on `codex/frontier-r1` and installed. D7 live reuse was not observed. Do not merge `main`. Rollback: `daemonctl.sh rollback-release`.
