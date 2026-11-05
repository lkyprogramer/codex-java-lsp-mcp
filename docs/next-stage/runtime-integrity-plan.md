# Runtime integrity and R12/R13 acceptance

Date: 2026-10-11 (Asia/Shanghai).
Base: 04058e43b8b2658864d0de09c8d6024e9928dfc5.
Installed release observed before work: 09b9851e888aa23a8e23162da6ec13b3501e9a75.
Deployment is outside this local repair run.

## Scope

Repair repeated-cold-build metadata loss, false READY publication and interrupted recovery; integrate the installed JDT child reaper without losing live-child lease ownership; close concrete Java syntax/dispatch defects exposed by the frozen K contracts. Keep schema v9, SQLite, Tree-sitter, bounded query worker and the five tools. Facts revision advances to 5 because stored parser/resolution facts change. Dense and declaration.range remain closed.

The current source tree is uncommitted by design. Evidence binds the base commit plus a deterministic digest of executable sources, tests, fixtures, package lock and scripts. A base commit alone does not identify this candidate.

## Acceptance

- First observe the lifecycle regressions; keep RED and GREEN logs.
- Preserve schema/identity/facts/encoding across rebuild, require completed source traversal before complete coverage, and count failed/recovered parses honestly.
- Verify complete recovery for Java and XML, sibling worktrees, real watcher events, actual SDK/MCP requests, and real JDT.
- Run the full isolated project validation, the original 27 source counterexamples and frozen bundle checks.
- Keep all K01-K32 rows, their original levels, raw hashes and unrun/failed outcomes. The generated 1000-file load profile measures the existing 150ms/20ms SLO; it does not establish capacity on every real repository.
- Independent review precedes final integration. A repaired finding is rechecked at its actual triggering boundary.
- Do not edit frozen dataset, gold, scorer, gates, audit kit or historical raw evidence.

## Model verification preregistration

Purpose: check the current candidate's model-facing tool and repair path with a real provider, and report the native/product comparison without changing either arm's prompts or scorer.
Provider/model: the owner's explicitly selected Pi model, openclaw/Qwen3.8-next. Credentials are loaded into process memory from the existing Pi configuration and never copied into artifacts.
Protocol: unchanged eval-protocol/v1.2; native tools in both arms, java_symbol only in product, same model, budgets, maxRounds=16, seed=1984.
Schedule: all 36 frozen bundled tasks, two arms, one repeat (72 scheduled attempts). This covers eight repair task groups. Rows remain in the denominator on any error. The default-model launcher was rejected by the isolation command validator before any task call; it contributes no attempt. A connection readiness request is reported separately and is not a task attempt.
The historical locked set has already been exposed. These runs are regression evidence, not an independent generalization test. Bundled-scoped and external-full evidence must not be mixed.
No embedding request is needed: the optional dense integration was removed and this run does not reopen it.
The run does not tune the product to task labels, relax typed JSON, add a new answer protocol, or claim improvement from a small score difference.

## Release decision

The frozen release verifier remains authoritative about its inventory and thresholds. Actual measured failures, unavailable independent evidence and unrun full-public/rollback gates produce NO_GO; they must not be replaced with source-test counts or hidden by a limited deployment profile. Local repair completion and full release eligibility are distinct outcomes.
