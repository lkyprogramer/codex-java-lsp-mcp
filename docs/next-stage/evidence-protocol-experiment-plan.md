# Evidence protocol and capacity experiment

2026-10-11. Authorized scope: local implementation, staged independent review and repair, offline validation, a bounded two-reader capacity experiment, and configured `openclaw/Qwen3.8-next` evaluation. No commit, push, install, deployment, production index mutation, or historical rescoring.

## Baseline and immutable inputs

- Base commit: `04058e43b8b2658864d0de09c8d6024e9928dfc5`.
- Starting executable source digest: `594c65b1cd6b16db0a5bfb2c79c22df2841f0be558e40efba174de31612cd137` (605 files, existing local changes retained).
- Raw run root: `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-evidence-experiment-xsnbz3zg`.
- Original task/gold/scorer, historical raw evidence and reports are immutable. Their hashes are captured before edits. New outputs receive separate protocol/configuration identifiers.
- Original QA 80%, warm-static P95 150 ms, event-loop P95 20 ms, source budgets, schedule denominator and exact frozen scoring remain unchanged. A changed worker configuration never rewrites the old single-worker FAIL.
- The earlier `a2-evidence-pilot.md` declaration-range experiment was reverted after its token guard failed. P2 does not restore passive `declaration.range` metadata or its old prompt; it tests one explicit resource source unit from existing resultMap facts. Its real source/token costs must be measured.

## Stage sequence and ownership

1. **P1 shared submission protocol.** A versioned evaluation protocol uses `submit_answer` built only from public keys/types. Assistant prose is retained as draft. An exclusive valid submission freezes previously dispatched receipts; mixed tool actions cannot purchase and claim unseen source. At most one public-contract recovery, no gold feedback/value normalization. Source exhaustion is explicit. Runner and evaluation/wire changes have disjoint owners. Independent review, repairs and offline fake/capture tests must pass before P2.
2. **P2 minimum evidence unit.** Prove a Java type to existing MyBatis resultMap source-range link, independent of a Java Mapper method, with exact hashes/ranges and the original shared budget. Preserve unresolved/stale/truncated states; completeness describes a source unit, never a task. Verify same-declaration multiple provenance separately with fixed candidates. Use a narrow experimental surface; do not silently change the public discovery default. Independent review and source/SQL/wire/receipt tests must pass before P3.
3. **P3 two-reader capacity.** Keep production default one reader. Add an explicit experimental two-reader configuration under one global bounded priority queue. Preserve request ranking, budget, deadline, cancellation, snapshot generation, release and close semantics. Review and lifecycle tests precede serialized same-host runs with unchanged 1000-file/100-sample/1,5,20/update workloads. Capture per-request queue/service timings, CPU/RSS and raw latencies. Fix observed defects before further stages; record capacity outcomes honestly.
4. **P4 next model experiment.** Freeze the integrated candidate and a matched protocol before requests. Both arms share submit/budget rules; preserve old v1.3 results. Run an offline-prevalidated smoke first, then complete scheduled paired attempts. Isolate shared protocol changes from tool/profile changes and fixed-candidate evidence-shape changes. Record actual requests/responses, accepted and rejected submissions, source delivery, usage and execution order. Exposed 36 tasks are regression evidence; any new independently authored cases must be frozen before execution and reported separately, never substituted for original gates.

## Decision rules

- A stage passes only after implementation review findings are repaired and its relevant offline/integration checks pass. No speculative future refactor is bundled into a stage.
- Capacity or model experiments may disprove a hypothesis. Failed original gates remain FAIL; they cannot be repaired by changing labels, thresholds, task budgets, denominator, candidate binding or recorded history.
- Keep broad declaration search unless controlled results justify restricting it. Compare actual success, source delivery, provider tokens/cache, repeated payload, latency and index preparation cost. A small exposed sample cannot prove general superiority; absence of stable benefit warrants an experimental restricted profile, not silent public API removal.
- If evidence units do not reduce a real source deficit within the same budget, stop expansion. If exact/native functionality matches or beats broad discovery, document the narrower supported role. Do not add arbitrary intent handlers, gold-derived vocabulary, full XML semantics, embeddings or a replacement search engine to rescue the experiment.
- Each stage records its source digest, commands, raw results, reviewer conclusion and unresolved boundaries in the new evidence directory. Final verification rechecks immutable hashes, source binding and the complete task scope.
