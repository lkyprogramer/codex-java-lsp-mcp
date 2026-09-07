# P1-T6 diff triage

## cipherlink (`fa43398`, 2026-09-07)

Point RPCs (anchor / type / files / implementers / referencers / callers / callees / batch / parameter-types / read-ranges / entity-search / fact-markers): **diffs=0**.

Remaining:

| RPC | diffs | evidence |
| --- | --- | --- |
| queryGraphDigest | 1 | heap 7518 nodes / 24824 edges vs SQL 7446 / 25443. SQL `rebuildFromStore` vs heap sweep `replaceFile`. |
| queryGraphReachable | 10 | heap file set ⊆ SQL (example +50 files, mostly `apps/*/config`). SQL KG walk is a superset. |
| queryContextGraph | 1 | SQL closed `O3` type-closure; heap left it open. Same extra walk. |

Classification: heap KG completeness / adjacency insertion vs SQL rebuild. Not a point-RPC bug. Old impl remains identity for graph walk until a follow-up equalizes KG construction. Do not change golden/thresholds.

Next: lishu-v2, exam-parent-v3, lishuedu with the same harness; graph RPCs expected to show the same class of diffs unless KG construction is unified.
