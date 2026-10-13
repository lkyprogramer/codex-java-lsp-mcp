# P1 验收边界与 P4 最小实验审查

2026-10-11。只读审查 `docs/next-stage/evidence-protocol-experiment-plan.md` 及主代理给定的 P1 接口说明；未审查变动中的 diff，未运行模型、负载或构建。本文是验收要求和实验建议，不声明 P1 实现已通过。

**计划的方向与不可变边界成立。** P1 能否通过取决于它是否只改变提交运输与公开形式校验，冻结 scorer 仍独立判定答案/证据/预算，repair 仍由冻结 judge 判定。v1.4 默认 locator 无预览也是一项实验干预，不能把整组 v1.4 改善归为 typed submit 或产品收益。

## P1 最小验收边界

1. `runLiveAgentTask({submission:{answerKeys}})` 只能从当前公开合同构造 schema。只有键/类型，无 gold 值、枚举答案、按题归一、隐藏 required ranges 或答案反馈。schema 不应默默 coercion、剥离前后 prose、删键、补键或更改值。形式有效不等于语义正确；合法但错误的答案须原样进入冻结评分。
2. exclusive submission 指一次回复中只有一个 `submit_answer`，无其他工具动作；含读/写/submit 混合动作应整次拒绝提交，不能先执行读/写再接受同次答案。回执冻结点是此前已经完成请求 dispatch、实际送达模型的 source，而非已抓取但尚未发送的 source。接受后不再执行后续动作，正文仅草稿，不能在提交失败时偷换为正文答案。
3. 最多一次形式恢复，反馈仅含公共 schema/独占规则错误；不含是否与 gold 相等、缺哪些 required lines 或 judge 结果。恢复的请求、响应、usage 和 source 送达都保留，重复片段照旧计费。形式恢复不应解锁预算、重置 rounds 或掩盖原始终止原因。MAX_ROUNDS、budget exhausted、模型停在草稿和恢复后仍无提交都须有明确独立状态。
4. 没有有效提交的 QA 答案保持 null/失败，并保留计划行，不能遗漏分母。repair 的 accepted/rejected/missing submission 作为协议结果单列；候选仍交冻结 judge，不能因模型未提交就漏测真实补丁，也不能因 patchApplied=true 就记成功。两者的组合规则必须预先写入 v1.4，避免临时按有利结果取舍。
5. 计划身份、候选摘要、protocol/config、首次提交/拒绝/恢复/接受记录、payload receipt 截止点、实际 execution order 和 provider usage 必须能追溯。保留 primaryStopReason 与 finalAnswerMode，不能将一次恢复后的有效包装改写成正常完成。SOURCE_FETCHED 与 SOURCE_RECEIVED 的区别保持。
6. eval v1.4 对 java_symbol 使用 preview=none，应由实验适配器显式发送并绑定配置。两臂 native tools 相同，公共产品默认不改。全部新结果独立目录；旧 v1.3 的原答案、原评分、FAIL、摘要和分母不改写。冻结输入 hashes 在 P1/P4 前后均复核。

离线最小用例需要覆盖：有效独占；缺键/额外键/错类型；合法错误值原样接受；mixed tools；重复/多 submit；仅草稿；一次恢复耗尽；FETCHED 尚未 dispatch；接受后动作；原始 MAX_ROUNDS/预算原因；有真实 repair 改动但无提交仍送 judge；完整 planned denominator。只要求这些可观察边界，不新增无证据的防御场景。

## P4 必须避免的归因混淆

- v1.3→v1.4 同时改变共享提交与 product locator 预览，历史前后只能报告整组干预。v1.4 内 native vs locator 可以估计额外 locator 可用性的增量，但不能单独证明 typed submit 改善了成功率。
- P2 evidence units 与 locator 比较时先固定 entity/candidates、query、收到的源码总预算，只改变证据单位；否则检索排名、候选选择和 evidence shape 会一起变化。completeness 相对于单位定义，不能用 gold 是否全覆盖为模型可见状态。
- P3 两 worker 不混入第一轮模型归因。首轮统一用原单 reader；容量结论独立报告。如果确需两 reader 的模型场景，再做单独配置，不能让只有产品臂获得容量/延迟变化。
- native 对照与 product 均不强迫检索，不提前塞理想源码。额外工具即使未使用仍可能影响选择和 prompt tokens，应计入真实端到端成本。gold 仅存在评分边界，不能用于构造输入上下文。

## 下一轮最小足够安排

**先冻结一个 v1.4 候选和两臂协议，完整保留原 36×2=72 次回归。** 两臂模型、completion 上限、总源码预算、reader 配置一致；product 为 locator，control 为 native。每题一次、arm order 平衡。独立 smoke 可用公开 fixture/已暴露题，提前固定名单；其请求与费用单列，不并入正式72分母，不能因 smoke 暴露答案再写专用提示。72 行计划在第一请求前持久化；运行中若协议或候选改变，终止并标记该轮，不把修改前后尝试拼成完整轮。

一次完整回归足以检查正式门槛及直接回归，不足以宣称泛化和稳定优越。先按以下证据决定是否增加少量诊断，而非自动启动更多全轮：

| 第一轮现象 | 最小追加 | 决策边界 |
|---|---|---|
| 格式失败消除，但已完整送达证据的语义失败仍在 | 静态源/答案审查；无需自动加工具或扩大模型轮数 | 协议有效不等于检索方向已获支持 |
| 两臂差距集中在少数题，且可能为随机波动 | 预登记最多6个差异/既有discordant，每题每臂额外2次固定重复，最多24尝试 | 总计划上限96次（不含独立smoke）；仅估这些题波动，不当新样本 |
| locator没有稳定收益，怀疑 broad 查词是成本来源 | 用已存结果先定位确由text/auto扫描参与的最多6题；单独冻结 narrow exact profile，与相同v1.4 broad locator作配对诊断 | 把该小实验计入预先声明的追加上限；不同时增repeat和新臂造成无界扩张；不能仅凭旧的6题名单推断广域收益 |
| P2没有发现真实预算内证据缺口 | 停止evidence unit模型实验，只交离线机制结果 | 不为凑三臂强行执行 |
| P2能修复真实关系证据缺口 | 固定候选做最多少数相关题的locator/evidence-unit配对；先定义替代哪段预算，而非额外送源码 | 从追加预算中分配；不将单题XML改善宣称通用答案引擎 |

“最多24追加”是成本约束建议，主代理应在首轮前选定具体配置和停止规则；不能结果出来后无限追加直到通过。若为了三臂匹配或固定重复需要超出该预算，先陈述具体未解不确定性和新增成本，再决定；无必要就收尾。后验挑选的小样本必须明确是定因诊断，不进入正式72成绩或泛化证据。

native+exact 的“exact”需先定义：java_symbol searchMode=exact 的产品限制，或给native共享的确切导航能力，不能混叫一个控制臂。前者是产品profile消融；后者改了两臂共享能力。广域/受限决定应依据真实调用方式、最终成功、token与重复payload、定位和索引准备成本共同判断。没有稳定广域收益可收缩实验支持范围，但不静默删除公共功能。

**本轮独立 holdout 不应成为 P1 的强制前置，也不用于替代原门。** 若只交付协议修复及原题回归，可明确泛化未验证后停止；若最终要作广域与受限产品方向的外推结论，才需要新的独立任务：从新源码真实问题设计、双人核对事实与公开表示合同，先冻结任务/gold/scorer/budget及泄漏隔离，再运行。不得根据既有 gold 的词汇/争议反推新题，也不得把已看答案的题标为独立。首批用于检验方向，不预称足够发布样本。

## 验收结论的安全措辞

可以报告“P1 离线协议边界通过”“v1.4 原36题回归结果”“原阈值在新协议/配置下通过或失败”“给定诊断题的波动/证据单位差异”。不得报告“修正后的原历史评分”“新协议证明工具提高准确率”“少数旧题证明产品泛化”“双worker修复原单workerFAIL”。本审查未检视最终 diff，P1代码正确性仍须独立实现评审确认。
