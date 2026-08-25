# V1 acceptance — daemon stability and memory (2026-08-25)

Branch `codex/frontier-r1` @ `e66a0fd`. Live release `c8fe7c16aaa9-20260825T080518Z` (`http://127.0.0.1:38456/mcp`). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe script: `scripts/probe-daemon-acceptance.mjs`.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D1 steady footprint ≤ 900 MiB after 30 min idle | FAIL | 31-minute soak `live/d1-idle-soak.log` (16:30–17:01). healthz 29/31 OK; two 2s timeouts (i=1, i=20). `phys_footprint` plateau 706 MiB for minutes 6–19, then 969–973 MiB at minute 31 (one 1239 MiB spike at i=29). End 973 > 900. Peak this process 3054 MiB during earlier rebuild. |
| D2 storm healthz P99 < 100 ms, 0 timeouts | PASS (W1 60-sample) / PARTIAL (soak) | W1: 60 samples, 0 timeouts, P99 35.2 ms. Soak: 2/31 healthz timeouts while host load was 21–94. V1 120×1s gradle-check not re-run. |
| D3a hot pin first impact P95 ≤ 3 s | PARTIAL | Pre-M4 cipherlink 873 ms then 12 ms. After M4 fingerprint invalidation, `lishu-v2` pin has no snapshot and prewarm OOMs the 1536 MiB isolate. |
| D3b cold pin first impact no tool fail | PARTIAL | S3 unit tests PASS. Live cold-pin path was not re-measured after the 30-minute soak. |
| D4 query timeout does not restart worker | PASS (unit) | S1: QUERY/STATUS `terminations === 0`; OPEN still retires. |
| D5 cold-build peak ≤ 4 GiB | PARTIAL | Rebuild `phys_footprint_peak` 3054 MiB (< 4 GiB). lishu-v2 worker then `ERR_WORKER_OUT_OF_MEMORY` at 1536 MiB isolate. |
| D6 unregistered `java_status` ≤ 3 s | PASS | W1: 442 ms. |
| D7 worktree seed reusedFiles ≥ 0.9, no child, ≤ 15 s | FAIL | Isolated tests PASS. Live torna probe retried at load 15–19 after restart and after prewarm OOM; every `java_status`/`java_impact` hit the 15s `runtime.create` / `java-index.open` deadline. `cold-build-metrics.json` mtime unchanged (no child). No new `worktree seed` log from `c8fe7c1`. See `m4-escalation.md`. |
| identity vs `main` first-plan content | PASS (content) / FAIL (formal floors) | Formal `--runs 5 --baseline main` on frozen scenario commits (`lishuedu db63b1a7`, `cipherlink fa43398`, `exam-parent-v3 f90a0b47`). Host logged `above-window, still running`. Three-repo recall/pRead/rReadMust/rTaskBlocking/token P50 **delta 0** old vs new. Verifier `passed=false` because `rReadMust`/`range*Recall`/`holdoutRReadMust` floors fail on **both** arms (pre-existing, not a candidate regression). Summary: `identity-matrix/matrix-summary.json`. |

## Overall

**NOT COMPLETE.** W/S/M code is installed. Live D7 reuse was not observed inside the 15s tool deadline. D1 end-of-soak 973 MiB exceeds 900. Identity of normal-path plan content vs `main` held. Do not merge `main`. Rollback: `daemonctl.sh rollback-release`.
