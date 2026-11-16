# README 历史归档（2026-11-16 前）

从 README.md 原样移出的历史叙述：发布与里程碑背景、当时的 benchmark 口径和下一周期计划。只作历史背景，不描述当前状态，不构成运行或部署依据。现行用法与隔离门禁见 [README.md](../../README.md)，当前状态见 [HANDOFF.md](../../HANDOFF.md)。

## 原 README · 开发与验证：开头的历史说明

历史 2026-10-11 QA 发布的静态事实 revision 为 **5**。旧 revision 的静态索引在正常访问时重建；静态 READY 需要完整遍历，并按实际解析、失败与恢复计数发布。存活的 JDT 子进程继续占有 lease，直到进程确认退出。较早 runtime integrity 阶段的未安装 / NO_GO 记录作为历史保留；QA 发布时刻的资格和安装记录位于维护工作区 `docs/next-stage/qa-contract-release-review.md`；后续 hook 同步见 [Java agent 指导](../next-stage/java-agent-guidance-review.md)。未手动修复或删除生产缓存。

较早范围与证据见 [runtime integrity 计划](../next-stage/runtime-integrity-plan.md)、[历史发布评审](../next-stage/runtime-integrity-release-review.md) 和 [历史原 NO_GO 清单](../next-stage/release-evidence.json)。[K01–K32 runner](../../scripts/run-release-contracts.mjs) 记录逐项原始结果；[真实 JDT driver](../../scripts/release-jdt-contracts.mjs) 生成 K26/K28 的隔离集成证据。使用这些入口仍须遵守下面的隔离约束。

## 原 README · 开发与验证：benchmark 口径、下一周期与历史报告

当前 benchmark 口径：

- hard gate 包括每仓 `R_read_must=1.0000`、task-blocking/recall/P_read 不低于冻结基线、standard estimated tokens 不增加，以及有绝对 slack 的 cold P95 上限。
- `goldenAttribution[]` 用于判断缺口是 `absent`、`readplan-full` 还是已命中 `readPlan`。
- `timing.phaseMs/sessionPhaseMs` 用于 warm 延迟归因；`warm-required` 的首触成本仍不足以支持默认化，因此保持 `KEEP_EXPLICIT`。
- 三仓 paired gate 使用 [`docs/three-repo-cold-matrix-runbook.md`](../three-repo-cold-matrix-runbook.md)：old/new 必须共享冻结的 `--scenarios` 文件，固定 AB/BA/AB、3 轮 × 每格 5 runs，且由脚本逐仓判定 quality/P95 硬门。

当前运维与下一周期：

- [生产操作（IOD 现行）](../phase-f/production-operations.md)
- [生产切流手册（历史）](../phase-f/production-cutover-runbook.md)
- [下一周期 token accuracy 计划](../deep/codex-java-lsp-mcp-next-frontier-token-accuracy-plan-2026-08-24.md)
- 三仓 paired gate：[three-repo-cold-matrix-runbook](../three-repo-cold-matrix-runbook.md)

历史 warm/readPlan 报告仍在 `docs/java-lsp-mcp-*-2026-06-*.md`。

## 原 README · Java Specialist Devkit v1（M0–M3）

本仓库同时是 Java Specialist Devkit v1 的执行载体：静态发现层（`java_symbol` 词法/结构化检索，A2 主线）+ 真实 agent 评测轨道。M0–M3 全部收口：

- **M1** 静态发现 + canary；**M2** 关键证据/读计划/真实 agent 评测（144 runs MEASURED，27B 后端）；**M3** 语义发现预注册实验（T10，KEEP_EXTERNAL 运行姿态，分支关闭）+ 绑定加深归因（T11，NOT_NEEDED）+ 单主线收口（T12）+ **终局双缺口关闭：full public corpus 12/12 语料 external-profile 实测（micro A2 0.574 → A3 0.625）与 Agent repair 48 runs 冻结测试实测（0/33，诚实的零）**。
- **单主线**：生产工具面 `java_status` / `java_impact` / `java_symbol` / `java_diagnostics` / `java_runtime`；未注册的 `java_context` 旧逻辑已在 M3 删除，`context-engine` 模块仍由 `java_impact`/SQL 层消费。
- **语义路线**：外部 dense 对照实验已关闭（R11 在 eval protocol v1.2 下重测为 NO_GO，见 `docs/next-stage/a2-static-fixes.md`），驱动与产品侧 `search_doc_text` 已删除；`experiments/semantic-discovery/` 只保留冻结审计按路径导入的 `provider.mjs` 与 `repair-judge.mjs`。产品默认线为 A2 词法。报告见 [`docs/java-specialist-devkit-v1/reports/`](../java-specialist-devkit-v1/reports/)（m0/m1/m2/m3-t10/m3-t11/m3 里程碑）。
- 历史路线（JIN/phase-f/v3 矩阵等）文档保留在 `docs/deep` 与 `docs/` 顶层，作为历史设计记录（当前生产主线以上文“单主线”节与 devkit 报告为准）；运行产物不在仓库内（仓库外 `java-devkit-v1-runs/`）。
