# M4 escalation — live D7 not observed

## Phenomenon

Isolated M4 tests are green (26/26 seeder+fingerprint after c8fe7c1; T0 278; gate:pr 1255). Production install of `aa4e8da` then `c8fe7c1` succeeded (`releases/c8fe7c16aaa9-20260825T080518Z`). Live D7 did not reach `SEEDED_DEGRADED` / `reusedFiles ≥ 0.9`.

## Attempts

1. **aa4e8da, torna snapshot deleted.** `java_status` returned `worktreeSeed.completion=NO_VALID_SOURCE`, `familyMismatch=10`, `family=07230b6e0a13` (target repoHash). Sibling caches `a72d9f683fd8` / `abe4393f4f56` still had snapshots and `familyHash=97ec2e32dd8a`. Seed never compared them as family.
2. **Daemon restart to drop WorktreeIdentityCache.** Same `family=07230b6e0a13`. Linked-worktree live git identity in the daemon was omitting `familyHash`; pin repos (primary checkouts) logged their real familyHash.
3. **c8fe7c1 familyHash-from-cache-meta, reinstall, torna snapshot still absent.** `java_status` used the full 15009ms budget and returned no `javaIndex.worktreeSeed`. `java_impact` then hit `Deadline exceeded before java-index.status`. Host 1-minute load was 42–70 (earlier peaks 160). Pin prewarm logged repeated `ERR_WORKER_OUT_OF_MEMORY` at the 1536 MiB isolate cap. `phys_footprint_peak` 2546 MiB. No new `worktree seed` log line from the c8fe7c1 release.

## What was tried that is not a skip

- Unit tests cover the fingerprint non-veto, JDK-pin files leaving the fingerprint, skip-reason telemetry, and the cache-meta familyHash fallback.
- Production install is in place; `daemonctl.sh rollback-release` remains the escape hatch.
- D7 was retried after restart and after the follow-up install. It is not a load-policy skip.

## Next two options

1. Re-run D7 when 1-minute load is back under ~20 and lishu-v2 pin has a durable snapshot (or keep the existing sibling snapshot at `a72d9f683fd8`). Expected: `familyHash` from torna `repo-meta.json` matches, `fingerprintMatched=false`, `reusedFiles ≥ 0.9 × 1886`, `cold-build-metrics.json` mtime unchanged.
2. Raise the worker isolate cap or stop hydrating lishu-v2 during the fingerprint-invalidation storm so OPEN/seed can finish inside the 15s `java_status` budget. Do not lower the public tool deadline.

Do not merge `main`. Do not treat this escalation as D7 PASS.
