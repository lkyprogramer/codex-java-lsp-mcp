# P3 independent review

Status: MEASUREMENT_REPAIR_REVIEW_PASS; IMPLEMENTATION_PHASE_PASS_R2; CAPACITY_RAW_AUDIT_PASS. Prior core/integration checks remain valid for unchanged code; the repair's narrow suite is PASS. Root completed six capacity-r2 runs; independent raw audit confirms single-reader 3 FAIL / dual-reader 3 PASS under the unchanged synthetic gates, with resource costs and limits in `capacity-review.md`. Capacity and LLM experiments NOT_RUN by reviewer.

Runtime finding P2 (confirmed, repaired): the first root-run capacity child failed warmup with `reader 0 did not complete warm query fuzzy` (`p3/capacity/pair-1-workers-1/stderr.log.txt`). `runStaticDiscovery` classifies auto intent (`src/discovery/query.ts:255`) and passes the resolved mode (`:511-513`); the original warmup oracle compared that mode with requested `auto` (`measure-query-load.ts:233`, pre-repair). Thus every original fuzzy cohort warmup failed before measurement. This is a measurement-oracle failure, not a measured SLO failure. Existing 3-test measurement fixture omitted the original auto/fuzzy query; the original independent review missed this mode conversion. Original failed artifacts are retained.

Repair r2 review: PASS. Source fix only imports the existing classifier and matches the resolved mode. The runner does the same; every-slot/query/task/completed/non-null-service checks, measured spawn0, shutdown, workload, thresholds and three-pair schedule remain intact. Tests add the original `refundOrder` auto cohort and directly assert its worker event is exact. RED `measurement-warmup-red.log`: pass1/fail2, both original fuzzy oracle failures. GREEN `measurement-warmup-green.log`: isolated compile and pass3/fail0/skip0/cancelled0. The reviewer read the repair-only delta and both logs, recomputed source/candidate hashes, and ran scoped `git diff --check` successfully. No repeat of the unaffected 118-test suite is required.

Repair candidate: `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-M49hJN/candidate`. Current repair hashes (workspace and candidate equal): measurement TS `89cf9661e4f0831c1005462f351cb7d949c5e9eb664c6e9f4fe4dfdb25d89e9c`; measurement test `05d1199da236c943d742f5369de0a435ebe6164f31069fa3c2e091f7048416ed`; runner `19c9e4428a76b5946a767b9daab2f35956f6d357ee1b25d7cf345856e6826954`. Preregistration hash unchanged. New outputs go to `capacity-r2`; the comparison records the retained first attempt as FAIL_SETUP.

Root repair binding verified in `p3/implementation-result-r2.json`: workspace and repair candidate source digest both `a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313` (611 files). It preserves the prior 118-test integration evidence and binds the narrow RED/GREEN repair. Implementation gate is restored; capacity result remains a separate pending gate.

Reviewed baseline: P2 candidate `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-l0YMpH/candidate`, supplied source digest `e76ee51bca620eab97655d7ae219cead9aff4473321f2c50b0cf56eb2e606564`.

Original pre-repair frozen P3 scope and SHA256 (historical; measurement hashes superseded above):

- `src/discovery/query-worker.ts`: `0b1262f16183c3e5d18d2f8076dd24cd21afeda7bf45e56be6d5b4727685f7d0`
- `src/discovery/query-worker.test.ts`: `a0adc483687a3709a387995053de63ff7866e29be063f5a62462b3a7b641b82f`
- `src/benchmark/measure-query-load.ts`: `25755f968533a932aa251b429c9261410d8c868ba2161a319e247c9093c5b9a2`
- `src/benchmark/measure-query-load.test.ts`: `25d7f6d847440f0c473e5b2b2b24e786ed093d391192db219994838c0acace02`
- `p3/run-capacity-pairs.mjs`: `5e312f48260dfa4dfa68677d1ce85c1aa1f7c9f4004261f48bd8eff1103168e3`
- `p3/preregistered-plan.md`: `687a5d91d20bf21a3e15b3c2823e2bf773826de8ac39d13a5b619e5624fc311f`

Original review found no blocking issue; runtime subsequently revealed the repaired P2 oracle issue above. No source edits made by reviewer. No historical run evidence modified.

## Evidence and behavior boundaries

- `query-worker.ts:145-161,350-360`: capacity accepts only 1/2; production default remains one. Global queue is bounded at 32, configurable only downward. Explicit shared reconfiguration rejects an active or still-closing pool. The only non-test caller configuring two readers is the benchmark entry path.
- `query-worker.ts:164-204,241-264`: one global exact-before-broad FIFO queue; expired waiters settle without SQL. Dispatch is per free slot; running and terminating slots are unavailable.
- `query-worker.ts:210-236,267-326`: release waits for all current readers; concurrent closes share one complete barrier. Worker error retains capacity until exit. Kill/close retain worker and running request through terminate plus exit, then settle and reuse the slot. Completed replies from a terminating slot are ignored. Tests cover both termination recovery and close during termination.
- `query-worker.ts:168-176,297,400-426`: queue time is enqueue-to-parent-dispatch; service time is worker-message-handler-start to worker-finish, including connection work. Dispatch-to-reply additionally includes startup/IPC. Missing finish information, queue rejection, and non-dispatched expiry produce null service, not invented zero service. Throwing timing observers are isolated from settlement.
- `src/java-index/sql/entity-search.ts:700-722` and `sql-client.ts:276-302`: request results and generation remain within the existing read snapshot. P3 does not split the transaction. Owner tests compare single/dual results, confirm actual metadata commits, and verify changed-during-request integration outcomes.
- `measure-query-load.ts:225-246,280-286`: each configured reader must have a completed worker timing with non-null service for every warm query. Evidence is per slot and query/mode, not a thread count. Full warm timings are retained. The capacity runner rejects reader replacement during measured requests (`measuredWorkerSpawned !== 0`). Cold worker startup is excluded by successful warmup before the measured window.
- `measure-query-load.ts:247-266,280-305,402-406`: individual discovery latencies preserve sample/round/slot/query/outcome; worker timings are a separately declared SQL boundary. CPU/wall and sampled whole-process RSS cover measured work; old warm-inclusive counters remain available with separate measured deltas. Client release precedes settled reporting; final all-thread shutdown is recorded.
- Preregistered runner uses three serialized pairs in order 1/2, 2/1, 1/2, independent child processes, same candidate digest, no output overwrite. Workload is unchanged 1000 files, 100 measured samples at 1/5/20 plus update concurrency20, original query cohort, deadline1000ms, writer100ms; targets remain 150ms/20ms. Approval receipt and candidate identity are checked before execution; drift checked around every run. Historical single-reader FAIL remains untouched.

## Validation observed

- Read `p3/core-validation-reviewed.log`: isolated compile and 18/18 tests PASS, fail0/skip0. Candidate `.../codex-java-lsp-isolated-validation-b8DTNO/candidate`. Normal bounded results, failure/expiry/queue-full, error-to-exit, throwing observer, termination/replacement, release/close, inode replacement and generation paths covered. Synthetic error emission models the error/exit gap; it is not a claim of a real native worker crash.
- Read `p3/measurement-tests.log`: isolated compile and 3/3 tests PASS, fail0/skip0. Candidate `.../codex-java-lsp-isolated-validation-TgCQAm/candidate`. CLI bounds and single/dual 120-file mechanism tests cover raw timings, every-reader warmup, update interleaving and shutdown. These tests are not the 1000-file capacity experiment.
- Reviewer ran `git diff --check -- src/discovery/query-worker.ts src/discovery/query-worker.test.ts src/benchmark/measure-query-load.ts src/benchmark/measure-query-load.test.ts`: PASS. Reviewer compared P3 source deltas against the P2 candidate and recomputed the four source/test hashes above.
- Root integrated validation: `p3/integrated.log` observed 118/118 PASS, fail0/skip0/cancelled0. Integrated candidate `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-5axcRn/candidate`; source digest `f3337fe6ddc779eaf3d2f0d1ec5956616b9205b7273ab87933b34c29d6d9b5e8` matches workspace per `p3/implementation-result.json`. Reviewer independently recomputed all four scoped candidate file hashes and confirmed exact equality with the reviewed freeze above. This satisfies the implementation integration gate, not the capacity gate.

## Residual limits and follow-up

Node SQLite native steps remain non-interruptible until the step returns; kill grace does not establish a hard native deadline. Terminated work without a worker finish message has unknown service duration. RSS is sampled every10ms and can miss shorter peaks. Closed-wave synthetic load and sparse 100-sample P99 do not establish production arrival-rate capacity or production performance. No new production default is justified by this review.

Root follow-up: execute the already authorized serialized preregistered capacity runs against the integrated candidate and retain all outcomes. Implementation PASS does not imply capacity gate PASS or capacity improvement; the latter require the raw three-pair evidence.
