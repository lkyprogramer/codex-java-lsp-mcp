# Final evidence review

Status: PASS_WITH_LIMITATIONS. No unresolved measurement integrity defect was found in the completed evidence. This is not product acceptance: K29 remains FAIL, and product-arm task success is below control in the new protocol.

## Scope and method

Read-only review of live-full, frozen reports, source snapshots, candidate trees, and six K29 reports. No model requests, load tests, repository changes, or gold-content inspection. Hash-only verification covered all 149 frozen dataset/harness files in each before/after candidate (298 comparisons). `final-evidence-audit.mjs` reproduces the checks; its first draft assumed all final answers were JSON, failed on an actual malformed answer, and was corrected to reflect the existing strict parser's null outcome before the successful audit. No run result was changed.

## Agent evidence

- 72 unique attempts, 458 requests and 458 responses; every request payload hash and requested model configuration verified.
- 429 raw tool records match their raw hashes and actual delivered model messages. All 429 delivery receipts match message hash, byte length, request hash and call id.
- 296 received source slices match their recorded file-version SHA256 and exact source lines. All 56 QA source budgets remain within 160 lines / 16000 bytes, with frozen counts and success mappings verified.
- Response usage sums match every attempt and frozen-result usage mapping. All responses identify openclaw/Qwen3.8-next. This verifies reported identity/settings, not provider internals or whether thinking was actually disabled.
- Product: 25/36 (17/28 QA, 8/8 repair), 499237 prompt tokens, 9100 completion tokens, 181 calls.
- Control: 27/36 (19/28 QA, 8/8 repair), 490615 prompt tokens, 12160 completion tokens, 248 calls.
- Failure statuses: product {'MISSING_REQUIRED_EVIDENCE': 3, 'WRONG_ANSWER': 6, 'INVALID_ANSWER': 2}; control {'INVALID_ANSWER': 2, 'MISSING_REQUIRED_EVIDENCE': 2, 'WRONG_ANSWER': 5}. These labels retain frozen strict scoring; they are not semantic rescoring.
- GSON02: both arms receive complete evidence and stay within budget; both answer locale as Locale.ENGLISH and remain WRONG_ANSWER. PAYMENTS02 product lacks the XML source receipt; control has complete evidence but appends XML-like tags to its JSON and is INVALID_ANSWER. The raw outputs support both failures.
- GSON01 product computes the concrete value but includes explanatory prose before JSON; strict INVALID_ANSWER is retained. This is an output-contract failure, not missing source.
- schedule.jsonl remains an enumeration. actual-execution-order.json matches first-request order and attempt order.

## Repair diagnostics

All 16 candidate trees match frozen-judge recorded hashes, compiler/run exits are 0, frozen_test_completed and validated_success are true, and candidate-version source receipts are VALID.

Original immutable-base scorer diagnostics are deliberately preserved: control PAYMENTS03, ACCESS03, NOTIFICATIONS03 and LEDGER03 contain stale/absent hash errors for modified source; product ACCESS03 is over its raw source budget (390 received lines). These must not be described as a clean raw scorer report. Repair success continues to come from the independent frozen repair runner under the existing contract.

## K29

Candidate source digests were independently recomputed: before 2d4f09405670e73bc655173b3ffe2ec72dc5b4beafddb396ea15c3fd4c0400d1; after 594c65b1cd6b16db0a5bfb2c79c22df2841f0be558e40efba174de31612cd137. Six comparison rows match the persisted reports and recomputed load gate. Sequence: before1, after1, after2, before2, before3, after3.

Every invocation uses 1000 files, 100 samples, concurrency 1/5/20 and the original 150 ms query / 20 ms event-loop P95 limits. All 24 steps settle with queued=0, running=false, one worker thread, 104 completed operations (100 measured + 4 warm-ups), queue peaks 1/4/19/19 and no queue rejection/expiry/termination recorded.

| Lane | Before median of 3 run P95s (ms) | After median of 3 run P95s (ms) | Reduction |
|---|---:|---:|---:|
| concurrency 1 | 32.689 | 27.59 | 15.6% |
| concurrency 5 | 89.111 | 58.92 | 33.88% |
| concurrency 20 | 273.604 | 184.273 | 32.65% |
| concurrency 20 + generation updates | 286.798 | 188.468 | 34.29% |

All six runs remain performance FAIL; all mechanism checks pass. Every after concurrency-20 P95 exceeds 150 ms, including the best run (182.617 ms). Event-loop P95 remains below 20 ms.

## Limits on interpretation

1. The agent protocol changed from v1.2 to v1.3. Historical/current comparisons measure the combined harness, prompt, tools and product changes, not retrieval-only causal impact. Current product/control are internally paired; product is still 2 tasks behind.
2. The same 36 tasks are exposed and repeats=1; no new blind holdout or success-rate significance claim.
3. K29 uses a synthetic corpus, not real-corpus production acceptance. Its update lane only increments indexedGeneration; it does not rewrite source files or postings. Timer commits include warm-up and differ with runtime (before 15/17/15, after 10/10/10), so reduced stale-result counts are not an equal-event-rate effectiveness result.
4. The original benchmark persists percentiles, not per-request latency arrays. Reviewed nearest-rank formula ceil(p*n)-1 and unchanged benchmark source; verified summary/gate mapping and median-of-run-P95 aggregation. Individual P95 order statistics cannot be independently reconstructed from persisted samples. This is a pre-existing evidence-granularity limit, not an observed numeric mismatch.
5. Execution and receipt audit proves the recorded local request/response chain, not an independent capture of provider internals.
