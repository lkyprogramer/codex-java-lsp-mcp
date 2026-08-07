# Phase 5 Semantic First-Touch Decision

Task 35 (plan `docs/deep/codex-java-lsp-mcp-java-only-development-execution-plan-v3.1-2026-07-23.md`,
Iteration E). Produced by `src/benchmark/semantic-first-touch.ts` (Task 35 Steps 1-3) plus one
public `JdtlsSession.waitForProgressIdle()` and one `java_status` field
(`semanticAutoPolicy`, Step 8) added while implementing this decision.

## Environment

- macOS 26.5.1 (BuildVersion 25F80), Apple Silicon.
- Node `v22.16.0` (`/Users/luo/.nvm/versions/node/v22.16.0/bin/node`).
- codex-java-lsp-mcp at `02aebc3f4735` on `codex/java-intelligence-v3` (includes Task 34's
  DocumentLru - Task 35 deliberately ran after Task 34 landed, since bounding open documents
  changes document open/close lifecycle and would otherwise invalidate this measurement).
- Real JDT LS (`JDTLS_BIN` unset, real `/opt/homebrew/bin/jdtls`) - **not**
  `JDTLS_BIN=/usr/bin/false` like every other gate in this repo. This is the one benchmark in the
  project that must observe real JDT startup/import latency.
- Target repo: `cipherlink` (633 `.java` files, Gradle multi-module), the smallest of the three
  golden repos, run from an isolated `git worktree` (detached at the repo's current HEAD) under
  the scratch directory - never the user's live checkout or active LSP cache.
  `JAVA_LSP_CACHE_ROOT` pointed at a scratch temp dir for every attempt (Step 3's fresh-workspace
  isolation), so `JDTLS_DATA_DIR`/`JDTLS_LOG_DIR` were never the user's real cache either.

## Runtime/JDT Versions

- `jdtls` 1.56.0 (Homebrew formula, `/opt/homebrew/Cellar/jdtls/1.56.0`).
- Project JDK resolved automatically by this project's own `resolveProjectJdk()` from a
  SDKMAN-managed JDK set (17.0.18-tem / 21.0.10-amzn / 21.0.10-tem / 25.0.1-open available;
  `$JAVA_HOME` pointed at SDKMAN's `current`).

## Matrix

Ran a small, targeted subset of Step 4's matrix, not the full Cartesian product - see Known
Limits for why. All cells: `cipherlink`, anchor
`modules/organization/.../DefaultOrganizationAppService.java:693:23` (the `createMember` method,
same anchor already verified against real source in the `readPlanRangeRecall` follow-up), raw
(non-gateway) `references` calls so measurements are never shortened by the SemanticGateway's
completed-at cache.

| Cell | Attempts | totalMs (ensureStarted + request) | completion | resultFiles |
|---|---|---|---|---|
| `fresh` x `none` x `references` | 1 | 42268 (8553 + 33715) | COMPLETE | 6 |
| `fresh` x `none` x `references` | 2 | 32296 (6637 + 25658) | COMPLETE | 6 |
| `fresh` x `none` x `references` | 3 | 35815 (5813 + 30002) | COMPLETE | 6 |
| `reused` x `none` x `references` | 1 (session start + 1st query) | 31425 (6171 + 25253) | COMPLETE | 6 |
| `reused` x `none` x `references` | 2 (same live session, same position) | 182 | COMPLETE | 6 |
| `reused` x `none` x `references` | 3 (same live session, same position) | 177 | COMPLETE | 6 |

An earlier diagnostic probe (same anchor, same isolation, before the tool above existed) also
recorded a `fresh` x `none` x `references` attempt that did not complete inside a 30s client
timeout at all (see Timeout and Cancellation Settlement) - consistent with, not contradicted by,
the three completed runs above: fresh first-touch on this repo lands somewhere in the
low-tens-of-seconds range, with real run-to-run variance.

`ensureStarted()` itself (JDT process spawn + LSP `initialize` handshake) is fast and stable:
5.8-8.6s across all runs. The slow, highly variable part is exclusively the first real semantic
request landing on top of an import that is still in progress - `ensureStarted()`/`READY` says
nothing about whether project import has finished.

## Quality Delta

Not measured. Step 6 ("re-run existing 3-repo golden matrix with `warm-required` diagnostic
runs") requires real JDT across all three repos and was skipped once Step 4's fresh-workspace
result already made the Step 7 decision unambiguous by roughly a 40-50x margin on the single most
expensive gate. Re-running the full quality matrix would spend real wall-clock time (each real
`warm-required` diagnostic run needs the same tens-of-seconds-per-attempt JDT cold start, times 3
repos times N scenarios) without being able to change a decision already forced by a gate that
already fails by that large a margin. See Known Limits.

## Timeout and Cancellation Settlement

A 5000ms-client-timeout probe against the same anchor, same isolation, showed the backend
settling **13744ms after** the client gave up (JDT actually answered ~18.7s after the request was
sent, well past the client's 5s budget). A separate probe with a 30000ms client timeout never saw
the backend settle before the client itself gave up. Bucketed against the plan's Step 5 categories
(`250ms / 1s / 5s / never before session stop`): observed settlement on this repo/anchor falls
past the `5s` bucket, on the order of **10-40s**, not `never` - the backend eventually does answer,
it is just far outside any interactive request budget. `$/cancelRequest` is not assumed to stop
JDT work promptly; this project's `request()` already only treats it as a soft signal and keeps
measuring real backend settlement independently (`cancelBackendSettlementMs`), which is exactly
the mechanism this section's numbers came from.

## Decision

**KEEP_EXPLICIT**

`DEFAULT_REQUIRED`'s gates require **all** of a list that includes
`warm-required fresh first-touch P95 <= 800ms`. The three real fresh-workspace attempts above
measured 42268 / 32296 / 35815 ms - roughly **40-53x** the 800ms bound, with real repeated
measurement (not a single outlier). No profile-specific subset plausibly clears this bound either
(`DEFAULT_FOR_SELECTED_PROFILE` requires the identical fresh-first-touch gate for its subset):
every profile's first semantic request on a cold workspace hits the same underlying bottleneck -
JDT's own project import/indexing, which is not scoped to caller profile at all. This matches the
plan's own stated default expectation exactly: "Historical reports already showed references
first-touch near 1.5s or worse. The default expectation is therefore KEEP_EXPLICIT unless new
architecture materially changes the measured result" (plan line 9740) - the measured result here
is worse than that historical 1.5s figure by more than an order of magnitude, not materially
better, so nothing overrides the default expectation.

## Policy Patch, If Any

None needed for two of Step 8's three `KEEP_EXPLICIT` bullets - both already held in the code
before this task, verified by reading (not assuming) the current source:

- `src/agent-router/semantic.ts:274-281` (`shouldUseSemantic`): `semanticPolicy=auto` decides
  purely from `mode`/`anchor.profile` (`policy==="required" || mode is precision/recall`, else
  `anchor.profile==="service"`). It never inspects JDT `READY` state as a trigger - exactly the
  thing this task's data shows would be wrong to do, since `READY` precedes real import
  completion by tens of seconds.
- `src/agent-router/semantic.ts:288-296` (`shouldUseSemanticVerify`): `required` (or
  `mode=precision/recall`) always runs within the request's own deadline; `fast` never does.

The third bullet ("java_status exposes why auto skipped") was a real, verified gap - `status.ts`
had no field describing the `auto` policy at all. Since the skip/run decision itself is a static
rule with no live-session dependency (confirmed by the `shouldUseSemantic` read above), the fix is
a static explanation, not new state tracking: added `semanticAutoPolicy` (a fixed string) to
`java_status`'s diagnostic-detail output in `src/tools/status.ts`, plus one assertion in
`status.test.ts`. Also made `JdtlsSession.waitForProgressIdle()` public (was private) so this
benchmark tool's `--prepare progress-idle` cell can wait for import-idle without also issuing a
`documentSymbols` request the way the existing `documentSymbolsWithRetry()` bundles it - a
one-line visibility change, no behavior change.

No change to `semanticPolicy=auto`'s decision rule itself, and no scheduler/queue/aging/bulkhead
machinery was added, per the plan's explicit instruction for the `KEEP_EXPLICIT` branch.

## Rejected Alternatives

- **`DEFAULT_REQUIRED`**: rejected outright by the fresh-first-touch gate (see Decision).
- **`DEFAULT_FOR_SELECTED_PROFILE` for `service`-profile anchors** (the profile `auto` already
  favors): rejected for the same reason - the bottleneck is JDT project import, which has no
  profile awareness, so a `service`-scoped default would still force the same 30-45s wait on a
  cold workspace, just for a narrower set of callers. There is no profile-specific measurement
  showing a materially different fresh-first-touch number, and no plausible mechanism for one to
  exist given where the time is actually spent.

## Known Limits

1. **Single repo, single anchor.** Only `cipherlink` was measured with the real tool; `lishuedu`
   (26854 `.java` files) and `exam-parent-v3` (1397 files) were not. `cipherlink` is the smallest
   of the three, so if anything this understates how bad fresh first-touch is on the larger repos -
   this asymmetry cannot flip the decision, only strengthen it, so it was not chased further given
   the already-decisive margin.
2. **Only `references` was measured** with the committed tool, not `definition` / `implementation`
   / `type-hierarchy`. All four ultimately route through the same JDT-side import/indexing
   bottleneck this report's data traces the slowness to, so there is no specific reason to expect
   a materially different fresh-first-touch number for the others, but this was not verified
   per-operation.
3. **3 runs per cell, not the plan's default 10.** Each `fresh` attempt is a genuine, independent
   JDT cold start costing real wall-clock minutes; per-attempt freshness (a fresh workspace per
   run, not one shared fresh workspace reused across a cell's runs) was used throughout, matching
   the plan's own P95 semantics, but the run count was cut given the decisive early margin - this
   is explicitly permitted by the plan ("This is a decision experiment, not a benchmark product...
   Do not run every profile/operation Cartesian product").
4. **Step 6's full quality-matrix re-run under `warm-required` was not performed** - see Quality
   Delta. `R_read_must`/`R_task_blocking`/`recall`/`P_read`/`NDCG_read@6`/`estimatedTokens` deltas
   between `cold-nolsp`/`warm-auto`/`warm-required` are therefore unmeasured. This does not affect
   the `KEEP_EXPLICIT` decision (already forced by the fresh-first-touch gate alone) but means "a
   latency improvement without task-level quality gain is not sufficient for defaulting required
   semantics" (plan line 9718) was never reached as a question - the latency side alone already
   settled it.
5. **The `reused` cell's fast numbers (177-182ms) repeat the identical query position**, so they
   are optimistic for "reused workspace, distinct new query" - real JDT-side caching for an
   already-answered exact position is a favorable case, not necessarily representative of a
   different query against an already-warm project. The `cacheHit`/`shared` fields on every
   attempt are hardcoded `false` by construction (raw, non-gateway calls were used deliberately so
   first-touch measurements are never shortened by this project's own SemanticGateway cache) - do
   not read them as "the gateway cache was cold," they simply do not apply to the raw path.
6. **No `.classpath`/`.project`/`.settings` files were observed written into the worktree** across
   these runs (`git status --short` stayed empty throughout). This project isolates via worktree
   regardless, matching this repo's own `scripts/run-three-repo-cold-matrix.mjs` convention. Do
   not treat "worktree stayed clean" as proof that a longer-running import on a different repo or
   JDT version can never write into the project directory - the isolation is cheap insurance, not
   something to remove based on one clean observation.

## Reproduction Commands

```bash
# Isolated worktree of the target repo (never the live checkout):
cd /Users/luo/Documents/program/cipherlink
git worktree add --detach /tmp/cipherlink-first-touch-worktree HEAD

# Fresh workspace state (each run gets its own JDTLS_DATA_DIR/LOG_DIR/cache):
JAVA_LSP_BENCH_ANCHOR_FILE="modules/organization/src/main/java/com/hhtele/cipherlink/organization/application/DefaultOrganizationAppService.java" \
JAVA_LSP_BENCH_ANCHOR_LINE=693 \
JAVA_LSP_BENCH_ANCHOR_COLUMN=23 \
node dist/benchmark/semantic-first-touch.js \
  --repo-root /tmp/cipherlink-first-touch-worktree \
  --project-id cipherlink \
  --workspace-state fresh \
  --operation references \
  --runs 3 --timeout-ms 60000

# Reused workspace state (one session, multiple attempts):
JAVA_LSP_CACHE_ROOT=/tmp/cipherlink-first-touch-cache \
JAVA_LSP_BENCH_ANCHOR_FILE="modules/organization/src/main/java/com/hhtele/cipherlink/organization/application/DefaultOrganizationAppService.java" \
JAVA_LSP_BENCH_ANCHOR_LINE=693 \
JAVA_LSP_BENCH_ANCHOR_COLUMN=23 \
node dist/benchmark/semantic-first-touch.js \
  --repo-root /tmp/cipherlink-first-touch-worktree \
  --project-id cipherlink \
  --workspace-state reused \
  --operation references \
  --runs 3 --timeout-ms 60000

git -C /Users/luo/Documents/program/cipherlink worktree remove --force /tmp/cipherlink-first-touch-worktree
```

Raw JSON output from the actual runs backing the Matrix table above is under
`artifacts/v3-phase5/task35-first-touch-20260807/`.
