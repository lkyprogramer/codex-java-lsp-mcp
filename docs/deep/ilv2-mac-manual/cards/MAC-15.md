# MAC-15 — 模型收益与保留集

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** 评测 runner、冻结数据和隔离 attempts；真实付费运行需预算授权。

**步骤：** 冻结 task×arm×repeat（每题每臂 ≥ 3）、模型、prompt/guidance、工具预算、顺序、cache 条件和 scorer。主对照为 `baselineProduct`（原生工具 + MAC-00冻结旧MCP）与 `candidateProduct`（相同原生工具 + 新MCP），分别使用冻结 driver；native-only 可作辅助臂，单独回答增加MCP的收益。主对照的模型、任务预算和输入相同，schema适配/公开guidance差异单独登记。旧版运行失败保留为失败，不剔除困难样本。先 dev 调优；最终 holdout 等 MAC-16 PASS/有依据 NOT_RUN、MAC-14 受影响重验及最终 source/native/driver/guidance/oracle/预算冻结后才打开结果。

**验收 G15：** 全部 scheduled slot 纳入分母，失败/超时/缺结果保留；按 task 聚类成对报告成功率、first-correct-evidence、token、墙钟、区间与仓库/类别分层。采用门针对 candidateProduct 相对 baselineProduct：成功率不降且输入 token 减少 ≥ 20%，或成功率提高 ≥ 10pp；retrieval recall 下降 > 2pp 则 FAIL。小样本/区间跨零如实写结论限制，不能把同题三次当三题。“±1 题”不再使用。holdout 一次正式决策；之后任何影响行为的修改都使该收益结论过期，重新调优/验收须新 holdout，原集可明确转 dev，禁止同集反复补测。无授权输出 BLOCKED_AUTH，不伪造收益。
