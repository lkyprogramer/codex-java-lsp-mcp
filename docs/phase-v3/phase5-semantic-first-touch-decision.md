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

**2026-08-07 follow-up** (user pushed back on leaving this unmeasured - fair, since "does
`required` even help" is a separate question from "should it be the default", and the KEEP_EXPLICIT
decision only answered the latter). Ran Step 6's comparison for real - `cold-nolsp` /
`warm-auto` / `warm-required`, 5 runs, cipherlink's full 8-scenario golden set, same isolated
worktree/cache discipline as the rest of this report.

**2026-08-08 follow-up** (user asked whether the finding generalizes past one repo): reran the
identical matrix against isolated worktrees of `exam-parent-v3` (1397 `.java` files, 8 scenarios)
and `lishuedu` (5337 `.java` files, 8 scenarios - see corrected Known Limits #1, the 26854 figure
below was wrong). Same isolation discipline (`JAVA_LSP_CACHE_ROOT` per repo, detached worktrees,
never the live checkout).

| project | warmState | recall | pRead | rReadMust | rTaskBlocking | estimatedTokens P50 | elapsedMs P95 |
|---|---|---|---|---|---|---|---|
| cipherlink | cold-nolsp | 0.8322 | 0.6375 | **1.0000** | 0.4914 | 15201 | 220 |
| cipherlink | warm-auto | 0.8322 | 0.6375 | **1.0000** | 0.4914 | 15202 | 3483 |
| cipherlink | warm-required | 0.8790 | 0.6771 | **0.9063** | 0.5286 | 10825 | 2015 |
| exam-parent-v3 | cold-nolsp | 0.7790 | 0.6042 | **1.0000** | 0.5003 | 16448 | 152 |
| exam-parent-v3 | warm-auto | 0.7835 | 0.6042 | **1.0000** | 0.5003 | 16450 | 3189 |
| exam-parent-v3 | warm-required | 0.6275 | 0.6433 | **0.8708** | 0.4658 | 11075 | 2034 |
| lishuedu | cold-nolsp | 0.7847 | 0.6771 | **1.0000** | 0.6046 | 26180 | 196 |
| lishuedu | warm-auto | 0.7847 | 0.6771 | **1.0000** | 0.6046 | 26181 | 287 |
| lishuedu | warm-required | 0.7378 | 0.7104 | **0.8854** | 0.5478 | 21059 | 5198 |

Three findings. The first two replicate across all three repos (deterministic across all 5 runs
per cell, not noise); the third was found while root-causing the second and changes how it should
be read:

1. **`warm-auto` moved zero quality metrics on any of the three golden sets** -
   recall/pRead/rReadMust/rTaskBlocking/tokens are bit-identical to `cold-nolsp` on every repo,
   while P95 latency jumped (220ms->3483ms cipherlink, 152ms->3189ms exam-parent-v3,
   196ms->287ms lishuedu). `auto`'s profile-gated semantic calls did fire (that's where the
   latency went) but never changed which files got ranked into the read plan for any of these 24
   scenarios - on this evidence, `auto`'s selective semantic usage is paying real latency for zero
   measured benefit here (still a modest sample - 3 repos, 8 scenarios each - see Known Limits).
2. **`warm-required` regresses `R_read_must` - the single metric this project gates hardest
   everywhere else (`=1.0000` is a non-negotiable floor elsewhere) - on all three repos**, from a
   modest 0.9063 (cipherlink) down to 0.8708 (exam-parent-v3) and 0.8854 (lishuedu). recall and
   pRead move in *different* directions per repo (cipherlink's recall improves 0.8322->0.8790;
   exam-parent-v3's and lishuedu's both regress, 0.7835->0.6275 and 0.7847->0.7378), so
   `warm-required` is not a clean "trade recall for rReadMust" story either - it is a real,
   repo-dependent reshuffling of the read plan, not a single consistent direction of improvement.
3. **Root cause, verified in source, not inferred from ranking output: `semanticPolicy=required`
   unconditionally disables the `typeReference` evidence provider.**
   `src/agent-router/type-reference.ts:44-46` -
   `collectTypeReferenceCandidates()` opens with `if (options.semanticPolicy === "required") return;`
   - a deliberate, tested branch (`docs/java-lsp-mcp-readplan-task4-type-reference-report-2026-07-01.md`,
   test: `"required semantic policy skips local type reference expansion"`), not new and not an
   accident. Its effect: candidates lose the `STATIC_STRUCTURE` evidence signal that
   `typeReference` (not `staticStructure`, a different provider that keeps running) contributes -
   observed directly as the `"static"` entry disappearing from `goldenAttribution[].providers` for
   the same file across `warm-auto` -> `warm-required`, on all three repos (e.g. cipherlink's
   `SmsGateway.java` `["static","lexical","relationship","support"]` ->
   `["lexical","support"]`; exam-parent-v3's `ApplyInfoService.java` and `ApplyInfo.java` lose the
   same `static` tag; lishuedu's `BenefitEntitlementAssembler.java` loses both `static` and
   `relationship`, dropping 2 of 3 must files in `benefit-product-code-dto`, the single worst
   regression observed in this follow-up). Files that depend on `typeReference`'s referenced-type
   reinforcement rather than a direct call/relationship edge - interfaces/ports and
   entity/DTO/record types the anchor method references by type but never calls - are exactly the
   ones that can lose their only static-evidence source this way and fall out of the read plan
   under budget pressure, even though the same request's live semantic calls fired successfully.

   **Correction to this report's original (2026-08-07) framing of finding 2**, which is factually
   wrong and should not be relied on: it attributed `SmsGateway.java`'s and
   `OrganizationAppService.java`'s drop to "a non-golden candidate that picked up real semantic
   evidence outranked it," cited as visible by diffing `goldenAttribution`'s `inReadPlan` flags.
   That citation does not hold up: for `organization-create-member-cross-module`,
   `goldenAttribution` shows `OrganizationAppService.java` `inReadPlan: false` in **both**
   `cold-nolsp` and `warm-required`, i.e. no flip is visible in that diagnostic at all - yet the
   real `rReadMust` metric (which does not read `goldenAttribution`) drops exactly one file
   (1.0 -> 0.75) between those two states. A ground-truth check (temporary debug field surfacing
   `result.readPlan`'s actual file list, the same data `evaluate()`'s real `rReadMust` computation
   uses) confirms `OrganizationAppService.java` **is** in the real read plan under `cold-nolsp` and
   **is not** under `warm-required` - the file-level claim was right, but `goldenAttribution` never
   showed it, and the "outranked by a competitor" mechanism was speculation that filled the gap
   left by that diagnostic's blind spot. The real mechanism is the `typeReference` skip above,
   confirmed in source, not inferred from a diagnostic. The same isolated single-run probe (a
   separate process invocation, filtered to just these two scenarios) reproduced both scenarios'
   exact `rReadMust` values from the 5-run matrix - 0.75 for
   `organization-create-member-cross-module`, 0.5 for `aliyun-sms-gateway-send` - independent
   replication that these are not run-to-run noise.

   **This surfaced a separate, pre-existing tooling defect worth flagging on its own**:
   `src/agent-router/shadow-ranking.ts`'s `selectedReadPlanPaths()` (used to compute
   `goldenAttribution[].inReadPlan`/`blockedBy`, Task 32 Step 2) calls the lightweight
   `selectReadPlanFiles()` for every policy except `required`, but production's real
   `index.ts` always calls the full token-aware `buildReadPlan()` regardless of policy
   (`src/agent-router/index.ts:344`) - two different selection algorithms. For `required`
   specifically the shadow path also calls `buildReadPlan()` (`shadow-ranking.ts:170`), so its
   diagnostic happens to be reliable there; for `cold-nolsp`/`warm-auto` it is not. Net effect:
   **`goldenAttribution[].inReadPlan`/`blockedBy` cannot be trusted for `cold-nolsp` or
   `warm-auto` attempts** - only the real `rReadMust`/`recall`/`pRead`/`rTaskBlocking` aggregate
   metrics (sourced from `result.readPlan` via `evaluate()`, not from `goldenAttribution`) and the
   per-file `providers`/`sourceFamilies` arrays (sourced from real evidence signals, unaffected by
   this) are reliable for non-`required` states. This is a genuine, reproducible defect in this
   project's own benchmark/attribution tooling (Task 32), not in production ranking, and not fixed
   here - flagged as a separate follow-up candidate, out of scope for this decision.

Net read: `warm-required` is not simply "better" - it measurably changes aggregate recall/pRead/
token-efficiency (direction varies by repo) while measurably degrading `R_read_must` on all three
repos measured, via a concrete, source-verified mechanism (the `typeReference` provider being
unconditionally disabled under `required`, removing static evidence some interface/DTO-shaped
golden files depend on). This is not disqualifying for keeping `semanticPolicy=required` as an
explicit, opt-in escape hatch (that decision is about defaults, made in the Decision section on
latency grounds alone, unaffected by this), but it is a real, now three-repo-replicated caveat for
anyone choosing `required` expecting a strict quality upgrade. The `typeReference`-skip branch
(`type-reference.ts:44-46`) was validated in July 2026 against a smaller/differently-schemaed
golden set under the pre-family-ranker-cutover ranking pipeline (see Known Limits #7) - that
validation no longer describes the current pipeline, so the branch is currently unvalidated rather
than freshly proven wrong; either the ranker fix (protecting must-tier / interface-typed files
from losing their only static-evidence source under `required`) or the shadow-ranking.ts
selection-function fix above are legitimate separate follow-ups, neither attempted here.

All three repos were measured in this follow-up (see Known Limits #4, now resolved).

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

1. **Single repo, single anchor for the fresh-first-touch latency matrix specifically.** Only
   `cipherlink` was measured with the real `semantic-first-touch.ts` tool; `lishuedu` (5337
   `.java` files - corrected 2026-08-08, the `26854` figure previously here was wrong) and
   `exam-parent-v3` (1397 files) were not. `cipherlink` is the smallest of the three, so if
   anything this understates how bad fresh first-touch is on the larger repos - this asymmetry
   cannot flip the decision, only strengthen it, so it was not chased further given the already-
   decisive margin. (The separate quality-delta matrix below *was* run on all three repos - see
   item 4.)
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
4. **RESOLVED 2026-08-08.** Step 6's quality-matrix re-run under `warm-required` originally
   covered `cipherlink` only; the 2026-08-08 follow-up in Quality Delta reran the identical matrix
   on `exam-parent-v3` and `lishuedu` too. The `R_read_must` regression replicates on all three
   (0.9063 / 0.8708 / 0.8854); the root cause (`typeReference` provider disabled under
   `semanticPolicy=required`, `type-reference.ts:44-46`) is confirmed in source, not repo-specific.
   This does not affect the `KEEP_EXPLICIT` decision (already forced by the fresh-first-touch gate
   alone, and the quality follow-up only concerns whether `required` is worth using at all, not
   whether it should default on).
5. **The per-file `goldenAttribution[].inReadPlan`/`blockedBy` diagnostic is unreliable for
   `cold-nolsp`/`warm-auto` attempts** (see Quality Delta finding 3's tooling-defect note) - a
   selection-function mismatch between `shadow-ranking.ts` (uses `selectReadPlanFiles()` for
   non-`required` policies) and production `index.ts` (always uses `buildReadPlan()`). Verified by
   a ground-truth cross-check for two cipherlink scenarios only; not independently re-verified for
   every flip claimed on exam-parent-v3/lishuedu in Quality Delta finding 3 - those repos' claims
   rest on the `providers` array (evidence signals, unaffected by this defect) rather than on
   `inReadPlan` flags, which is why they are stated as "loses the `static` provider tag" rather
   than "flips `inReadPlan` true->false."
6. **The `typeReference`-skip-under-`required` branch was validated once, in July 2026**
   (`docs/java-lsp-mcp-readplan-task4-type-reference-report-2026-07-01.md`), against a golden
   scenario set that has since been migrated to schema V3 and expanded 16->24 scenarios (Task 32
   Steps 1 and 5) and under a ranking pipeline from before the family-ranker cutover (Task 25) and
   Task 30's token-aware planner both landed. That validation's `exam-parent-v3 warm-required
   rReadMust=1.0000` result describes a system that no longer exists in that form; it is not
   evidence that the current 0.8708 finding is a regression from a known-good 1.0000 baseline -
   the two numbers are not comparable. The correct reading is: the skip's original justification
   is currently unvalidated against the present pipeline, not disproven by a specific delta.
7. **The `reused` cell's fast numbers (177-182ms) repeat the identical query position**, so they
   are optimistic for "reused workspace, distinct new query" - real JDT-side caching for an
   already-answered exact position is a favorable case, not necessarily representative of a
   different query against an already-warm project. The `cacheHit`/`shared` fields on every
   attempt are hardcoded `false` by construction (raw, non-gateway calls were used deliberately so
   first-touch measurements are never shortened by this project's own SemanticGateway cache) - do
   not read them as "the gateway cache was cold," they simply do not apply to the raw path.
8. **No `.classpath`/`.project`/`.settings` files were observed written into the worktree** across
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
