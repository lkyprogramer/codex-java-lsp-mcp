# P1-T6 diff triage

Point RPCs (anchor / type / types / files / implementers / referencers / callers / callees / batch / parameter-types / read-ranges / mybatis / fact-markers / entity-search): **diffs=0 on all four repos**.

Graph-layer diffs are the same class everywhere: SQL `rebuildFromStore` vs heap sweep `replaceFile`. Heap file set ⊆ SQL; SQL closes some extra context obligations. **Old impl remains identity for graph walk.** Do not edit golden/thresholds.

| repo | tree | SHA | calls | graph diffs | notes |
| --- | --- | --- | --- | --- | --- |
| cipherlink | live | `fa43398` | 188 | digest 1, reachable 10, context 1 | heap 7518/24824 vs SQL 7446/25443 |
| lishu-v2 | live | `10de9c3fe` | 2214 | digest 1 | no `lishu-v2.scenarios.jsonl`; reachable/context not golden-driven |
| exam-parent-v3 | throwaway clone (live tree dirty `DataCryptUtil.java`) | `1d2b09f1` | 1475 | digest 1, reachable 7, context 1, persistence 1 | heap `QUERY_READ_RANGES` INDEX_CORRUPT on some files (invalid exclusive end); harness skips old-impl throw |
| lishuedu | live (clean) | `9507e499e` | 276 | digest 1, reachable 9, context 2 | heap parse 6090 files |

Heap `QUERY_READ_RANGES` validator failure on exam is an old-impl bug; skipped, not counted as SQL diff.

interval P99 on all four runs: 1 ms.
