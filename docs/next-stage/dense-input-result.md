# Ordered dense input and first real-provider pilot

**State: DONE.** The R10 residual "no ordered dense input" is closed:
- The product index now persists each SearchDocument's ordered, redacted `normalizedText`.
- The dense experiment embeds exactly that text, and it ran end to end on a real provider.

Base commit `aa8a1e3`. Evidence is in `java-specialist-audit-runs/dense-input/`.

This is **not** an R11 result. The A2/A3 arms do not yet have equal budgets; see Limits.

## Product: `search_doc_text` (schema v8)

| Item | Change |
|---|---|
| Table | `search_doc_text(doc_sym PK → search_doc ON DELETE CASCADE, text)`. The text is the `normalizedText` the postings were tokenized from. |
| Redaction (review P2-1) | `finish()` now applies the preview rule per line (`redactPreviewLine`): value shape plus secret-named assignments. The old document rule judged value shape only, so `PASSWORD = "short"` stayed in the text, the postings and the embedding input. Test: K18 short-secret case in `search-docs.test.ts`. |
| Write | `insertDocuments` writes it in the same transaction as `search_doc` and `search_doc_token`. That covers the cold build, Java refresh, XML resource job and reconcile. |
| Delete | Deleted explicitly alongside the postings in `deleteTokensForPath` and `deleteTokensForSource`, and in the cold-build reset and `clearIndexData`. The FK cascade is a backstop. |
| Version | `SCHEMA_VERSION` 7 → 8. An older DB is dropped and rebuilt, and sibling copies are reused only on an exact version match. |
| Size | gson 0.60 MB of 22.4 MB; mybatis 1.02 MB of 53.6 MB (≈2–3 %) |
| Separate table | Keeps `search_doc` rows narrow for the stats scans (`commitSearchDocStats` sums `token_len` over every row). |

**Test:** `src/java-index/builder/search-doc-text.test.ts` runs through the real writer paths. After each of the cold build, Java refresh, XML-only resource job and file deletion, it checks:
- every document has exactly one text;
- no text is orphaned;
- `token_len` and the stored postings are exactly `documentTokens(text)`;
- comment and signature text keep their source word order.

`rows.test.ts` allowlists `search_doc_text.text` as a reviewed TEXT column.

## Experiment (`experiments/semantic-discovery/`)

### `readSearchDocumentFacts`

- Reads `search_doc_text` in one read transaction, together with `meta.buildState`.
- Refuses an index without the table, or with a document lacking text (`DISABLED_INVALID`). Text is never rebuilt from tokens.
- Refuses a snapshot that is not `READY` (`INDEX_NOT_READY`).
- Each fact keeps:
  - the owning file as `relativePath`;
  - the evidence source as `sourcePath` + `contentHash` (for example the MyBatis XML).

### `waitForReadyIndex`

Found in the pilot. `compare.mjs`'s warm-up query returns while the cold build still runs. The first cold run read mybatis at 5,742 of 9,067 declarations. Both entry scripts now wait for `READY`, and `agent-ab` keeps its warm-up server alive until then.

### Join order

A declaration's own-file documents come first, by line, then the other source files by path and line. The range comes from the own file only.

### Entry scripts

- They no longer refuse at import. They **fail closed**: a corpus whose dense index cannot be built stops the run instead of producing two identical arms.
- `embeddingProviderFromEnv` takes the key from `EMBEDDING_API_KEY`, else `SILICONFLOW_API_KEY`, else `OPENROUTER_API_KEY`, kept in the git-ignored `.env`. It also reads `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` (sent as `dimensions` and part of the identity) and `EMBEDDING_PROVIDER`.

### Query vectors

Cached under `cacheIdentity`: the provider identity plus `query-verbatim-v1` and the query text hash. This closes R10's "query cache key outside the identity" gap.

It also makes reruns reproducible. Measured: SiliconFlow returns slightly different vectors for the same query across runs (top-score difference ≤ 0.0018 cosine). The query vector hashes differed in every task between two uncached runs, which reordered near-tied hints in two tasks; recall was unchanged. `compare.mjs` records each query vector's sha256 and the top-9 cosine scores.

### Cache file

Read once per provider instance. It is ≈200 MB at 1024-d for the dev corpora, so re-reading it per query was not viable.

### Scorer

`line-recall.mjs` implements `required_line_recall` with the kit's `harness/scoring.py` `line_set` semantics:
- A path-only region contributes 0.
- An overlap counts only its lines.

`compare.mjs` uses it; its old `coverage()` (whole-file credit, any overlap = full credit) is removed.

### R10 leftover fixed

`buildCost.deltaHttpCalls` was always `null`: it read `.calls` from a `costReport()` snapshot whose field is `httpCalls`.

## RED → GREEN

| Check | RED | GREEN |
|---|---|---|
| Product: `search-doc-text.test.ts` | product files reverted to HEAD: 2/2 fail, `no such table: search_doc_text` (`red-product.txt`) | 2/2 pass |
| Product: short secret in a document (`red-redaction.txt`) | `s3cr3t!` and `zq7short` present in document text | Redacted; the key name stays searchable |
| Experiment: HEAD `provider.mjs` + HEAD `coverage()` (`red-experiment.txt`) | 3/3 fail: the reader throws `DISABLED_INVALID` on a v8 index; path-only scores 1 (expected 0); partial overlap 2/4 lines scores 1 (expected 0.5) | Covered by `semantic-discovery.test.mjs` (22 pass) |

The product RED is a missing table: the behavior did not exist before, so it is not a broken build.

## Real-provider pilot

- **Authorization**: the owner asked for an embedding pilot with SiliconFlow `Qwen/Qwen3-VL-Embedding-8B` and an agent pilot with `openclaw/Qwen3.8-next`.
- **What leaves the machine**: SearchDocument text of the public kit corpora (the hydrated upstream repos plus the authored kit corpora) and the dev task queries.
- **Disclosure**: the runs before the redaction fix (`pilot-cold` through `pilot-b` and `agent-ab`) sent two signature texts with their literal values. They are MyBatis's public upstream test classes `MysqlContainer` and `PgContainer`, whose `DB_NAME`, `USERNAME` and `PASSWORD` are test-container credentials from the open-source repository. After the fix exactly these 2 of 10,343 mybatis documents changed (`pilot-v2a`: 2 re-embedded items).
- **Corpus**: `harness hydrate-public` into `dense-input/full-stage`. Seed-file sha256 checks passed; the manifest is `full-stage-manifest.json`.

### Retrieval layer (`compare.mjs`, 24 dev tasks, 8 corpora, 1024-d)

| Run | Embedding requests | Notes |
|---|---|---|
| `pilot-cold` | 623 HTTP / 9,586 items, 0 errors | **Invalid for mybatis** (read mid-build); led to `waitForReadyIndex` |
| `pilot-warm` | 232 / 3,349 | Completed mybatis (9,067 declarations); 7 corpora 0 embeddings |
| `pilot-final` / `-warm` | 24 / 24 each (queries only) | Fresh product index, cached declaration vectors |
| `pilot-rep1` / `-rep2` | 24 / 24 each | Showed query-vector drift → query caching |
| `pilot-a` / `pilot-b` | 24 / 24, then 0 / 0 | Query caching; row-identical |
| `pilot-v2a` | 1 HTTP / 2 items | After the redaction fix: fresh product index; only the 2 changed mybatis texts re-embedded. **Reported run** |
| `pilot-v2b` | 0 / 0 | Row-identical to `pilot-v2a` |

`pilot-v2a`, using `required_line_recall` (kit semantics). Recall is identical in `pilot-a`:

| | A2 (lexical) | A3 (A2 + ≤8 dense hints) |
|---|---|---|
| Micro mean | 0.275 | 0.339 |
| Mean unique covered lines | 28.5 | 41.2 |

| Corpus | A2 | A3 |
|---|---|---|
| inventory | 0.333 | 0.511 |
| access | 0.111 | 0.278 |
| admissions | 0.333 | 0.500 |
| payments | 0.333 | 0.333 |
| pricing | 0.222 | 0.222 |
| petclinic | 0.333 | 0.333 |
| gson | 0.533 | 0.533 |
| mybatis | 0 | 0 |

- **Facts**:
  - A3 gained on 4 tasks: INVENTORY-01/02, ACCESS-03 and ADMISSIONS-02, all on the small authored corpora.
  - A3 gained nothing on the three upstream repos (gson, mybatis, petclinic).
  - No hint was path-only, since no file was stale.
- **Inference, not a result**: the gain comes with 45 % more covered lines. Under an equal budget, part or all of it may disappear. This pilot cannot attribute it to the dense route.

### Agent layer (`agent-ab.mjs`, run before the redaction fix)

- Chat model: `openclaw/Qwen3.8-next`.
- 5 tasks × 2 arms × 1 repeat = 10 attempts; all 10 MEASURED and 0 runtime failures.
- Hints were present in 51 model requests of the A3 arm.
- The dense build hit the cache: 0 new embeddings.

| Task | A2 | A3 |
|---|---|---|
| INVENTORY-01 (qa) | CORRECT | CORRECT |
| INVENTORY-02 (qa) | WRONG_ANSWER | WRONG_ANSWER |
| ADMISSIONS-02 (qa) | WRONG_ANSWER | WRONG_ANSWER |
| ACCESS-03 (repair) | REPAIR_TEST_FAILED | REPAIR_TEST_FAILED |
| GSON-01 (qa) | INVALID_ANSWER | WRONG_ANSWER |

1/5 vs 1/5. This is a **wiring pilot**: n=5 with one repeat supports no A/B conclusion.

## Independent review

The review found 0 P1, 4 P2 and several P3.

| Finding | Outcome |
|---|---|
| P2-1: document redaction weaker than the preview rule; short secret values reached `search_doc_text` and the embedding input | Fixed (preview rule in `finish()`); disclosure above |
| P2-2: the key was chosen independently of the base URL, so a SiliconFlow key could go to OpenRouter and the reverse | Fixed: vendor keys are bound to their host; the string `"undefined"` is not a key; `agent-ab` no longer writes `"undefined"` into `process.env` |
| P2-3: `agent-ab` degraded a failed query embedding to "no hints" and still spent chat budget | Fixed: the run stops before any chat call |
| P2-4: the product pays storage and a rebuild for an out-of-product consumer | Accepted. Measured +2–3 % DB size; cold-build time delta **not measured**. Kept always-on: one representation source, no flag-dependent schema |
| P3: null recall crashed `compare.mjs`; scorer differences from the kit undocumented; no busy timeout on the reader; stale comments | Fixed: nulls excluded from means; `uniqueLines` and `malformedRegions` with the documented differences; `timeout: 5000`; comments updated |
| P3: READY is not quiescent during a reconcile | Documented (frozen stage; low risk) |
| P3, test gaps not closed: the `BEGIN` snapshot, the entry-script fail-closed branches (they need a live MCP session) and XML-file deletion (covered by the FK cascade) | Recorded |

## Verification

- **Full product validation** (`run-isolated-validation --profile full`, final code): 1279 + 339 pass, 0 fail (`full-validation-final.log`).
- **Sweep** (`sweep/summary.txt`, final code), all pass:
  - scripts 77/77;
  - experiments 44 + 1 skip;
  - **audit 27/27**;
  - probe 12/12;
  - both kit selfchecks;
  - `check_bundle` PASS (357);
  - kit unittest OK.
- **Real-endpoint E2E** (`EMBEDDING_E2E=1`): pass.
- **Kit and gold**: no kit, gold, threshold or harness file was changed. The `__pycache__` directories the selfchecks created were removed.

## Limits and remaining gaps (R11)

- **Unequal budget.** A3 = A2 + hints. R11's equal K10 / 160 lines / 16,000 bytes after RRF is not implemented, so no dense-vs-lexical conclusion can be drawn.
- **No region validation.** `compare.mjs` regions carry no content hash or byte cost, unlike the kit's `validate_regions`. The A2 regions are preview windows or single selection lines, so A2's low line recall partly reflects that region shape.
- **Provider cost not recorded.** The provider does not record token `usage`; only HTTP calls and item counts are reported. Total for this work: about 13.1k embedded items, 0 errors.
- **Rebuild on upgrade.** Schema v8 forces a full index rebuild on upgrade; the production install was not touched.

## Evidence hashes (`java-specialist-audit-runs/dense-input/`)

```text
898a793944e18b63b61f76d9d5d38f33b673173bc10f8163c5c1ee5dccfc1682  red-product.txt
0f2a810f7578083da5442e637f5a124c162981d19cabe7c0adc3eaad2c38c942  red-experiment.txt
6f78dcc20077bb8fdca7b7155b3554c6eee13b50ca49e3bd3b51a690778e5190  red-redaction.txt
8e5453020936e3d5a55811ed0521d42cab5635375fd4ddfded8b630edee5bedc  pilot-v2a/results-pack.json
063234d1e4fcd708c19425e6513ae64be7739d01efb30503175771d4cfa72dbf  pilot-v2b/results-pack.json
43816c59fa6a279fdb86c483c94db2f463e28a7a42b8c0ff16c89e5cffb4718b  agent-ab/results-pack.json
10e69b5ad0d2369fe08bc6fa47b7469740cbcd0f198411cbf5a92844ea41827a  full-validation-final.log
da3b0a7a0d2e959b847b78e94b2eab50875e446cd05ace7a7a91db449b36386a  sweep/summary.txt
44c527037446b4c4a19c19614a1a4d960a62c21a4d5971d1f6bf807bed5a9881  full-stage-manifest.json
```
