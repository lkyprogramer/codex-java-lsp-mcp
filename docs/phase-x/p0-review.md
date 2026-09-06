# P0 0.6 review

- dated: 2026-09-07
- SHA_PHASE: `f9cbe18` (`docs(iod): P0 record G5 G6 G7 gate evidence`)
- PHASE_BASE: `6885b17` (`codex/fs-track`)
- SHA_FIX: `226e8a9` then `8670700` (`fix(iod): P0 review fixes`)
- closeout: **not written**. Review protocol has no remaining P0/P1. P0-G4 still fails. No `iod/P0` tag. P1 not started.

---

## Round-1 outputs

### 1. Code Reviewer

Subagent: Cursor generalPurpose `d2a9b60d-7994-4183-8b01-4c54f0f85e27` (read-only `6885b17..f9cbe18` `src`/`scripts`).

**Verdict:** no code-level P0 (no connection leak, no new `JAVA_LSP_*`, no heap/RSS conditional action, `graph-builder.ts` / `persistence-edge-builder.ts` untouched, G7 old-file whitelist holds). **Do not close P0** because G4 failed. P1-1–P1-7 must-fix before closeout.

#### P0 blocking

None as code defects. G4 size is a phase gate, not a missing-zlib bug.

#### P1 must-fix (verbatim findings, shortened evidence)

| id | finding |
| --- | --- |
| P1-1 | `SqlKnowledgeGraph.removeFiles` deletes `WHERE owner_file IN (...)` with a single `owner_file` column. Heap refcounts shared edges (`MODULE_DEPENDS_ON`). Two owners then `removeFiles([first])` drops the edge. |
| P1-2 | `readBundle` rebuilt types with `WHERE file_id=?`. Last-write-wins `ON CONFLICT` moves `type.file_id` to the winner; loser bundle misses the shared `type_id`. Heap `files()` uses `fileOwnedNodeIds`. |
| P1-3 | `implementers` / `callers` / `callees` / `typeReferencers` inflate all matches, JS sort, then `slice(limit)`. No SQL `LIMIT`. |
| P1-4 | `SqlKnowledgeGraph` constructor `SELECT facts FROM kg_edge` and `decodeFacts` every row into `knownEdgeIds`. Unbounded inflate on reopen. |
| P1-5 | `entity-tokens.test` only round-trips `toSnapshot()`. KG tests use heap `rebuildFromStore`, not stub `sqlStoreAsIndex` + `replaceFile`. Cold-build tests only asserted `count > 0`. Digest/entity equality not on the P0 write path. |
| P1-6 | `parseJavaSourceFile` catch returns `undefined`; only `parseFailed` count. I/O and invalid repo-relative look like syntax failures. |
| P1-7 | zlib changed `facts` encoding; `SCHEMA_VERSION` stayed 1. `ensureSchema` would not rebuild; `decodeFacts` throws `expected facts blob`. |

#### P2 suggestions

P2-1 facts loop does not advance `done`; pass 3 has no phase. P2-2 `jsonTopLevelString` is not a JSON parser. P2-3 table-name string concat (internal constants). P2-4 `PRAGMA cache_size=-${cacheKb}` after finite check. P2-5 `nodesByPath` SQL `ORDER BY id` vs heap insertion order. P2-6 `myBatisStatement` / `repositoryFactMarkers` full scans.

### 2. Doc-Consistency Auditor

Subagent: Cursor generalPurpose `46b25b14-9599-4900-b5e7-65b83dbc3066`.

Full implementer notes: `docs/phase-x/p0-review-round1-docs.md`.

Cannot closeout. Product block is G4 `1407225856` B. Process: no `p0-closeout.json`, dirty git, G7 diffstat was `86de82e` not HEAD (regenerated), G2/G3/G4 lacked dedicated raw files (provenance files added), three-repo unfinished. T1–T7 mostly landed. T5 `resolveFileRefs` always restarts at offset 0. Builder `PRAGMA cache_size=-16384` overrides the 32 MiB default. zlib vs handbook jsonb is the documented in-phase G4 change.

### 3. Gate Runner

No separate Gate Runner subagent. Implementer ran the handbook gate table. Raw files under `docs/phase-x/p0-gate-raw/`.

| id | target | measured | pass | raw |
| --- | --- | --- | --- | --- |
| P0-G1 | isolated `full` + `gate:pr` | dist 1351 pass, scripts 282 pass, `FULL_EXIT=0`, `PR_EXIT=0`, `rawSha256=6f7af580…` | yes | `P0-G1.txt`, `P0-G1-summary.txt` |
| P0-G2 | ≤ 180 s | 133.18 s | yes | `P0-G2.txt` (provenance; original `time -l` not retained) |
| P0-G3 | ≤ 600 MiB | 461504512 B (440.1 MiB) | yes | `P0-G3.txt` |
| P0-G4 | ≤ 350 MB | 1407225856 B (1342.0 MiB) | **no** | `P0-G4.txt` |
| P0-G5 | ±1% vs live snapshot | lishuedu/cipherlink/exam-parent-v3 exact; lishu-v2 all <1% after upsert | yes | `P0-G5.txt` |
| P0-G6 | resume ≤ 1.3× G2 (173.134 s) | 133.61 s | yes | `P0-G6.txt` |
| P0-G7 | old src whitelist vs `6885b17` | only `entity-search.ts` + `graph-store.ts` | yes | `P0-G7-diff-stat.txt` |
| three-repo `--runs 5` | loadavg < 20 must run | `THREE_REPO_EXIT=2`; 18 cells written; verifier empty-stderr fail (in-process parse cap-waived log on old and new) | **no** | `P0-three-repo.txt`, `P0-three-repo-summary.txt` |

---

## Implementer disposition

### P1

| id | action |
| --- | --- |
| P1-1 | **fixed.** Extra owners in `meta.graphExtraEdgeOwners` / `graphExtraNodeOwners`. `removeFiles` promotes the next owner; deletes only at zero owners. Test: shared `MODULE_DEPENDS_ON`, drop one owner, edge remains; reopen then drop the last owner. |
| P1-2 | **fixed.** `readBundle` walks `file.allTypeIds` then global type/field/method point lookups (heap `files()` / `fileOwnedNodeIds`). Last-write-wins UNIQUE unchanged. Test: loser file still contains the shared `type_id`. |
| P1-3 | **fixed in round-2 follow-up.** `references()` streams `ORDER BY f.path`, inflates the limit-th path group plus one extra SQL path group (collation slack), then `compareReferences` + `slice(limit)`. `callers`/`callees` `limit=1` now deepEqual the heap store. `implementers` stays JS sort+slice (P2-1; fan-in ~210). |
| P1-4 | **fixed in round-2 follow-up.** Dropped `knownEdgeIds`. Existence is the indexed `(from_id, to_id, kind)` probe only. |
| P1-5 | **fixed.** Cold-build test now compares `SqlKnowledgeGraph.digest()` to heap `KnowledgeGraphBuilder.rebuildFromStore` (fixture store includes MyBatis, matching pass 3) and entity ids to `recordsFromBundle` over `JavaIndexStore.files()`. First digest mismatch was the test omitting mapper XML, not xor. |
| P1-6 | **fixed.** `ENOENT` / `EACCES` / `EPERM` / `EISDIR` and invalid repo-relative rethrow. Other parse errors append `{ relativePath, message }` to `parseFailures` and still count as `parseFailed`. |
| P1-7 | **fixed.** `SCHEMA_VERSION = 2` and `meta.factsEncoding=deflate-raw`. Version `0` or `1` drops all tables. Driver test covers both. |

### P2

| id | action |
| --- | --- |
| P2-1 | **not in this fix.** Resume consistency is `clear()` + replay. G6 resume 133.61 s already ≈ G2. Independent `phase: facts\|graph` is P1 builder work. |
| P2-2 | **not in this fix.** Fixture digest now matches; production path still uses the top-level scanner to avoid inflating `callSites`. |
| P2-3 | **not in this fix.** Concatenated names are internal table literals, not user input. |
| P2-4 | **keep.** Numeric pragma after `Number.isFinite && > 0`. |
| P2-5 | **not in this fix.** Tests sort both sides. |
| P2-6 | **defer to P1 query layer.** Same as heap store; not on the P0 cold-build hot path. |

### Doc-auditor process items

| item | action |
| --- | --- |
| G4 1342 MiB | wait for user: raise gate / change schema / defer entity tables. Do not edit the handbook number. |
| closeout JSON | only after G4 decision; 0.6 review has no remaining P0/P1 at `8670700` |
| G7 diffstat SHA | regenerated `6885b17..f9cbe18` |
| G2/G3/G4 raw | provenance files added; original `time -l` stdout not recovered |
| T5 resolve from offset 0 | **not in this fix** (P2-1 family; G6 still within budget) |
| `cache_size=-16384` | keep; not a new `JAVA_LSP_*` |
| extra fix commits vs 1-task-1-commit | do not rewrite history |
| zlib vs handbook jsonb | documented G4 in-phase change |
| dirty worktree-family / untracked manuals | left out of this commit |

---

## Round-2 Code Reviewer (`ca79c6ba-e307-4f3d-b30f-1063377236ec`)

Range: `f9cbe18..226e8a9` src/scripts. Verdict: **must-fix remaining P1s**. No P0 in the fix diff. Independently reproduced 14 pass / 0 fail.

| id | finding | action |
| --- | --- | --- |
| P1-A | `knownEdgeIds` still accumulated every live `kg_edge` id (~95–180 MB on lishuedu). Constructor preload was gone but the Set stayed a pure cache. | Dropped the Set; `findStoredEdge` is the indexed probe only. |
| P1-B | `references()` inflated full fan-in (BizException 3,217 in-edges, 33.1 ms). Disposition that zlib range blocks bounding was wrong: primary sort key is `f.path`. | Path-ordered iterate, inflate limit-th path + one extra group, then `compareReferences`. |
| P2-1 | `implementers()` same unbounded inflate, ~210 rows. | **not this fix** (order of magnitude smaller). |
| P2-2 | JS xor/owners mutated inside tx, not restored on rollback. | **not this fix**; P0 only `clear()` then abort. |
| P2-3 | `readBundle` via `type.fieldIds` can return winner facts for a loser file. | **not this fix**; duplicate-id last-write-wins is the G5 contract. |
| P2-4 | `readBundle` query count. | **not this fix**. |
| P2-5 | `Math.max(0, limit)` forks heap negative-limit `slice`. | Reverted to `slice(0, limit)` in `implementers` / `references`. |
| P2-6–P2-11 | parseFailures size, ENOENT fatal, inert factsEncoding, corrupt extra-owner meta, unused `f.path`, refcount test gaps. | **not this fix**. |

G4 1342 MiB remains a product gate, not a code P0.

---

## Round-3 Code Reviewer (`1be73a6c-0939-447d-9a04-a73057ed99b3`)

Range: `226e8a9..8670700` src/scripts. Verdict: **approve fix diff**. No remaining P0 or P1. Independently: isolated compile exit 0; 14 pass / 0 fail. Confirmed `knownEdgeIds` gone, heap-parity on digest/ordinals/reopen/`removeFiles`, and `references()` window identical to full sort+slice (BizException-scale 3217 in-edges `limit=80`: 1.66 ms vs 22.62 ms).

| id | finding | action |
| --- | --- | --- |
| P2-R3-1 | One-extra-group collation slack breaks if SQLite BINARY vs JS UTF-16 invert by more than one group (supplementary-plane vs U+E000–U+FFFF). BMP/CJK/ASCII paths sort identically. Reproduced on synthetic astral paths. | **not this fix.** Target repos are ASCII paths. Query-layer can fall back unbounded when a collected path has code point > 0x7F. |
| P2-R3-2 | `ORDER BY f.path` uses a temp B-tree (`PRAGMA temp_store=MEMORY`). Bound is on decode work, not total RSS: 100k in-edges / `limit=80` ≈ 29 MiB transient; 3217-row case ≈ 1 MiB. Not a regression vs `226e8a9`. | **note only.** P1 query layer must not assume `references()` is O(limit) in memory without a path-ordered covering index. |
| P2-R3-3 | Dropping the Set moves duplicate-edge probes onto SQL+inflate (~5.55 µs/call). ~1M re-adds ≈ 5.5 s vs G2 133.18 s / 180 s gate. G2/G6 not re-run after `8670700`. | **not this fix.** Re-measure G2/G6 only if G4 is raised and closeout is attempted. `references()` is not on the cold-build write path. |
| P2-R3-4 | `UPDATE kg_edge … WHERE from_id/to_id/kind` updates ordinal siblings, not the matched row id. No observable divergence today (ordinals share owner; NULL-owner CONTAINS has no siblings). | **not this fix.** Pre-existing at `226e8a9`. |

Round-2 P2-1 `implementers()` unbounded inflate stays P2 (~210 rows ≈ 1.5 ms).

---

## Verification (review-fix)

Isolated `compile` + targeted:

`dist/java-index/builder/cold-build.test.js`
`dist/java-index/sql/knowledge-graph.test.js`
`dist/java-index/sql/rows.test.js`
`dist/java-index/sql/driver.test.js`
`dist/java-index/sql/facts-store.test.js`
`dist/java-index/sql/entity-tokens.test.js`

**ran: 14 pass / 0 fail** after the round-2 P1-A/P1-B follow-up (includes `callers`/`callees` `limit=1`). Phase `full` / G2–G6 not re-run (G4 still blocking).

---

## Residual

- P0 cannot close while G4 is 1342 MiB.
- Three-repo `--runs 5` failed empty-stderr (`7d6d62b`); not a SQL-builder path.
- 0.6 code review is complete at `8670700` (no remaining P0/P1). Round-2/round-3 P2s are recorded above and not started.
- `references()` memory is O(fan-in) for the SQLite temp sort, O(limit + one path group) for JS inflate.
