# P3 0.6 review

Range: `iod/P2` (`3ae5e67`) .. SHA_PHASE `6a2cbdd`. No review-fix commit (`shaFix` = SHA_PHASE).

## Round 1

### Code Reviewer (`6a2cbdd`, read-only)

P0=0, P1=0, P2=5.

Production SQL bind/transaction/close, single-writer builder, hibernate/recycle removal, and `java_impact` V6 fields: no blocking regression.

P2 (not adopted here; reasons):

1. Fixture RPC tests are SQL≡SQL after heap client deletion. Keep as naming debt; live identity is P3-G2. Do not invent a second heap oracle.
2. A.6 hibernate/recycle manager tests still exist and are tautological. Leave for a later test-only cleanup; they do not restore production recycle.
3. Historical FSR/memory scripts still call deleted APIs. Those scripts are retired heap-era tools, not daemon entrypoints.
4. `isJavaIndexPrewarmReady` still accepts snapshot `DURABLE`. Production `assembleStatus` never sets `snapshot`; `prewarmRepo` does not use that helper. Dead branch.
5. `BuilderSupervisor.stop()` is one-shot. Production `createRuntime` never reuses a closed client.

### Doc-Consistency Auditor

一致: 0.2 #1/#2/#3/#5/#6/#7/#9; T1–T3 deletion body; T2 env formula = 30; schema.ts = handbook 3.9.3; T4 verdict digits match `p3-gate-raw` for `d0ea177`.

偏离 (process / leftover, not P0/P1 src):

- 0.2 #8 several P3 commits exceed 400-line churn because whole leftover files were deleted (T1 split rule).
- `install-runtime.sh` still passthroughs unread `JAVA_LSP_*` names (not the hibernate set).
- `build-fingerprint.ts` kept: JDT semantic edge store still calls `computeBuildFingerprint`.
- T4 identity/release measured at `d0ea177`, not `6a2cbdd`. Later G3 commits are loc/hibernate deletion and import moves; reviewer found no query-algorithm change.
- `p3-gate-raw/p3-probe.json` lacks G6; later `docs/phase-x/p3-probe.json` has G6 true.
- Manager tests still contain hibernate/recycle scripts (same as reviewer P2-2).
- `JavaIndexStatus.snapshot?` / `snapshotVerificationPending?` remain optional unused SQL fields.

### Gate runner (raw, no interpretation)

| gate | command / source | raw |
| --- | --- | --- |
| P3-G1 | isolated full at `6a2cbdd` | `docs/phase-x/p3-gate-raw/P3-G1.txt` — unit 1129/1129, scripts TAP 288/288, smoke exit 0 |
| P3-G2 | T4 three-repo + ruoyi at `d0ea177` | `p3-t4-verdict.json`, `p3-t4-verify.txt`, `p3-t4-ruoyi.json` |
| P3-G3 | loc / JAVA_LSP / timers at `6a2cbdd` | `docs/phase-x/p3-gate-raw/P3-G3.txt` — loc 8971≤9000, JAVA_LSP 30, timers 2 |
| P3-G4 | production daemon after install | not run (no `install-runtime.sh`) |
| P3-G5 | 48h observation | not run |

`gate:release` last twice-green: `p3-t4-release-1.json` / `p3-t4-release-2.json` at `d0ea177`.

## Round 2

Not required: round 1 P0=0 P1=0. No `fix(iod): P3 review fixes` commit.

## P2 disposition

| id | adopt? | reason |
| --- | --- | --- |
| R-P2-1 tautological SQL≡SQL tests | no | Would not restore a heap oracle; G2 is live identity |
| R-P2-2 delete A.6 hibernate tests | no | Test-only; production API already gone |
| R-P2-3 retire FSR scripts | no | Not on daemon path |
| R-P2-4 drop DURABLE shortcut | no | Dead on SQL status |
| R-P2-5 supervisor reopen | no | Manager never reuses a stopped supervisor |
