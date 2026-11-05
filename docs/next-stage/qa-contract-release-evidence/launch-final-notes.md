# Final launcher offline implementation

Status: IMPLEMENTED_OFFLINE_ONLY. Real prepare, drycheck, provider requests, frozen scorer execution, benchmarks, whole-suite builds, installer and deployment were not run by this author.

`launch-final.mjs` is outside the repository and does not modify the original launcher, old helper, frozen inputs or candidate source. It reuses original `buildPlan` / `pendingScoringRows`, original helper `verifyKit` / `measuredSession`, real `runLiveEvalRun` with default repair judge, and original `assemblePack`.

| phase | original schedule | new stage |
|---|---:|---|
| qa | 28 tasks × two arms = 56 | p4-release/final-qa |
| repairs | 8 tasks × two arms = 16 | p4-release/final-repairs |
| public | original QA plus repair = 72 | p4-release/full-public-new |

Each stage contains preregistration.json, schedule.jsonl and a new run/ directory. Each run slot has its own block/session/workspace/candidate and original raw tool/model/source artifacts. Existing stage and run directories are never overwritten.

prepare/drycheck import and verify static inputs only; they never read Pi credentials or invoke runLiveEvalRun. Real prepare is intentionally not performed yet. All actions require P1/P2/P3 PASS, current state.p4Candidate identity, original single-worker performance PASS, final engineering PASS bound to that digest, and final independent public preparation module/review seal. The historical state.sourceDigest remains untouched.

Binding includes candidate source/file-set identity, original 150-file kit content/file-set, frozen 36-row task and gold universe, original launcher/helper and all preparation .mjs hashes, versioned public contract, protocol, evaluator/adapter, native/product/submission schemas and unchanged model/config. Configuration remains openclaw/Qwen3.8-next, broad, production default worker, max_tokens 2048, none, thinking false, 16 rounds and ordering seed 1984; provider sampling seed is null.

Scoped QA/repair use the original per-block frozen scorer. Public uses fullPublicPreparation/fullAttemptOptions and full repository roots, then calls scoreFullPublic once on all 72 actual original boundary rows. It does not call the scoped scorer for public. Corpus validation checks exact 2533-file set/hash, frozen fingerprint and upstream commit/clean/seed provenance before and after execution/scoring; changing completion timestamps are excluded from corpus equality. QA retained success remains null until frozen scoring accepts the raw clone. Original live-runs are preserved before scoring.

NO_SUBMISSION, failed typed submission, runtime failure and blocked/rejected states returned by the original boundary remain ordinary scheduled rows. Internal errors, scorer authority failure and candidate/input drift stop execution and persist original planned missing rows without inventing answers or success. byArm separates QA and repair scheduled/actual/missing/measured/success denominators. Provider usage remains original measured usage; wall time is recorded separately. Exposed original tasks are regression, not independent locked evidence.

Offline tests: `node --test ROOT/launch-final.offline.test.mjs` passed 9/9. Tests use original plan/pack helpers and explicitly fake live/scorer callbacks with no provider/session. They cover 56/16/72 plans, frozen task/gold identity, new-versus-historical digest, engineering/prep gate drift, corpus timestamp normalization, normal failure retention, scorer failure pending-null, internal fatal missing denominator, public aggregate-only scoring, and distinct QA/repair denominator accounting. These tests do not establish real model or scorer results.

After the parent seals actual engineering and preparation PASS, commands are:

```sh
node ROOT/launch-final.mjs CANDIDATE prepare qa
node ROOT/launch-final.mjs CANDIDATE drycheck qa
node ROOT/launch-final.mjs CANDIDATE run qa
node ROOT/launch-final.mjs CANDIDATE prepare repairs
node ROOT/launch-final.mjs CANDIDATE drycheck repairs
node ROOT/launch-final.mjs CANDIDATE run repairs
node ROOT/launch-final.mjs CANDIDATE prepare public
node ROOT/launch-final.mjs CANDIDATE drycheck public
node ROOT/launch-final.mjs CANDIDATE run public
```

The author has not run these commands. Independent preflight/review must assess the frozen launcher, final preparation seal and actual candidate before the parent starts authorized model execution.

## R2 CLI entry correction

Independent reviewer found that path.resolve(argv[1]) differs from canonical import.meta.url on macOS /var -> /private/var and symlink execution, causing silent exit zero. The final launcher now uses fs.realpathSync(argv[1]) against canonical launcherPath. A real symlink CLI invalid-arguments test reproduced exit zero before the fix (launch-final.cli-red.tap) and exit one with the required business validation message afterward (launch-final.cli-green.tap). No provider configuration was opened. Cumulative offline tests passed 10/10 in launch-final.offline-r2.tap; the original nine-test log remains unchanged.

Final launcher SHA-256: 93439e4c6ecd08742eaf281abbf7d42d7a467f8bada2d05eff9b56d66a4d82d1.
