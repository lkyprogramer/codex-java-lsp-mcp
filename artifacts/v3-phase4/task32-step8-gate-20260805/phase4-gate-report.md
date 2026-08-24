# Iteration D Gate — Task 32 Step 8

- Decision: **FAIL**
- Generated: 2026-08-05T03:19:32.305Z
- Runtime commit: `a1e6e4be6b43`

## Warm-State Matrix

| project | warm state | runs | recall | P_read | R_read_must | R_task_blocking | tokens P50 | tokens P95 | elapsed P50 (ms) | elapsed P95 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lishuedu | cold-nolsp | 5 | 0.7847 | 0.6771 | 1.0000 | 0.6046 | 23482 | 34027 | 34 | 218 |
| cipherlink | cold-nolsp | 5 | 0.8322 | 0.6375 | 1.0000 | 0.4914 | 14046 | 25407 | 68 | 168 |
| exam-parent-v3 | cold-nolsp | 5 | 0.7790 | 0.6042 | 1.0000 | 0.5003 | 14742 | 21744 | 38 | 153 |

## Evidence Provider Value

| provider | added | selected | golden hits | counterfactual gain | cost P50 (ms) | cost P95 (ms) | decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| framework | 0 | 0 | 0 | 0 | 5 | 39 | PENDING |
| lexical | 645 | 355 | 355 | 15 | n/a | n/a | PENDING |
| mapstruct | 50 | 35 | 35 | 15 | n/a | n/a | PENDING |
| relationship | 495 | 295 | 295 | 35 | 1 | 2 | PENDING |
| spring | 140 | 75 | 75 | 0 | n/a | n/a | PENDING |
| static | 595 | 330 | 330 | 50 | n/a | n/a | PENDING |
| support | 845 | 450 | 450 | 45 | n/a | n/a | PENDING |

## Hard Gate Failures

- lishuedu/cold-nolsp: P_read 0.6771 < Phase3 0.8333 - 0.02
- lishuedu/cold-nolsp: recall 0.7847 < Phase3 0.8220 (NOTE: golden set grew 16->24 scenarios in Step 5, see report for denominator caveat)
- cipherlink/cold-nolsp: P_read 0.6375 < Phase3 0.7000 - 0.02
- exam-parent-v3/cold-nolsp: recall 0.7790 < Phase3 0.9000 (NOTE: golden set grew 16->24 scenarios in Step 5, see report for denominator caveat)

## Raw Artifacts

- `/Users/luo/Documents/github/codex-java-lsp-mcp/artifacts/v3-phase4/task32-step8-gate-20260805/matrix/lishuedu-cold-nolsp.json`
- `/Users/luo/Documents/github/codex-java-lsp-mcp/artifacts/v3-phase4/task32-step8-gate-20260805/matrix/cipherlink-cold-nolsp.json`
- `/Users/luo/Documents/github/codex-java-lsp-mcp/artifacts/v3-phase4/task32-step8-gate-20260805/matrix/exam-parent-v3-cold-nolsp.json`

## Known Limitations

- R_task_blocking has no Phase 3 baseline (taskBlocking is a new V3 golden-schema bucket) - reported as a new baseline this iteration, not gated as a regression.
- estimatedTokens has no Phase 3 baseline (new V3 Step 7 metric) - reported as a new baseline this iteration, not gated as a regression.
- recall/P_read comparisons are against the archived Phase 3 figures measured on a 16-scenario golden set; Step 5 expanded the set to 24 scenarios, so this is a denominator-changed comparison, not a strict paired regression.
- This run uses scripts unrelated to run-three-repo-cold-matrix.mjs's old-vs-new paired arm: that script's baseline commit (86fef13) predates the V3 golden schema and cannot parse golden/*.scenarios.jsonl, so no valid paired comparison exists for this iteration - see phase4 report for detail.
- Shadow-ranking's non-required read-plan selection does not replicate production's buildReadPlan() shortlist bucket-representative guarantee or byte-budget trim, so goldenAttribution.inReadPlan/counterfactual.readPlanHitLost can under-report real production hits (reproduced on lishuedu's audit-order-repository-mapper-rule-type scenario).
