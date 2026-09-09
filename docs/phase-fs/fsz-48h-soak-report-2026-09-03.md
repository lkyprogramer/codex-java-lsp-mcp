# FSZ 编辑负载 48h 采样报告

- 窗：2026-09-01T06:58:33Z → 2026-09-03T07:24:19Z（**48.43h**）
- 线上：`buildSha=6148de23d3cd`（FSZ，`codex/fs-track`），LaunchAgent pid **91592** 全程未换
- 对照：FSY `0f9cc14` 窗 2026-08-30T14:38Z → 2026-09-01T01:45Z
- 原始账本：`docs/phase-fs/fsz-48h-heap-growth.jsonl`（8 条）；impact 抽查：`docs/phase-fs/fsz-48h-impact-probe.json`
- 计划门槛：`docs/deep/codex-java-lsp-mcp-worktree-family-memory-sharing-plan-2026-08-27.md` §8.4

## 1. 结论

**时长已满 48h。§8.4 字面四条不全绿，判定 FAIL。**

意图上：FSY 那条「lishu-v2 后台涨到 1103 再 JsonStringify 撞 1536 墙」**本窗没有再现**。0 FATAL、0 EBADF、0 撞墙；查询抽查通过。失败点是「重建次数 / 爬升规则 / lishuedu 一次指纹丢快照后的高水位平台」，不是又一次 OOM。

| §8.4 | 结果 | 证据 |
|---|---|---|
| 1. 0 daemon FATAL、0 EBADF、0 worker 撞墙 | **PASS** | 本 ready 窗（log 1683 起）fatal=0 ebadf=0；pid 91592 连续 48.4h |
| 2. 换气/重建有序且 ≤3 次/24h，事后 heap 回基线 ±10% | **FAIL** | recycle=0；compact 日志 26 条 / T0 后 budgeted **23**；lishuedu 484→1139 未回落 |
| 3. jsonl 无单调爬升段超过 12h | **FAIL** | 热仓 max 774→1139，采样器从 T+13.4h 起一直标爬升（幅度由 lishuedu 一跳贡献） |
| 4. 抽查 java_impact | **PASS** | 2026-09-03T02:10Z，lishu-v2 133–153ms，18 context，heap Δ0 |

按文档「任何一条不过，回到 FSZ3 的失败处理路径重新裁决」——应裁决，不是宣布验收通过。

## 2. 采样序列

6h 监视 + 本报告手动补的第 8 拍（跨 48h）。SHA 全程 `6148de23d3cd`。

| # | UTC | h | verdict | lishu-v2 | lishuedu | cipherlink | exam | compactB | 备注 |
|---|---|---:|---|---:|---:|---:|---:|---:|---|
| 1 | 09-01 06:58 | 0 | OK | 774 | 484 | 13 | 632 | 0 | T0；exam 仍热；预热 compact 3 次不进预算 |
| 2 | 09-01 14:24 | 7.43 | OK | 782 | 484 | 10 | 16 | 2 | exam 睡回；lishu-v2 files 2818→2891 |
| 3 | 09-01 20:24 | 13.43 | WARN | 782 | 485 | 15 | 16 | 2 | 平台；规则把 +8MB/13h 标成爬升 |
| 4 | 09-02 03:22 | 20.39 | WARN | 795 | **探活失败** | 11 | 14 | 9 | lishuedu 丢快照冷建中 |
| 5 | 09-02 09:22 | 26.39 | FAILED | 831 | **1135** | 10 | 13 | 14 | 24h 字面收口 FAIL；lishuedu +650MB |
| 6 | 09-02 17:25 | 34.44 | FAILED | 847 | 1136 | 13 | 15 | 18 | lishuedu 冻住；exam files 回填 |
| 7 | 09-03 01:59 | 43.02 | FAILED | 913 | 1136 | 14 | 16 | 21 | lishu-v2 加速 +66/8.6h |
| 8 | 09-03 07:24 | **48.43** | FAILED | **894** | **1139** | 12 | 17 | **23** | 48h 点；lishu-v2 GC 回落 |

冷仓 cipherlink / exam 全程 10–17 MiB（T0 exam 632 是预热+status 打热，+7h 已睡）。heartbeat 没有把冷仓拉活成热 isolate。

## 3. 对照 FSY（同机器、同四仓）

FSY live `0f9cc14`，recycle 全程 0，窗口里有历史 FATAL（lishu-v2 JsonStringify OOM）。

| 仓 | FSY 首 | FSY ~13h | FSY 峰 / 结局 | FSZ T0 | FSZ 48.4h |
|---|---:|---:|---|---:|---:|
| lishu-v2 | 784 | **1080** | **1103 + OOM**（后冷启 822） | 774 | **894** |
| lishuedu | 485 | 484 | 484 平 | 484 | **1139**（一次重建抬上去后冻 ~22h） |
| cipherlink | 12 | 12 | 13 | 13 | 12 |
| exam-parent-v3 | 15 | 15 | 20 | 632→16 | 17 |

- FSY 死在「编辑仓单调爬升 + 快照全量 stringify」。FSZ 编辑仓 48h 净 +120MB（774→894），files 2818→2929，**没有撞墙**。
- FSZ 的高水位换到了 lishuedu：不是慢泄漏，是 9/2 上午一次身份不匹配丢快照后的进程内 6k 文件重建。

## 4. heapSplit（FSZ4 字节账）

`knowledgeBuilderBytes` 全程 **0**（按设计，不在热路径累加）。intern / entitySearch 在编辑仓上近似平台，不是 append-only 无界。

### lishu-v2（编辑负载仓）

| | T0 | +48.4h | 变化 |
|---|---:|---:|---|
| heapUsedMb | 774 | 894 | +120 |
| files | 2818 | 2929 | +111 |
| columnarBytes | 9.5M | 19.5M | 前 7h 升到 ~19M 后平台 |
| stringTableBytes | 70.0M | 72.0M | +7h 后锁在 75,497,472 |
| tombstoneRatio | 0 | 0.037 | 峰值 0.180（+26h），compact 压回 |
| entitySearchBytes | 42.8M | 46.8M | +4.0M / 48h |
| graphBytes | 34.8M | 38.2M | 缓增 |
| otherBytes | 576M | 695M | heap 主体，随编辑/GC 波动 |
| graphSynced | true | true | |

intern 锁死在 72MiB、墓碑被 compact 打回，说明 FSZ3 对 **lishu-v2 的 REFRESH 增长**是有效的。heap 主体在 `otherBytes`（V8 / 解析残留），不是列/intern 无界涨。

### lishuedu（热 pin，本窗几乎无持续编辑，一次重建）

| | T0 | +20h | +26h | +48.4h |
|---|---:|---|---:|---:|
| heapUsedMb | 484 | 探活失败 | **1135** | **1139** |
| graphSynced | false | — | true | true |
| graphBytes | 0 | — | 38.6M | 38.6M |
| otherBytes | 241M | — | 843M | 846M |
| stringTableBytes | 136.0M | — | 136.0M | 136.0M |

T0 是 files-only 水线。重建后 graph 进进程、`otherBytes` +600MB，之后 **22h 几乎不动**（1135→1139）。这是阶跃，不是 FSY 那种 6–13h 内 +270MB 的斜坡。

1139 < 1200，FSZ1 心跳换气从未开火（recycle=0）——阈值没到，不是看护没挂上。

## 5. compact / recycle 账

- recycle（`worker heap recycle` / `source=heartbeat`）：**0**
- compact 日志：本窗 26 条；T0 预热 3 条不进 24h 预算；budgeted **23**
- 采样器按「每条 compact 日志 = 1 次重建」计数，所以 24h 收口起 soak=FAIL 钉死

分簇（按 intern 代际，不是 23 次独立事故）：

1. **T0 预热**（不进预算）：lishu-v2 / exam 首次 hydrate，墓碑 0.18–0.55 → 0。
2. **+7h**：exam 休眠路径 intern 18MB + lishu-v2 75MB 各一次。
3. **+20h lishuedu 丢快照后从零重建**：intern 80KiB → 147k → … → 73MB 梯子（7 条），紧接着 142MB 平台上连打。
4. **+26h 之后**：lishuedu intern 142MB→75MB 的重复 compact，heap **不回落**（1135 平台）。这是「有序但空转」：墓碑清了，高水位 `otherBytes` 还在。

字面 ≤3/24h 被第 3 簇单独打穿。若把「一次指纹丢快照冷建」算 1 个有序重建事件，次数故事会改写，但第 2 条后半「heap 回基线 ±10%」对 lishuedu 仍不成立（484→1139）。

## 6. lishuedu `snapshot identity mismatch`（FSZ4 取证）

**不是心跳误删，也不是 git SHA 进了身份。**

身份四字段：`extractorVersion` / `stableIdVersion` / `canonicalRepoRoot` / `buildFingerprint`。`buildFingerprint` 含根和 module 的 `pom.xml` / `build.gradle.kts`。

9/2 CST 上午（主仓，作者 git `kaiyao.luo`，无 MCP `java_*`）：

| CST | 事实 |
|---|---|
| 11:07 | `modules/subscription/...` 落盘 |
| **11:09:03** | 根目录 `build.gradle.kts` +1 行 `api("com.alibaba:easyexcel")`（后入 `6c234cfc0`） |
| 11:09 | worker 91614 写出 snapshot tmp（flush 中途） |
| stderr:1698 | `discarding .../6496e5a49fd9/java-index-snapshot.json.gz: snapshot identity mismatch` |
| 随后 | intern 梯子 + `cold-build child failed` |
| 11:16–11:17 | 新快照 `createdAt`；`cold-build-metrics.json` files=6086，rssPeak=1.30GiB，**total=300.55s** |
| 11:22 | 采样器 `java_status` 失败（撞重建） |
| 11:29 | 上述提交进 develop |

`COLD_BUILD_CHILD_TIMEOUT_MS=300_000`。子进程 300.55s 已写完 28MB 快照，父进程按 300s SIGKILL，日志当失败，再在进程内 parse 6k 文件 → compact 风暴 + heap 留在 1135。

当前盘上快照与 live 指纹、canonicalRoot、extractor **一致**。旧快照已被 rm，无法做字节级 A/B。工作树上其它 lishuedu worktree **没有独立 cache**，不是 worktree 误删主仓。

**FSZ4 原嫌疑「分支/commit 过严」不成立。** 过严点是 **build marker 一改就整库 discard**，外加冷建超时卡在完成线上。

## 7. java_impact 抽查（§8.4 第 4 条）

- 时间：2026-09-03T02:10:29Z（T+43.2h，heap 采样点之间）
- 锚点：`apps/lishu-education-backend/.../LishuEducationBackendApplication.java` L1C1
- `mode=minimal` `semanticPolicy=fast` `deadlineMs=15000`

| 次 | 墙钟 | 服务端 | 结果 |
|---|---:|---:|---|
| 1 | 133ms | — | 成功 |
| 2 | 147ms | — | 成功 |
| 3（metrics） | 153ms | **50ms** | 18 context（TGT1/REL16/CFG1） |

`freshness.coverage=COMPLETE`，`indexedGeneration=955`（编辑负载确实在刷索引），`changedDuringRequest=false`，`estimatedTokens=1504`。无旧工具名、无超时。热仓默认 3s 门，实测远低于。

调用前 heap 874 → 调用后 **874（Δ0）**；lishuedu 旁路仍 1136。L1C1 解析到 symbol=`package`（弱锚），仍返回同包 composition/Feign 相关文件，足够证明查询路径热且不抬 heap。

## 8. 机制对照（FSZ1–3 在本窗的表现）

| 卡 | 本窗观察 |
|---|---|
| FSZ1 5min 心跳换气 | 挂上了（热 pin 一直活、冷仓会睡）。heap 从未 >1200，故 recycle=0 是阈值判断，不是失效。1139 距阈 61MB。 |
| FSZ2 流式快照编码 | 本窗 0 FATAL、0 JsonStringify 撞墙。FSY 两次 OOM 同栈未再现。 |
| FSZ3 REFRESH compact | lishu-v2 intern/墓碑有界，编辑 +111 文件未走 FSY 斜坡。副作用：lishuedu 重建期 compact 日志暴增，且 compact **拉不回 otherBytes 高水位**。 |
| FSZ4 heapSplit | 字段齐全；`knowledgeBuilderBytes=0`；entitySearch 缓增非无界。 |

## 9. 裁决（§8.4 失败处理）

回到 FSZ3 路径，而不是宣称合 main 条件已齐。建议分开看：

**已闭环、不必为 48h 字面再空转**

- FSY 同型 worker 撞墙：本窗未发生。
- 零 MCP 后台泄漏：lishu-v2 编辑负载下 intern/墓碑有界。
- 查询可用性：impact 抽查通过。

**仍要另立/回炉的点（按杀伤）**

1. **buildFingerprint 变更 → `rm` 整份快照**（本窗 lishuedu 1139 的真源）。gradle/pom 一行不应等于 6k 文件冷建。
2. **冷建超时 300s 误杀 300.55s 成功子进程**，父进程落入进程内 parse，heap 不回 files-only 基线。
3. **§8.4 计数口径**：一条重建里的 N 次 compact 不应计 N 次；12h 爬升规则把 +8MB 和 +650MB 阶跃当成同类。不改口径，字面永远 FAIL。
4. **compact 后 otherBytes 不回落**：墓碑清了，1139 仍在。若要满足「回基线 ±10%」，需要换气或真正释放解析残留，而不是再 compact。

合 main：文档写「全绿后合 main」。当前不是全绿。若改为意图验收（0 撞墙 + 编辑仓有界 + 查询可用），需要显式改 §8.4 口径后再合；本报告不代替那次改口。

## 9.1 裁决落点（2026-09-03 补）

上述 4 点已在计划 §9（R4）拆成真因与 FSR0–FSR4 卡：本窗最重要的事实不是「重建次数」，而是 **heap 主体 75–78% 落在 `otherBytes` 未归因**，且同一批 facts 从快照 hydrate 是 484 MiB、进程内 parse 是 1135 MiB——表示随到达路径不同。§9 中「compact 拉不回 otherBytes」由此得到解释：compact 只作用在已归因的 ~15%。合 main 条件改按 §9.5 FSR4 口径。

## 10. 监视

6h durable scheduler `01a05bc4e9ba7c019944c9f32b46b0ba` 仍在。48h 点已采。继续挂只会重复 FAILED，除非要盯 lishuedu 会不会破 1200 触发第一次心跳换气。
