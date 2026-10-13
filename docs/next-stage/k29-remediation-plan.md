# K29 and paired agent evaluation remediation

Date: 2026-10-11. This is a local implementation and validation run; it does not authorize installation, deployment, live-cache rebuild, or publication.

## Fixed baseline and outcome rules

- Before: base commit `04058e43b8b2658864d0de09c8d6024e9928dfc5`, executable source digest `2d4f09405670e73bc655173b3ffe2ec72dc5b4beafddb396ea15c3fd4c0400d1` (605 files). Preserve the existing runtime-integrity reports and raw archive unchanged.
- Frozen tasks, gold, scorer, repair judge, source budgets, full scheduled denominator, and release thresholds remain unchanged. The historical v1.2 result is not rescored or overwritten.
- New execution protocol: `eval-protocol/v1.3`. Changes include correct preview and anchor forwarding, strict native argument validation, compact discovery messages, source-budget enforcement before model delivery, accurate primary stop causes, candidate-bound repair receipt diagnostics, and common native exact replacement/build-scope fixes.
- Both arms receive the same public prompt, native tools, budgets, model settings and recovery behavior. Only product receives `java_symbol`. No gold-derived per-task hint, vocabulary, answer repair, or test oracle is sent to the model.
- Cross-version before/after results measure the complete intervention, not the isolated effect of one optimization. Compare product/control within the new protocol separately. These previously exposed 36 tasks are regression evidence, not an independent holdout.

## Execution order

1. Offline regression tests for the changed SQL query, tool forwarding, budget/receipt, native edit/compile and completion-recording paths. Independently inspect the integrated changes before live evaluation.
2. Run an exposed paired smoke on GSON-01, GSON-02, PAYMENTS-02, HIKARI-01, ACCESS-03, ADMISSIONS-03, MYBATIS-02 and HIKARI-02. Preserve it separately; it is not part of the final 72-attempt result.
3. Run all 28 QA and 8 repair tasks, two arms, one repeat, seed 1984, maxRounds 16, max completion tokens 2048, the original context/source budgets, and the original frozen scorer. Use the configured Pi `openclaw/Qwen3.8-next` credential in memory only. Explicitly send the configured `off -> none` reasoning-effort mapping and `chat_template_kwargs.enable_thinking=false`; log what was requested without claiming provider compliance. This explicit reasoning-effort parameter is a declared change from the historical run.
4. Run three alternated before/after K29 pairs in private compiled candidates, with the original 1000-file fixture, 100 samples, concurrency 1/5/20, and the built-in concurrent-update step. Keep the 150 ms latency and 20 ms event-loop thresholds. Do not overlap these measurements with compilation or other benchmark runs.
5. Archive exact commands, candidate/source bindings, frozen-input hashes, raw model requests/responses/usage, tool delivery records, repair candidates and judgments, load reports, and a before/after comparison. A failed threshold remains FAIL; no result is promoted by changing the workload or excluding failed attempts.

## Acceptance boundaries

- Query output order, localeCompare tie behavior, invalid-ID refill, scope, posting/examined counters, deadlines and generation consistency must remain valid. A same-request cache must not cross a SQLite snapshot. Batch SQL reads are bounded but not individually cancellable inside a synchronous call.
- Receipt hashes and ranges must match the exact source sent to the model. Raw fetched data that was trimmed or never dispatched is not received evidence. Repeated source still consumes the original budget.
- Repair success comes only from the frozen judge on the actual candidate. Candidate receipt diagnostics are separate from the immutable-base discovery scorer; preserve both original and new diagnostics honestly.
- Independent holdout, full external public-corpus acceptance, production capacity, installation and deployment are not claimed by this run.
