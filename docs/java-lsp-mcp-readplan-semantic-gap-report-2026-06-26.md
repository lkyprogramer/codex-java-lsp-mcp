# readPlan semantic gap optimization report (2026-06-26)

## Conclusion

Task 1/2 solved the actionable regression: `warm-required` keeps the semantic recall gain while restoring `R_read_must=1.0000`. Tasks 3-5 were not executed because the acceptance gate was already met without adding SourceIndex graph scans, signature type-reference edges, or cross-module penalty exemptions.

## What changed

- `src/agent-router/index.ts`
  - Builds a non-LSP readPlan baseline after typeGraph + rg and before any LSP semantic collection.
  - Moves `collectSemanticSeed()` behind that baseline so `definition/implementation` candidates cannot redefine the baseline.
  - Passes protected non-LSP readPlan paths through `finalizeRank()` so tail truncation cannot drop them.
  - Makes `buildReadPlan()` protected-aware: protected baseline files fill guaranteed slots first, then remaining slots can still be filled by higher-value LSP semantic candidates; final output is sorted by normal `(priorityRank, score)`.
- `src/agent-router.test.ts`
  - Adds a regression test proving required semantic candidates cannot evict `StorageGateway` contract neighbors from readPlan.
  - Extends `FakeSemanticSession` to return semantic implementation locations.
- `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`
  - Adds the 2026-06-26 readPlan semantic overflow verification table.

## Review claims

Accepted:

- `warm-required` semantic recall is useful, but the previous fixed readPlan capacity made it non-adoptable because must-read baseline neighbors were evicted.
- "Pre-semantic" must mean before all LSP semantic collection, including `collectSemanticSeed()`, not only before `semanticVerify()`.
- The minimal fix is preserving non-LSP readPlan slots, not widening `candidateLimit`, `readPlanMaxItems`, or changing public MCP contracts.

Corrected / not adopted:

- `warm-auto` zero gain is not proof that `references` or `typeHierarchy` are ineffective; it is primarily a semantic gate/profile coverage issue and was not widened in this change.
- A broader offline graph was not needed for this gate. Full implementer scan, signature type-reference facts, and cross-module semantic exemptions remain conditional follow-up work.
- SQL/test/config side evidence remains diagnostic-only and is not part of the readPlan hard gate.

## Commands run

```bash
git switch -c codex/readplan-semantic-gap-optimization
npm run build
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --list-scenarios
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/lsp-lishuedu-cold-nolsp-diagnostic.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-auto --strategy impact --runs 5 --verbosity diagnostic > /tmp/lsp-lishuedu-warm-auto-diagnostic.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/lsp-lishuedu-warm-required-diagnostic.json
node --input-type=module <<'NODE' > /tmp/lsp-lishuedu-semantic-gap-table.tsv
// Task 0 semantic gap classifier from docs/superpowers/plans/2026-06-26-readplan-semantic-gap-optimization.md
NODE
npm run build && node --test --test-name-pattern="required semantic candidates do not evict non-LSP read plan neighbors" "dist/**/*.test.js"
npm run build && node --test --test-name-pattern="required semantic candidates|semantic verify|port recall" "dist/**/*.test.js"
npm test
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "fix(router): protect readPlan baseline from semantic overflow"
npm run build
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/lsp-lishuedu-after-readplan-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 > /tmp/lsp-lishuedu-after-readplan-warm-required.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/lsp-lishuedu-readplan-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/lsp-cipherlink-readplan-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/lsp-exam-readplan-cold.json
git add docs/java-lsp-mcp-benchmark-guide-2026-06-23.md
git commit -m "test(router): verify semantic readPlan overflow fix"
npm run build && npm test
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/final-lishuedu-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/final-cipherlink-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/final-exam-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 > /tmp/final-lishuedu-warm-required.json
node --input-type=module <<'NODE' > /tmp/lsp-lishuedu-semantic-gap-table-after.tsv
// Same Task 0 semantic gap classifier, rerun after the router change
NODE
./install-runtime.sh
./check-codex-mcp.sh --fast
```

The first focused test command failed before the implementation, as expected, because `StorageSignedUrlCommand.java` was evicted from readPlan. The same focused pattern passed after the router change.

## Final validation

Unit/integration tests:

```text
npm run build && npm test
62 tests
58 pass
4 skip
0 fail
```

Benchmark metrics:

| project | warmState | recall | precision | P_read | R_read_must | elapsedMs | total payload | estimatedTokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| lishuedu | cold-nolsp | 0.7756 | 0.4127 | 0.8000 | 1.0000 | 18.07 ms | 18432.24 B | 4608 |
| lishuedu | warm-required | 0.8256 | 0.4049 | 0.8000 | 1.0000 | 705.89 ms | 19047.60 B | 4762 |
| cipherlink | cold-nolsp | 1.0000 | 0.5455 | 0.8333 | 1.0000 | 6.25 ms | 10126.20 B | 2532 |
| exam-parent-v3 | cold-nolsp | 1.0000 | 0.5833 | 0.6667 | 1.0000 | 7.91 ms | 13368.20 B | 3342 |

Install/runtime checks:

```text
./install-runtime.sh
Registered Codex MCP server: codex-java-lsp
Runtime installed at: /Users/luo/Library/Application Support/codex-java-lsp-mcp

./check-codex-mcp.sh --fast
READY: codex-java-lsp checks passed with 0 warning(s).
```

Note: the final warm-required benchmark emitted one `textDocument/implementation` timeout log, but the benchmark completed and the final JSON totals passed the gate.

## Gap classification

Before the fix:

| scenario | hard gap |
|---|---|
| StorageGateway#getSignedUrl | No must-hit readPlan gap; all 5 must files were already in readPlan. |
| ReportBatchExportTaskRepository#findReusableReadyZip | 3 must files were in `files` but not `readPlan`: `ReportBatchExportTaskRepositoryImpl.java` (`seed`), `ReportBatchExportTaskDO.java` (`rg`), `ReportBatchExportTaskMapper.java` (`rg`). |
| ParentStudentBenefitItemResponse.productCode | No must-hit readPlan gap; `ProductView.java` remained a should-hit outside readPlan and side test evidence stayed diagnostic-only. |

After the fix:

| scenario | hard gap |
|---|---|
| StorageGateway#getSignedUrl | All 5 must files in readPlan. |
| ReportBatchExportTaskRepository#findReusableReadyZip | All 4 must files in readPlan. The previous 3 missing must files are now protected baseline entries. |
| ParentStudentBenefitItemResponse.productCode | All 3 must files in readPlan. Should/side gaps remain non-hard-gate diagnostics. |

## Known limits

- No method-call graph was added.
- No full-repo implementer scan was added.
- No signature type-reference routing was added.
- No default `warm-auto` profile widening was added.
- Side SQL/test/config evidence remains out of the hard readPlan gate.
- `warm-required` remains an optional precision/recall enhancement; cold path behavior is unchanged for public defaults.
