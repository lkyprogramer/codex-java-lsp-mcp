# semantic-discovery (optional dense experiment)

A standalone experiment comparing the product's lexical discovery (A2) with an optional external dense route. It is **not a product dependency**:
- Nothing under `src/` imports it.
- It imports no product source, only the frozen evaluation harness scripts.
- Dense results are `DISCOVERY_HINT` only and never bind a declaration.

## Status

| Part | State |
|---|---|
| `EmbeddingProvider`, `DenseDiscoveryIndex`, `gate.mjs` | Repaired in R10; offline tests plus an optional real-endpoint E2E |
| `readSearchDocumentFacts` (index → dense input) | Reads the ordered `search_doc_text` (index schema v8+). An older index is refused (`DISABLED_INVALID`) |
| `compare.mjs`, `agent-ab.mjs` | Runnable. They fail closed: a corpus without a dense index stops the run instead of producing two identical arms. `agent-ab` also stops before any chat call if a query embedding fails. Both wait until the index's `buildState` is `READY` |
| `line-recall.mjs` | `compare.mjs` scorer with the kit's `required_line_recall` semantics |

### Dense input: `search_doc_text`

- The product stores each SearchDocument's ordered, redacted `normalizedText` in `search_doc_text` (schema v8). It is written in the same transaction as the document's postings and deleted with it.
- **Redaction** uses the preview rule, applied per line: value shape plus secret-named assignments, for example `PASSWORD = "..."` or `token: '...'`. A joined multi-line signature is one line, so one secret-named assignment redacts every literal in it.
- **Limit**: the rule is name- and shape-based. It does not recognise every secret, such as values in text blocks or unnamed short literals.
- The postings are exactly `documentTokens(text)`, so A2 and the dense route read one text surface.
- One dense row per declaration joins its documents:
  - first the declaration's own file, by line;
  - then the other source files (for example a MyBatis XML), by path and line.
- The line range comes only from the own-file documents. Every source file and its hash are in the source manifest.
- An index without `search_doc_text`, or with a document that has no stored text, is refused. Joining unordered tokens would embed a different representation, so it is never approximated.

### Provider configuration (`embeddingProviderFromEnv`)

| Variable | Meaning |
|---|---|
| `EMBEDDING_API_KEY` | Explicit key for any endpoint |
| `SILICONFLOW_API_KEY` / `OPENROUTER_API_KEY` | Vendor keys. Each is used **only** when `EMBEDDING_BASE_URL`'s host is that vendor's host (`*.siliconflow.cn` / `*.openrouter.ai`), so a vendor key is never sent to another host. Keep keys in the git-ignored `.env`; a key is never part of a cache key or a request body |
| `EMBEDDING_BASE_URL` | OpenAI-compatible base URL (default OpenRouter) |
| `EMBEDDING_MODEL` | Required |
| `EMBEDDING_DIMENSIONS` | Optional. Sent as `dimensions` and part of the cache identity |
| `EMBEDDING_PROVIDER` | Optional. Defaults to the endpoint host |

Example (SiliconFlow, 1024-d):

```bash
EMBEDDING_DIMENSIONS=1024 node --env-file=.env experiments/semantic-discovery/compare.mjs \
  --stage <hydrated full-stage> --out <run dir> --cache <cache dir>
```

Query vectors are cached under the same `cacheIdentity`: the provider identity, `QUERY_REPRESENTATION_VERSION` and the query text hash. Measured on SiliconFlow, the same query gives slightly different vectors across runs; the largest top-score difference was 0.0018 cosine, enough to reorder near-tied hints. Caching makes a rerun reproducible. `compare.mjs` records each query vector's sha256 and the top-9 cosine scores.

### Scorer

`compare.mjs` uses `required_line_recall` = `|pred ∩ req| / |req|` over `(path, line)` points, as `harness/scoring.py` does:
- A path-only hint contributes no lines.
- An overlap counts only the lines it covers.

The arms are still **not equal-budget**: A3 is A2 plus up to 8 hints, and the pack records both arms' unique covered lines. Equal K/line/byte budgets after fusion are R11 work.

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
  - The file is read once per provider instance and kept in memory. An `embed` call writes it, through a temporary file and `rename`, only when it added entries.
  - Batches that finished before a later batch failed are still saved.
  - Keyless calls never read or write the file. Entry scripts embed queries through `embedQuery`, which is keyed.
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

## Known gaps (R11)

- **Unequal budget.** A2 and A3 are not capped to the same K/lines/bytes after fusion (RRF); R11 defines that profile.
- **No region validation.** `compare.mjs` scores candidate ranges directly. It does not run the kit's region validation (content hash, byte cost), and a malformed region only contributes nothing instead of invalidating the arm (see `line-recall.mjs`).
- **READY is not quiescent.** Reads require `buildState=READY` in one snapshot. A reconcile of an existing index commits XML and Java separately while staying READY, so a read can land between them. The stage is frozen during a run, so this is unlikely.

## Tests

```bash
node --test semantic-discovery.test.mjs repair-judge.test.mjs ab-summary.test.mjs
```

All tests are offline, using a fake `fetch` and no API key. The optional real-endpoint round trip runs only with `EMBEDDING_E2E=1`:

```bash
EMBEDDING_E2E=1 node --env-file=../../.env --test semantic-discovery.test.mjs
```
