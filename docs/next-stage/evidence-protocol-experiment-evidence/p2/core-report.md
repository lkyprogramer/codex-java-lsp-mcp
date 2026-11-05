# P2 source evidence core

Status: r5 implementation frozen for independent review; offline validation PASS.

Owned changes:
- src/java-index/java-index-client-api.ts: required experimental queryEvidenceSources and typed generation/anchor/source contract.
- src/java-index/sql/sql-client.ts: adapter to new snapshot reader. Pre-existing changes retained.
- src/java-index/sql/evidence-sources.ts: one WAL snapshot; fresh facts store, bounded point-document/resource scans and dedup of path/hash/range. Complete-FQN resultMap links without Mapper; missing/unqualified type spellings explicitly RESULT_MAP_TYPE_UNSUPPORTED/PARTIAL (no alias guesses); duplicate FQN requires unique physical same-module visibility. METHOD retains only XML resource documents, independent of declaration winner.
- src/discovery/evidence-unit.ts: exact UTF-8 whole LF/CRLF lines with content hash and anchor hash checks, realpath containment, file identity consistency, secret-sensitive source omission, bounded 8 units/80 lines/16000 delivered bytes; complete describes only the full original source range. Partial ranges expose actual endLine and originalEndLine. DB generation rechecked after asynchronous reads; buildState/source root coverage guards empty readiness.
- src/discovery/evidence-unit.test.ts: real Java parser and SQL fixtures; no frozen corpus changes.

The public supportedScope is indexed-mybatis-xml-fqn-links. No writes in the query path. No new persisted schema, no discovery default/ranking changes, no JDT, no production/live DB or model requests.

Verification commands:
1. sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test dist/discovery/evidence-unit.test.js
   core-test.log: compile PASS; 7 PASS / 1 FAIL. Failure was fixture comparison of naturally variable query trace timestamps; source/entity behavior unchanged.
2. sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test dist/discovery/evidence-unit.test.js dist/java-index/sql/facts-store.test.js
   core-test-r2.log: compile PASS; 12/12 PASS.
3. Same command after actual DeadlineBudget, XML-only scope and coverage checks.
   core-test-r3.log: compile PASS; 13/13 PASS.
4. sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test dist/discovery/evidence-unit.test.js dist/tools/symbol-static.test.js
   core-integration-r4.log: compile PASS; 17/17 PASS, including explicit evidence static routing/no JDT. Executable tree 83baf282b268e483c5aadf3cbd9cb448f29e90f2.
5. Same core+symbol-static command after adding supportedScope and unsupported-alias fixture.
   core-integration-r5.log: compile PASS; 18/18 PASS.
6. git diff --check -- src/java-index/java-index-client-api.ts src/java-index/sql/sql-client.ts src/discovery/evidence-unit.ts src/discovery/evidence-unit.test.ts src/java-index/sql/evidence-sources.ts
   PASS.

Critical success: Receipt -> XML resultMap lines 2-4 (CRLF byte exact), no Mapper and no statements. METHOD baseline query entity/result/counters unchanged while two XML provenance ranges remain deliverable.
Critical failure: changed Java or XML hashes are rejected; foreign symlink sources omitted; incomplete coverage/parser/bounded scan returns PARTIAL; mixed DB generation delivers no units. Real second connection publishes generation 2 during query, first snapshot stays generation 1 with old resource facts, subsequent query observes generation 2.

Limits/unrun: MyBatis type alias/full XML field semantics not interpreted; only complete FQN links supported. Resource scans cap 256 rows and 64 duplicate types/documents; each compressed resource <=65536 bytes/inflated <=262144 bytes. Source file hash reads bounded at 2 MiB/file. Large/incomplete scopes remain PARTIAL. Live performance, real model source costs and production acceptance not run. No filesystem-wide transactional snapshot claimed.

## Independent review repair

Confirmed defect: METHOD queries used the search_doc join as an exhaustion proof. Failed XML parser facts lose namespace and statements; the builder removes its XML documents, while Java coverage can stay READY. This caused false READY empty METHOD evidence.

RED: isolated targeted test `--test-name-pattern='METHOD damaged' dist/discovery/evidence-unit.test.js` reproduced actual READY vs expected PARTIAL using real malformed Mapper XML; raw core-review-red.log.

Fix: TYPE and METHOD share one bounded resource-fact generator under the same DB snapshot. Failed parse, bad/oversized facts, resource cap and deadline become explicit partial reasons for both. Bounded decoded JSON requires the consumed resource shape; a deflated null fact cannot silently vanish. METHOD additionally reports SOURCE_RANGE_UNRESOLVED for namespace/name-associated statement facts lacking a parser range. No alias binding is guessed; METHOD source documents do not claim resultMap-type resolution.

GREEN commands: sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test dist/discovery/evidence-unit.test.js
- core-review-green.log: compile PASS, 14/14 PASS.
- core-review-green-r2.log: compile PASS, 15/15 PASS; includes damaged Mapper/no docs, invalid raw and deflated-null facts, scan cap/deadline, real duplicate statement IDs with no located ranges.
- Relevant git diff --check PASS.

Post-repair owned source hashes in core-files.sha256. Frozen for reviewer and parent's integrated kept-candidate verification. No live/system/global-index behavior changed.
