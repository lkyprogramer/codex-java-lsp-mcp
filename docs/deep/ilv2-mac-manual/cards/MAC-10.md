# MAC-10 — 可运行的真实任务评测基础

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** `scripts/generate-commit-tasks.mjs`、`evaluate-java-task.mjs`、`eval-pilot-compare.mjs`及新转换/retrieval/paired runner；输入/结果按§0.3存本机datasets/runs目录，临时attempt只在受管隔离根。

**步骤：**

1. 把 `jin-commit-tasks/v1` 当候选输入，新增人工核验转换步骤，分别输出 agent-visible tasks、agent-visible answer contract、private gold、repair oracle、corpus manifest。commit changed files 不能直接当 required evidence。
2. 先冻结 6 个 dev task，覆盖 lishu-v2、lishuedu、exam-parent-v3，每仓至少 QA/repair 各一；QA 真值/文件范围人工核查，repair 的错误前态必失败、已知正确修复必通过。隔离验证 oracle 依赖和时间上限。
3. 实现无模型 retrieval runner；agent-visible query plan 不得使用 private gold 选查询。评估实际收到的文件/源码范围、hash、payload、首次正确证据，而非仅“read plan 列了文件”。
4. evaluator/比较器显式接收 dataset/gold/schedule/driver 身份，移除对旧 pilot IDs 和 dev.jsonl 的隐含绑定；缺 backend/dry-run 保持 UNMEASURED，不能变成无模型评测 PASS。
5. 链路跑通后扩到 40–60 个经核验任务，覆盖调用方、实现类、XML、Spring、DTO 影响与 repair。按仓库/类别分层保留 30% holdout；私有 gold 和保留集结果不向调优流程开放。

**验收 G10：** 六题全链路可执行；漏证据、错 hash、重复候选、timeout、漏 slot 评分正确；dataset/gold/schedule 不匹配拒绝比较；gold 不泄漏给执行 agent；已知失败/正确 repair oracle 判定稳定。全数据集完成身份冻结后才能进入 MAC-15。
