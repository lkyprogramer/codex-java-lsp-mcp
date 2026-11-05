# Independent final acceptance review

Final evidence is internally consistent. Release eligibility remains NO_GO. This read-only review inspected recorded outputs and per-case scoring; it did not rerun the experiment.

72 scheduled attempts are present and measured on openclaw/Qwen3.8-next. Product: 19/36 overall, 12/28 strict QA, 7/8 frozen repair judge, 798699 input / 13742 output / 812441 total provider tokens. Control: 20/36 overall, 13/28 QA, 7/8 repair, 563402 input / 17556 output / 580958 total tokens. QA success agrees with frozen scoring row by row. Real repair success is independently judged. The temporary derived token summary was corrected to use promptTokens/completionTokens; source usage was unchanged. There is no demonstrated quality or token-saving benefit; one repeat cannot establish statistical equivalence or degradation.

Mandatory disclosures:
- Only GSON-01 differs in success: product false, control true.
- Both ACCESS-03 attempts ended FORCED_ANSWER, made no code edits and failed frozen repair tests.
- Product ADMISSIONS-03 passes the independent candidate repair judge but has one stale/absent region content hash in the frozen structured-evidence report. Not all structured evidence is valid.
- K matrix is31 PASS/1 FAIL. K29 c20P95=268.585ms violates150ms; same-host base268.696ms does not waive the threshold.
- QA floor, independent locked and full-public gates are unmet. Isolated install rollback, production install/rebuild/deployment are unrun.

The actual passing JDT artifacts are real-jdt-verified.log and its jdt-evidence.json, accepted by K26/K28 with matching candidate digest. The earlier two failures are retained as acceptance-driver correction records. Final acceptance-script tests18/18 pass. The605 final file hashes match the candidate. No production drift found.
