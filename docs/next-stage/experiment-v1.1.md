# Experiment protocol v1.1 (R11)

This protocol replaces the T10/M3 comparisons, which are `INVALID_EXPERIMENT_FOR_CAUSAL_CLAIMS` (kit `docs/06-experiment-redesign.md`). There were two defects:
- A3 was A2 plus extra hints, so the arms had unequal budgets.
- The scorers credited path-only hints with the whole file, or skipped region validation.

The configuration is registered in `docs/java-specialist-devkit-v1/configs/experiment.json` (`r11_protocol`). The code was `experiments/semantic-discovery/budget.mjs` (removed after the v1.2 re-measurement returned NO_GO; last version at commit `d157b58`).

## Questions and arms

| Question | Arms | Driver | Corpus |
|---|---|---|---|
| Product increment (primary control) | `control`: native list/rg/read(/write/test) vs `product`: A2 = `java_symbol` + the same native tools | `scripts/evaluate-java-task.mjs --arms product,control`, then `scripts/eval-pilot-compare.mjs --baseline control --candidate product` | kit bundled corpora |
| Dense mechanism, retrieval layer | A2 = lexical top-K vs A3 = RRF(lexical, dense) top-K, plus the **non-semantic control** `a2-seeded-fill` (lexical padded to K by a seeded shuffle of the remaining declarations) | `experiments/semantic-discovery/compare.mjs [--agent-pack <agent evidence>]` | hydrated external-full corpus |
| Dense mechanism, agent layer | Same model, prompt, tools and budget. The task text carries one candidate block: A2 = lexical top-K, A3 = RRF top-K | `experiments/semantic-discovery/agent-ab.mjs` | kit bundled corpora |

A native zvec system profile is a different system and is not run here. It must never be mixed with this same-representation ablation.

## Fixed profile (`ExperimentProfile`, hashed as `protocolHash`)

- **Since the A2 fixes (`docs/next-stage/a2-static-fixes.md`)**:
  - The retrieval layer runs `--variants all` by default: the kit primary query plus each task's language variant, stratified by variant.
  - `java_symbol` is called with `preview: "none"` (locators only; the shared renderer owns the evidence).
  - Agent drivers run **eval protocol v1.2**: a received-source ledger after every tool round for both arms, and an 80-line default `read` window.
  - Results from different protocol versions are not compared.


- **Corpus**: mode, kit `corpus_fingerprint`, `dataset_digest`, split and task ids. `compare.mjs` refuses a stage whose hash differs from its hydrate manifest.
- **Representation**: `search_doc_text` (product index schema v8), `searchdoc-v2/declaration-join-v1` and `query-verbatim-v1`.
- **Provider**: endpoint, provider, model, revision/epoch, dimension and metric. No credential is ever included.
- **Lexical**: `java_symbol`, `limit=10`, `mode=auto`.
- **Fusion**: `A3 = RRF(rank_lexical, rank_dense, k0=60).dedup(declarationId).top(10)`.
  - Each channel contributes at most 10 to the pool.
  - A channel that did not return a declaration contributes 0.
  - Ties are broken deterministically: score, then lexical rank, then dense rank, then id.
  - `k0=60` is a frozen initial value, not tuned.
- **Renderer** (`declaration-head-window/v1`), shared by both arms:
  - `DeclarationResolver` maps a declarationId to the product index facts: path, name, `range.start.line` (the product's own locator line), the range end and the file hash.
  - `renderEvidence` takes the ranked ids and emits up to K candidates.
  - It emits up to `max_regions` regions, each of `floor(max_lines / max_regions)` lines from the declaration start, clipped to the remaining line and byte budget.
  - Bytes are counted as the kit counts them.
  - A file whose current sha256 differs from the indexed hash is **dropped**. It is never a path-only credit or a stale range.
- **Budget**: the task budget, shared by every dev task: 8 regions, 160 lines, 16,000 bytes; K = 10 candidates.
- **Scorer**: the frozen kit.
  - Retrieval: `harness score` on a `java-specialist-results/v1` pack, then `harness compare` (paired, cluster bootstrap 95 %, 2000 samples, seed 1984).
  - Agent QA: `scoreWithFrozenKit`.
  - Repair: the frozen judge.
- **Agent fields**: model, system-prompt sha256, tools, candidate-block format, `maxRounds=16`, repeats and seed.

`LEGACY_INVALID_PROTOCOLS` names the two invalid protocols. A new `protocolHash` never equals theirs (tested).

## Metrics

- **Macro-task line recall**: the mean of the kit's per-task `required_line_recall`, with numerator and denominator.
- **Micro-evidence line recall**: pooled required lines. The numerator is recovered from the kit's per-task recall times the gold line count, which must be an integer.
- **Also reported**: kit `declaration_recall_at_10`, `mrr`, `emitted_bytes`, `invalid` and `over_budget`.
- **Agent layer**: success = successes / every scheduled attempt (R02). QA success is the kit's `qa_contract_pass`.

## Four-way decision (`decideFourWay` v2, deterministic; the version is part of the profile)

Thresholds come from the frozen kit `schemas/gates.json`: `dense_recall_at_10_min_delta` 0.1 and `dense_input_token_median_max_ratio` 0.85.

| Decision | Rule |
|---|---|
| `INVALID_EXPERIMENT` | Any invalid or over-budget row in any arm |
| `NO_GO` | The bootstrap **upper** bound of the A3 − A2 Recall@10 delta is below the gate, over ≥ 8 clusters |
| `GO_OPTIONAL` | All of the conditions below |
| `INCONCLUSIVE` | Otherwise, with every unmet condition listed |

`GO_OPTIONAL` needs all of these:
- the screen: Recall@10 delta ≥ gate, lower bound > 0, ≥ 8 clusters;
- A3 beats the fill control on Recall@10 (lower bound > 0);
- the MRR and required-line-recall lower bounds are ≥ 0;
- agent evidence: the QA delta lower bound is ≥ 0 and the prompt-token median ratio is ≤ 0.85.

The retrieval layer alone can at most pass the screen; that is INCONCLUSIVE. `KEEP_EXTERNAL` is a product judgment ("independent tool value, not worth internal fusion"). The experiment cannot produce it on its own.

Results are also reported by origin (authored vs upstream) and by corpus, with each arm's mean candidate count.

## Preconditions (kit 06: stop conditions)

| Precondition | Where it is enforced |
|---|---|
| Wire valid | R01–R03 |
| Scorer consistent | The kit itself |
| Cache cold/warm consistent | `eval-experiment-budget.test.mjs`; reruns row-identical |
| Budget symmetric | This protocol |
| A2 statically correct | R05–R09 |

At most one pre-registered provider pilot runs: SiliconFlow `Qwen/Qwen3-VL-Embedding-8B`, 1024-d, with the agent chat model `openclaw/Qwen3.8-next`. Both were authorized by the owner on 2026-10-10. The pilot task set is the 12 dev tasks registered in `experiment.json`, 3 repeats per arm. Locked labels are never used.
