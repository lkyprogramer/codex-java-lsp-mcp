# R04 — 修复判定器复用、候选物化和可搬运测试

**Status**: GREEN

{
  "schema": "java-specialist-r04-task-result/v1",
  "status": "GREEN",
  "date": "2026-10-08",
  "source_head": "b58d3f1446a9012296e657d031755a8fb5e26e40",
  "red": {
    "command": "python3 docs/java-specialist-release-audit-v1.1/tools/run_audit.py --project $PROJECT --output \"$RUNS/r04-red\" --cases J01",
    "baseline": "b58d3f1 worktree (pre-R04 repair-judge.mjs)",
    "result": "1/1 FAIL — 旧 judge 报告 passed=true / status=PASS，而 diffReport.removed=[src/A.java]：候选删掉的 allowed 源文件被 pristine 副本静默恢复",
    "counterexamples_sha256": "d1ecd5bf91d097aa19bd74f5894fa66fa40aeee35bc6fc18aefd9d5b7a4effec"
  },
  "green": {
    "command": "python3 docs/java-specialist-release-audit-v1.1/tools/run_audit.py --project $PROJECT --output \"$RUNS/r04-green-j01\" --cases J01",
    "result": "1/1 PASS，exit 0（status=REJECTED_MISSING_ALLOWED_FILE，passed=false）",
    "counterexamples_sha256": "7773f01d7584e83256fa7f138109d99f13507aeb84a96f9019aea7322f928369",
    "full_suite": "python3 … --output \"$RUNS/r04-green\"：27 例 12 PASS / 15 FAIL / 0 ERROR，剩余 15 例属 R05–R09 边界，未回退",
    "full_counterexamples_sha256": "53a8054a0ba394386705605e4e7862c570c6e75d13bded0bfa73405cc34d0a94",
    "run_json_sha256": "4662ffc39b74ada501d37319ca849167a0aadc0c63af39d666130274b0159739"
  },
  "interface": {
    "evaluateRepair": "scripts/eval-repair-adapter.mjs -> evaluateRepair({kitRoot,taskId,mode,candidateRoot,outputRoot,timeoutMs,python,javaHome}) => {state, validatedSuccess, judgeArtifact, policy, toolchain, judgeArtifactPath, python}",
    "validated_success_source": "唯一来源是原 Python frozen judge：python -m harness --dataset <kit>/dataset repair --task ID --mode … --output <artifact>。适配器不自行判定“通过”，只做候选策略预检、进程边界和状态包装；JS judge 只是无 Python 时的离线兜底，且与适配器共用同一策略实现。",
    "states": "VALIDATED_SUCCESS / TEST_FAILED / COMPILE_FAILED / REJECTED_MISSING_ALLOWED_FILE / REJECTED_DISALLOWED_EDIT / REJECTED_UNSAFE_PATH / MISSING_RECEIPT / TIMEOUT / OUTPUT_LIMIT / BLOCKED_ENV / BLOCKED_SETUP / JUDGE_ERROR",
    "cli": "node scripts/eval-repair-adapter.mjs --kit-root DIR --task ID --output DIR [--mode candidate|reference|baseline] [--candidate DIR] [--timeout-ms N] [--python python3] [--java-home DIR]；exit 0=validated success，1=判定失败，2=环境/装载阻塞"
  },
  "mechanism": {
    "candidate_materialization": "stageCandidateTree：pristine fixture 全量拷贝 + 只覆盖 allowed_edits 里候选实际存在的文件；候选删掉的 allowed 文件在工作区里同样被删除（staged.deleted），绝不把 pristine 副本复制回去冒充候选。",
    "policy_diff": "diffCandidateTrees 用 lstat 走全树 + sha256 逐文件比对：missingAllowed（删除 allowed 文件）、violations（allowed_edits 之外的 changed/added/removed）、symlinks/other（非普通文件，永不跟随）。JS judge 与适配器共用这一个实现，不存在两套口径。",
    "process_bounds": "runBounded：argv 数组（永不 shell 拼接）、总输出 128KiB 上限（超限即杀进程树并记 OUTPUT_LIMIT）、绝对 timeout、子进程自成一个进程组并用 kill(-pid) 清理整棵树。",
    "receipt": "JS judge 的完成回执带 nonce，内容必须逐字节匹配；JVM exit 0 但回执缺失/不匹配 = MISSING_RECEIPT，不算通过。",
    "toolchain_gate": "probeJavaToolchain 先跑 javac -version：不可运行、低于 JDK9、或不支持 --release <java_release> 一律 BLOCKED_ENV；frozen judge 编译期出现 release 不支持也重分类为 BLOCKED_ENV，不用 COMPILE_FAILED 冒充业务 RED。",
    "portable_roots": "agent-ab.mjs / compare.mjs / repair-judge.test.mjs 的 KIT、STAGE、SERVER_JS、OUTPUT、CACHE、TASKS、GOLD 全部来自 --flag 或 env（缺参直接报错），或从 import.meta.url 相对定位；五个文件里没有任何个人绝对路径，测试用断言把这条锁死。"
  },
  "boundary_tests": [
    "deletedAllowedFile.passed === false 且 status=REJECTED_MISSING_ALLOWED_FILE；judgeWorkspace.containsRestoredDeletedFile === false（staged.deleted 记录删除）",
    "pristine.compile.exit_code === 0 且 pristine.run.stderr 含 AssertionError（8 个冻结 repair 任务逐个验证 RED）",
    "reference.validated_success === true 且 frozen_test_sha256 与 RED 臂一致（8 个任务逐个验证 GREEN，判定器来自原 Python run_repair）",
    "allowed_edits 之外的新增/删除/改动 → REJECTED_DISALLOWED_EDIT（JS judge 与适配器同结论）",
    "候选内 symlink 指向 /etc/hosts → REJECTED_UNSAFE_PATH，不跟随",
    "缺 javac（javaHome 指向不存在目录）→ BLOCKED_ENV，且记录里没有 compile 结果",
    "JVM exit 0 但无 nonce 回执 → MISSING_RECEIPT，passed=false",
    "64×8KiB stdout → OUTPUT_LIMIT，捕获字节数不超过 128KiB",
    "挂死测试（主线程 + 非守护线程循环）→ TIMEOUT，pgrep 验证 -cp 路径下无残留 java 进程",
    "全部判定跑完后冻结 fixture 语料的 tree hash 与开跑前逐文件一致（judge 不写冻结输入）"
  ],
  "portability": {
    "scratch_dir": "mkdtemp 目录名含空格：'repair judge with spaces XXX'；测试内所有 workDir/candidate 路径都含空格",
    "eight_runs": "在 \"$RUNS/r04 portability/run 01 with spaces\"（checkout 之外、含空格）连续 8 次 node --test experiments/semantic-discovery/repair-judge.test.mjs：8/8 exit 0，每次 19 pass / 0 fail",
    "kit_root": "JSB_KIT_ROOT 覆盖 kit 根；未设置时从 import.meta.url 相对定位到仓库内 baseline-kit"
  },
  "regression": {
    "audit_counterexamples": "27 例：12 PASS / 15 FAIL / 0 ERROR（J01 由 FAIL 转 PASS；D01–D04、Q01–Q09、N01、P01 仍为后续任务的预期失败）",
    "source_probe_12": "12/12（docs/java-specialist-devkit-v1/adapters/probe-source.mjs --project .，日志 sha 1e06c9b35626068ff677655b41b64a89dfdca6da02d0514dec2ee8e9fcf30d60）",
    "frozen_selfcheck": "5/5 passed=true，summary.json sha 5f6f4cb1412546249221239568a57fa3dbb176a8a209d266967e466d56dcbc02（与 R01 记录逐字节相同，冻结自检未回退）",
    "scripts_unit_tests": "63/63（eval-native-tools 5 + evaluate-java-task 10 + eval-frozen-adapter 13 + run-agent-trace-live 27 + eval-tool-wire 8）",
    "experiments_tests": "experiments/semantic-discovery：28 例 27 PASS / 0 FAIL / 1 SKIP（EMBEDDING_E2E 未开），repair-judge.test.mjs 已并入 package.json 的 test 脚本",
    "build_isolated": "npm run build:isolated exit 0（日志 sha bf82514d0df6f48053796ec66ac8fd641f7b993d6a480f08bb6cb72354c8b592）",
    "npm_test": "npm test exit 0：1199 + 322 PASS / 0 FAIL（日志 sha 57ff4f62f789555b36dadf1dd748f9303e1b821c509ff337125a659b8a7f1531）",
    "basis_caveat": "build:isolated 与 npm test 走 detached local clone，克隆的是 HEAD b58d3f1，即 R04 改动提交前的产品树；R04 只改 scripts/ 与 experiments/，产品编译不消费这两个目录，工作树上的 63/63 与 28 例已覆盖改动面。"
  },
  "also_touched": {
    "agent-ab.mjs": "改用 evaluateRepair（frozen-python-bridge），只有 BLOCKED_ENV/BLOCKED_SETUP 才退回 JS 离线 judge 并记 judgeImplementation；BLOCKED 的 attempt 记 taskOutcome=BLOCKED、taskSuccess=null，留在分母里不计入成功率。顺带修掉 HEAD 上就存在的结构性错误：per-task 循环被提前闭合导致汇总段落在模块作用域，运行即 ReferenceError: byCorpus is not defined（已用 node --check 与实跑验证修复）。",
    "compare.mjs": "KIT/STAGE/SERVER/OUTPUT/CACHE 改为 CLI/env，补 fileURLToPath import；缺参时报明确 usage 而不是写到某个人的家目录。",
    "kit_untouched": "git status 对 docs/java-specialist-release-audit-v1.1 为空：dataset、harness、schemas/gates.json、evidence、tools/audit-regressions.mjs 均未改动，PYTHONDONTWRITEBYTECODE/PYTHONPYCACHEPREFIX 保证冻结 kit 里不落 __pycache__。"
  },
  "remaining_gaps": [
    "真实 repair 由 agent 修改候选（A2/A3 四臂 LIVE）未运行：需要模型预算与授权，属 R10/R12；本任务只用 reference 验证 judge 本身，不作为 LIVE 样本，也不做任何模型有效性声称。",
    "剩余 15 条反例（D01–D04、Q01–Q09、N01、P01）按计划在 R05–R09 修复，本任务未触碰。",
    "JS 离线 judge 的回执仍是完成性检查，不是同权限恶意代码的操作系统沙箱；进程边界是资源界限。",
    "适配器对候选的判定顺序是先策略预检后调用 Python：被拒候选不会产生 frozen-judge 工件，这是有意区分“未判定”与“判定失败”。"
  ]
}

## 源码 SHA（提交前工作树）

| 文件 | sha256 |
| --- | --- |
| `scripts/eval-repair-adapter.mjs`（新增） | `4030d0dacf424468e9ade40cd3c2990fa9920ca166c0bfffc684afd70496815e` |
| `experiments/semantic-discovery/repair-judge.mjs` | `f7f036870faf42a3edd578fe0e9484f2dbc717e9966374892d93295919d58129` |
| `experiments/semantic-discovery/repair-judge.test.mjs` | `895a456809a37701581d4833fe9b78340ca83cc27545d31044e41a150c62ee78` |
| `experiments/semantic-discovery/agent-ab.mjs` | `762f805182e6104771ec64ba2c51106c3e843b3bbde0e3da685c12a7861661a7` |
| `experiments/semantic-discovery/compare.mjs` | `816c97cca42e26be36f4f3b4d899501dae5a19eacc64de27be0aa6c3250f3757` |
| `experiments/semantic-discovery/package.json` | `e4c9f04abae80c70133c18b34829c4556135d0e3ba56f039450b69cedb6e5a7b` |

## 证据目录

- RED：`java specialist v11 runs/r04-red`（`--cases J01`，1/1 FAIL）
- GREEN：`java specialist v11 runs/r04-green-j01`（`--cases J01`，1/1 PASS）与 `r04-green`（全量 27 例）
- 可搬运 8×：`java specialist v11 runs/r04 portability/run 01 with spaces`
- 回归：`r04-probe-12.log`、`r04-selfcheck/summary.json`、`r04-build-isolated.log`、`r04-npm-test.log`、`r04-rc.log`
