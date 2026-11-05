# semantic-discovery (closed)

The optional dense-discovery experiment is closed. The R11 re-measurement under eval protocol v1.2 (`docs/next-stage/a2-static-fixes.md`) returned `NO_GO`. Its drivers (`compare.mjs`, `agent-ab.mjs`, `budget.mjs`, `gate.mjs`) and the product's dense input table (`search_doc_text`, index schema v8) were then removed. History: `docs/next-stage/dense-input-result.md`, `r11-task-result.md`.

## What remains, and why

The frozen release audit (`docs/java-specialist-release-audit-v1.1/tools/audit-regressions.mjs`, hashed and never edited) imports two modules by path:

| File | Audit cases | Content |
|---|---|---|
| `provider.mjs` | D01–D04 | `EmbeddingProvider` (cache identity, deadline, retries) and `DenseDiscoveryIndex` (per-declaration vectors, stale hints are path-only) |
| `repair-judge.mjs` | J01 | The frozen repair judge over `scripts/eval-repair-adapter.mjs` |

Nothing under `src/` or `scripts/` imports this directory. The native-vs-A2 pilot comparison now lives in `scripts/eval-pilot-compare.mjs`.

## Tests

```bash
node --test semantic-discovery.test.mjs repair-judge.test.mjs
```

All offline, using a fake `fetch` and no API key.
