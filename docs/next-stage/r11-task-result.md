# R11 result: equal-budget experiment and four-way conclusion

**State: DONE. Conclusion: `INCONCLUSIVE`.** This follows the kit 06 stop rule: one pre-registered pilot, then close. No other provider or model is tried.
- **Valid experiment**: equal budgets, the kit's own scorer, deterministic reruns, and 0 invalid or over-budget rows.
- **Retrieval layer**: under equal budgets, dense fusion's Recall@10 gain cannot be separated from padding the lexical list with **random** declarations. It only appears in the 14–19-declaration authored corpora, and MRR drops significantly.
- **Agent layer**: A3 is worse on QA and costs 1.86× the median prompt tokens.
- **Product**: dense stays out of the dependency tree. Whether to keep the experiment as an external tool (`KEEP_EXTERNAL`) or remove it is the owner's call.

The protocol is in `docs/next-stage/experiment-v1.1.md` and registered in `docs/java-specialist-devkit-v1/configs/experiment.json` (`r11_protocol`). Base commit `1bbb63c`. Evidence is in `java-specialist-audit-runs/r11/` and `r11-red/`.

## What changed

| File | Change |
|---|---|
| `experiments/semantic-discovery/budget.mjs` (new) | See the list below |
| `compare.mjs` | Rewritten. Three arms, all through the same resolver and renderer; kit `score` + `compare`; strata; agent evidence; decision. Fails closed on a missing index, a failed query embedding or a PARTIAL scope. Checks the stage against its hydrate manifest when one exists |
| `agent-ab.mjs` | Both arms get one candidate block of the same format (locators only, ≤ 10): A2 = lexical, A3 = RRF. Model, prompt, tools and budget are shared. Runs on the kit's bundled corpora only. Raw runs are written before scoring. QA is scored by the frozen kit, repair by the frozen judge. Pilot-row comparison and `agentEvidence` |
| `pilot-compare.mjs` (new) | Reproducible pilot comparison of any frozen-kit-scored agent pack, used for native vs A2 |
| `provider.mjs` | `DenseDiscoveryIndex.rank()` |
| `line-recall.mjs` | **Deleted**: R11 removes substitute metrics |
| `scripts/evaluate-java-task.mjs` | Exports `attemptStateOf` |
| `scripts/eval-experiment-budget.test.mjs` (new) | 8 tests; see Tests |

`budget.mjs` provides:
- `rrfFuse`: k0=60, dedup by declarationId, top 10, deterministic ties.
- `seededFill`: the non-semantic control.
- `DeclarationResolver`: product index facts; the locator line is `range.start.line`, as in the product.
- `renderEvidence`: one renderer for every arm; task budget; stale → DROP.
- Kit bridges: `kitEvaluate`, `kitHashes`, `kitScorePack`, `kitCompare`, `comparePilotReports`.
- Totals and strata: `evidenceTotals` (macro-task and micro-evidence, with numerators and denominators), `stratifiedDelta`, `medianPromptTokens`.
- Protocol: `experimentProfile`, `protocolHash` and `LEGACY_INVALID_PROTOCOLS`. The profile includes the arms and `DECISION_RULE_VERSION`.
- `decideFourWay` v2.
- `formatCandidateBlock`.

## RED → GREEN

| Check | RED | GREEN |
|---|---|---|
| HEAD's A3 construction (`compare.mjs@1bbb63c`: A3 = A2 + up to 8 hints) on the same payments fixture, card assert `a3.finalCandidates.length <= 10` | FAIL, `a2=8 a3=16` (`r11-red/red-budget.txt`) | `eval-experiment-budget.test.mjs` 8/8 |

The card's four required assertions are all in the test file:
- both arms `finalCandidates.length <= 10`;
- `pathOnly.required_line_recall == 0` through the kit's `evaluate()` (the kit also marks such a row invalid);
- both arms `emitted_bytes <= 16000` through the kit;
- `newProtocolHash != oldInvalidProtocolHash` against both legacy protocols.

### Tests (zero-cost)

The fixture uses:
- the kit's payments corpus and the JSB-PAYMENTS-01 task and gold;
- a product cold build (`dist`) and the product's lexical search;
- an offline embedding endpoint with an on-disk cache;
- the kit's `harness/scoring.py` `evaluate()`.

The tests cover:
- **Cap and budget**:
  - the fused pool exceeds the cap;
  - both arms stay ≤ 10, valid and within budget;
  - the renderer's bytes and lines equal the kit's;
  - a tight 3/9/200 budget is clipped by the same rule;
  - the candidate block has the same header, ≤ K entries and locators only.
- **Path-only, unresolvable and stale**:
  - a path-only result scores 0 and is invalid;
  - an unresolvable id is reported, never rendered;
  - an edited evidence file drops its declarations in both arms, with recall 0.
- **Cold → warm**: identical fused candidates and evidence, and no new embedding call.
- **RRF**: scores, missing channel, dedup, ties and cap.
- **Protocol hash**: differs from the legacy protocols; changes with the budget, the provider dimension or an added arm; independent of key order.
- **Totals**: macro and micro numerators and denominators, including the non-integer guard.
- **Four-way decision**:
  - GO only with every gate;
  - the retrieval screen alone is INCONCLUSIVE;
  - INCONCLUSIVE when A3 does not beat the fill control, on an MRR or line-recall regression, with too few clusters, on an agent QA regression or when over the token gate;
  - NO_GO when the upper bound is below the gate;
  - INVALID on invalid rows.
- **Helpers**: the fill control, `lexicalDeclarationIds`, strata and token medians.

## Pilot (pre-registered, authorized 2026-10-10)

- **Embeddings**: SiliconFlow `Qwen/Qwen3-VL-Embedding-8B`, 1024-d.
- **Chat**: `openclaw/Qwen3.8-next` (cost 0).
- **Embedding calls**: 0 new HTTP calls across all R11 runs. Every vector came from the identity-keyed cache built in `dense-input`. The real provider's cold/warm equivalence is shown by the offline fixture and by identical warm reruns; the cold real-provider run itself happened in `dense-input`.

### 1. Retrieval layer (`compare.mjs`, 24 dev tasks, 8 corpora, external-full; `retrieval-final`, protocol `4cce2841…`)

| | A2 lexical | A3 RRF | A2 + seeded fill (control) |
|---|---|---|---|
| Mean candidates | 6.4 | 10 | 10 |
| Recall@10 (kit) | 0.563 | 0.646 | 0.625 |
| MRR | 0.538 | 0.409 | 0.547 |
| Macro-task line recall | 15.28 / 24 | 16.82 / 24 | 17.28 / 24 |
| Micro-evidence line recall | 84 / 160 | 89 / 160 | 90 / 160 |
| Mean emitted bytes | 1,348 | 1,718 | 1,717 |
| Invalid / over budget | 0 / 0 | 0 / 0 | 0 / 0 |

Kit `compare` (cluster bootstrap 95 %, 8 clusters):

| Delta | Recall@10 | MRR | Required line recall |
|---|---|---|---|
| A3 − A2 | +0.083 [+0.021, +0.167] | **−0.129** [−0.218, −0.046] | +0.064 [0, +0.164] |
| A3 − fill control | +0.021 [−0.042, +0.083] | **−0.137** [−0.220, −0.063] | −0.019 [−0.083, +0.025] |

A3 − A2 by origin:

| Origin | Tasks | Recall@10 | MRR | Line recall |
|---|---|---|---|---|
| authored (14–19 declarations per corpus) | 15 | +0.133 | −0.153 | +0.102 |
| upstream-scoped (240–9,067 declarations) | 9 | **0** | −0.089 | **0** |

- `java_symbol` returns fewer than 10 candidates on 15 of 24 tasks, and A3 is always padded to 10. On a 14-declaration corpus, 10 slots cover most of the corpus.
- The random fill control gets the same gain: it is no better than A3 on Recall@10, and better on MRR, line recall and micro evidence. **The A3 − A2 gain is "more candidates", not dense semantics.**
- Reruns are deterministic: `retrieval-a` and `retrieval-b` (the two-arm protocol `0e245b1f…`) produced identical rows and comparison, with 0 HTTP calls.

### 2. Agent layer, primary control: native vs improved A2 (`evaluate-java-task.mjs`, 12 pre-registered tasks × 2 arms × 3 repeats)

| | control (native) | product (A2) |
|---|---|---|
| Success / scheduled | 24 / 36 | 22 / 36 |
| QA | 15 / 24 | 13 / 24 |
| Repair (frozen judge) | 9 / 12 | 9 / 12 |
| Median prompt tokens | 17,280 | 14,097 (ratio 0.82) |
| Mean tool calls | 8.3 | 6.2 |

- All 72 attempts were MEASURED. Four ACCESS-03 attempts hit `MAX_COMPLETION_TOKENS` (2 per arm); they stayed in the denominator as failures.
- `pilot-compare.mjs` (product − control, pilot QA rows): `qa_contract_pass` −0.071, CI [−0.167, 0].
- **Result: `INCONCLUSIVE`.** The arms differ only on ACCESS-01 and MYBATIS-01 (control 1/3, product 0/3). The product's failures there are `RECEIVED_OVER_BUDGET`: `java_symbol` previews count toward the received-source budget. A2 needs fewer tool calls and a lower median token count, with no measured quality gain.

### 3. Agent layer, dense mechanism: A2 block vs A3 block (`agent-ab.mjs`, same 12 tasks × 2 × 3)

| | A2 lexical block | A3 RRF block |
|---|---|---|
| Success / scheduled | 22 / 36 | 18 / 36 |
| QA | 13 / 24 | 9 / 24 |
| Repair | 9 / 12 | 9 / 12 |
| Median prompt tokens | 8,731 | 16,204 (ratio **1.86**; gate 0.85) |

- `pilot-compare.mjs` (A3 − A2): `qa_contract_pass` −0.167, CI [−0.476, +0.071], over 7 clusters.
- **Largest single effect: ADMISSIONS-01** (A2 3/3, A3 0/3).
  - The A3 block lists the `undergrad` module first, and the model answered `["undergraduate","graduate"]`.
  - The kit compares lists strictly in order against gold `["graduate","undergraduate"]`.
  - So fusion order changed the answer order. The agent was not misled to a wrong file.
- This pack was produced before the review fixes. Its agent evidence was recomputed by `pilot-compare.mjs` from the same frozen-kit reports, with no rerun.

## Four-way conclusion

`decideFourWay` v2 on the retrieval run plus the agent evidence returns **`INCONCLUSIVE`**, screen `FAIL`. Every unmet gate is listed in the pack:
- Recall@10 +0.083 < 0.1;
- A3 vs fill-control lower bound ≤ 0;
- the MRR lower bound < 0;
- the agent QA lower bound < 0;
- token median ratio 1.86 > 0.85.

| Question | Result |
|---|---|
| Product increment (native vs A2) | INCONCLUSIVE: no measured quality benefit; previews push some product attempts over the received-source budget |
| Dense mechanism | INCONCLUSIVE (frozen rule). Inference from the evidence, not a rule outcome: the semantic contrast against the fill control has an upper bound of 0.083, which is already below the 0.1 gate, and every quality and cost signal points the same way. A larger sample would most likely end at NO_GO, not GO |
| **Overall** | Closed as INCONCLUSIVE after one pilot (kit 06). `GO_OPTIONAL` is not supported. Dense stays out of the product |

## Review

The independent review found 2 P1, 3 P2 and several P3.

| Finding | Outcome |
|---|---|
| P1-1: the Recall@10 gain comes from filling slots on micro corpora, not from dense semantics | Fixed: `a2-seeded-fill` control arm and by-origin/by-corpus strata are now part of the protocol and the report (results above) |
| P1-2: `decideFourWay` could return GO from the dev retrieval screen alone | Fixed (v2): GO needs the screen with ≥ 8 clusters, beating the fill control, MRR and line-recall lower bounds ≥ 0, and agent evidence (QA lower bound ≥ 0, token median ratio ≤ the gate). The retrieval layer alone yields at most `screen: PASS` → INCONCLUSIVE. Tests cover each gate |
| P2-1: the locator line is the annotation line (`range.start.line`), while the gold target is the name line, for example PetValidator `validate` 38 vs 39. It undercounts both arms' Recall@10 and MRR | **Not fixed (product scope).** It is symmetric between arms, so deltas keep their direction, but absolute A2 numbers are low. The precondition "A2 statically correct" is **not met**; see Limits |
| P2-2: the native-vs-A2 comparison could not be reproduced from code | Fixed: `pilot-compare.mjs` |
| P2-3: an `agent-ab` scoring failure lost the live runs | Fixed: `runs-raw.json` is written first; a scoring failure writes `status: SCORING_FAILED` |
| P3: path-only test validity; resolver null path; `lexicalDeclarationIds`; GO counter-examples | Tests added |
| P3: cold/warm claim too strong | Wording narrowed above |
| P3: `--stage` with a hard-coded corpus mode | `agent-ab` now refuses `--stage` |
| P3: PARTIAL scope | `compare.mjs` stops on it |
| P3: filtered pilot reports kept the whole-split summary | The summary is removed |
| P3: legacy-hash assertion is trivially true | Accepted; it is the card's required assert, and the hash also covers arms and decision version now |

## Verification

- **Full product validation** (`run-isolated-validation --profile full`, final code): 1280 + 347 pass, 0 fail (`r11/full-validation-final.log`).
- **Sweep** (`r11/sweep/summary.txt`), all pass:
  - scripts 85/85, including `eval-experiment-budget.test.mjs` 8/8;
  - experiments 43 + 1 skip;
  - **audit 27/27**;
  - probe 12/12;
  - both kit selfchecks;
  - `check_bundle` PASS (357);
  - kit unittest OK.
- **Kit and gold**: no kit, gold, threshold or scorer file was changed. The selfcheck `__pycache__` directories were removed.

## Limits

- **Small sample**:
  - 12 pilot tasks over 8 corpora, 3 repeats; 24 tasks at the retrieval layer.
  - Clusters are corpora, but tasks in one project are not independent.
  - Only primary variants were run, with no unknown-entry stratification; the locked split was not used.
- **A2 static gaps** (product, not R11; reported separately):
  1. Locators use the annotation line instead of the name line (P2-1).
  2. JSB-PETCLINIC-01 returns 0 lexical candidates for an all-CJK query.
  3. `java_symbol` previews push agents over the received-source budget.
- **Strict list order**: the kit compares answer lists strictly, so the candidate order can decide QA outcomes.
- **Corpora**: agent layers use the kit's bundled corpora (the frozen QA scorer validates against them); the retrieval layer uses the hydrated external-full corpus.
- **No zvec profile**: a native zvec system profile was not run.

## Evidence hashes (`java-specialist-audit-runs/`)

```text
ae0f01ab22be33b5e07ed9617698621197ce08518da4ca68d9d8df23bf640da8  r11-red/red-budget.txt
3975a068e63ef834224ee7a98135d9a078b8c6bdf6e4fc970c242df992ec9d2a  r11/retrieval-final/results-pack.json
b6b5e8abbf5eeb1ab82ab3fcca6d86705e21ee1ff07ff67d20d02a91357d8ba6  r11/retrieval-a/results-pack.json
aeb061f3e669094fa1df15a01bcf4b568ff1e4085576a077fc82b9c128e2f6dc  r11/retrieval-b/results-pack.json
83dbc8cc77cda0300f96e3c285ba2b854903ce5c6ddfeedd8dec354dbe1a92fc  r11/agent-native-vs-a2/results-pack.json
97076ea3dcc320fd77c85cc57f53c7530c7a1ba8ac8933dbf511318fe0509ee1  r11/agent-native-vs-a2/frozen-score/native-vs-a2-evidence.json
ba4af9fc7d21e34907efa6bc13accd615a21b50f268def95b4e5e899fa7232bd  r11/agent-a2-vs-a3/results-pack.json
5c3d51306de6a710bb731209f206e570334e12b1232431b6ca38bd9ff79006cb  r11/agent-a2-vs-a3/frozen-score/a2-vs-a3-evidence.json
8d1981594cb3ceada630fea1e420eb9b800f523b8cca4fa889a07b2722759cee  r11/full-validation-final.log
7aa0b0e6f895d7511064ed8ab4b41e30907ec41522aa5319a7a18aeb01475482  r11/sweep/summary.txt
```
