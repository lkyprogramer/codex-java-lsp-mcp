# Full public 准备结果

状态：PREPARED_NOT_EXECUTED。此目录只提供外部接线和离线验证；没有模型请求、性能 benchmark、安装或认证文件复制。候选 sourceDigest 尚未固定，prepared-plan.json 中保留 null，实际运行前由主代理冻结最终源码及原 helper/协议/任务/模型参数。

`prepare-full-public.mjs` 复用原 launch-model.mjs 的 buildPlan，产生原 36 任务 × product/control 两臂 72 行。`fullAttemptOptions` 将已重算的 full-stage 各 corpus 根传给原 `runLiveEvalRun`，后者使用原 createAttemptWorkspace 做每 slot 完整源码复制与独立 candidateRoot，默认原 evaluateRepair 负责真实候选判定。不要传入 fake chat、fake session 或覆盖 repairJudge。

`score-full-public.mjs` 导出的 `scoreFullPublic` 接收全部原 tasks/runs。它复用 buildFrozenResultsPack/runProfileFrom、原严格答案及提交验证、原 repair outcome helper。QA 结果来自未修改的 Python harness score，命令显式传 `--corpora-root <full-stage>`；profile 是 external-full。SOURCE_RECEIVED 和 provider usage 由原 pack helper 映射，不根据源码字节或 patchApplied 推算。实际执行或成功的 repair judge 必须绑定当前候选逐文件 hash 与原 frozen-judge.json，并记录 artifact SHA；合法的原 pre-judge rejection、blocked、missing、timeout 等行保留原 helper 的失败或未测结果，不伪造 judge，不取消整轮分母。使用新 outputDir，拒绝覆盖。

原 2533 文件逐 hash、全文件 fingerprint 和四 upstream commit/clean/seed 每次评分前后重查；完整 hash 为 13d529a6d262bfbe43a44c84b5666dedaa8527447768a098778682f1539de747。主运行器仍须执行原 verifyKit 和最终 candidate identity 检查，并把 actual run trajectories、payload、usage、candidate、judge 和 score raw 加入发布证据。

离线命令：

```sh
node --test p4-release/full-public-prep/full-public-offline.test.mjs
node p4-release/full-public-prep/prepare-full-public.mjs <candidate> prepare
```

prepare 拒绝覆盖已产生的 prepared-plan.json。此准备模块没有 run 动作。实际执行入口由主代理审查并调用 exported fullAttemptOptions 与原 runLiveEvalRun；最后调用 scoreFullPublic，`allowMissingForOfflineTest` 必须保持默认 false。

离线测试中 frozen CLI 对两臂的空输入产生 36+36 条 MISSING，只证明完整来源被送入原 CLI、正确 profile 和分母；结果明确标 OFFLINE_WIRING_TEST_NOT_MODEL_EVIDENCE。它不能作为 FULL_PUBLIC 的模型成绩或 repair 证据。test 的实际源码复制仅作用当前目录 offline-test-*。

门禁权威：baseline-kit/schemas/gates.json release_requires 要求 full upstream corpus profile measured separately；baseline docs/14-acceptance-checklist.md:22 要求独立 full profile，不能用 scoped 高分替代。单独 FULL_PUBLIC 没有另定义两臂均须80%规则。release-policy.json:6 与 audit docs/07-release-runbook.md:16 的全发布 QA floor 为0.8；原 harness cli.py:158-172 的 gate 会对所给 report 计算 QA floor、valid、budget、anchors，并明确只输出 STRUCTURED_QA_ONLY_NOT_RELEASE。主代理应分别报告该冻结 gate 的结果，不新增每臂门槛或把 measured profile 冒充完整发布资格。8 repair 要求真实候选均被原 judge 测量，原 runbook 明确未要求全8成功。

原题已暴露，这次 full 是 regression。INDEPENDENT_LOCKED 仍等待所有者的独立输入，不由此适配器创建或改名。

## R2 独立评审修复

原5项离线通过只验证了正常准备路径，独立评审发现成功 judge 未绑定当前候选、合法失败会取消全轮。原日志不覆盖。r2-red.stdout.log 中两个业务反例均失败：NO_SUBMISSION QA 使整个评分抛错；同 task 旧成功 artifact 对错误 candidate 被接受。

R2 仅修改本目录的外部适配器与测试。QA 的 INVALID_SUBMISSION/MODEL_STOP/MAX_ROUNDS 在原 attemptStateOf 下可为 COMPLETED，因此没有有效提交的行以 answer:null 交给冻结 scorer。声称 SUBMITTED 时，必须有原 accepted submission receipt、相同 requestIndex、原 public validator 检验及原值一致性，矛盾证据拒绝。

repairEvidence 记录 task/arm/repeat、原 verdict、judgeExecuted、artifact SHA、candidateTreeHash。实际 artifact 的 candidate_tree 与当前 candidate 完整逐文件 hash 一致，frozen_test_sha256 与原 manifest.test_file 实际字节一致；路径越界和 symlink 拒绝；评分前后再核 artifact 与 candidate 没有改变。原 Python 的 DISALLOWED_EDIT 可在 compile/run 前产生无 candidate_tree 的 rejection artifact，此时以原 diffCandidateTrees 重算 policy，记录 judgeExecuted=false。原无 artifact 的 REJECTED_*、BLOCKED_*、TIMEOUT、OUTPUT_LIMIT、JUDGE_ERROR 和缺结果保持原 scoreRunOutcome，不从分母删除。测试中的合成 judge 仅为验证器反例，不算真实 repair judge 证据。
