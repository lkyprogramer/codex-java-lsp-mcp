# A2 evidence pilot: declaration ranges and "a preview is not evidence" (eval protocol v1.3)

**State: PRE-REGISTERED** (written and committed before the run; results are appended below without changing this section).

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
