# Task 29 Framework Adapters Validation

## Decision

MapStruct is registered after its real-repository canary passed. JPA remains implemented but unregistered because the available real repositories do not establish counterfactual value. Lombok completeness remains result-level metadata/gap logic and does not create synthetic candidate edges.

## Correctness changes

- `@Mapper(config=...)` and `imports=...` class literals do not emit `MAPSTRUCT_USES`; only the `uses` attribute is parsed.
- A structurally discovered non-anchor mapper exposes only mapping methods whose parameter/return types touch the task anchor.
- MapStruct activation uses bounded request facts instead of a whole-store marker scan.
- `MAPSTRUCT_USES` survives lexical tail trimming but cannot make the final candidate list exceed `candidateLimit`.
- Spring, MyBatis, JPA and MapStruct recognize normalized `STATIC_STRUCTURE` signals before family scores are materialized.
- JPA derived-query evidence requires `<prefix>By<UppercaseProperty>`; `findAll` and `getFoo` are excluded while `findByCustomerId` remains.
- Lombok completeness reuses the JDT session's generated-code snapshot and checks selected read-plan collaborators as well as anchors.
- `generatedSemantics` and a task-relevant Lombok advisory remain visible in compact, standard and diagnostic output.
- Cold partial declaration lookup foreground-refreshes only bounded, exact conventional FQN paths before retrying once.

## Validation

- Direct TypeScript compile: pass.
- Task 29 targeted adapter/router/benchmark tests: 60/60 pass before registration.
- Candidate-limit regression plus ranking integration: 25/25 pass.
- Registered MapStruct/provider/ranking tests: 42/42 pass.
- Stable full regression after registration: 608/608 pass:
  - non-AgentRouter stable batch: 162/162;
  - isolated `rg-runner`: 13/13;
  - AgentRouter: 177/177;
  - JavaIndex/runtime/benchmark: 256/256.
- All tests used `JDTLS_BIN=/usr/bin/false` and `JAVA_LSP_FILE_WATCH=0`; no active LSP was started or restarted.

## Three-repository canary

The matrix used three alternating rounds with five runs per cell, `cold-nolsp`, separate caches and COMPLETE JavaIndex coverage.

| repository | median P95 off | median P95 on | ratio | recall off → on | P_read off → on | R_read_must |
|---|---:|---:|---:|---:|---:|---:|
| lishuedu | 212.85 ms | 219.33 ms | 1.030× | .743 → .826 | .722 → .722 | 1.0000 |
| cipherlink | 95.19 ms | 96.04 ms | 1.009× | .896 → .896 | .667 → .667 | 1.0000 |
| exam-parent-v3 | 123.41 ms | 123.28 ms | 0.999× | .900 → .900 | .667 → .667 | 1.0000 |

The manually verified `SchoolTemplateImportAssembler uses={IdConverter.class, DateTimeConverter.class}` scenario improved recall from 0.5 to 1.0. Across its 15 attempts, MapStruct added 30 candidate/golden hits; it did not claim a read-plan gain for that scenario. Across all lishuedu scenarios, the adapter produced 105 selected, 15 read-plan and 45 golden observations.

## Evidence limitations

- Canary off/on worktrees shared source HEAD `71f8c5b` and differed only by the registration import/list entry, but the generated `dist/build-stamp.json` was absent and raw files record `runtimeBuild.gitSha=unknown`. The source/diff boundary is known; the artifacts alone are not a cryptographically stamped runtime build.
- Benchmark preparation completed every source root before impact sampling. The cold-partial exact-FQN retry is validated by a direct integration regression, not by these P95 cells.
- The partial-FQN retry performs at most 512 exact existence checks; multi-root cap/deadline stress remains a documented follow-up.
- JPA real-repository quality/cost is unmeasured, so it is deliberately not in `FRAMEWORK_ADAPTERS`.

Raw evidence is under `artifacts/v3-phase4/task29-mapstruct-canary-20260801/`; cache snapshots are intentionally excluded from version control.
