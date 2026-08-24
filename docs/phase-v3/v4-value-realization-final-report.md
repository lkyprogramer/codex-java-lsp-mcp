# V4 value realization report

Identity: Sprint0' denominator is `docs/phase-v4/v4-sprint0-manifest.json` (measured commit `63a80a2`, production tree `1be810da`). Percentage claims below use only that denominator. Historical V3.2 33,219/33,230 LOC doors are archived.

## What closed in this cycle

- Daemon + five-tool Java intelligence already share one tree (V4-01).
- LOC baseline 35,472 / cap 37,245 (`docs/phase-v4/v4-loc-baseline.md`).
- V4-06 range/holdout remains `CLOSED_WITH_RESIDUAL_STRUCTURAL_MISSES`.
- V4-07: `workspace/symbol` and `textDocument/documentSymbol` use SemanticGateway complete-only cache. Coordinator `GenerationClock` is the external generation; session `cacheGeneration` is a derived/fallback view. Edit-B-then-query-A does not serve an old COMPLETE.
- V4-09: sibling `dataDir`/lease isolation is tested. No JDT version/build fingerprint was added to `dataDir` after the stopped-session reuse experiment (`docs/phase-v4/v4-09-jdt-workspace-fingerprint.md`).
- V4-11: session-level idle-prewarm hit-rate telemetry exists (`IdlePrewarmTracker`, re-exported from `impact-metrics.ts`). Production trigger stays `JAVA_LSP_IDLE_PREWARM=1` (default-off) and does not start JDT. Isolated JDT trial against golden cipherlink: JDT booted (`ensureStartedMs=5356`) but `textDocument/references` hit `DEADLINE_EXCEEDED` at 90s; official 3-repo experiment was not started because 1-minute load rose to 22.49. P95/RSS **UNMEASURED**. Not default-on.
- V4-12: `golden/framework-mybatis.scenarios.jsonl` scores real XML mapper paths.
- V4-08: `src/jdtls-session.ts` is 1,013 production lines (target <1,200) after extracting first-touch, hierarchy walk, SemanticBackend, and remaining raw LSP/request I/O (`jdtls-lsp-io.ts`, `jdtls-lsp-types.ts`). Isolated full after the extract: 1,027 + 159 pass.
- V4-13: deleted the `JAVA_LSP_RELATIONSHIP_FACTS_BATCH=off` rollback switch. `src/util/` is gone. README v5 leftover text is gone. `scoreBase` / `legacyCompatEntries` still have production callers.
- V4-14: `npm run gate:pr|nightly|release` emit a raw SHA-256 (`scripts/run-v4-gates.mjs`).
- Merge to `main` is not part of this cycle.

## Sprint0' bytes (denominator)

From `docs/phase-v4/v4-sprint0-summaries/bytes.json`:

| project | standard serializedBytes |
|---|---|
| lishuedu | 9318.6 |
| (see file for cipherlink / exam-parent-v3 and compact/diagnostic) | |

Cold-matrix / first-touch / progressive summaries live next to that file and are SHA-256 bound in the Sprint0' manifest.

## Final three-repo cold (this tree vs Sprint0')

Ran `scripts/run-three-repo-cold-matrix.mjs --runs 5` AB/BA/AB on 2026-08-19. Host load 7.70 < 20. Old = `63a80a2`. New = `4130e3a` + working-tree patch, executableTree `a56af2f9`.

Raw tree: `/tmp/codex-java-lsp-v4-final-cold-20260819-171144/`. Report: `docs/phase-v4/v4-final-three-repo-cold-20260819.md`. Summary SHA-256 `95aa6e0f04febeee68407f5e2954020ed5c901c2316facb24472e684367d82a2`.

Script **exit 1** (quality gate FAIL). Candidate tests 159/159. RangeLineRecall new means 0.842 / 0.875 / 0.853 (not 1.0). Holdout `rReadMust` 0.625 / 0.550 / 0.400. cipherlink p95Ratio 2.035; exam 1.777; lishuedu 1.053. Token P50 rose on all three repos vs Sprint0'.

## Agent Token / TaskSuccess

`UNMEASURED`. V4-10 did not run live model cells. The harness stays `BLOCKED_EXTERNAL` without a user key and `--authorize-external`. Usage and TaskSuccess are `UNMEASURED`, never `0`.

## Dual-worker (V4-05)

`JAVA_LSP_JAVA_INDEX_DUAL_WORKER` remains default-off unless two sequential `run-storm-gate.mjs` rounds with the flag on meet P95/quiet ≤ 1.10, `staleCount=0`, and `T_complete`/RSS ≤ +10% vs Sprint0'. Digest tests still require bitwise equality with single-worker.

## Residual

- RangeLineRecall / holdout `rReadMust` 1.0 not reopened.
- `scoreBase` still has production callers; V4-13 does not delete it.
- `legacyCompatEntries` still feeds `finalize.*` scoreBreakdown ids that `read-plan-budget.ts` / `ranking-signals.ts` recognize.
- Single-worker path kept until dual-worker default-on.
- Production LOC 36,770 is under the +5% cap 37,245 and above the frozen V4 baseline 35,472. **Net-zero vs 35,472 is impossible without deleting still-live `scoreBase` / `legacyCompatEntries` callers** (plus already-landed V4-05/06 and extract headers/re-exports). Those callers still drive ranking and `finalize.*` scoreBreakdown consumers; deleting them would change candidate identity/order/reasons.
