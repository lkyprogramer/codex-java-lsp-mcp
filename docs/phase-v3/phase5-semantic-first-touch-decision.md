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
worktree/cache discipline as the rest of this report:

| warmState | recall | pRead | rReadMust | rTaskBlocking | estimatedTokens P50 | elapsedMs P95 |
|---|---|---|---|---|---|---|
| cold-nolsp | 0.8322 | 0.6375 | **1.0000** | 0.4914 | 15201 | 220 |
| warm-auto | 0.8322 | 0.6375 | **1.0000** | 0.4914 | 15202 | 3483 |
| warm-required | 0.8790 | 0.6771 | **0.9063** | 0.5286 | 10825 | 2015 |

Two findings, both real and reproducible (deterministic across all 5 runs, not noise):

1. **`warm-auto` moved zero quality metrics on this golden set** - recall/pRead/rReadMust/
   rTaskBlocking/tokens are bit-identical to `cold-nolsp`, while P95 latency jumped 220ms to
   3483ms. `auto`'s profile-gated semantic calls did fire (that's where the latency went) but
   never changed which files got ranked into the read plan for any of these 8 scenarios - on this
   evidence, `auto`'s selective semantic usage is paying real latency for zero measured benefit
   here (small sample; see Known Limits).
2. **`warm-required` traded `R_read_must` - the single metric this project gates hardest
   everywhere else (`=1.0000` is a non-negotiable elsewhere) - for gains everywhere else.**
   Root-caused to the exact file level: `aliyun-sms-gateway-send` and
   `organization-create-member-cross-module` each dropped exactly one golden "must" file from the
   read plan under `warm-required` - `SmsGateway.java` and `OrganizationAppService.java`
   respectively. Both are **the interface/port the anchor class implements** - not implementation
   detail, the literal contract a reader needs. Diffing `goldenAttribution` between `cold-nolsp`
   and `warm-required` for `aliyun-sms-gateway-send` shows every other file's `inReadPlan` flag
   identical; only the interface flips `true`->`false`, meaning a non-golden candidate that
   picked up real semantic evidence outranked it for the last read-plan slot. This is a real
   ranker interaction, not a fluke: real semantic edges add confidence to whichever candidate
   happens to receive them, and an interface definition (often only lexically discoverable, no
   direct call/reference edge from the anchor to it) is not guaranteed to be one of them.

Net read: `warm-required` is not simply "better" - it measurably improves aggregate recall/
precision/token-efficiency while measurably degrading the one metric this project treats as an
absolute floor everywhere else, via a concrete, understood mechanism (interface files losing a
semantic-evidence popularity contest). This is not disqualifying for keeping the option
`semanticPolicy=required` as an explicit, opt-in escape hatch (that decision is about defaults,
made in the Decision section on latency grounds alone), but it is a real caveat for anyone
choosing to use `required` expecting a strict quality upgrade, and a legitimate candidate for
separate follow-up work on the ranker (e.g. protecting golden-tier "must" files, or interface
files specifically, from eviction once semantic evidence is present) - not attempted here, out of
scope for a warm-default decision.

Only `cipherlink` was measured (see Known Limits); `lishuedu`/`exam-parent-v3` were not run for
this follow-up.

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
4. **Step 6's quality-matrix re-run under `warm-required` was performed for `cipherlink` only**,
   not all three repos (see Quality Delta for the 2026-08-07 follow-up and its
   `R_read_must` regression finding) - `lishuedu`/`exam-parent-v3` deltas remain unmeasured. This
   does not affect the `KEEP_EXPLICIT` decision (already forced by the fresh-first-touch gate
   alone, and the quality follow-up only concerns whether `required` is worth using at all, not
   whether it should default on), but the interface-file-eviction mechanism found on cipherlink
   is not yet confirmed to generalize to the other two repos' evidence-signal mixes.
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
