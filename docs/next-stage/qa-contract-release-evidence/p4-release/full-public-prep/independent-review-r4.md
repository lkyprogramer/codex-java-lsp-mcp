# FULL_PUBLIC preparation R4 independent review

Status: **PASS — CLI delta only; preparation remains NOT_EXECUTED.** No new blocking finding. R3 preparation/score review in `independent-review.md/json` remains unchanged and applies to the unchanged behavior.

Scope: `prepare-full-public.mjs` main-module guard and the one new real-symlink CLI regression. The guard now compares `fs.realpathSync(process.argv[1])` with `fileURLToPath(import.meta.url)` instead of comparing only path.resolve. A symlink invocation consequently executes argument validation rather than silently exiting successfully. Main still rejects any action other than `candidate prepare`, before writing the plan or invoking preparation; it has no model launch action.

Independent exact-delta verification: reversing only that guard expression reproduces the sealed R3 preparation SHA `f1bdd96678143a8fc0e998740536ad1f01e7d3ec772698550b31d3bf5be38aff`. Removing only the new R4 test and spawnSync import reproduces R3 test SHA `2211544b01a67e8ec1b8049a3ab12516d57da6f30f914dbf97546b38acbf5f0d`. Score module SHA remains unchanged. Thus prior repairs for candidate/judge/test hashes and failed-row denominators were not altered.

Observed raw evidence: `r4-cli-red.stdout.log` has a genuine assertion failure (subprocess exit0 instead of expected1); `r4-cli-green.stdout.log` has1/1 PASS, fail0/skip0/cancelled0. The inspected test creates a real symlink, spawns Node against that symlink with invalid-action, asserts exit1, `candidate prepare required` stderr and empty stdout. This proves the actual CLI guard path, rather than merely importing main. Invalid arguments prevent corpus work or provider requests. Reviewer read the raw evidence and recomputed all hashes in `prep-evidence-r4.json`; every hash matched. Reviewer did not rerun tests.

Final R4 binding:

- prepare-full-public.mjs: `366f5e30cb44bc24ff242d2100f731ad3e1b163163e2c92dccbc82ec7e89fff7`
- full-public-offline.test.mjs: `c2122aeaae153d89fef669e765536d8570ad82f906805cdfb8065a45a577f7bd`
- score-full-public.mjs: `31f307c3d761f24d74b9e9bd1111ab26e6e64377858d9b8c90ed7e911ade5b4b`
- green raw log: `b92155c9d0fc619856fd033168c24aa05556dc7224c4096f536e10d2084f068e`

Launch remains the parent launcher's responsibility: seal the final sourceDigest and full adapter/protocol/input/model bindings, then recheck before actual runs. This narrow review does not independently attest the parent's engineering/JDT/K-gate results, model execution, FULL_PUBLIC measurement or INDEPENDENT_LOCKED. No model, benchmark, JDT, installer, corpus scan/copy or full prep suite was run by reviewer. Existing R3 and historical evidence were preserved.
