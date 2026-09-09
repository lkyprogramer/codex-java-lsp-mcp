# P2 0.6 review

Range: `iod/P1` (`3e0450c`) .. SHA_PHASE `0389d9a`, then review-fix `0389d9a..af90da2`.

## Round 1 (reviewer + doc-auditor + gate-runner on `0389d9a`)

Reviewer: P0=1, P1=5, P2=3.

- **P0** cold stall: `runColdOnce` unregistered the child without SIGKILL → dual writer. Fixed in `52f3811`.
- **P1** incremental never wrote `buildProgress` (watchdog false-kill). Fixed: parse/reconcile heartbeat outside the big txn.
- **P1** `shutdownChild` timeout did not await exit. Fixed.
- **P1** `open()` swallowed coldBuild/reconcile failures. Fixed: `markDegraded` + `.catch`.
- **P1** `findSiblingDb` only scanned live runtimes. Fixed: `scanFamilySiblingIndex`.
- **P1** failed `VACUUM INTO` left dest / `opened=true` too early. Fixed: `.copying` + rename; `opened` after success.

Doc-auditor: 0.2 violations=0. Schema unchanged. `createRuntime` uses `SqlJavaIndexClient`. Closeout must not call G6/G7/G8 unconditionally 0-diff.

Gate-runner: G1–G7 measured pass; G8 point diffs=0 with P1-class graph residual.

## Round 2 (reviewer on `0389d9a..52f3811`)

P0=0, P1=2.

- **P1** close vs in-flight cold/reconcile reopen. Fixed `975a433` (`opened=false` on close).
- **P1** sibling reconcile `submit` resolves `ok:false` (`.catch` dead). Fixed `975a433` (`result.ok`).

## Round 2 remainder (reviewer on `52f3811..975a433`)

P0=0, P1=1: `status()` reassembled READY over DEGRADED. Latched with `failReason` at `af90da2`. Isolated lifecycle 8/8 twice.

## P2 suggestions not adopted here

- Reconcile still size+mtime (not `content_hash`); P3 optional.
- `JAVA_LSP_PREWARM_HOT` / hibernate env still read as leftovers; P3-T2 deletes.
- Graph RPC heap ⊆ SQL (P1 triage); not a P2 regression.

## Round 2 final

P0=0, P1=0 remaining on the review-fix range after `af90da2`.
