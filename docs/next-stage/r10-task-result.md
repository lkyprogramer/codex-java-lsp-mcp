# R10 result: dense experiment cache identity, body deadline, stale safety

**State: DONE.** The experiment is repaired. Its index-backed runs are **DISABLED_INVALID**, and the entry scripts refuse to start; see Decision. The audit cases D01–D04 went from RED to GREEN, and the full audit is now 27/27. Product code (`src/`, `scripts/`) is unchanged. Base commit `463ba33`; evidence is in `java-specialist-audit-runs/r10*/`.

## What changed (`experiments/semantic-discovery/`)

### `cacheIdentity(...)` → sha256

- The input is canonical JSON of exactly these fields: `endpoint`, `provider`, `model`, `revision`, `dim`, `metric`, `representationVersion`, `declarationId`, `textHash`, `sourceManifestHash`.
- Every field is required, and unknown fields are rejected, so an API key can never become part of the key.
- When the endpoint reports no model revision, the identity uses `unversioned:<UNVERSIONED_CACHE_EPOCH>`.
- `providerIndexIdentity` is derived from the same provider identity plus the representation version and the corpus hash. It is what every hint carries.

### Dense rows

- Facts are sorted deterministically. Each declaration's document texts are joined in source order.
- `sourceManifestHash` hashes the sorted `(source path, contentHash)` pairs.
- One key per declaration, so two declarations in one file never share a vector (D01).

### Cache (`cacheFile`, layout `dense-cache/r10`)

- Records are `{key, dim, vector}`. A hit requires the key to match, the dimension to match, and all values to be finite. All hits in one build must share a dimension.
- Pre-R10 `model::path::hash` entries are always misses. The known-bad cache is never reused.
- The file is written atomically (temporary file plus `rename`) and only when entries were added. Batches finished before a later failure are kept. Keyless (query) calls never touch the file.

### Deadline

- `timeoutMs` is a total per batch, covering fetch, headers, body decode, retries and backoff (D04).
- A backoff that cannot fit is not started. That case is reported as `retry budget exhausted`, not as a timeout.
- A timeout aborts the request signal. Timers are cleared in `finally`.

### Stale hints

A hint carries a hash and a line range only when every source file of the declaration still matches its indexed hash. Otherwise it is path-only, with `startLine`/`endLine` set to `null` (D03). The range is taken only from the declaration's own file.

### `README.md`

New. It covers the status, identity, cache, deadline, and the known gaps before a pilot.

## Decision: index-backed dense input is DISABLED_INVALID

The card requires "保序normalizedText来源而不是tokens无序重建" (an ordered normalizedText source, not a rebuild from unordered tokens). The product index stores only SearchDocument **token postings**, deduplicated per document with tf counts; it does not store the ordered `normalizedText`.

The in-scope options were:

1. Persist the ordered text in the product. This needs a schema change and a full rebuild, outside R10's file list and the design's "dense only fixes the experiment".
2. Rebuild the text from source lines in the experiment. That duplicates product text and redaction logic, would not be the same representation, and risks sending unredacted text to a remote endpoint.
3. Disable the index-backed path. This is the card's stated legal alternative: "移出可执行面并标DISABLED_INVALID" (remove from the executable surface and mark DISABLED_INVALID).

Option 3 was taken:

- `readSearchDocumentFacts` throws `DISABLED_INVALID`.
- `compare.mjs` and `agent-ab.mjs` call `assertDenseRunnable()` right after their imports. They refuse before reading arguments, opening sessions, embedding or calling a model.
- Resuming the experiment requires the product to persist the ordered representation first.

## RED → GREEN

| Check | RED | GREEN |
|---|---|---|
| Audit D01–D04 (`run_audit.py --cases D01,D02,D03,D04`) | 4 FAIL (`r10-red/`) | 4 PASS (`r10-green/`) |
| Repo tests (`semantic-discovery.test.mjs`) | 6/12 fail on behavior after only the identity exports existed (`r10-red-repo-tests.txt`) | 18 pass, 1 skip (optional E2E) |

The card's four required asserts are all in `semantic-discovery.test.mjs`:
- `reloaded.vectors` equals `cold.vectors`.
- The identity differs between endpoint A and endpoint B.
- A stale hint has `startLine == null && endLine == null`.
- `bodyNeverFinishesWithinDeadline` rejects.

## Verification

- **Experiments package**: 40 pass, 1 skip (`semantic-discovery`, `repair-judge`, `ab-summary`).
- **Mutations**: 21/21 killed on the final code (`r10/mutations-summary.txt`). They cover:
  - each identity field;
  - the body deadline, the backoff bound, timer cleanup and abort;
  - finite, dimension and key validation;
  - dirty-only and partial saves;
  - multi-source staleness;
  - merge order;
  - the entry guard.
- **Final sweep** (`r10/sweep-final-summary.txt`):
  - scripts 77/77;
  - experiments 40 + 1 skip;
  - **audit 27/27**;
  - probe 12/12;
  - both kit selfchecks pass;
  - `check_bundle` PASS (357);
  - kit unittest OK.
- **Full product validation** (`run-isolated-validation --profile full`): 1277 + 339 pass (`r10/full-validation.log`). It ran on this R10 tree before the review fixes; those fixes touched only `experiments/`.
- `git diff --check` is clean. No gold, scorer, threshold, or kit file was changed.

## Independent review

The review found 1 P1, 3 P2 and 10 P3.

- **P1**: the entry scripts swallowed `DISABLED_INVALID` and would still have spent model budget. Fixed with the guard right after imports, plus a spawn test.
- **P2**:
  - The provider identity in the cache key was not covered by any test. Fixed: every identity field is required, and a cross-endpoint/revision/model test was added.
  - Whole-file JSON rewrite on every call. Fixed: keyless calls skip the file and writes happen only when entries were added.
  - `compare.mjs` `coverage()` gives whole-file credit to a path-only hint. This is a **scorer change, outside R10's files**, so it is recorded as a label challenge and an R11 prerequisite, not changed here.
- **P3, fixed**:
  - double-counted `errors`;
  - a fast 503 reported as a timeout;
  - temporary-file name collision;
  - partial batches lost on failure;
  - the request URL changed by URL normalization;
  - no assertion of the body-stage abort;
  - multi-source staleness and line ranges;
  - `declarationRows()` recomputed on every search.
- **P3, documented**:
  - `agent-ab`'s query cache key sits outside the identity (dormant behind the guard);
  - `embed` must be sequential per instance;
  - `latencyMs` counts successful attempts only.
- **Evidence**: the first mutation log showed a mutant the test was strengthened against. It was replaced by a clean run on the final code.

## Residual gaps

- No ordered dense input exists until the product persists the SearchDocument text.
- `compare.mjs` scorer: path-only hints get whole-file coverage (label challenge, R11).
- `agent-ab.mjs`: the query embedding cache key needs `cacheIdentity`.
- Dimension drift on a real provider when `dim: "auto"` is inferred only; it is untested. The query fails as a shape mismatch, and the gate falls back to A2.

## Source SHA-256 (final)

```text
2233245e41bda3fad6c218d07ca6f55d241e4a8c8f6261e2bcb641c04c2d5e91 provider.mjs
07764aca97445f988132eef94926efdb82b11250a5187da972b0e0c6b587e707 gate.mjs (unchanged)
fb4bc86c96d2ff8efe2a1dd798c9d95febc9630fc97702134add90aa79509bfb semantic-discovery.test.mjs
04b1177c5618db30ca913e41b5ab25852e2c6b36741f1b7daa32f0aa6dc51982 README.md
8336bf914e86c426d518a4d6e53d9ca863af089fdc1c467804aade0c5b92702f compare.mjs
4ba08beb77ef91e131f48b01e1637868521e4acb20331f787213be16e648d833 agent-ab.mjs
```

Evidence hashes:

```text
6e7af2dab3c31135e1af991d8099fdb618e3f32d145b79d032d5b2606a42f6b4 r10-red/counterexamples.json
12638d8d0d2a40f61b78065abc00040078eccbe1f2e381269e39ca4e3c9e76f6 r10-green/counterexamples.json
f7276fa0fcf18e1371cc7ffd01fbc0832e7c0f791234ff41fec7db6f8ff44e06 r10-red-repo-tests.txt
```
