# R09 follow-ups: build lock, scope budget, queue order, legacy search

Scope: the four residual items listed in `r09-task-result.md` ("限制与剩余缺口"). Design target per the owner: single user, low concurrency. Evidence lives in `java-specialist-audit-runs/r09-followups/`.

## 1. Cold build fails with `database is locked` while an agent polls

### Root cause (measured)

- The failure is the builder's `BEGIN IMMEDIATE` returning SQLITE_BUSY after **0 ms**, which means the busy handler never ran. It always happens in `writeKnowledgeAndEntities`, the only builder loop that keeps a read cursor (`sql.iterFiles()`) open across its per-file write transactions. With a cursor open, `BEGIN IMMEDIATE` is an upgrade of a read snapshot. SQLite refuses that upgrade at once when the snapshot is stale (517 BUSY_SNAPSHOT) or when the writer lock is held (5), with no busy wait.
- Two things in the MCP process caused one or the other:
  1. **Read-only connections checkpointed on close.** `close()` ran `wal_checkpoint(TRUNCATE)` on every connection. A read-only connection does not skip that. It takes the checkpoint and writer locks, waits `busy_timeout` for them, then fails with SQLITE_IOERR_WRITE (778).
     - Deterministic: closing a reader while the builder holds a write transaction blocks the closing thread for **5.2 s**. That thread is the main event loop, through `peekBuildState` every 250 ms.
     - Deterministic: on a fully backfilled WAL, a read-only connection's TRUNCATE succeeds and restarts the WAL, and a writer holding a cursor then fails its next write with 517. This is the direct builder failure.
  2. **`compactWalFile` committed.** It opened a writer through `openIndexDb`, and `PRAGMA auto_vacuum=INCREMENTAL` writes a transaction.
     - Deterministic: a connection holding a cursor then fails its next write with 517.
     - A bare `wal_checkpoint(TRUNCATE)` also resets a fully backfilled WAL under such a connection (517). Compaction is only safe while no builder process exists.
- Ablation results:
  - r09 runtime script, 500 ms polling:

    | Variant | Result |
    |---|---|
    | Baseline (b22c0a5 / 836f772) | 3/7 runs failed |
    | `compactWalFile` disabled | 4/4 runs still hit the lock |
    | Read-only no-checkpoint | 0/4 |
    | Both changes | 0/4 |

  - In-process 5 ms polling (`lock-poll.mjs`):

    | Variant | Result |
    |---|---|
    | Baseline | 3/5 rounds failed |
    | Read-only no-checkpoint only | 3/8 |
    | Both changes | 0/8 |

  So both changes are required.

### Fix

| Layer | Change |
|---|---|
| `driver.close` | Read-only connections never checkpoint. A writer's closing TRUNCATE runs with `busy_timeout=0`, best effort. |
| `compactWalFile` | Bare connection with `busy_timeout=0` and only `wal_checkpoint(TRUNCATE)`. No writer pragmas, never waits. |
| `SqlJavaIndexClient.dropConn` | Compacts only when the supervisor reports no builder process (`absent`). A live builder owns WAL truncation on its own close. |
| `cold-build` | Reads the file paths up front, so no cursor spans a write transaction (defence in depth). |
| `awaitPrewarmReady` | Exits once the client is closed, or the cold build failed and no rebuild is running. Without a budget it previously looped forever, and its timer kept the process alive. |

### Tests (red first)

- `driver.test`:
  - Reader close while a writer holds the lock takes < 1 s. It was 5190 ms.
  - Compaction does not break a cursor-holding writer and does not wait on it.
- `cold-build.test`: the build survives a foreign writer committing every ~1 ms during the build.
- `sql-client-lifecycle.test`:
  - Real builder child, 300 files, 5 ms polling, `maxRestarts=0`, 6 rounds, all READY. Before the fix, 5 of 6 rounds were DEGRADED.
  - Compaction is skipped while a builder is alive.
  - `awaitPrewarmReady` ends on a failed build or a closed client.

## 2. Head-of-line blocking (low-concurrency design)

There is still one worker thread and no new lane. In the waiting queue, an exact lookup goes ahead of waiting broad scans, FIFO within each class. The classification is the scan's own rule: `classifyQuery`, or an explicit mode. A scan that is already running is not preempted. A scan cannot be starved past its own deadline. The queue cap stays at 32.

- Test: running scan → scan-a → point-a → scan-b → point-b completes in the order running, point-a, point-b, scan-a, scan-b.
- Not done, by decision:
  - A dedicated thread for point lookups.
  - Multiple scan workers.
  - Coalescing of in-flight requests.
  - Impact-ordered postings.

  The 20-concurrency 150 ms gate is recorded only. It is not a target for this deployment.

## 3. Scope-filtered postings were invisible to the deadline

Before, the scope predicate filtered rows inside one SQL statement. A narrow scope plus a common token meant SQLite read every posting of that token with no row boundary, so there was no deadline check until the statement ended. R06 still requires that only in-scope rows are billed to the posting budget.

### Fix

The scope stays in SQL, but a scoped scan reads each token's postings in keyset pages of 2048 rows:

- `LIMIT 1 OFFSET 2047` on the covering index finds each page's end.
- The page order is the index order, so the visit order and the results are unchanged.
- The deadline is checked before every page.
- Every page counts as `work.examined`. The last page counts `df - read`.
- Unscoped scans are untouched: every row is billed, so every row already checks the deadline.

### Alternatives measured on lishuedu (token `service`, scope `modules/print`, median of 9)

| Strategy | Median |
|---|---|
| One SQL statement (old) | 15.2 ms |
| JS-side filter, object rows | 27.6 ms |
| JS-side filter, array rows | 21.3 ms |
| Keyset pages (chosen) | 16.2 ms |

A first JS-filter implementation measured 2–2.3× slower on scoped queries (`scope-bench-jsfilter.txt`) and was replaced.

### Result

Across 30 lishuedu cases (5 queries × auto/text × print/order/no scope):

- The top-8 results are identical, old vs new.
- Latency matches within about 2 ms (`scope-bench-paged.txt`).
- The slowest scoped query takes 51 ms.

The planned `entity_path` index plus scope-side driving was **not** done. It needs a `SCHEMA_VERSION` bump (full rebuild of every index), and at low concurrency the paged scan is already bounded and fast enough.

### Test

- 20k out-of-scope entities share 4 chunk tokens with 1 in-scope target (80k filtered postings).
- With ample time, only 4 postings are billed, `examined` equals 80,004, and there is at least one deadline check per 2048 rows.
- A deadline passing mid-scan stops it with 0 < examined < total.

## 4. Legacy `search()` / `queryEntitySearch`

**Correction to `r09-task-result.md`.** This path is not java_impact's lexical fallback in production. In `src/`, `JavaIndexRouter.queryEntitySearch` has no caller, and `queryContextGraph` (whose lexical fallback calls `search()`) is called only by `benchmark-agent-impact.ts`.

- **Route semantics unchanged.** `sql-queries.test` asserts SQL/heap parity, including the exact-miss → BM25 fall-through.
- **Bounded like `searchDetailed`.**
  - The default posting cap (20,000) applies.
  - `queryEntitySearch` and `queryContextGraph` forward the request deadline.
  - An expired deadline runs no scan.
- **`fqnHits` uses the `entity_simple` index.** It adds `simple_name_lc = lower(last segment)` instead of a leading-wildcard `LIKE` over every fqn. The invariant "simple_name_lc is the last `[.#$]` segment of fqn" held for 51,169/51,169 entities in the three real indexes.
- **Not moved to the worker.** The worker protocol carries `searchDetailed` only, and the path has no production caller. Its main-thread cost is bounded by the same cap as the R09 in-process `:memory:` path.

## Independent review (before commit)

The review found 0 P1, 0 P2 and 6 P3. It confirmed:

- No main-process writer touches the file while a builder is alive. The only other writers are the sibling-copy helpers, which run before any builder exists for that path.
- The keyset page bounds are exact.
- The visit order matches the old IN-list order.
- The `fqnHits` narrowing is lossless.
- `awaitPrewarmReady` has no false early exit.

| Finding | Outcome |
|---|---|
| `classifyQuery` throwing at enqueue (empty or >512-char text) rejected `search` | Fixed: classification never throws; the scan answers as in-process. Test added. |
| A scoped route started after an earlier route spent the posting budget still read every filtered page | Fixed: stops with `postings` before the first page. Test added. |
| A scan without a deadline could wait behind a steady stream of point lookups | Documented. Not relevant for a single-user server. |
| Legacy `search()` shares one 20k budget across its routes (as `searchDetailed` does), silently | Documented: `benchmark-agent-impact` results on very large repos are not comparable with runs before this change. |
| `work.examined` is an upper bound (whole pages; the row that hit the budget) | Documented in the type. |
| WAL truncation is now opportunistic | Accepted. A writer close no longer waits for readers, and the MCP process only compacts when no builder exists. A large WAL can persist until then; `journal_size_limit` caps it after the next reset. |

Test gaps closed:

- The cold-build foreign-writer assertion no longer sits in `finally`.
- Page-boundary test: df = 4096 with in-scope rows at positions 2047–2049.
- Spent-budget route test.

Remaining risk, not introduced here: several MCP processes sharing one index path. The `absent` check only sees this process's own supervisor.

## Verification

- `run-isolated-validation --profile full`: 1277 + 339 pass, 0 fail (`r09-followups/full-validation.log`).
- Mutations: 16/16 killed (`mutations-summary*.txt`). The two `awaitPrewarmReady` mutants are killed by test failure plus a hung process, which the runner kills at 300 s.
- Real stdio MCP:
  - The R09 runtime check (cold build polled every 500 ms, then 20 concurrent queries) passed 10/10 with 0 `database is locked`; it was 3/4 before.
  - The R07 and R08 runtime checks pass.
- Sweep:
  - scripts 77/77
  - experiments 30 + 1 skip
  - audit 23/27; the open items are D01–D04 (R10)
  - probe 12/12
  - both kit selfchecks pass
  - `check_bundle` PASS (357)
  - kit unittest OK
