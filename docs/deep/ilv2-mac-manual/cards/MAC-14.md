# MAC-14 — 整合门和 K 合同换代

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** `scripts/run-release-contracts.mjs`、`scripts/release-mcp-contracts.test.mjs`、`scripts/release-jdt-contracts.mjs`、`scripts/run-isolated-jdt-benchmark.mjs`及其定向测试、`src/benchmark/release-index-contracts.test.ts`、`docs/java-specialist-release-audit-v1.1/contracts/runtime-matrix.json`及当前合同说明、三仓runner/verifier与runbook。

**步骤：** 按 §6.2 更新 K 搭建与 oracle；全部 K01–K32 列表保留。改造现有 `scripts/release-jdt-contracts.mjs` 和 `run-isolated-jdt-benchmark.mjs`，使真实 JDT 测试经唯一 owner/新 transport 运行；在隔离 fixture 上生成同一候选的 `real-jdt-evidence.json`，临时根清理前导出到本任务 RAW，并以 `--jdt-evidence` 交给 K runner。native/source/fixture 身份必须一致，不接受旧 JDT 产物。历史结果保持原样；当前矩阵标新 contractVersion、source/native/driver digest。对同一整合候选执行一次 full、PR、K、真实负载和三仓门，复用有效证据；任何修改使直接受影响证据失效。

**验收 G14：** 完整合同结果表无隐含跳过，K26/K28 缺真实 JDT 则 G14 为 BLOCKED_ENV，并阻断 G17/部署；不能写“全 K PASS”或把必需 K 静默降级；正式三仓质量无回退、p95 比 ≤ 1.25；新真实多 worktree 门独立 PASS；旧路径删除清单为零生产调用者。对明确新增行为用新 oracle，不要求新输出逐字兼容旧 JSON。
