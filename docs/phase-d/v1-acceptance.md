# V1 acceptance — daemon stability and memory (2026-08-25)

Branch `codex/frontier-r1`. Live release `3e9ef62e405c-20260826T034749Z` (`http://127.0.0.1:38456/mcp`, hot-set `hydrate:true`). Pins: `lishuedu`, `exam-parent-v3`, `cipherlink`, `lishu-v2`. Probe: `scripts/probe-daemon-acceptance.mjs`. Fast D1 soak: `scripts/d1-fast-idle-soak.sh`. D3a 三振：`docs/phase-d/d3a-escalation.md`.

Isolated T0: 1264 + 278 pass, exit 0. `gate:pr` exit 0. Targeted unit file set in scratch `targeted-tests.log` 236 pass.

## Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| D1 steady footprint ≤ 900 MiB after idle-close | PASS | Fast soak `docs/phase-d/d1-fast-idle-soak.json` on `425fd96` files-only prewarm: hibernate 2s + index-idle 4s then restore production plist. End 807 MiB (plateau 805–807), peak 2458. Same process after ~25 min production TTL idle: 840–866 MiB. Prior hydrate-on soak ended 973 FAIL. |
| D2 storm healthz P99 < 100 ms, 0 timeouts | PASS | W1: 60 samples, 0 timeouts, P99 35.2 ms. V1: `lishu-v2 ./gradlew classes --no-daemon` while healthz 1 Hz, 90 samples covering the gradle run, 0 timeouts, P99 31.2 ms, max 57.4 ms, gradle exit 0. Idle probe healthz 12 samples P99 14.3 ms. Pin OPEN can still stall healthz (fast-soak t=9–25). |
| D3a hot pin first impact P95 ≤ 3 s | FAIL | Hot-set `hydrate:true` restored on `3e9ef62`. Three live lishuedu hydrates hit `ERR_WORKER_OUT_OF_MEMORY` at the 1536 isolate (install + two restarts). Post-hydrate probe: lishuedu 4975 ms toolFail `Java index worker is unavailable after one restart attempt`; lishu-v2 48 ms. Escalation: `docs/phase-d/d3a-escalation.md`. |
| D3b cold pin first impact no tool fail | PASS | 15s public budget: `cipherlink` 26/18/17 ms, `exam-parent-v3` 1908/15/10 ms, no tool fail. Default minimal 1500 ms is too tight after index-idle close (first probe ~1511–1520 ms `Deadline exceeded`). |
| D4 query timeout does not restart worker | PASS | Unit: QUERY/STATUS `terminations === 0`; OPEN still retires. Live: `deadlineMs: 1500` then retry 14 ms, no tool error. |
| D5 cold-build peak ≤ 4 GiB | PARTIAL | Fast-soak peak 2458 MiB; M4 rebuild peak 2546; restored daemon peak 2389. All < 4 GiB. lishuedu/lishu-v2 rest-hydrate can still `ERR_WORKER_OUT_OF_MEMORY` at the 1536 isolate cap. |
| D6 unregistered `java_status` ≤ 3 s | PASS | W1: 442 ms. V1 probe `fixtures/generic-java`: 577 ms. |
| D7 worktree seed reusedFiles ≥ 0.9, no child, ≤ 15 s | PASS | `54b7c09` first open: `SEEDED_DEGRADED`, reused 1423/1423 (dirty 69), status 7201 ms, impact 98 ms, no child. V1 re-probe: `RECONCILED_COMPLETE`, reused 1419 / denom 1492, status 45 ms, no child. |
| identity vs `main` first-plan content | PASS (content) / FAIL (formal floors) | Formal `--runs 5 --baseline main` on frozen clones (`lishuedu db63b1a7`, `cipherlink fa43398`, `exam-parent-v3 f90a0b47`). Live exam tree was dirty; frozen clones used, user tree not reset. Load 18.6 (in window). recall/pRead/token P50 **delta 0** old vs new on all three repos. Verifier floors `rReadMust` / `range*Recall` / `holdoutRReadMust` fail on **both** arms (pre-existing). Summary: scratch `identity-matrix-v1-run/matrix-summary.json`. |

## Overall

**NOT COMPLETE.** Hot-set `hydrate:true` is wired (entry-point test: lishuedu true / cipherlink false). D3a FAIL after three live lishuedu rest-hydrate OOMs at 1536 MiB — see `docs/phase-d/d3a-escalation.md`. D1/D2/D3b/D4/D6/D7 still PASS from the files-only measurements; identity content vs `main` held. Do not merge `main`. Rollback: `daemonctl.sh rollback-release`.
