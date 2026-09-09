# FSR 24h 采样失败报告（`4ce48953d27c`）

- 线上：`buildSha=4ce48953d27c`（`codex/fs-track`，FSR1–4 代码在 `f1969ee`；后两笔是安装器测试 flake 修复）
- 计划门槛：`docs/deep/codex-java-lsp-mcp-worktree-family-memory-sharing-plan-2026-08-27.md` §9.5 FSR4
- 对照：FSZ 48h `docs/phase-fs/fsz-48h-soak-report-2026-09-03.md`（`6148de23d3cd`）
- 原始账本：
  - 重启前（pid 80747，**未满 24h，不是 PASS**）：`docs/phase-fs/fsr-pre-reboot-heap-growth.jsonl`
  - 重启后（pid 1611，24h 门 FAIL）：`docs/phase-fs/fsr-24h-post-reboot-heap-growth.jsonl`
- 现场日志：`~/Library/Logs/codex-java-lsp-mcp/daemon.stderr.log` 本窗从 **L1747** `HTTP daemon ready`
- 采样器：`~/Library/Logs/codex-java-lsp-mcp/fsr-watch/`（重启前归档在 `fsr-watch-pre-reboot-20260904/`）

本文只整理**已经采到、可以独立复述**的事实，以及与代码对得上的因果。不宣布合 main，也不在这里改代码。

## 1. 结论：够不够证明问题？

**够。** 重启后序列在 `watchHours=29.62` 按 FSR4 字面收口 **FAIL**；现场还有一条比计数更重的功能故障：热 pin `lishu-v2` 从 ~2959 files 塌成 43，之后 24h 没恢复。

这不是 FSY/FSZ 那种 JsonStringify OOM。0 FATAL、0 EBADF、0 进程内 parse 事件、lishuedu 锁在 hydrate 基线。失败集中在 **FSR3 换气看护 + FSR1 skip 回退**。

| §9.5 FSR4 | 结果 | 证据 |
|---|---|---|
| 0 daemon FATAL / 0 EBADF | **PASS** | 本窗 fatal=0 ebadf=0；pid 1611 从开机到 T+35h 未换 |
| 0 进程内 parse 事件（`in-process parse files=`） | **PASS** | parseBudgeted=0 |
| recycle ≤ 2 次/24h 且每次回落到基线 ±10% | **FAIL** | 采样器 `recycleBudgeted=7`；第二簇换气后 lishu-v2 未回基线，files 2959→43 |
| heap > 1.4× hydrate 持续 ≥6h | **PASS（字面）** | 带基线的末点 483/480 < 1.4×；塌缩后无基线，闸门不算 |
| 单拍 >+30% 须 24h 内回落 | **采样器未记 FAIL** | 19→120 = +532% 未回落；soak step 用热仓 max=lishuedu，漏掉塌缩仓 |
| compact 不入账 | **按设计** | compact 79 只观察 |
| heapSplit `otherBytes` ≤ 15% | **FAIL（T0 就不满足）** | lishuedu ~20%；lishu-v2 T0 ~41% |
| 查询抽查 java_impact | **未做** | 本窗没有 impact 探针 |

**重启前 23.16h 序列不能当 24h PASS**，但足以当阳性对照：同 SHA、同四仓，1 次 recycle 后 lishu-v2 761→584、files 保住 ~2950，lishuedu 498→539，0 skip 风暴。机器 2026-09-05 10:55 CST 重启后换了 pid，才打出「连打换气 → skip → 空壳」这条链。

## 2. 两条序列

SHA 全程 `4ce48953d27c`。冷仓 cipherlink / exam-parent-v3 一直 files-only（prewarm `hydrate=false`），heap 10–16 MiB。

### 2.1 重启前 pid 80747（中断，IN_PROGRESS）

| # | UTC | h | verdict | lishu-v2 heap/基线/files | lishuedu | recycleB | 备注 |
|---|---|---:|---|---|---:|---:|---|
| 1 | 09-04 01:55 | 0 | WARN | 761/468/2936 | 498/505 | 0 | 墓碑 0.531；1.63× 基线 |
| 2 | 09-04 08:35 | 6.66 | OK | **556/481/2946** | 525 | 1 | 心跳 recycle 1 次，墓碑 0.042 |
| 3 | 09-04 18:13 | 16.29 | OK | 579/481/2952 | 539 | 1 | graphSynced=false 观察 |
| 4 | 09-05 01:05 | 23.16 | OK | 584/481/2952 | 539 | 1 | 主机随后重启 |

本窗 recycle 日志（ready 之前，属旧进程）：L1738 `heapUsedMb=762 thresholdMb=749 source=heartbeat`。一次越门、一次换气、hydrate 基线 468→481，heap 落到 1.16×。

### 2.2 重启后 pid 1611（24h 门 FAIL）

T0 = 2026-09-05T03:37:06Z。ready 窗 L1747。开机预热四 pin 都 `prewarm end`，无 discard、无 skip。

| # | UTC | h | verdict / soak | lishu-v2 | lishuedu | recyc | skip | 备注 |
|---|---|---:|---|---|---:|---:|---:|---|
| 1 | 09-05 03:37 | 0 | OK / IN_PROGRESS | **737/472/2955**（1.56×） | 499/496 | 0 | 0 | 距 1.6× 门 755 只差 18 MiB |
| 2 | 09-05 08:43 | 5.11 | OK / IN_PROGRESS | **483/480/2959** | 500 | **3** | 0 | 第一簇 3 条 recycle |
| 3 | 09-05 15:14 | 11.62 | WARN / IN_PROGRESS | **19/—/20** | 500 | **7** | 1 | 第二簇 + skip 3013 + DEADLINE |
| 4 | 09-05 21:14 | 17.62 | WARN | 120/—/43 | 500 | 7 | 120 | familyRootCount=7，worktree 挂空壳 |
| 5 | 09-06 03:14 | 23.62 | WARN | 177/—/43 | 500 | 7 | 127 | 差 23 min 满 24h |
| 6 | 09-06 09:14 | **29.62** | **FAILED / FAIL** | 178/—/43 | 500 | 7 | 127 | `recycle 7 exceeds 2/24h` |
| 7 | 09-06 15:14 | 35.63 | FAILED / FAIL | 178/—/43 | 501 | 7 | 127 | 冻结；无新 recycle/skip |

## 3. 已钉死的问题

### P0-1 心跳换气连打（FSR3）

本窗 8 条 `worker heap recycle`，全是 `event=false family=97ec2e32dd8a roots=1 source=heartbeat`，阈值始终 **755 = round(472×1.6)**（T0 的第一次 hydrate 基线）：

```
L1757 heap=824
L1758 heap=790
L1759 heap=790          ← 第一簇，采样器记 3 条
L1760 heap=759
L1761 heap=784
L1762 heap=786
L1763 heap=767
L1764 heap=790          ← 第二簇；与 L1758 正文相同，跨拍去重后预算 7 不是 8
```

采样器把**每一行日志**当一次 recycle 事件（`fsz-live-sample.mjs` + `fsr4CountLogLine`）。同一窗内相同正文不去重，跨拍才按正文去重，所以 8 行 → `recycleBudgeted=7`。FSR4 闸是 `> 2`，24h 后字面 FAIL。

即便把两簇合成 **2 次换气操作**（= 2/24h 帽），第二条仍违反「每次回落到基线 ±10%」：换气后不是 480±48，而是 20 files / 19 MiB。

代码对得上的机制（`src/repo-runtime-manager.ts`）：

1. 心跳 `heapRecycleIntervalMs` 默认 **300_000**，`pollIdleHeapRecycle` 每 family 一次 `maybeRecycleHighHeap`。
2. 阈值 `max(JAVA_LSP_WORKER_HEAP_RECYCLE_MB=0, 1.6× entry.hydrateBaselineHeapMb)`。基线用 `??=`，**recycle / 新 isolate 成功 hydrate 后不刷新**。worker 已报到 480，daemon 仍按 472→755 开火。
3. 打印 recycle 日志后立刻 `recycle()` + 对热 pin `prewarmRepo`（预算 `PREWARM_INDEX_MS=300_000`）。**没有冷却、没有 “hydrate 完成前禁止下一拍”**。
4. 空闲判断只看 `pendingForeground/pendingBackground`。OPEN 后台 rest-hydrate 不一定把这两计数抬起来，心跳可以在 hydrate 高峰（790–824）上把刚换过的 isolate 再杀掉。

推断（日志无时间戳，5 min 间距未直接量到）：两簇是多次 poll 打在「hydrate 过冲仍高于冻结阈值」上，不是单次调用打 3/5 行（单次调用只 `console.error` 一次）。

### P0-2 skip>500 不启动 cold-build，热仓变成空壳（FSR1）

第二簇之后紧接：

```
L1765 in-process parse skipped files=3013 cap=500
L1766–1767 columnar compact …
L1768 pinned repo prewarm index wait failed … Deadline exceeded before java-index.status
      at RepoRuntimeManager.prewarmRepo
      at RepoRuntimeManager.maybeRecycleHighHeap
      code: DEADLINE_EXCEEDED
```

之后同一句 skip 循环到 L1984（`files=3013 → 2996 → 2994 ×108 → 2988`），采样器记 **coldBudgeted=127**（`in-process parse skipped` 被算成 cold-build 事件）。**没有**任何 `cold-build child` / `cold-build child failed` 字面日志。

`beginBackgroundSweep`（`java-index-worker.ts`）：

- cold-build 子进程只在 `store.filesByPath.size === 0 && !coldBuildAttempted` 时 spawn。
- `unindexed > 500` 且 child 开启时：**打 skip 日志、`coverage.failed`、`return`**。不 spawn 子进程，不进程内 parse，不 `pendingIdleRecycle`。

所以 recycle 后若快照只恢复了部分 files（或 hydrate 被下一拍 recycle 打断），发现 ~3000 未索引文件 → 永久 skip。FSR1 文档写的是「files-only + 指数退避重试子进程」；线上这条回退**没接上子进程**。

结果：lishu-v2 files 2959→20→43，无 `hydrateBaselineHeapMb`，`familyRootCount` 从 1 变成 7（worktree 往塌缩 isolate 上挂，`poolBundles=336` vs `thisRootFiles=43`）。heap 19→120→177 是空壳上回填，不是正常 hydrate。

### P0-3 T0 已在 1.6× 门沿，FSR2 未把表示压到 hydrate 形

| 点 | lishu-v2 heap/基线 | × | otherBytes | intern |
|---|---|---:|---|---|
| 重启前 T0 | 761/468 | 1.63 | 49.8% | 75.5M |
| 重启前 +23h | 584/481 | 1.21 | 42.2% | 75.5M |
| 重启后 T0 | 737/472 | 1.56 | 40.9% | 142.6M |
| 重启后第一簇后 | 483/480 | 1.01 | 18.7% | 142.6M |
| 塌缩后冻结 | 178/— | — | 87.8% | 1.2M |

lishuedu 全程 499–501 / 496（1.01×），files 6090，intern 锁 142.6M，tombstone 0.023，**otherBytes 约 20%**。FSR4 目标 ≤15%，T0 就不满足。这与 §9.2「稳态堆取决于到达路径、FSR2 未做完」一致：FSR3 用 recycle 当表示归一的备选，生产上第一次 hydrate 就已经靠近 1.6× 门，换气变成高频而不是例外。

重启后 T0 intern 142.6M 与 lishuedu 同一数量级（family/共享 intern 或 hydrate 路径差异），重启前 lishu-v2 intern 只有 75.5M。报告为观察，不当成已证根因。

## 4. 明确不是问题的部分

- **没有撞 1536 墙、没有 FATAL、没有 EBADF。** FSY 的 JsonStringify OOM、FSZ 的 lishuedu 484→1139 指纹 discard 本窗都没再现。
- **lishuedu 稳。** 指纹加载+调和（FSR1a）在这次切流预热上成立：新 ready 窗无 `snapshot identity mismatch`。
- **0 越限 in-process parse。** skip 帽 500 挡住了 FSZ 那次 6k 进程内 parse；代价是 P0-2。
- **compact 不是 soak 事件。** 墓碑在塌缩前能被压回（重启前 0.531→0.002）。
- **冷仓 files-only 是预热设计**，不是故障。

## 5. 采样口径缺口（分析时不要误用）

1. recycle 按日志行计，不按「一次换气操作」计；相同 `heapUsedMb` 正文跨拍会丢。
2. `in-process parse skipped` 记入 cold-build WARN，不是独立门。本窗 127 是同一 skip 循环，不是 127 次子进程。
3. 爬升/阶跃 soak 输入用热仓 **max heap**（lishuedu 500），lishu-v2 的 19→120 阶跃不会写成 soak FAIL。
4. 塌缩后没有 hydrate 基线，1.4× 闸直接不算。
5. Grok 6h loop 在会话休眠时会晚开火（本序列实际间隔 5–6h，曾晚过 38 min / 3.6h）。不影响 24h 计数方向，但不要把采样点当成精确 6h 节拍。

## 6. 给后续优化的切入顺序

按「现场已证、改动面小、能挡住空壳」排，不是完整设计：

1. **换气冷却 + 刷新基线**（FSR3）  
   recycle 后直到 `factsHydrated && files≈换气前`（或明确 DEGRADED）禁止下一拍心跳换气；`hydrateBaselineHeapMb` 在成功 prewarm 后改写，不要 `??=`。没有冷却时，1.6× 门会打在 hydrate 过冲上。
2. **skip 必须接 cold-build 或完整 snapshot hydrate**（FSR1c）  
   `unindexed > 500` 时禁止只 `coverage.failed` 返回。store 非空但缺口 >500 也应 spawn/重试子进程，或等 own-snapshot rest 完成后再决定 skip。
3. **recycle 计数改成按 family 去抖**（FSR4 口径）  
   同一 family、同一 5–10 min 窗的连续 heartbeat 行算 1 次操作；并断言「回基线 ±10%」，否则即使次数 ≤2 也 FAIL。
4. **FSR2 表示归一仍是堆体积的主卡**  
   否则 T0 就会站在 1.6× 门沿，看护只能反复换气。otherBytes 20–41% 相对 ≤15% 目标未动。
5. **不要用 rollback 当第一反应**  
   回滚 `6148de2` 能躲开连打换气，但会回到 FSZ 的绝对 1200 阈值和 lishuedu 丢快照路径。先修 P0-1/P0-2。

## 7. 未覆盖 / 不要声称已证

- 没有 java_impact 抽查，查询正确性与延迟未知（塌缩后的 lishu-v2 几乎肯定 DEGRADED）。
- 没有 heap snapshot（FSR0 三态归因未在这次 live 上重做）。
- 日志行无墙钟，5 min 连打间距是代码默认值 + 簇状日志的推断。
- 48h 编辑负载窗没跑完；重启后有效观察是 ~11h 健康 + ~24h 空壳。
- `JAVA_LSP_COLD_BUILD_CHILD` 生产未设 `0`，child 路径按代码是开的；本窗没走到 spawn 是因为 skip 在 `filesByPath.size===0` 条件之前就 return。

现场 daemon 仍是 `4ce48953d27c` / pid 1611 / lishu-v2 43 files。6h 采样 loop 未停，后续拍不会改变 24h FAIL 结论，除非有人明确要求停监控或切流。
