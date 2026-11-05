# 06 统一评测：在已有设施上补闭环，不重造基准

## 6.1 三类数据不能混用

**历史回归集**：已暴露的旧devkit、三仓、mac10-v3 dev与已看过的holdout。用于防回归与失败归因，不能宣称未来泛化。

**新冻结任务组**：从未用于本次调参的Java仓库/模块和真实问题中选择。冻结代码commit、输入、editTargets、requiredEvidence、允许替代证据和答案/修复oracle。建议至少36个任务组，按12入口/行为、12字段/接口影响、12异常/状态划分；24开发、12锁定。数量是可负担起点，不是精确统计保证。不能把翻译和重复采样算新任务。若无法取得独立任务，报告只支持回归结论。

**本包机制附件**：`fixtures/`和`evaluator/cases.json`是原创可公开的小型验收语料，不是上述真实任务组。覆盖同文件错选、同FQN模块、Java/XML来源、长方法、Unicode和JDT关系口径。标签和测试放在evaluator侧，不进入Agent工作区/索引。

MAC10-v3的50题和149条gold证据不在公开仓库；本包没有伪造它们。已有私有数据可通过manifest验证后复用；没有则BLOCKED_ENV，不拿附件机械样例替代。[S09]

## 6.2 先修评测能力，再测效果

付费LIVE前必须通过：

1. 使用假模型回放抓到最终request body；含source的tool消息能逐字节验证；只列paths或摘要不能产生sourceReceipt。
2. strict QA按冻结schema比较类型、键和证据要求；缺usage是null/UNMEASURED而非0。
3. repair known-bad失败、known-good通过；打印固定PASS字符串再System.exit(0)仍失败；编辑评测测试/非允许文件拒绝。
4. 完成凭据只在冻结test main正常返回后由独立wrapper生成。nonce是防偶然误报的关联值，不是同权限候选代码无法伪造的密码学保证；不能据此声称安全沙箱。
5. 真正LIVE前至少一个可预期成功的easy control与一个必失败control，工具调用和最后写入来源身份贯通。

复用现有`scripts/evaluate-java-task.mjs`、`ilv2-mac-paired-compare.mjs`与oracle；不要再建一个“几乎一样”的scorer分支。

## 6.3 八级归因

为每题记录目标在哪里消失：

```text
NOT_DISCOVERED → WRONG_DECLARATION → RELATION_MISSING
→ CANDIDATE_EVICTED → RANGE_MISS → SERIALIZATION_LOSS
→ DELIVERY_UNCONFIRMED → TASK_REASONING_OR_EDIT_FAILURE
```

它们是评测侧标签。运行时只能报告可观察的budget/unsupported/stale等原因，不能访问gold判断“自己漏了必须文件”。候选召回、selection、ranges和final-message各自有manifest/hash。

新改动必须声明改善哪一级。若主要是RANGE_MISS，不立刻加provider；若主要是未知入口，不通过扩大evidence窗口掩盖；若源码在最终请求里但答案仍错，才有理由讨论模型/任务策略。

## 6.4 对照臂

| 臂 | 内容 | 用途 |
|---|---|---|
| B0 | 当前固定产品+宿主原生rg/read/build | 日常真实起点，不是一次单词搜索 |
| B1 | B0 + outline操作，返回组织保持简单 | 隔离新增能力 |
| B2 | B1 + 选定Java evidence交付/少量候选组织 | 隔离展示与交付，不改召回排名 |
| B3（条件） | B2 + Q05/Q06/Q07其中一个改动 | 一次只比较一个机制 |

embedding没有实验臂。真实Agent阶段先比较B0和待发布的最小B2；B1用于离线/必要小样本消融，不把所有臂跑满制造成本。

两臂同任务、同代码、同模型版本/推理设置、同可用原生工具、同预算和同权限。不强制使用MCP，不禁止baseline的多轮rg/read。后端预建可用于隔离查询贡献，但建库、维护与冷启动成本另列。

## 6.5 指标和分母

- file recall与declaration Recall@5/10分列；一个文件有多个方法不能混成一次正确。
- RequiredLineRecall按`path+hash`行集合交集/并集计算，不以任意相交代表整段命中；替代证据按预冻结any-of组判定。
- anchor containment、wrongHash、wrongWorkspace、伪确定性absence是硬正确性指标。
- actual-source-received只记最终请求中的原源码；planned bytes、wire bytes、source bytes、provider input/output/cached/reasoning分列。
- taskOutcome：QA冻结判定或repair冻结测试；path coverage和task success永远分离。
- 总成功率`successful / scheduled`，另列未执行/环境阻塞，报告必须说明将其视为未完成的端到端口径；能力正确率可用attempted分母，但不能单独展示它。
- 每个任务3次重复先聚合为任务组；中英文同组；bootstrap按任务组，跨仓只作少量簇的描述性稳健性。小样本区间宽则INCONCLUSIVE。

## 6.6 冻结预算与门禁

产品readPlan budgets保持现状：minimal4/6KiB、balanced6/14KiB、precision8/20KiB、recall12/32KiB。evidence8units/80lines/16000bytes。任意budget变化必须单独成臂，不能混入算法提升。

真实任务pilot建议12个代表任务×2臂×3重复=72次，按原数据集分层选，不看候选结果挑题。授权只覆盖这次固定矩阵；缺预算先完成无模型控制。pilot有明确方向后再扩36任务，不以pilot几题宣布稳定提升。

工程筛选初值（Q00/Q02预注册，不是测得收益）：无新增关键错误；fixed-budget关键证据覆盖改善或任务成功率改善；质量不下降时实际input中位数下降约15%可作为成本信号。小样本+5个百分点不作自动GO。对照逐任务失败和CI，最终允许NO_GAIN/INCONCLUSIVE。

## 6.7 报告发布纪律

附每slot结果、配置、artifact hash、失败和重试；不能只给平均值。保留原有效失败，不跨候选/不同corpus/不同模型混样本。只报告因缺环境未运行，不报成通过。

任何“token减少”“比Serena准确”的公开主张都需要对应同任务测量；项目方宣传和本包检查器通过不是证据。
