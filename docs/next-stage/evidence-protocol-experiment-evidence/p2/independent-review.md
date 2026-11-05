# P2 independent review

Status: CORE_REVIEW_PASS; confirmed finding repaired and regression evidence verified. Integrated candidate freeze / parent offline-MCP phase gate remains pending.

## Scope

Read-only P2 delta against preserved P1 candidate `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-GbDpky/candidate` (P1 sourceDigest `dc27cfbadb6466b333743681dcdb86ad099e44822cf0c93c67e85a6ae5335826`). Reviewed new evidence-unit/source-query code and tests, JavaIndex API/SQL adapter, symbol static route and MCP description, eval product profiles, source clamping/wire receipts, run-agent session mapping, and relevant parser/builder/coverage call chains. Unrelated pre-existing changes excluded.

## Confirmed finding — resolved

P2 / medium severity, high static confidence: METHOD evidence can hide FAILED XML behind READY + empty units.

Location: `src/java-index/sql/evidence-sources.ts:40-53` (particularly line 44 INNER JOIN through existing search_doc).

Trigger: a Java Mapper method remains parsed and its Java source-root coverage COMPLETE, while its intended mapper XML is malformed. `extractMyBatisMapperFacts` emits FAILED facts with empty namespace/statements. No statement documents are built, or the previous resource documents are replaced/removed. METHOD only examines resource facts reachable through existing search_doc rows; therefore it never encounters that failed resource and leaves partial=false. `publishIndexCoverage` counts Java file parse states only, so buildState can remain READY. TYPE's independent resource scan correctly returns RESOURCE_PARSE_INCOMPLETE for the same failed XML.

Impact: the new evidence contract falsely advertises a fully searched relation scope although XML evidence could not be parsed, obscuring the source deficit during both interactive retrieval and the planned experiment.

Minimal repair: include a bounded resource health/completeness check for METHOD evidence (FAILED/unreadable/capped scope must be PARTIAL), without changing broad search ranking; add a regression with FAILED mapper resource, no search_doc, and COMPLETE Java coverage. Also preserve explicit unresolved statement ranges if resource facts cannot generate a document.

Validation: static chain verified in mybatis-xml-extractor.ts, search-document.ts, index-builder/incremental.ts and progress.ts. Owner subsequently reproduced the actual damaged-XML failure in core-review-red.log, then repaired with a shared bounded resource scan and explicit missing statement ranges. Reviewer inspected those changes and the RED/GREEN raw logs. core-review-green-r2.log shows compile PASS and 15/15 tests PASS, including damaged XML/no docs, invalid facts, 257-resource cap, deadline, and duplicate statement IDs with missing ranges. No repeated reviewer build was run. Independently checked frozen SHA-256: evidence-sources.ts `1a521b7089bf921abb91e381f3262282fd9878ae164d2725fbdc42cfb11694a9`; evidence-unit.test.ts `cb144c2c0ceaf51c0ed844211718e526bf8477c8791a9ce0338fc9a1cce2f028`.

## Other reviewed behavior

No confirmed additional defect in bounded units/lines/bytes, CRLF/UTF-8 preservation, hash/realpath checks, snapshot read and post-read generation check, duplicate-FQN physical-module selection, actual retained-slice receipts, exclusive submission reuse, exact-profile parameter rejection, and explicit operation=evidence routing without JDT. Public MCP registered tool count remains five; java_evidence is an eval adapter name mapped to java_symbol operation=evidence.

Contract synchronization completed and inspected: eval java_evidence description now explicitly says indexed MyBatis XML/FQN source units, distinguishes type anchor from constructor, and describes method statement units; evaluation-protocol.json documents the three profiles and evidence receipt/source-budget behavior.

## Validation actually run by this reviewer

A pure offline Node inline probe imported boundSourceResult/serializeModelToolResult/productTools/validateProductArguments. It fed two 30-line CRLF multibyte units through shared 40-line/400-byte budget and a 900-byte model-message limit, then serialized twice. PASS: delivered 26 lines / 208 source bytes; remaining 14 lines / 192 bytes; payload 899 bytes; both units marked incomplete; repeated serialization preserved slices and remaining budget; exact-evidence rejected terms. No network/model/build/index mutation.

Existing owner r5 log inspected (not rerun by reviewer): compilation and 18/18 core/symbol tests PASS. The new METHOD failure path is covered by the owner RED/GREEN evidence above. Reviewer also ran git diff --check: PASS.

## Unrun and residual boundary

No live model, benchmark/capacity, production DB, JDT, deployment, or real local MCP process was run by this reviewer. Repaired failure-path regression is verified. Frozen integrated candidate identity and parent-run integrated offline/MCP verification remain required for the overall P2 phase gate; this review does not substitute for those checks. Filesystem-wide atomic snapshot is not promised; source hashes represent the individually read versions. Current XML semantics deliberately do not resolve aliases or all MyBatis dependencies.
