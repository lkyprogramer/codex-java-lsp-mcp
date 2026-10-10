# A2 evidence pilot: declaration ranges and "a preview is not evidence" (eval protocol v1.3)

**State: DONE, decision REVERT** (pre-registered and committed in `fc11d90` before the run; the change was reverted by the pre-registered rule; results below).

## Correction to the v1.2 diagnosis

`a2-static-fixes.md` named "the agent answers after a head preview without reading the evidence" as A2's main failure. The v1.2 attempt rows do not support that. Product QA failures, by `answerStatus` (`fixes-final/agent-native-vs-a2`):

| Failure | Product | Control | What happened |
|---|---|---|---|
| `WRONG_ANSWER` | 5 | 4 | INVENTORY-02 ×3 answered FQNs (`lab.inventory.StockEndpoint#cancel(Reservation)`) where the contract wants `cancel`; PAYMENTS-01 `Set<String> (HashSet)` vs `Set<String>`; MYBATIS-01 `0` vs `1` |
| `INVALID_ANSWER` | 3 | 0 | Prose instead of JSON (MYBATIS-01, GSON-03), one `MAX_ROUNDS` |
| `MISSING_REQUIRED_EVIDENCE` | 2 | 3 | All ACCESS-01 |
| `RECEIVED_OVER_BUDGET` | 1 | 2 | All ACCESS-01 |

- **Evidence failures are one task.** ACCESS-01's `isAllowed` spans lines 5–396; the required comparison is on line 199. In all six attempts, in both arms, the agent paged through the method 10–80 lines at a time. `rg expiresAt` would have found line 199 directly; the agent ran it only after the budget was gone, or not at all. No attempt stopped after a head preview.
- **The larger failure class is answer format** (8 of 11 product QA failures). It is not discovery-specific and is not addressed here.

## Change under test

- **Product** (`java_symbol` static query): each candidate's `declaration.range = {startLine, endLine}` is the whole declaration (annotations to closing brace), in every preview mode. RED: `src/discovery/locator-name.test.ts` (`fixes-evidence/red-range.txt`).
- **Tool description** (MCP and eval): a preview is a discovery aid, not evidence. Read the lines the answer relies on. When a range is longer than the remaining budget, search inside it (rg) instead of reading it whole.
- **Eval protocol v1.3**: only the product arm's `java_symbol` description and output change. Control is v1.2 under a new label.

## Design

- Pilot: the 12 pre-registered tasks (`configs/experiment.json` `pilot.task_ids`) × {product, control} × 3 repeats.
- Chat model `openclaw/Qwen3.8-next`, cost 0. Same system prompt, native tools, ledger and budget as v1.2.
- Baseline: v1.2 product arm (`fixes-final/agent-native-vs-a2`). Control is re-run for the paired kit comparison.

## Pre-registered decision

- **Primary**: E = product attempts with `MISSING_REQUIRED_EVIDENCE` or `RECEIVED_OVER_BUDGET`, out of 36. v1.2 baseline E = 3.
- **Guards**:
  - product QA successes ≥ 12 of 24 (v1.2: 13, one attempt of noise allowed);
  - product median prompt tokens ≤ 12,235 (1.15 × v1.2's 10,639).
- **KEEP** if E < 3 and both guards hold. **REVERT** (product field and description removed) otherwise.
- **Secondary, no decision**: kit compare product − control on QA (`scripts/eval-pilot-compare.mjs`), and ACCESS-01 per-arm outcomes.
- **Power**: three baseline events make this a coarse check. KEEP means "the targeted failure moved and nothing regressed", not a measured effect size.

## Results (`fixes-evidence/agent-native-vs-a2-v13`, eval-protocol/v1.3)

| | v1.2 product | v1.3 product | v1.2 control | v1.3 control |
|---|---|---|---|---|
| Success / 36 | 22 | 21 | 24 | 26 |
| QA / 24 | 13 | 12 | 15 | 17 |
| Repair / 12 | 9 | 9 | 9 | 9 |
| **E** (missing evidence + over budget) | 3 | **2** | 5 | 3 |
| Median prompt tokens | 10,639 | **12,446.5** | 8,917 | 8,737 |
| ACCESS-01 | 0/3 | **2/3** | 0/3 | 2/3 |

**Decision by the pre-registered rule: REVERT.**
- E fell from 3 to 2: pass.
- QA 12: pass, exactly at the guard.
- Median prompt tokens 12,446.5 against a guard of 12,235: **fail**.

`declaration.range`, its test and the description change were reverted. The eval protocol is back to the v1.2 description. The v1.3 packs stay labelled v1.3.

**Observed:**
- The targeted task moved: product ACCESS-01 went from 0/3 to 2/3. The remaining failure is an FQN answer (`lab.access.SignedAccessPolicy#isAllowed`).
- The two remaining product evidence failures are new: MYBATIS-01 and GSON-03, both `RECEIVED_OVER_BUDGET`.
- Answer format dominates again. Product `WRONG_ANSWER` 8: PAYMENTS-01 ×3 `Set<String> (HashSet)`, INVENTORY-02 ×3 FQN-with-path, ACCESS-01 FQN, MYBATIS-01 `param2`. `INVALID_ANSWER` 2: JSON in a code fence, or after prose.
- Kit compare, product − control, QA: −0.238, CI [−0.476, −0.048], over 7 clusters. In this run A2 is below native on QA with a CI that excludes 0. Token ratio 1.42.
- Control also moved between runs, from 15 to 17 QA with the same tools and protocol. Run-to-run noise is about two QA attempts per arm.

**Inference (not tested):** most of the remaining product-arm gap is answer format, not discovery. Product answers echo `java_symbol` identities (FQN, `path:line`) into fields that want a bare name. A fair test would change the answer contract for both arms, a symmetric eval-protocol change. That is outside this card.

## Evidence hashes (`java-specialist-audit-runs/`)

```text
9bc90c25c819a2c574b8b6904c5bf1d990a981d69afa10d71ba9bdab1f244ac4  fixes-evidence/red-range.txt
29b599b617170b552210eb7faf9c15cd92de6705c8b10873b2063637294984a5  fixes-evidence/agent-native-vs-a2-v13/results-pack.json
7dd0327084d0aa85743898ce3e788dfc3c9b9f8248d80de8aa6670baa7d9cf10  fixes-evidence/agent-native-vs-a2-v13/frozen-score/native-vs-a2-v13-evidence.json
```
