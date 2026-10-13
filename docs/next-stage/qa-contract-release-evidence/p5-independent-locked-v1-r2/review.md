# Independent holdout freeze private review — public receipt

Status: **PASS — r2 freeze approved before first model request.** This approves the new input freeze and owner boundary only. It does not claim a measured INDEPENDENT_LOCKED gate, model success or release eligibility.

The private review covered9QA and3repair tasks with12 new IDs in3 newly authored corpora. No ID overlaps the original36-task set. The original exposed set remains regression; this supplement does not overwrite or replace its tasks, gold, scorer, gates or history. The reviewer did not send private gold, expected values, required-source coordinates, reference changes or private test contents to the parent or executing runner.

## Frozen identity

- Public freeze SHA256: `0f1faaab3dfecc2b53bc59b24dc7a0b29037547696996d330f87c654e35a2528`
- Public owner-interface SHA256: `82133f37fd2197de71dcece7f03586e580e57dc80a4efe0b3de9483fee0340ad`
- Private manifest SHA256: `dd3b011017a028b920a1ed86033870e26b5146414115ef21387865cc8cb60748`
- Owner seal: `259a0d158e1fc300f3533816769ad2e304ef98ca996a9d1d7b24b8872d9248d7`
- Frozen private input count:79 files; original copied harness/schema files checked:18, all byte-identical to original counterparts.
- Fixed candidate sourceDigest: `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`,611 source-identity files.

Reviewer independently recomputed the private scoped inventory and all public frozen-file hashes. Inventories and public/private source copies match. Frozen scopes include kit, pre-model-validation and owner-engine; the manifest/seal are not recursively included in their own content hash. Later runtime and review outputs are outside the immutable input scopes. Private owner directory permission is0700.

## Semantic and evaluator checks

- Read the private questions, gold, source implementations, evidence ranges and public field-role constraints. All9QA values and required evidence are consistent with the actual source and declared representations. Public schemas specify roles/types/representations without distributing expected answer literals or private source coordinates.
- Read the retained pre-model proof: actual Java compilation and invocation plus source/XML extraction support the9QA labels. Frozen dataset validation has zero errors. These are input-authoring checks, not candidate/model trials.
- Read all3repair specifications, restricted edit policies, frozen tests and reference changes. They cover their requested normal/failure/boundary behaviors. Retained original-judge proofs show compilation exit0 followed by business AssertionError failures for all3 original inputs, then reference PASS with validated success for all3. This is reference-oracle validation, not a claim of actual agent repair.
- One initial declaration-target metadata inconsistency was reported privately to the owner and corrected only in the new r2 version. The reviewer verified the correction. Answers, required evidence, all source files and private tests remain byte-identical to the retained first version. No candidate/model attempt occurred between versions according to the owner record; neither version's original artifacts were overwritten.

## Owner boundary checks

The public interface exposes only metadata, verifyFrozen, synchronous score and asynchronous judge. Score delegates to the unchanged original scoreWithFrozenKit; judge delegates to the unchanged original evaluateRepair. The private engine verifies the fixed79-file scope and candidate identity before and after both operations. Public source/task/contract hashes are also checked. The candidate helper imports are bound to the frozen611-file identity; owner-engine itself is inside the private seal.

The initial judge temporary-artifact concern was repaired in r2. Original judge execution, temporary Java sources, raw diagnostics and complete original verdict now stay beneath owner-created0700 runtime directories. Public receipts retain status, candidate/test/artifact hashes, process exits and completion guards; argv/stdout/stderr contents and private reference/test sources are not copied out. Public diagnostic reasons are state-only. This preserves the original judge's success semantics while reducing accidental exposure on error/timeout paths. Private runtime is excluded from frozen input scopes so execution cannot self-invalidate the dataset seal.

Observed narrow interface evidence: reviewer called the public verifyFrozen and received PASS with the expected79-file seal; score is synchronous, judge asynchronous. An empty score request was rejected with the expected argument error and produced no output directory. This was read-only provenance/argument validation, not candidate tool, model, score or judge execution. Actual score/judge delegation behavior was inspected in code and supported by the unchanged original helper semantics; no new candidate repair or model trial was performed for this review.

The0700 directory and restricted public API prevent accidental distribution and separate roles; they are not an OS sandbox against another process running as the same macOS user. Model-visible tools and the executing agent must continue to use only public corpora/tasks/contract and safe owner results. No private files should be copied into attempt workspaces or model messages.

## Remaining execution boundary

The parent may now seal the24 planned original keys for this supplement (12 tasks×two arms, one repeat) against this exact r2 identity and fixed candidate/configuration before the first model request. Recheck both the public launcher binding and owner seal around execution. Preserve every failed, blocked or missing planned attempt; do not tune the candidate, labels, tests or prompts from interim scores, and do not silently retry a failed row. Any frozen input correction requires a new version and renewed review, retaining this history.

Report the supplement separately from the exposed original dataset. Three authored corpora and24 attempts do not establish production incidence or broad statistical generalization. Real per-case model/source/usage/candidate/judge evidence and final audit remain required before assigning INDEPENDENT_LOCKED PASS. The original overall release quality and performance gates remain unchanged.

Reviewer did not modify source/kit/gold/gates, rerun Java tests, launch candidate tools/JDT, call a model, benchmark or installer. Only this public redacted review and its JSON receipt were written.
