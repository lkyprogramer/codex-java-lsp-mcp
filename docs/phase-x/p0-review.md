# P0 0.6 review

- dated: 2026-09-07
- SHA_PHASE: `f9cbe18` (`docs(iod): P0 record G5 G6 G7 gate evidence`)
- PHASE_BASE: `6885b17` (`codex/fs-track`)
- SHA_FIX: the `fix(iod): P0 review fixes` commit that adds this file
- closeout: **not written**. P0-G4 still fails. No `iod/P0` tag. P1 not started.

Round-2 Code Reviewer input is `f9cbe18..SHA_FIX` (src/scripts only).

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
| three-repo `--runs 5` | loadavg < 20 must run | retry on frozen clones still running at review-fix commit | pending | `P0-three-repo.txt` (live append; not in this commit) |

---

## Implementer disposition

### P1

| id | action |
| --- | --- |
| P1-1 | **fixed.** Extra owners in `meta.graphExtraEdgeOwners` / `graphExtraNodeOwners`. `removeFiles` promotes the next owner; deletes only at zero owners. Test: shared `MODULE_DEPENDS_ON`, drop one owner, edge remains; reopen then drop the last owner. |
| P1-2 | **fixed.** `readBundle` walks `file.allTypeIds` then global type/field/method point lookups (heap `files()` / `fileOwnedNodeIds`). Last-write-wins UNIQUE unchanged. Test: loser file still contains the shared `type_id`. |
| P1-3 | **partial.** `references()` still sorts the match set (range is in zlib facts; SQL `ORDER BY` cannot match `compareReferences`) then inflates `sourceSet` only for the `limit` slice. `implementers` keeps JS `compareTypes` + `slice` for the same reason. `facts-store.test` already `deepEqual`s `implementers(id, 1)` to the heap store. Covering range columns would break the frozen schema; leftover work is P1 query layer, not a silent LIMIT that would fork heap order. |
| P1-4 | **fixed.** Constructor no longer inflates `kg_edge`. Existence is `knownEdgeIds` plus point query `from_id/to_id/kind`. |
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
| closeout JSON | only after G4 decision and round-2 with no P0/P1 |
| G7 diffstat SHA | regenerated `6885b17..f9cbe18` |
| G2/G3/G4 raw | provenance files added; original `time -l` stdout not recovered |
| T5 resolve from offset 0 | **not in this fix** (P2-1 family; G6 still within budget) |
| `cache_size=-16384` | keep; not a new `JAVA_LSP_*` |
| extra fix commits vs 1-task-1-commit | do not rewrite history |
| zlib vs handbook jsonb | documented G4 in-phase change |
| dirty worktree-family / untracked manuals | left out of this commit |

---

## Verification (review-fix)

Isolated `compile` + targeted:

`dist/java-index/builder/cold-build.test.js`
`dist/java-index/sql/knowledge-graph.test.js`
`dist/java-index/sql/rows.test.js`
`dist/java-index/sql/driver.test.js`
`dist/java-index/sql/facts-store.test.js`
`dist/java-index/sql/entity-tokens.test.js`

**ran: 14 pass / 0 fail.** Phase `full` / G2–G6 not re-run on the fix (G4 still blocking; G2/G3/G6 would need another lishuedu cold build).

---

## Residual

- P0 cannot close while G4 is 1342 MiB.
- P1-3 SQL `LIMIT` that preserves `compareTypes` / `compareReferences` needs sort keys outside zlib blobs (P1 schema or query-layer decision).
- Three-repo `--runs 5` on frozen SHAs was still running at this commit.
- Round-2 reviewer has not yet signed the fix diff.
