# P1 independent review

Status: PASS after repair re-review. Three initial P2 findings below are resolved. Read-only review; no implementation edits by this reviewer.

Scope: delta from sourceDigest `594c65b1cd6b16db0a5bfb2c79c22df2841f0be558e40efba174de31612cd137`, using the preserved `codex-java-lsp-isolated-validation-snfAeK/candidate` files, to current P1 scripts: run-agent-trace-live, eval-answer-contract (new), evaluate-java-task, eval-tool-wire, their tests and native validateArguments export. Reviewed against evidence-protocol-experiment-plan.md and protocol v1.3/v1.4. Prior unrelated dirty edits are excluded.

## Findings

1. **P2 — remaining source budget describes pre-wire source rather than delivered source.** `scripts/evaluate-java-task.mjs:388` (also read branch 372), with integration at 685–690. `boundSourceResult` subtracts all retained previews and stores remainingSourceBudget; `serializeModelToolResult` can then drop previews to fit 32768 bytes, but keeps that earlier remainingSourceBudget. The actual sourceSpent ledger correctly charges only final wire slices. A tiny in-memory reproduction with 20 distinct candidates, each a valid 2000-byte one-line source comment, and a 20-line/40000-byte budget produces 14 received lines/28000 bytes and 6 dropped previews, while model payload says remaining lines=0, bytes=0. Actual remaining is 6/12000, so tools and the subsequent ledger give contradictory availability and can induce premature submission. Minimum fix: compute metadata from final serialized slices, accounting for any reserialization, and recompute terminal when applicable; retain source-budget truncation diagnostics separately. Add a default-wire-budget preview-drop test and a read-wire clipping test.

2. **P2 — typed recovery erases length termination from primaryStopReason.** `scripts/run-agent-trace-live.mjs:700–701,762`. A first response with `finish_reason: length` and a syntactically complete submit object correctly rejects the submission as length_truncated, but sets primaryStopReason to INVALID_SUBMISSION. A successful second submission yields `{stopReason: SUBMITTED, primaryStopReason: INVALID_SUBMISSION}`. A body-only length response becomes missing_submission, with the same primary stop. Thus the principal stop metric cannot distinguish provider truncation from malformed answer despite the protocol requiring original stop preservation. Raw completion recording still contains the provider reason; this is an attribution defect, not a missing denominator row. Minimum fix: preserve MAX_COMPLETION_TOKENS for an initial length stop, independently of the public-contract validation reason and final recovery outcome. Test recovery success and transport failure following that first stop.

3. **P2 — failed async completion auditing drops usage already measured by provider.** `scripts/run-agent-trace-live.mjs:601–606` and usage merge after dispatch at 657. The new awaited onCompletion callback can reject after chat has returned a completion. That throws before usageFromCompletion is merged. A fake completion with prompt_tokens=123/completion_tokens=45 followed by rejecting onCompletion returns FAILED_RUNTIME with usage `{status: UNMEASURED}`. This violates measured usage preservation and understates failed-request cost. Minimum fix: merge measured usage immediately after chat resolves, before invoking the audit callback, and remove later duplicate merges including legacy fallback. Test exactly-once accumulation for both successful and failed completion callbacks.

## Validation

Executed two `node --input-type=module` in-memory fake scripts. They reproduced the three findings above; no source, gold, scorer or historical artifacts were modified. Normal typed submit after one rejected truncated submit was exercised, as were an audit failure and the source-budget/wire integration edge. Existing narrow implementation tests were inspected; their PASS counts are parent/implementer evidence, not rerun claims here.

Reviewed invariants that appear sound: exclusive valid submit freezes only previously dispatched receipts; mixed read+submit invokes no actions; a recovery exposes only submit and invokes no other action; one-recovery/maxRounds/context caps remain bounded; legacy no-submission fallback is preserved; exhausted native reads short-circuit before invocation; exact line terminators and source hashes survive ordinary wire clipping; missing/invalid answers remain scheduled rows; repair judge remains independent of final answer success. Shared schema uses only public key/type metadata. Escaped duplicate keys now decode before comparison.

Not run: model requests, provider schema compatibility, builds, benchmarks, real JDT/MCP or DB, full frozen scoring. Real provider acceptance of generic array schemas remains runtime verification. No P1 severity finding was established. Do not proceed on this report alone until fixes are reviewed and parent's integrated checks pass.


## Repair re-review — final

All three findings above are resolved in the current P1 scripts. No remaining blocking correctness finding was established within this review scope.

- Finding 1: wireSourceBudget refunds exactly the supplied-minus-final retained slices at this wire layer, includes budget metadata in fitting decisions, and stays stable on second serialization. Read/symbol partial clipping and total model-budget rejection pass; dropped source is not charged or minted as received. Byte capacity too small for a particular next line no longer falsely marks all retrieval terminal.
- Finding 2: the first typed length response preserves MAX_COMPLETION_TOKENS as primaryStopReason. Independently exercised recovery success and recovery transport failure; final stops were SUBMITTED and FAILED_RUNTIME respectively with the same preserved primary reason.
- Finding 3: provider usage is merged in dispatch immediately after chat resolves and before onCompletion. Only one merge remains. Typed and legacy forced callback failure tests retain exactly 123/45 tokens per request, with no double count.

Commands independently run after repair:

1. `node --test --test-name-pattern='callback failures|completion auditing|measured usage|provider length|truncation' scripts/run-agent-trace-live.test.mjs` — 9 PASS.
2. `node --test --test-name-pattern='completion audit rejection' scripts/run-agent-trace-live.test.mjs` — 2 PASS.
3. `node --test --test-name-pattern='wire|remaining|byte budget' scripts/evaluate-java-task.test.mjs scripts/eval-tool-wire.test.mjs` — 6 PASS.
4. An in-memory `node --input-type=module` assertion script for length -> successful submission and length -> failed recovery transport — both PASS.

Final reviewed implementation SHA-256:

- scripts/run-agent-trace-live.mjs: 72636e7121afa33a4978d0b06d6440986c588f015e42909cdb31e3a858738092
- scripts/eval-answer-contract.mjs: 0552b90988cc15e0c6892712853078729869f9bbafacbb9145c09281447f5ce8
- scripts/evaluate-java-task.mjs: a587f47598eb4fee320f2de40a874399d7b79f335e32ee9313912c2fd0accb0c
- scripts/eval-tool-wire.mjs: 3e3d037d56ce71bfca5215bae2454b2a2d0032a6c1717bb1cfbeccf8ed000fe2
- scripts/eval-native-tools.mjs: 0ae0573ea43604c983385f5b53f572f9540bffe92c88f7e644ac1c010291707e

Parent is responsible for the integrated isolated candidate test and its two fake protocol migrations (budget message and final submit). These are not claimed as reviewer-run. Real models/provider schema compatibility and all benchmark/runtime layers remain unrun by this reviewer. No historical rescoring, frozen Python/gold modification, or production acceptance is claimed.
