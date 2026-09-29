# Java Specialist v1.1：b9c3cc3 上线审计与修复执行包

**审计日期：2026-09-28（Asia/Singapore）**  
**审计基线：`b9c3cc325491947b198342575e9ea251c024b521`**  
**当前结论：NO_GO——不满足原 v1 完整上线验收；不是已经实施的产品修复。**

本包包括独立审计报告、原要求追踪、14 张修复任务卡、可执行反例、原始离线证据、完整原版冻结 devkit、发布证据检查器。它不是第三方认证，不是新的通用 Context Engine，也没有替用户安装或替换 daemon。

## 从哪里开始

开发 AI 先读 [RUN_AI.md](RUN_AI.md)、[AGENTS.md](AGENTS.md)、[审计报告](docs/01-audit-report.md)，再按 [执行主计划](docs/04-execution-master.md) 顺序进入 R00。产品设计以 [增量设计](docs/03-design-delta.md) 为准；`baseline-kit/` 内的旧路线仅用于需求与冻结评测依据，不能再与 R00–R13 并行开工。

```bash
python tools/check_bundle.py
python -m unittest discover -s tests -v
python tools/run_audit.py --project /absolute/codex-java-lsp-mcp --output /tmp/java-audit-b9
```

最后一个命令在 b9c3cc3 上预期退出 1，报告 **27 个检查：1 PASS、26 FAIL、0 ERROR**。这是实际源码函数的反例基线，不是“修好后的测试通过”。退出 2 表示环境/接口装载失败，不能冒充发现缺陷。TypeScript 仅转译，未类型检查；SDK 的未使用 transport import 被离线 stub 禁止启动，假模型与假 embedding 只用来检查数据流与缓存。

## 阅读地图

| 文件 | 用途 |
|---|---|
| `docs/01-audit-report.md` | 已实现成果、缺陷、复现、测量边界、上线判断 |
| `docs/02-requirements-matrix.md` | 原 T01–T12/K01–K32 与当前代码逐项对照 |
| `docs/03-design-delta.md` | 接口、状态、范围、缓存与评测的唯一新设计 |
| `docs/04-execution-master.md` + `tasks/` | 任务依赖、RED/GREEN、文件、提交、停止条件 |
| `docs/05-test-protocol.md` | 离线→MCP→真实 Agent→macOS 上线链 |
| `docs/06-experiment-redesign.md` | 修正 A2/A3 对照与四向判定 |
| `docs/07-release-runbook.md` | 完整上线资格与部署授权分离 |
| `docs/08-reporting-and-evidence.md` | 状态、哈希、分母、证据发布与历史结果撤销 |
| `docs/09-runtime-contract-matrix.md` | 32 个原契约的测量层级与缺失补跑 |
| `docs/10-next-optimization.md` | 修正后仍值得做与应停止的工作 |
| `docs/11-delivery-verification.md` | 本包实际运行了什么、没有运行什么 |
| `docs/12-sources.md` | 固定源码和原始资料来源 |
| `tools/` | 离线审计、完整性校验、发布证据检查 |
| `baseline-kit/` | **未经修改的原 v1 数据、gold、scorer、冻结测试和文档** |
| `evidence/` | 本次实际离线日志与反例结果 |

## 核心结论

首轮修复确实有效：原源码探针 12/12 通过。新发现更严重的是 LIVE 评测把新工具输出错误送入 impact 压缩器；模型看到空结构，记录器却在压缩前写 `SOURCE_RECEIVED`。因此历史“模型读到证据仍拒绝修复”“dense 在任务层无净收益/无伤害”的因果判断不成立。

向量缓存对同文件多个声明使用相同 key；A3 检索又把 A2 全集加 dense 候选，未对齐最终预算。“零回退”不能证明无害。产品本身还存在 scope 后置、重复 FQN 错误消歧、XML 证据归属错误及 stale locator/preview 边界问题。

**最短正确路线：保留已有底座，先修评测可信性和静态产品正确性，再进行一次可结束、可解释的验证。不是继续加模型、重写语言或扩大工具面。**
