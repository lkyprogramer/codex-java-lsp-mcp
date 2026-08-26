# D3a escalation — hot-set rest-hydrate OOM (2026-08-26)

Card: M1 / V1 D3a. Release `3e9ef62e405c-20260826T034749Z`. Three consecutive live failures after restoring `JAVA_LSP_PREWARM_HOT` `hydrate:true`. Stop retrying the same hydrate on this isolate cap.

## Phenomenon

`prewarmPinnedRepos` calls `prewarmRepo({ hydrate: true })` for `lishuedu` then `lishu-v2`. `lishuedu` `ensureFactsHydrated` (27 MiB rest gz) kills the JavaIndex worker at `resourceLimits.maxOldGenerationSizeMb=1536`:

```
pinned repo prewarm begin lishuedu hydrate=true
pinned repo prewarm index wait failed Error [ERR_WORKER_OUT_OF_MEMORY]
pinned repo prewarm end lishuedu
```

Cold pins (`exam-parent-v3`, `cipherlink`) files-only succeed. `lishu-v2` hydrate returns without an OOM line.

## Attempts after `hydrate:true` was restored

| Attempt | Trigger | lishuedu hydrate | Result |
| --- | --- | --- | --- |
| 1 | install `3e9ef62` | `hydrate=true` | `ERR_WORKER_OUT_OF_MEMORY`. First `java_impact` 4975 ms, toolFail `Java index worker is unavailable after one restart attempt`. D3a false. `lishu-v2` 48 ms OK. |
| 2 | `daemonctl restart` | `hydrate=true` | same OOM, prewarm finished pins=4 |
| 3 | `daemonctl restart` | `hydrate=true` | same OOM, prewarm finished pins=4 |

Evidence: scratch `live/d3a-prewarm-wait.json`, `live/d3a-after-hydrate-1.json`, `live/d3a-hydrate-attempts-2-3.json`. Unit entry-point test asserts `lishuedu hydrate:true` / `cipherlink hydrate:false` and is green.

## Earlier related failures (not counted in the three)

- Sequential rest-hydrate (`7e29c0c`) OOMed lishuedu isolate.
- Hot rest-hydrate idle soak ended 961 MiB (D1 900).
- Files-only V1 probe: `lishu-v2` 4055 ms / `lishuedu` followFail 5579 ms when hydrate ran on demand.

## Next options

1. **Keep the 1536 isolate cap. Shrink default hot set to `lishu-v2` only** (env `JAVA_LSP_PREWARM_HOT`). lishuedu first impact stays files-only + S3 fail-soft; D3a measured on the remaining hot pin. D1 likely holds.
2. **Do not raise the isolate cap.** Build a facts hydrate that does not decode the full rest segment into the 1536 heap (true streaming / query-scoped hydrate). That is a new card, not a fourth retry of `QUERY_REPOSITORY_FACT_MARKERS` on lishuedu.

Do not merge `main`. Rollback: `daemonctl.sh rollback-release`.
