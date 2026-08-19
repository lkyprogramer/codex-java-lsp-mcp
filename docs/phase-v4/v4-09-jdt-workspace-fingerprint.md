# V4-09 JDT workspace fingerprint

Date: 2026-08-19

## Sibling isolation (shipped tests)

- Independent `dataDir`: `src/jdtls-runtime-paths.test.ts` — linked worktrees and an explicit `JDTLS_DATA_DIR` still suffix `repoHash`, so two siblings cannot share a workspace path.
- Independent lease: `src/cross-process-lease.test.ts` — sibling worktrees acquire distinct `jdt-worktree` leases when slots allow; same worktree second acquire is `BUSY_SAME_WORKTREE` (mismatch refuses reuse).
- HTTP daemon already asserts distinct `dataDir` for linked worktrees (`src/http-server.test.ts`).

## Stopped-session pom edit experiment

Command (isolated JDT, tiny Maven fixture, real `/opt/homebrew/bin/jdtls`):

`scripts/run-v409-jdt-datadir-experiment.mjs` through `run-isolated-jdt-benchmark.mjs`.

Observed:

- Both starts reached `READY`.
- Same `dataDir` reused (`reusedSameDataDir: true`).
- First start 16810 ms, reuse start 4294 ms.
- JDT log contained no M2E “Updating/Importing Maven project” or “up to date” English lines (`NO_M2E_SIGNAL_GAP_OR_QUIET_LOG`).
- Host 1-minute load was 17.19 (not the old 0.7/CPU quiet bar). A later pass mutates a real dependency (junit) rather than a no-op property.

## Decision

No JDT version / build fingerprint was added to the `dataDir` key.

Reason: the experiment reused the workspace and came up faster, which is consistent with M2E keeping a warm workspace. There was no evidence that reuse served a stale classpath after the stopped-session edit. Adding a fingerprint expiry layer would discard that warm workspace on every JDT or pom hash change. The residual V3.2-24 (c) gap remains documented; sibling mismatch already refuses lease/workspace reuse.
