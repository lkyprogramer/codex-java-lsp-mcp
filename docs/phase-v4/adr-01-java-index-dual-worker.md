# ADR-01：JavaIndex 双 worker 并发模型

- 状态：`ACCEPTED`
- 日期：2026-08-17
- 任务：V4-05
- 解除边界：V3.2 硬门第 8 条「不新增第二 scheduler」。本 ADR 新增的是第二 worker **线程**，不是第二套 sweep 调度语义。

## 背景

V3.2-17 已定性：storm foreground P95 / quiet = 7.72×–13.24×（门槛 ≤1.10）的主因是单 worker 线程同时承担前台 `QUERY_*` 与后台 `processBackgroundChunk`。`startBackgroundLoop()` 与 `handle()` 共享同一条 Node worker 事件循环；sweep 只在 chunk 之间 `yieldToMessageLoop()`，前台请求仍被解析 CPU 饿死。

这不是待办事项的重开，而是用 ADR 把已关闭的架构结论转成可实施的并发模型。

## 决策

采用 **消息移交（message handoff）+ 查询线程单写者**，而不是「sweep 写 / 查询读快照」。

| 线程 | 职责 | 不做什么 |
|---|---|---|
| Query worker（现有 `java-index-worker.ts` 的命令面） | 拥有 live `JavaIndexStore`；处理全部 `QUERY_*`、前台 `REFRESH` / `REFRESH_RESOURCES` / `ensureFresh` / `ACTIVE_ANCHOR`、`STATUS`、`FLUSH`、snapshot persist | 不在本线程跑 `discoverJavaFiles` / `refreshFile` 的后台 chunk 循环 |
| Sweep worker（新线程） | 发现源文件、按现有 `prioritizeJavaFilesForBackgroundSweep` 切 chunk、解析、把 **已解析 facts** 以消息交回 query worker | 不读、不写 live store；不另起一套 lease/sweep 调度 |

调度语义保持不变：

- 仍是一个 background sweep、一个 machine-level sweep lease、同一套 root coverage / `isJavaIndexCompleteAt` 证明；
- `beginBackgroundSweep` 的 piggyback / generation catch-up 规则原样搬到 sweep worker；
- feature flag `JAVA_LSP_JAVA_INDEX_DUAL_WORKER=1` 打开双线程；默认保持单 worker，直到 storm 门禁两轮通过后再删旧路径（计入 V4-13 偿还）。

## 为什么不选「sweep 写、查询读快照」

前台新鲜度路径（`ensureFresh`、`ACTIVE_ANCHOR`、单文件 `REFRESH`）必须在查询返回前落到 live store。若 sweep 是唯一写者，这些路径要么等 sweep 发布快照（把冷启动税加回热路径），要么再引入第二条写通道（破坏单写者）。消息移交把 CPU 重活搬走，同时让 query worker 继续是唯一 store 写者，facts/edges/snapshot digest 可以保持与单 worker 逐位等价。

## 门禁（相对 Sprint0'，不得池化历史数字）

- `scripts/run-storm-gate.mjs`：foreground P95 / quiet ≤ 1.10，且 `staleCount=0`；
- 最终 facts / edges / snapshot digest 与单 worker 逐位等价；
- `T_complete` 相对 Sprint0' 不退化 >10%；
- 峰值 RSS 增幅 ≤10%。

## 回滚

flag 关闭即回到当前单 worker。门禁未过两轮之前，禁止把双 worker 设为默认，也禁止在拆 god file（V4-08）时顺手改调度语义。
