# A2 static fixes after R11: name locators, vocabulary diagnosis, bounded previews, eval protocol v1.2

**State: DONE.** The three A2 static gaps that R11 found are fixed, along with a fourth product bug found while re-measuring. R11 was then re-measured under eval protocol v1.2.
- **Dense, retrieval layer**: with correct locators and both language variants, the frozen rule now returns `NO_GO`.
- **Product increment** (native vs A2): still `INCONCLUSIVE`.

Commits:
- `0348a16`: product, items 1, 2a, 2b and 3a;
- `aed7603`: product, item 4;
- this commit: experiment and eval, items 2c and 3b, plus the reruns.

Base commit `a1c9d26`. Evidence is in `java-specialist-audit-runs/fixes-*/`.

> **Correction:** the failure analysis below said agents "answer after a head preview without reading the evidence". The attempt rows do not show that. Product evidence failures are all ACCESS-01: the agent paged through a 392-line method instead of searching it. Most product QA failures (8 of 11) are answer-format errors. See `a2-evidence-pilot.md`. Since then, the dense drivers and `search_doc_text` have been removed (index schema v9).

## Fixes

| # | Problem (R11) | Fix | Regression test (RED first) |
|---|---|---|---|
| 1 | The locator line/column was `facts.range.start`, i.e. the first annotation (`@Override` 38 vs gold 39). It differed from the gold targets and from an LSP selection | Type and method facts carry `nameRange` (name identifier; `JAVA_FACTS_REVISION` 3 → 4, full rebuild). `selection` = `nameRange.start` (UTF-16). The head preview still starts at `range.start` (new `declarationStartLine`), so annotations stay visible. The experiment resolver follows the same rule | `src/discovery/locator-name.test.ts`: multi-line annotations, same-line annotation, a surrogate pair before the name; preview keeps `@Service`/`@Override`. RED: type at 3:1 instead of 6:14 (`fixes-locator/red.txt`) |
| 2a | An all-CJK query over English code returned an empty list without saying why | A complete, empty non-exact scan reports how many query tokens the vocabulary knows (identifier, chunk and document postings). If none, it returns `emptyReason: {kind: "no_vocabulary_overlap", queryTokens, knownTokens: 0, queryScripts, hint}`. There is no fuzzy fallback (R07), and `scopeState` stays READY | `src/discovery/vocabulary.test.ts`: all-CJK and unknown Latin words are diagnosed. Mixed queries, CJK comments (bigrams) and an empty scope are not. RED: no `emptyReason` (`fixes-vocabulary/red.txt`) |
| 2b | Tool description | `java_symbol` (MCP and eval) says matching is lexical and to query with code identifiers. It names the `emptyReason` and the preview modes | Covered by the full suite |
| 2c | The retrieval experiment only ran the zh primary query | `compare.mjs --variants all` (default) runs each task's kit variants. Strata are by variant, origin and corpus | Run evidence below |
| 3a | One `java_symbol` call could return 10 × 12 lines and 16 KiB of previews, the whole task byte budget | `preview: head` (default: 4 lines, 1 KiB each, 2 KiB per request) \| `window` (R08 window) \| `none` (verified locators, `previewOmitted: not_requested`). Stale files are still dropped in every mode. R08 window-cap tests pin `preview: "window"` | `src/discovery/preview-mode.test.ts`. RED: 12-line default, no `none` (`fixes-preview/red.txt`) |
| 3b | Agents over-read: native `read` defaulted to 200 lines, and nothing showed the running total | **Eval protocol v1.2** (`EVAL_PROTOCOL_VERSION`, written into every evaluate pack and into the agent-ab profile; earlier results are not comparable). After every tool round, both arms get one ledger line: `Source budget so far: received X of 160 lines and Y of 16000 bytes`. It counts exactly the retained slices the kit counts, overlaps included. The `read` default window is 80 lines; explicit windows up to 400 | `scripts/eval-budget-ledger.test.mjs`: exact counts, placement after the round's tool replies, arm-independent, absent without a budget, 80-line default. RED: no ledger, 200-line default (`fixes-ledger/red.txt`) |
| 4 | **Found during the reruns.** `SqlJavaIndexClient.open` served an existing index file without checking its schema, identity or facts revision (only sibling copies were checked). The first rerun on the R11 caches still read revision-3 facts. In production, an upgrade would have kept serving facts built by the old rules, and the builder `serve` mode resets a mismatched DB to an empty schema without a cold build | `open()` checks an existing file read-only. On a mismatch or read error, it removes the file (with `-wal`/`-shm`) and cold-builds | `sql-client-lifecycle.test.ts`: an index with facts revision N−1 is not served READY and is rebuilt to N. RED: served READY (`fixes-stale-index/red.txt`). End to end: the R11 `cache-v2` indexes (revision 3) were rebuilt to 4 automatically, and the rows were identical to a fresh build |

## Re-measurement (protocol v1.2)

**Authorization and cost**:
- Embeddings: SiliconFlow `Qwen/Qwen3-VL-Embedding-8B`, 1024-d, 24 new query vectors for the en variants.
- Chat: `openclaw/Qwen3.8-next`, cost 0.

### Retrieval layer (`fixes-final/retrieval-final`)

Run settings:
- 24 dev tasks × 2 variants = 48 cases, external-full, both product indexes at facts revision 4.
- Protocol `fcd77818…`, including the agent evidence below.

| | A2 lexical | A3 RRF | Seeded fill |
|---|---|---|---|
| Recall@10 | **0.729** (R11: 0.563, zh only) | 0.708 | 0.760 |
| MRR | 0.559 | 0.445 | 0.563 |
| Macro-task line recall | 33.62 / 48 | 33.45 / 48 | 35.62 / 48 |
| Micro-evidence line recall | 169 / 320 | 164 / 320 | 175 / 320 |

| Kit compare (8 clusters) | Recall@10 | MRR | Line recall |
|---|---|---|---|
| A3 − A2 | −0.021 [−0.125, +0.063] | −0.114 [−0.206, −0.001] | −0.003 [−0.063, +0.063] |
| A3 − fill | −0.052 [−0.135, +0.021] | −0.118 [−0.206, −0.013] | −0.045 [−0.087, 0] |

A3 − A2 Recall@10 by stratum:

| Stratum | A2 | A3 | Delta |
|---|---|---|---|
| zh primary | 0.646 | 0.729 | +0.083 |
| en variant | 0.813 | 0.688 | **−0.125** |
| authored | 0.833 | 0.883 | +0.05 |
| upstream | 0.556 | 0.417 | **−0.139** |

- **`decideFourWay` v2 → `NO_GO`**: the Recall@10 upper bound of 0.063 is below the gate of 0.1, over 8 clusters.
- Fix 1 roughly doubled A2's upstream Recall@10, from 0.278 to 0.556. That fix is what turned the dense comparison from "indistinguishable" into "harmful on real repositories".
- `emptyReason=no_vocabulary_overlap` fired on JSB-PETCLINIC-01 and JSB-PAYMENTS-02 (zh primary). Their en variants retrieve the targets.

### Agent layer, primary control: native vs A2 (12 pre-registered tasks × 2 × 3, `fixes-final/agent-native-vs-a2`)

| | v1.1 control | v1.1 product | v1.2 control | v1.2 product |
|---|---|---|---|---|
| Success / 36 | 24 | 22 | 24 | 22 |
| QA / 24 | 15 | 13 | 15 | 13 |
| Repair / 12 | 9 | 9 | 9 | 9 |
| `RECEIVED_OVER_BUDGET` | 5 | **7** | 2 | **1** |
| Median prompt tokens | 17,280 | 14,097 | 8,917 | 10,639 |

The pre-registered checks for the 3a/3b change all hold:
- product over-budget 7 → 1;
- product QA unchanged (13 → 13);
- product median tokens lower (14,097 → 10,639).

The freed failures moved elsewhere:
- `MISSING_REQUIRED_EVIDENCE`: the agent answered correctly without reading the required lines after a head preview (ACCESS-01).
- `INVALID_ANSWER`: prose instead of JSON, or `MAX_ROUNDS`.

Kit compare, product − control, QA: −0.095, CI [−0.238, 0]. **Result: `INCONCLUSIVE`.** A2 still shows no quality gain over native at the agent layer.

### Agent layer, dense: A2 block vs A3 block (`fixes-final/agent-a2-vs-a3`)

| | A2 lexical block | A3 RRF block |
|---|---|---|
| Success / 36 | 21 | 18 |
| QA / 24 | 12 | 9 |
| Repair / 12 | 9 | 9 |
| Median prompt tokens | 9,111 | 18,922 (ratio **2.08**; gate 0.85) |

Kit compare (A3 − A2, QA): −0.143, CI [−0.429, 0], over 7 clusters.

## Conclusion

| Question | R11 (v1.1) | Now (v1.2, fixed A2) |
|---|---|---|
| Dense mechanism (retrieval) | INCONCLUSIVE | **NO_GO** (frozen rule): no gain; worse on upstream repositories and English queries; MRR lower |
| Dense mechanism (agent) | INCONCLUSIVE, leaning negative | Same direction: QA −0.143, tokens 2.08× |
| Product increment (native vs A2) | INCONCLUSIVE | INCONCLUSIVE: over-budget failures fixed, but no QA gain over native |

The dense experiment can stay closed. Removing its code, or keeping it external, is still the owner's decision.

For the product, the next lever is not retrieval but evidence: agents now stop reading after a head preview (`MISSING_REQUIRED_EVIDENCE`). Candidate follow-ups, not done here, need their own pre-registered pilot:
- point a candidate at its body range;
- teach the tool description that the head preview is not evidence.

## Verification

- **Full validation** (isolated runner, at `aed7603` plus this change):
  - 1287 + 350 pass, 0 fail (`fixes-stale-index/full-validation.log`);
  - the earlier run at the locator/vocabulary/preview stage: 1286 + 350 (`fixes-final/full-validation.log`).
- **Sweep** (`fixes-final/sweep/summary.txt`), all pass:
  - scripts 88/88, including `eval-budget-ledger` and `eval-experiment-budget`;
  - experiments 43 + 1 skip;
  - **audit 27/27**;
  - probe 12/12;
  - both kit selfchecks;
  - `check_bundle` PASS (357);
  - kit unittest OK.
- **Unchanged**: no kit, gold, threshold or scorer file was changed.

## Limits

- **Small sample**: 12 pilot tasks × 3 repeats; 48 retrieval cases from 8 projects.
- **JDT not exercised**: the locator change is tested through the index and discovery path. A real JDT run at a name position was not exercised (no JDT in the isolated runner).
- **Older eval packs**: `evalProtocol` is absent from v1.1 packs; they are v1.1 by date (R11).

## Evidence hashes (`java-specialist-audit-runs/`)

```text
d4bcd9b5f5f55a1259cb222346b615e66f476fc9f43251db7514902880b39ee9  fixes-locator/red.txt
d2fc8fb17ee86809037f7bf5088a1369bdd3580e2cc4ccee29a9505b16d095c5  fixes-vocabulary/red.txt
de95c4c03a3ce83b1e5ab7b748f18afad6617ca3671dd7f41697723b007d09c3  fixes-preview/red.txt
4761a65b6c0ee7955feb4ffee5c79cd9519f2f60b44c980b62da92b344a37bea  fixes-ledger/red.txt
0ee0e60bd4a4a27fcb86dace4bcdd1b2fd7119b353f81894fdd33451716ea891  fixes-stale-index/red.txt
2af7e526661c274aa48a52a9411cbbc557613ec0e3ac5110057b1f523ba9682f  fixes-stale-index/full-validation.log
73297476a316f0106e03846c5496aa2f8465c145666d0a616b540988a3c71a26  fixes-final/sweep/summary.txt
d817fb5aa9b53b0494c4189fa628873905186796cbbdc578036da18e6b44dfb4  fixes-final/retrieval-final/results-pack.json
6d6982381bb61219d76131bbca8cb6287a05e4432cac9ae7f52c360b21a3d7dc  fixes-final/retrieval-b/results-pack.json
8ca46d65c6deb314f96c0962dea7725803b3adaa37a113c2242aa6f68c57a419  fixes-final/agent-native-vs-a2/results-pack.json
aa0de3bebf0c393e6cae00ec17a35ff3de1384997170e26ad1736dee32182e3a  fixes-final/agent-native-vs-a2/frozen-score/native-vs-a2-evidence.json
269ce17e24f83e43e219c36154e79d28e560c6cb063710a412ba32b5b600399d  fixes-final/agent-a2-vs-a3/results-pack.json
ea2a24dec948da71eff4a72d91ef3970e5b88db9516663d1f2d48b984b8df801  fixes-final/agent-a2-vs-a3/frozen-score/a2-vs-a3-evidence.json
```
