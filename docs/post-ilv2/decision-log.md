# Post-ILV2 决策日志（Q12、D15）

D0 记录首次开发交付时的未运行状态。下表纳入后续 Mac 实测和正式 Q10 配对结果。

| 方向 | 卡 | 结论 | 依据 | 维护 owner / 验证任务 |
|---|---|---|---|---|
| 最终请求 receipt 与 oracle 完成判定 | Q01 | PASS | Mac 定向控制通过，正式 LIVE 的 66 个 QA 最终请求完成回执复验 | [Q10 验收](acceptance.md) |
| 失败归因 | Q02 | INCONCLUSIVE | 20 组 dev ledger 已生成，40 个检索 slot 全部完成，14 组缺足够阶段证据 | 用户；[Q02 结果](results/Q02.json) |
| 单文件 outline | Q03 | INCONCLUSIVE | 合同已实现，B2 已观测调用。Q10 没有单独测量 outline 的收益 | 用户；`outline.test`、`symbol-static.test` |
| Java 声明 evidence v2 | Q04 | INCONCLUSIVE | 合同已实现。Q10 里 B2 对 B1 的检验没跑；若该检验结论为 NO_GAIN，按卡片删除 Java evidence 路径，只保留正确性修复 | 用户；`evidence-unit.test`、`evidence-source-reader.test`、`eval-evidence-e2e.test` |
| 定向关系 / 发现缺口 / 证据边际 / 绑定保真 / 等待与 I/O | Q05–Q09 | Q07 调查完成 | Top 3 截断定位完成，固定预算 ReadUnit 在给定目标锚点后覆盖 4/4。Q06 一组低于阈值，Q05/Q08/Q09 缺充分阶段或计时证据 | [Q02 ledger 汇总](attribution.md#mac-实测) |
| 真实 Agent 配对 | Q10 | INCONCLUSIVE | B0 通过 11/36，B2 通过 15/36。任务组配对区间跨 0，三仓变化方向不一致，B2 输入 token 增加 | [Q10 结果](results/Q10.json) |

## 规模与形态（按代码检查得出，未运行 measure 脚本）

- 生产代码（`src` 非测试文件）相对 `665d66e`：+492 / −77，净增 **+415 行**。其中 outline 234 行，evidence 改造净增 75 行，共享读取器 57 行（从 evidence-unit 抽出，不是新的安全实现），symbol 接线净增 49 行。没有删除任何试验模块：本轮没有新增备用 ranker、第二 scorer 或 provider，也就没有可淘汰的。
- 默认检索实现仍只有 1 条（静态 discovery）；没有 embedding 依赖；没有新增常驻 daemon；公共工具仍是 5 个（`java_status`、`java_impact`、`java_symbol`、`java_diagnostics`、`java_runtime`）。outline 是 `java_symbol` 的一个 operation，不是新工具。
- `package.json` 没有新增脚本。

## 文档入口

当前状态的唯一入口是 [decisions.md](decisions.md)。产品 README 已经说明 query → outline/evidence → 按需 JDT 这三步用法，以及 outline 和 evidence v2 的边界。README 里其余历史章节本轮没有精简（NOT_DONE），原因是精简会牵动大量与本轮无关的已验收描述。

## 是否继续

Q07 的同预算对照定位到查询 Top 3 截断，ReadUnit 暂无改动依据。正式 Q10 使用 v1.8 的默认调用回执与每 slot 遥测。结论按以下规则处理。

- outline 或 evidence v2 测出 NO_GAIN：删除对应路径。
- Q10 的结果仍是 INCONCLUSIVE：停止本路线，不再自动生成新的平台级路线。

Q10 最终为 INCONCLUSIVE，按上一条规则，outline/evidence 路线停止，不再为它们单独做模型验证，代码保留，去留延后。2026-11-12 用户另行批准了发现与排序阶段（D15），见 [D15 阶段计划](d15-discovery-ranking.md)。该阶段有独立的预注册采纳规则，不是由上述规则自动生成的。

## D15 收尾

2026-11-12 完成 W6。以下决策来自 dev 诊断和回归。W4、W5 和正式采纳判定均为 `NOT_RUN`。[D15 W6](d15-discovery-ranking.md#10-w6-收尾决策2026-11-12)

| 事项 | 决定 | 依据 |
|---|---|---|
| W3 排序与查询路径 | 停止，步骤 C、D 结束 | W1 有 78/104 个目标未返回，重排没有提升 hit@8。Step B 在 10% 响应字节 p50 预算内最多增加 3 个 hit@8，低于 5 个的实现门槛。[D15-W1.json](results/D15-W1.json) |
| F 读取预算 | O2，保持 C0（6 个文件、14 KiB） | C1、C2 未达到召回门槛。C3 平均召回增加 3.79 pp，每题接收源码字节 p50 增加 45.82%，超出 20% 门槛。用户确认保持 C0，保留文件 ID 与投影一致性修复。[D15-F.json](results/D15-F.json) |
| 封存集 | v1 归档，v2 延后 | v1 衡量锚点声明自身的排序，与当前证据覆盖问题不匹配。新候选改动进入评估时，先冻结与该改动相符的指标、预算、采样规则和数据，再执行一次封存评估。[D15 封存集处置](d15-discovery-ranking.md#10-w6-收尾决策2026-11-12) |
| XML-3（2026-11-13） | 对账后收尾，MyBatis 发现为 `NOT_RUN` | 16 个证据范围中有 15 个 XML 和 1 个 YAML。15 个 XML 范围均来自 Maven POM 或日志配置，MyBatis 语句目标为 0。[D15-XML3.json](results/D15-XML3.json) |
