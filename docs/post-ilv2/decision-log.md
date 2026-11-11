# Post-ILV2 决策日志（Q12）

本轮代码均**未编译、未运行**（D0）。下表各方向的结论只依据本轮证据，没有收益数据的方向一律不写 ADOPT。

| 方向 | 卡 | 结论 | 依据 | 维护 owner / 验证任务 |
|---|---|---|---|---|
| 最终请求 receipt 与 oracle 完成判定 | Q01 | INCONCLUSIVE | 代码和测试已写，未运行；作为评测侧正确性修复保留 | 用户；`ilv2-mac-delivery-receipt.test`（含假模型全链）、`ilv2-mac-repair-oracle.test`、`eval-repair-adapter.test`、`evaluate-java-task.test` |
| 失败归因 | Q02 | INCONCLUSIVE | 工具已写；私有数据缺失，ledger 为 BLOCKED_ENV | 用户；`ilv2-quality-attribution.test` + Mac ledger 运行 |
| 单文件 outline | Q03 | INCONCLUSIVE | 合同已实现，收益未测（Q10 没有 LIVE） | 用户；`outline.test`、`symbol-static.test` |
| Java 声明 evidence v2 | Q04 | INCONCLUSIVE | 合同已实现。Q10 里 B2 对 B1 的检验没跑；若该检验结论为 NO_GAIN，按卡片删除 Java evidence 路径，只保留正确性修复 | 用户；`evidence-unit.test`、`evidence-source-reader.test`、`eval-evidence-e2e.test` |
| 定向关系 / 发现缺口 / 证据边际 / 绑定保真 / 等待与 I/O | Q05–Q09 | NOT_TRIGGERED | 没有 ledger 或计时证据，没有写代码 | — |
| 真实 Agent 配对 | Q10 | INCONCLUSIVE | 只交付了 `summarizeSchedule` 和无费用控制；benefit 为 UNMEASURED | 用户；`run-agent-trace-live.test` |

## 规模与形态（按代码检查得出，未运行 measure 脚本）

- 生产代码（`src` 非测试文件）相对 `665d66e`：+492 / −77，净增 **+415 行**。其中 outline 234 行，evidence 改造净增 75 行，共享读取器 57 行（从 evidence-unit 抽出，不是新的安全实现），symbol 接线净增 49 行。没有删除任何试验模块：本轮没有新增备用 ranker、第二 scorer 或 provider，也就没有可淘汰的。
- 默认检索实现仍只有 1 条（静态 discovery）；没有 embedding 依赖；没有新增常驻 daemon；公共工具仍是 5 个（`java_status`、`java_impact`、`java_symbol`、`java_diagnostics`、`java_runtime`）。outline 是 `java_symbol` 的一个 operation，不是新工具。
- `package.json` 没有新增脚本。

## 文档入口

当前状态的唯一入口是 [decisions.md](decisions.md)。产品 README 已经说明 query → outline/evidence → 按需 JDT 这三步用法，以及 outline 和 evidence v2 的边界。README 里其余历史章节本轮没有精简（NOT_DONE），原因是精简会牵动大量与本轮无关的已验收描述。

## 是否继续

下一步只做一件事：在授权的 Mac 上按 [acceptance.md](acceptance.md) 跑受影响的门，再跑 Q02 的 ledger。之后由用户决定是否给 Q10 授权 LIVE。结论按以下规则处理：

- outline 或 evidence v2 测出 NO_GAIN：删除对应路径。
- Q10 的结果仍是 INCONCLUSIVE：停止本路线，不再自动生成新的平台级路线。
