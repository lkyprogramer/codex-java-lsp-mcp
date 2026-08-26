# V1 acceptance — daemon stability and memory (2026-08-25)

Branch `codex/frontier-r1` @ `425fd96`. Live release `425fd962fd2f-20260826T021910Z` (`http://127.0.0.1:38456/mcp`). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe script: `scripts/probe-daemon-acceptance.mjs`. Fast D1 soak: `scripts/d1-fast-idle-soak.sh`.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D1 steady footprint ≤ 900 MiB after idle-close | PASS | Fast soak `docs/phase-d/d1-fast-idle-soak.json` on `425fd96` (files-only pin prewarm). Temporarily set `JAVA_LSP_HIBERNATE_TTL_MS=2000` + `JAVA_LSP_INDEX_IDLE_TTL_MS=4000`, waited for prewarm + those timers, then restored production plist (no TTL env). End `phys_footprint` 807 MiB (plateau 805–807), peak 2458 MiB. Climb 265→2436 MiB over 29s then drop to 819 by t=37s. healthz 2s timeouts at t=9–25 while OPEN was ramping (event loop busy). Prior 31-minute wall-clock soak on an older hydrate-on prewarm ended 973 MiB FAIL. |
| D2 storm healthz P99 < 100 ms, 0 timeouts | PASS (W1 60-sample) / PARTIAL (soak) | W1: 60 samples, 0 timeouts, P99 35.2 ms. Soak: 2/31 healthz timeouts while host load was 21–94. V1 120×1s gradle-check not re-run. |
| D3a hot pin first impact P95 ≤ 3 s | PARTIAL | Pre-M4 cipherlink 873 ms then 12 ms. After M4 fingerprint invalidation, `lishu-v2` pin has no snapshot and prewarm OOMs the 1536 MiB isolate. |
| D3b cold pin first impact no tool fail | PARTIAL | S3 unit tests PASS. Live cold-pin path was not re-measured after the 30-minute soak. |
| D4 query timeout does not restart worker | PASS (unit) | S1: QUERY/STATUS `terminations === 0`; OPEN still retires. |
| D5 cold-build peak ≤ 4 GiB | PARTIAL | Rebuild `phys_footprint_peak` 3054 MiB (< 4 GiB). lishu-v2 worker then `ERR_WORKER_OUT_OF_MEMORY` at 1536 MiB isolate. |
| D6 unregistered `java_status` ≤ 3 s | PASS | W1: 442 ms. |
| D7 worktree seed reusedFiles ≥ 0.9, no child, ≤ 15 s | PASS | `54b7c09` live torna: `SEEDED_DEGRADED`, reusedFiles 1423 / files 1423 (dirty 69), `java_status` 7201 ms, `java_impact` 98 ms, `fingerprintMatched=false`, eligibleSnapshots 2, familyMismatch 7, child not spawned (`cold-build-metrics.json` mtime 11:18:35). |
| identity vs `main` first-plan content | PASS (content) / FAIL (formal floors) | Formal `--runs 5 --baseline main` on frozen scenario commits (`lishuedu db63b1a7`, `cipherlink fa43398`, `exam-parent-v3 f90a0b47`). Host logged `above-window, still running`. Three-repo recall/pRead/rReadMust/rTaskBlocking/token P50 **delta 0** old vs new. Verifier `passed=false` because `rReadMust`/`range*Recall`/`holdoutRReadMust` floors fail on **both** arms (pre-existing, not a candidate regression). Summary: `identity-matrix/matrix-summary.json`. |

## Overall

**NOT COMPLETE.** D7 live PASS on `54b7c09` (still the worktree-seed evidence). D1 PASS on `425fd96` files-only idle (807 MiB ≤ 900) via min-TTL soak, production TTLs restored. Residual: pin rest-hydrate still OOMs the 1536 MiB isolate so production prewarm stays files-only (D3a first-impact hydrate-on-demand). D2 healthz can stall during pin OPEN. Identity of normal-path plan content vs `main` held. Do not merge `main`. Rollback: `daemonctl.sh rollback-release`.
