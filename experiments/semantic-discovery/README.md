# semantic-discovery (optional dense experiment)

A standalone experiment comparing the product's lexical discovery (A2) with an optional external dense route. It is **not a product dependency**:
- Nothing under `src/` imports it.
- It imports no product source, only the frozen evaluation harness scripts.
- Dense results are `DISCOVERY_HINT` only and never bind a declaration.

## Status (R10)

| Part | State |
|---|---|
| `EmbeddingProvider`, `DenseDiscoveryIndex`, `gate.mjs` | Repaired; offline tests only |
| `readSearchDocumentFacts` (index → dense input) | **DISABLED_INVALID** |
| `compare.mjs`, `agent-ab.mjs` | **Refuse to start** (`assertDenseRunnable()` right after their imports, before arguments, sessions, embedding or model calls). A provider pilot needs explicit approval (R11). |

`readSearchDocumentFacts` is disabled for this reason:
- The product index stores SearchDocument **token postings** (`search_doc_token`, deduplicated per document with a tf count). It does not store the ordered `normalizedText`.
- Joining tokens back into "text" embeds a different, unordered representation. Dense and A2 would then not compare the same text, so the comparison could not be attributed to the retrieval method.
- Until the ordered representation is persisted, building dense input from the index throws, and both entry scripts refuse to run. Running them anyway would spend model budget on two identical arms and report "no dense gain" as if it were a result. Callers of `DenseDiscoveryIndex` may pass facts that already carry ordered `text`.

## Cache identity

```text
cacheIdentity({ endpoint, provider, model, revision, dim, metric,
                representationVersion, declarationId, textHash, sourceManifestHash }) -> sha256
```

- **Canonical JSON** of exactly these fields. Unknown fields, including any credential, are rejected.
- **Endpoint** is the origin plus path of the embeddings URL, so the same model behind two endpoints has two identities.
- **Revision**: when the endpoint reports none, the identity is `unversioned:<UNVERSIONED_CACHE_EPOCH>`. It does not claim to be reproducible over time; bump the epoch to start a new cache.
- **Per-row fields**: each declaration row has its own `textHash` (the SHA-256 of its ordered text) and its own `sourceManifestHash` (the sorted list of source path and contentHash pairs). Two declarations in one file therefore never share a vector.
- **Index identity**: `providerIndexIdentity` (on every hint) is derived from the same provider identity plus the representation version and the corpus hash.

The cache file layout is `dense-cache/r10`:

- **Load and write**:
  - The file is read once per keyed `embed` call. It is written through a temporary file and `rename` only when new entries were added.
  - Batches that finished before a later batch failed are still saved.
  - Keyless calls (query embeddings) never read or write the file.
  - `embed` calls on one provider instance must be sequential. Between processes, the last `rename` wins.
- **What counts as a hit**: the record's key must match, the vector must have the recorded dimension, and every value must be finite. All hits in one build must share one dimension.
- **Everything else, including pre-R10 entries** (`model::path::hash`), is a miss and is re-embedded.

## Deadline, failures, stale hints

- **Deadline per batch**: `timeoutMs` covers one batch in total: the connect, the headers, decoding the body, every retry and every backoff. A backoff that cannot fit before the deadline is not started. Every attempt's timer is cleared in `finally`.
- **Retries**: only HTTP 429 and 5xx are retried, up to `maxRetries`. Other failures throw `EmbeddingProviderError`.
- **Response checks**: the row count, a single dimension and finite values are verified. An error message never becomes vector text.
- **Error reporting**: when a fast HTTP 429/5xx failure's retry cannot fit before the deadline, the error is reported as `retry budget exhausted`, not as a timeout. A body-stage timeout aborts the request signal.
- **Counters**: `errors` counts failed attempts. `latencyMs` counts successful attempts only.
- **Stale hints**: a hint carries `indexedContentHash` and a line range only when **every** source file of the declaration still has its indexed hash (for example, the Java file and the MyBatis XML file). Otherwise it is a path-only hint with `startLine`/`endLine` set to `null`; the caller must re-read the file and locate the declaration again.
- **Range sources**: the range is taken only from documents in the declaration's own file.

## Known gaps before a pilot (R11)

- **No ordered dense input.** There is no ordered SearchDocument text source: see `readSearchDocumentFacts` above.
- **Scorer bug (label challenge, not changed here).** `compare.mjs` `coverage()` counts a path-only hint as covering the whole file. Since R10, stale dense hints are path-only, so this scorer would *raise* A3 recall for stale hits. `docs/06-experiment-redesign.md` says "候选路径缺范围不计 line coverage" (a candidate path without a range does not count toward line coverage). The scorer must change before any comparison is reported.
- **Query cache key outside the identity.** `agent-ab.mjs` caches query embeddings under `${model}::query::${query}`, which is outside `cacheIdentity` and has no endpoint. Route it through the identity before a pilot.

## Tests

```bash
node --test semantic-discovery.test.mjs repair-judge.test.mjs ab-summary.test.mjs
```

All tests are offline, using a fake `fetch` and no API key. The optional real-endpoint round trip runs only with `EMBEDDING_E2E=1` and a key kept outside the repository.
