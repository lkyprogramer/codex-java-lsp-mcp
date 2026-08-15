# HANDOFF

## 当前任务

Java-only LSP/MCP V3.2 优化的 Sprint3 已完成并已 commit/push。当前应继续 Sprint4（JDT 语义价值兑现，V3.2-21~25）。用户的硬约束不变：**任何测试、构建、benchmark 或验证都必须与正在使用的 LSP 隔离**，不能接触活动 checkout、LSP、JDT、JavaIndex 缓存或 `node_modules`。

当前分支是 `codex/java-intelligence-v3`，`HEAD=0736713`（`ba6a02f` 主体实现 + `0736713` V3.2-19 telemetry/storm-ratio exit decision/V3.2-20 关闭）。**Sprint3 已 commit 且已 push，不是 dirty worktree**。

用户的标准授权（持续有效，无需每次重新确认）：
- 本仓库上的 `git commit`、`git push origin codex/java-intelligence-v3` 不需要逐次请求授权。
- 设计分叉/实现取舍不需要问用户，直接调用 advisor 并按其最终建议执行；只有 destructive/不可逆操作、PR/发布/deploy 范围、或 advisor 自己标注为"需要用户判断"的事项才升级给用户。
- 详见 `~/.claude/projects/-Users-luo-Documents-github-codex-java-lsp-mcp/memory/autonomous-scope-authorization.md`（如果下一会话是同一账号/同一 Claude Code 环境，这份记忆应该已经自动加载）。

**唯一仍然需要用户明确授权、不可绕过的边界**：development-plan V3.2-07b（外部 Agent eval）——任何会产生外部模型调用成本或把代码发送给外部 provider 的操作，必须由用户显式授权；未获授权时相关任务状态必须是 `BLOCKED_EXTERNAL`，不得编造/估算数字顶替。Sprint4 的 V3.2-21 若涉及"实际 Agent quality 结论"，同样受此约束。

## Sprint3 最终状态（已关闭，供追溯）

- V3.2-16（progressive-index benchmark）：完成。
- V3.2-17（前台 anchor closure 优先级）：实现完成，且修复了一个真实的 `resourceCoverage`/snapshot-durability 竞态（`java-index-worker.ts`，三次迭代定位到正确修复：`processBackgroundChunk` 的 `finalChunk` 兜底重扫）。但其自身 `storm foreground P95/quiet ≤1.10` 验收线**未达标**（实测 7.72x-13.24x），已正式记录为 exit decision `DO_NOT_IMPLEMENT_SINGLE_WORKER_ARCHITECTURAL_CONTENTION`：拆解为一次性 ~671ms 冷启动税（次要）+ 单线程 worker 上后台 sweep 与前台请求的持续资源争用（主要、架构性，需要第二 worker 线程或 ADR 级并发模型决策才能消除，明确超出 Sprint3 范围）。**这不是待办事项，是已关闭的架构性结论**——除非有新证据或产品优先级变化，不要在 Sprint4 里顺手重新触碰 `beginBackgroundSweep`/`processBackgroundChunk` 试图修它。
- V3.2-18（后台 root 优先级）：确认已实现且有测试（`manifest.ts` 的 `prioritizeJavaFilesForBackgroundSweep`）。
- V3.2-19（snapshot/seed telemetry）：本轮补齐了此前缺失的无条件 telemetry 半边；门控式 metadata directory index 半边未触发入场条件，未实施（正确行为）。
- V3.2-20（cooperative cancel 研究门）：已用现有证据关闭，入场条件不满足，不实施。

详细报告：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-sprint3-storm-progressive-cold-matrix-report-2026-08-15.md`。
记忆索引：`v32-sprint3-status.md`。

## Sprint4 范围（development-plan 第 630-680 行）

- **V3.2-21：已用 exit decision 关闭，不实施（`DO_NOT_IMPLEMENT`）。** 写过一版 admission-gate 草稿（`session.status().started && progress.active===0 && !budget.expired()`），未落地就 revert 了——`progress.active===0` 是瞬时读数，`waitForProgressIdle()`（`jdtls-session.ts:2054`）自己已经证明瞬时 idle 不可信，需要 sustained-idle wait 才可靠，而这恰是 V3.2-21 原文明确禁止的（"修改 admission，而不是延长 timeout"）。在设计更好的信号之前，先用真实 jdtls 在当前 tree（`3030975`）上重跑了 Task35 2026-08-07/08 的 `cold-nolsp` vs `warm-auto` quality 对比（3 仓 × 5 runs × 全量 golden scenarios），**结果与 Task35 原始结论完全一致**：recall/pRead/rReadMust/rTaskBlocking 三仓全部 bit-identical，P95 却暴涨 7-15.6 倍。`auto` 现有的 live JDT 调用对当前三仓 golden 集合没有任何可测量的质量收益，只有真实延迟成本——这本身就是 line 640 验收线的完整答案（quality 非劣是平凡成立的，因为两边本来就相同；要做到 P95 不再顶 cap 又不引入质量退化，唯一路径是不打这些没有收益的调用，而不是把"何时打"变聪明）。**这不是待办事项，是已关闭的结论**，除非未来某个新场景证明 live semantic 证据真的改变了某个 golden 指标，否则不要重新设计 admission gate。详见 `docs/phase-v3/phase5-semantic-first-touch-decision.md`（2026-08-15 追加小节）+ `artifacts/v3-final/sprint4-v321-admission-recheck-20260815/`。
- V3.2-22：persisted semantic operation-completeness 合同（`SemanticEdgeStoreV2`）——推荐实现或保守替代（不新增 coverage record，只提供正向候选不承诺 completeness）二选一，依据 telemetry 是否证明值得。依赖 V3.2-08、V3.2-21（V3.2-21 已关闭，重新评估此依赖是否仍有意义再决定是否继续）。
- V3.2-23：opt-in idle JDT prewarm 实验。依赖 V3.2-04、V3.2-05。试验门：first-touch P95 至少 -30% 且 peak RSS/CPU 增幅 ≤10%，否则不进默认路径。
- V3.2-24：JDT 单变量参数实验（import concurrency / workspace reuse / project import readiness / document prepare，一次一个变量）；workspace/dataDir reuse 有严格隔离要求（同 canonical worktree + 同版本 + 同 build fingerprint 才允许复用）。
- V3.2-25：默认化硬门——5 项条件（P95≤800ms、0 partial/timeout、R_must=1 且 Recall/R_task 非劣、Agent task success 非劣、资源受控）全部满足前，策略维持 `KEEP_EXPLICIT`。V3.2-21 关闭后这条本来就更加确定不会满足（连 auto 的选择性调用都没有收益，遑论把它变成默认）。

Sprint4 完成门（development-plan 原文未单列一行，但按 §5.2 全局硬门 + 上述 5 条默认化硬门执行）。

## 下一步

1. V3.2-21 已关闭，下一会话应从 V3.2-22 开始：先判断"依据 telemetry 是否证明值得"这句话在 V3.2-21 关闭后是否还成立——如果 `auto` 已经不打算走 live JDT，`SemanticEdgeStoreV2` 的 operation-completeness 合同的价值主张可能也要重新审视，不要默认照抄计划文本直接实现。
2. 遇到设计分叉直接问 advisor，不问用户；遇到需要外部 Agent 调用/涉及外部成本的边界，停下来问用户。
3. 完成后走 Sprint3 同样的收尾流程：隔离回归 → LOC ledger → 报告 → commit → push（均已获用户标准授权，不需要再问）。

## 绝对不要再踩的坑（跨 Sprint 持续有效）

- 不要在活动 checkout 直接执行 `npm run build`、`node dist/...`、`npx tsc`、任何 `node --test` 或三仓 benchmark。所有会启动 Node worker/JDT/JavaIndex 的命令必须包在 `sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs` 中，并保持 `JDTLS_BIN=/usr/bin/false`。
- 不要运行旧的 `benchmark:lsp-performance` 入口；它已删除。
- 不要把 close 的 grace 恢复成 deadline 触发 `terminate()`；这会在 native parser 或原子写中杀 worker。
- 不要将 watcher refresh、A2 anchor 或多文件 refresh 标为 `ACTIVE_ANCHOR`。只有 `AgentRouter` 的第一个 A1 anchor 且单 changed/no deleted 能升级 root priority。
- 不要把 `isJavaIndexQuiescent()` 当作 `T_complete`；progressive complete 必须用 `isJavaIndexCompleteAt()`。
- 不要改变、删除或暂存未跟踪的历史 artifacts（`artifacts/v3-phase3`、`artifacts/v3-phase4`、`artifacts/v3-phase5`、`artifacts/v3-final/task36-remediation-20260809`、`artifacts/model-eval`、`artifacts/v3-task22`）、`.workflow/`、`.task30-debug.mjs`、`docs/evals/task30-model-comparison-20260802`。它们是其他并行会话/任务的产物，与 V3.2 Sprint 系列不是同一所有权，截至 2026-08-15 仍是 untracked。
- 不要在没有新证据或产品优先级变更的情况下重开 V3.2-17 的 storm/quiet P95 exit decision（见上）。
- 不要在没有用户明确授权的情况下产生任何真实 Agent 模型调用成本（V3.2-07b/V3.2-21/V3.2-30 的 quality 结论）。

## 关键文件 / 命令 / 验证

- 计划真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md`。
- Sprint3 证据：`artifacts/v3-final/sprint3-{cold-matrix-20260815-v3,progressive-20260815,storm-20260815,diagnostics-20260815,followup-20260815}/`。
- 隔离验证入口：`sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted|compile|full [--keep] [--env NAME=VALUE] -- COMMAND`。
- LOC ledger 生成参考：对比固定基线 `d7f23d5`（31,638 行）与当前 worktree，用 `scripts/count-production-ts.mjs` 的 `countProductionTs`；硬上限 `Math.floor(31638*1.05)=33,219`；当前候选 33,215（4 行余量，Sprint4 起步前如需新增生产代码请先规划偿还或确认余量）。

## 给下一会话的第一步

```sh
git log --oneline -5
git status --short
```

确认 HEAD 是 `0736713`（或更新）、工作树干净，再读 development-plan 第 630-680 行，开始 Sprint4 的 telemetry 覆盖度核查（第一步）。
