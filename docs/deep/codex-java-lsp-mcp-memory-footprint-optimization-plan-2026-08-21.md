# `codex-java-lsp-mcp` 内存占用彻底优化方案（M 轨道）

> **日期**：2026-08-21  
> **状态**：ADOPTED（本文档同时是 JIN R1 计划 N1 RSS 升级项 0A.4(4b) 的正式裁决记录）  
> **触发**：JIN Phase N1 索引期基准（`docs/phase-jin/jin-phase-n1-closeout.json`）：lishuedu 冷建 RSS Δ2344 MiB、稳态 heapUsed 838 MiB；用户工作负载为 **2–3 个项目并行开发、每项目 1–2 个 worktree**（最多 4–6 个并发 runtime，可能跨多个 stdio 进程），当前量级不可接受。  
> **裁决**：原 N1「RSS ≤ 512 MiB/仓」门**不放宽、但重新定义**——该门把「分配器高水位」「稳态对象模型」「native 解析缓存」混在一个数字里，不可执行也不可归因。本文档以分解后的数字门取代之（§3），并作为 JIN 主计划的前置轨道（M 轨道）执行。  
> **执行约束**：沿用 JIN R1 文档第 0A 章全部硬禁令与测试分级（T0–T4）；本文任务卡格式与 15A 一致，AI 可自主执行，无需用户参与决策。

---

## 1. 问题解剖：838 MiB / 2.3 GiB 到底花在哪

### 1.1 三层分解（lishuedu，60,119 节点 / 117,630 边）

| 层 | 量级 | 性质 | 证据 |
|---|---|---|---|
| A. JS 堆稳态：JavaIndex 对象模型 | **838 MiB** | 常驻（runtime 存活期间） | `heapUsedMiB: 838` |
| B. RSS − heap ≈ 1.5 GiB：tree-sitter native + 分配器高水位 | 峰值驻留 | 冷建期间冲高，之后不还给 OS | `rssDeltaMiB: 2344`；解析树 LRU 上限只有 64 MiB 源码字节（`parse-tree-cache.ts`），说明大部分是高水位不是活对象 |
| C. 磁盘 | 23 MiB（gz） | 无问题 | snapshot v3 gzip |

对照信息量：同一个仓的 JIN 知识图快照 gzip 只有 **1.7 MiB**；JavaIndex snapshot gzip 23 MiB，解压后 JSON 约 140–190 MiB。**同样的信息，对象模型在 V8 堆里膨胀到 838 MiB（约为 gz 的 36 倍）**。这就是主攻方向。

### 1.2 对象模型为什么这么胖（按 `index-types.ts` 归因）

1. **深嵌套小对象**：`JavaMethodFacts` → `callSites[]`（每个调用点一个 `JavaCallSiteFact`）→ `argumentTypeHints[]`（每实参一个 `JavaTypeRef`）→ `JavaTypeRef` 递归（`typeArguments[]`、`resolution` 判别联合对象）。一个中等方法 10 个调用点 × 2 实参 × 递归 TypeRef ≈ 50+ 个 JS 对象；V8 每对象 ~50–80 字节头部开销，百万级小对象 = 数百 MiB 纯开销。
2. **字符串不驻留**：`fromId`/`toId`/`ownerTypeId`/`methodIds[]`/`sourceFile`/`qualifiedName` 等长复合 ID 字符串（`file#type#member#hash` 形态）在 facts、edges、reverse 索引里**逐份复制**。V8 不会自动合并动态构造的字符串。117k 条 `StaticEdge` 每条至少 4 个长字符串。
3. **SourceRange 遍地开花**：每个 import/注解/参数/调用点/边都挂 `range`（1 个 range 对象 + 2 个 point 对象 ≈ 3 × 60 字节），实际信息只有 4 个小整数。
4. **JSON.parse 整体物化**：snapshot 加载 = 190 MiB JSON 一次性 parse 成完整对象森林，峰值翻倍，加载后全量常驻——**即使一次查询只碰几十个文件的事实**。
5. **B 层（1.5 GiB 非堆）**：冷建扫全仓时解析树在 native 堆里高速流转，逐出时 `tree.delete()` 会释放，但 macOS 分配器不及时归还页面 → RSS 高水位驻留到进程退出。

### 1.3 多 worktree/多项目场景的放大系数

- 同进程内有 `maxActiveRepos` 帽（≤24 GiB 机器 = 1）+ LRU 逐出 + idle TTL 15 分钟——单进程不叠加。
- **但每个 stdio 会话是独立进程**：3 个项目 × 2 个窗口 = 最多 6 个进程，各自一份对象模型。跨进程只有解析缓存预算会自适应收缩（64→32→24 MiB），**对象模型不收缩**。最坏情况 6 × 0.8 GiB ≈ 5 GiB 稳态 + 冷建峰值可能同时发生。
- worktree 快照播种（`worktree-snapshot-seeder.ts`）省的是冷建时间，**不省稳态内存**。

---

## 2. 方案总览：五个支柱

```text
支柱 P1  列式紧凑核心存储        —— 消灭 A 层（838 MiB → ≤ 200 MiB）
支柱 P2  快照 v4 分段二进制+惰性  —— 消灭加载峰值，按需驻留
支柱 P3  冷建子进程化            —— 消灭 B 层高水位（建完即归还 OS）
支柱 P4  跨进程/多 worktree 治理  —— 全机总量可控（信号量+两级 TTL+段共享）
支柱 P5  测量与回归门            —— 行为零改变（identity 门）+ 数字门
```

核心思路一句话：**信息量只有 ~20 MiB 的东西，不应该以 800 MiB 的形态活在堆里**。把「存储真源」从 JS 对象森林换成「单块 Buffer + 字符串表 + 列式偏移」，对象只在被查询触碰时**按需短命物化**（正好喂给 V8 年轻代 GC）。

### 2.1 明确不做（边界）

- **不引入** SQLite/LMDB/RocksDB 等 native 依赖（隔离与零依赖纪律；自定义二进制段格式足够）。
- **不重写** `router-java-index.ts`（62K）及各 provider 的查询逻辑——通过**兼容物化层**让它们拿到与今天完全相同形状的 fact 对象（§4.3）。
- **不改变**任何 facts 语义/字段/ID 规则（`stableIdVersion` 不动），不改变默认选择与输出——这是纯存储层改造，出口用 T3 identity 矩阵证明。
- **不动** JDTLS（`jdtlsXmx` 独立话题）；不动 JIN 知识图（它已经足够小）。
- **不做**分布式/常驻共享服务进程（个人使用场景，复杂度不值得）。

---

## 3. 数字门（取代 JIN N1 的单一 RSS 门）

以 `scripts/run-jin-index-benchmark.mjs` 扩展后的口径测量（§7 M0 卡定义），三仓 + 多 runtime 场景：

### 3.1 单仓门（lishuedu = 最大仓基准）

| 门 | 现状 | 目标 | 说明 |
|---|---|---|---|
| G1 热稳态 JS heapUsed | 838 MiB | **≤ 200 MiB** | 建完/加载完、`pendingBackground=0` 后 |
| G2 热稳态进程驻留（heap + snapshot Buffer + native 缓存） | ~2.3 GiB | **≤ 400 MiB** | 冷建走子进程后，主 worker 只有加载态 |
| G3 冷建峰值（子进程内） | 2344 MiB | **≤ 1536 MiB** | 子进程退出即归还 OS，主进程不承担 |
| G4 快照加载时间（v4 惰性） | 全量 JSON.parse | **≤ 2s 可服务**（懒段后台补） | 现基线随 v3 全量 parse |
| G5 warm 查询 p95 回归 | 基线 | **≤ +10%** | 惰性解码的代价护栏；用 N3 候选池回放口径 |

中小仓（cipherlink/exam 级）：G1 ≤ 64 MiB、G2 ≤ 128 MiB。

### 3.2 全机场景门（用户真实工作负载）

| 场景 | 门 |
|---|---|
| S1：3 仓热驻留（1 进程 HTTP 或 3 个 stdio 进程） | 稳态总增量 **≤ 1 GiB** |
| S2：S1 + 同仓第 2 个 worktree ×2（共 5 runtime） | 稳态总增量 **≤ 1.4 GiB** |
| S3：任意时刻全机同时冷建数 | **= 1**（跨进程构建信号量，其余排队） |
| S4：闲置 5 分钟的 runtime | 进入休眠态（heap ≤ 32 MiB），15 分钟完全拆除 |

### 3.3 identity 门（不可协商）

- M 轨道出口 **T3 三仓配对矩阵**（old=改造前树，new=改造后树）：recall/pRead/rReadMust/RangeLineRecall/holdout/tokens **逐位 identity**；p95 配对 ≤ 1.10。
- facts 等价 digest（§7 M0 定义）：新旧存储对全部文件物化出的 fact 对象规范化 JSON 哈希**逐文件相等**。

---

## 4. 详细设计

### 4.1 P1：列式紧凑核心存储（`src/java-index/columnar/`）

**字符串表（StringTable）**

- 全库唯一驻留：所有路径、FQN、simpleName、modifiers、ID 复合串进表，取回 `u32` 句柄。
- 存储：单块 `Buffer`（UTF-8 拼接）+ `Uint32Array` 偏移 + 哈希桶（open addressing，`Uint32Array`）。
- 复合 ID（`typeId`/`methodId`/`edgeId`）不再整串存储：存**成分句柄元组**（fileHandle, typeNameHandle, memberHandle, sigHashU32），对外 API 需要字符串时惰性拼接并 memoize。

**列式布局（Struct-of-Arrays）**

按实体各建一组平行 TypedArray（示意，字段对齐 `index-types.ts`，语义零变化）：

```text
files:    path[], module[], sourceRoot[], pkg[], contentHash[], size[], mtime[], parseState[], gen[] …
types:    fqn[], simpleName[], kind[], fileIdx[], enclosingIdx[], rangeIdx[], modifiersRef[], fieldSpan[], methodSpan[] …
methods:  name[], ownerIdx[], sigKey[], rangeIdx[], bodyRangeIdx[], paramSpan[], callSiteSpan[], throwsSpan[] …
callSites: kind[], name[], receiverRef[], arity[], argHintSpan[], rangeIdx[] …
typeRefs: （递归结构拍平为 arena）text[], simpleName[], qualified[], resolutionKind[], resolutionRef[], typeArgSpan[], arrayDepth[] …
edges:    kind[], fromRef[], toRef[], confidence(u8)[], rangeIdx[], sourceFileIdx[], resolutionKind[], gen[] …
ranges:   Int32Array，每 4 个一组 (startLine,startCol,endLine,endCol)，全库去重
```

- 变长子列表（parameters/callSites/typeArguments…）用 **span 索引**（start,len 指向共享 arena），零对象。
- ranges 全库去重进一个 `Int32Array` 池（同一行号四元组只存一次）。
- 反向索引（by-name、by-fqn、caller→callee 等现有 Map）改为排序数组 + 二分，或紧凑哈希（`Uint32Array` 桶）。

**增量更新**：列式结构对单文件重建不友好——采用**分代设计**：base 列式段（不可变）+ 增量 overlay（该文件的新 facts 以普通对象形态放小型 delta map，量级 = 编辑过的文件数，通常个位数）。查询时 overlay 优先。后台在 overlay 超阈值（如 64 个文件或 8 MiB）时做**段压实**（重建列式 base）。这与现有 generation/快照发布时序天然对齐。

### 4.2 P2：快照 v4（分段二进制 + 惰性加载）

```text
[header: magic|schemaVersion=4|identity(extractorVersion,stableIdVersion,buildFingerprint,repoRoot)|manifestFingerprint|gen|checksum]
[string-table 段]
[段目录: 每段 (kind, fileRangeStart, fileRangeEnd, offset, len, crc32)]
[files 元数据段]（全量常驻，很小：路径/hash/mtime，用于 manifest 校验与播种）
[facts 列式段 × N]（按源根分区；每段自含其行号区间）
[edges 段 × N]
[mybatis / entitySearch 段]
```

- **写**：沿用 `writeSnapshotAtomic` 的 temp+fsync+rename 原子语义，只换编码器；不再 `JSON.stringify` 190 MiB（这本身就是冷建峰值的一部分）。
- **读**：打开时只读 header + 段目录 + files 元数据段（毫秒级，G4 门）；facts/edges 段**按需读入**（`fs.read` 指定 offset）并解码为列式视图；LRU 保留最近段。全量常驻上限 = 快照原始大小（~100–150 MiB Buffer，off-heap），且只在全仓扫描型查询时才会全载。
- **兼容**：v3 快照读到即弃并重建（沿用「rebuildable cache，schema 不匹配即删」的既有语义，零迁移代码）。
- **worktree 播种升级**：段目录携带每段内容 crc → 兄弟 worktree 播种从「逐文件比对 + 全量重建对象」变成「段级复用 + 脏文件 overlay」，播种时间和内存同时下降。

### 4.3 兼容物化层（关键：不重写查询面）

新增 `FactsView` 访问层，签名与今日 store 相同（`fileBundle(fileId)`、`typeById(id)`、`methodsOf(typeId)`、`edgesFrom(id)`…）：

- 内部从列式段解码，**按需构造**与 `index-types.ts` 完全同形的对象返回；
- 每请求（RequestContext 生命周期）一个小型 memo cache，请求结束整体丢弃——物化对象只活在年轻代；
- `router-java-index.ts`、providers、JIN graph-builder 全部**零改动或只改构造入口**。

风险护栏：热点路径若因反复解码退化（G5 门），允许对 top-N 热文件保留解码缓存（LRU ≤ 32 MiB），仍远小于全量对象森林。

### 4.4 P3：冷建子进程化

- 全量冷建（OPEN 无有效快照 / schema 升级 / 播种失败）改为 **fork 一次性构建子进程**：子进程扫描+解析+写 v4 快照 → 退出（B 层高水位随进程消失）→ 主 worker 惰性加载快照。
- 增量更新（编辑驱动，毫秒级）留在主 worker，不走子进程。
- 子进程内解析树用「提取完即 delete」策略（构建期不需要 LRU 复用），并按源根分片流式写段，中间态不整仓驻留 —— G3 门。
- 失败语义：子进程崩溃 = 冷建失败，按现有 DEGRADED 路径处理，可重试。

### 4.5 P4：跨进程与多 worktree 治理

1. **全机构建信号量**：复用 `cross-process-lease.ts` 的锁机制加 `build-semaphore` lease：任意时刻全机最多 1 个冷建子进程（S3 门），其余 OPEN 走「快照缺失 → 排队等待或 DEGRADED 惰性服务」。
2. **两级 TTL**（替换单级 15 分钟）：
   - **T_hibernate（默认 5 分钟）**：丢弃解码缓存、overlay 压实落盘、释放解析树缓存、可选 `global.gc()` —— runtime 降到 heap ≤ 32 MiB 的「休眠态」，下次请求按 G4 快速回热；
   - **T_teardown（默认 15 分钟，沿用 `idleTtlMs`）**：完全拆除。
3. **内存压力响应**：`os.freemem()` 低于阈值（默认 2 GiB）时提前触发休眠/拆除（先动 LRU 最冷的 runtime）。
4. **同仓多 worktree 段共享（可选，M4 内做减法评估）**：同 `buildFingerprint` 的 worktree 打开时直接以兄弟的 v4 快照为 base（只读，段级 crc 校验），自己只持 overlay——稳态内存从 2 × base 变为 1 × base（OS 页缓存天然跨进程共享文件段）+ 2 × overlay。若实现复杂度超预算则降级为现状（各持一份惰性 base），S2 门按降级形态校准。

### 4.6 立即可用的止血措施（不等 M 轨道，今天就能用）

```bash
# 限制每进程活跃仓数（≤24GB 机器默认已是 1，可显式固化）
export JAVA_LSP_MAX_ACTIVE_REPOS=1
# 缩短闲置拆除（默认 900000 = 15 分钟，改 5 分钟）
export JAVA_LSP_IDLE_TTL_MS=300000
```

并行开 3 项目 × 2 worktree 时，建议只让当前正在交互的窗口保持 MCP 会话活跃（其余窗口的会话闲置 5 分钟即自动释放）。

---

## 5. 与 JIN 主计划的关系

- **插入位置**：M 轨道作为独立轨道，**优先于 JIN N4/N5 的后续迭代**执行（用户已裁决"先彻底优化内存"）。JIN 的 live 形态修复（N5 FAIL 的后续）在 M 轨道出口后恢复。
- **正式修订**：JIN R1 文档 §15 Phase N1 退出条件中的「RSS 增量 ≤ 512 MiB/仓」自本文档起由 §3 数字门取代；`jin-phase-n1-closeout.json` 的 escalate 项以本文档为 RESOLVED 依据。R1 文档不改写历史，只在 HANDOFF 记账。
- **禁令继承**：0A.2 全部硬禁令适用；本轨道不触碰排序/选择/输出（identity 门保证）。
- **LOC 预算**：M 轨道生产代码净增 ≤ +2,500 LOC（列式层 + v4 编解码 + 治理）；JIN N6 删旧链时一并核算总量门。

---

## 6. 测试分级（沿用 0A.3）

| 级别 | 本轨道用法 |
|---|---|
| T0 | 列式编解码/字符串表/span 索引的单元 + 属性测试（roundtrip、边界、并发读） |
| T1 | 每卡收口 `npm test` 全绿 |
| T2 | facts 等价 digest 回放（三仓逐文件）、内存基准（G1–G5、S1–S4）、N3 候选池回放护 G5 |
| T3 | **仅 M5 出口一次**：三仓配对矩阵 identity + p95 |
| T4 | 不涉及 |

---

## 7. 任务卡（M0–M5）

### M0：测量基线与归因剖析（时限 2 天）

- **目标**：先量化，不猜。产出三份基线：
  1. 扩展 `scripts/run-jin-index-benchmark.mjs` → `scripts/run-memory-benchmark.mjs`：分别报告 heapUsed 稳态、RSS 峰值/稳态、快照加载时间、warm 查询 p50/p95（复用 N3 候选池回放场景）、S1/S2 多 runtime 场景（多进程 fork 模拟 3 仓 + 2 worktree）；
  2. `node --heapsnapshot` 或 `v8.getHeapStatistics` + 采样统计：字符串 vs 对象 vs 数组的字节占比、top 构造器（预期验证 §1.2 的归因：TypeRef/CallSite/StaticEdge/Range/字符串五大头）；
  3. **facts 等价 digest 工具** `scripts/verify-facts-digest.mjs`：对全部文件物化 `JavaFileBundle`，规范化排序后 SHA-256，输出逐文件 digest 清单（M1–M3 每步的 identity 真源）。
- **边界**：只加测量脚本，零生产代码改动。
- **验证**：T0（脚本自测）；三仓基线数字入 `docs/phase-m/m0-baseline.json`。
- **失败处置**：无（测量任务）。若归因与 §1.2 显著不符（如字符串占比 < 30%），先修订本方案 §4 再开工 M1。

### M1：字符串表 + 列式 edges/ranges（时限 5 天）

- **目标**：最大且结构最简单的两块先落地：`StaticEdge` 全量列式 + 全库 range 池 + StringTable；`edgesFrom/edgesTo/references` 查询走 FactsView 兼容层。
- **边界**：`src/java-index/columnar/{string-table,range-pool,edge-columns,facts-view}.ts`；不动 methods/callSites（M2）；快照仍 v3（M3 换）——本卡先改**内存内**表示，v3 加载后转列式、对象森林即弃。
- **验证**：T0 属性测试（roundtrip：对象→列式→物化 === 原对象；digest 相等）；T2 facts digest 逐文件相等 + G1 阶段目标（lishuedu heap ≤ 500 MiB，即 edges/ranges/字符串三项兑现）；G5 查询 p95 ≤ +10%。
- **失败处置**：digest 不等 → 阻塞修复（identity 是硬门）；内存降幅 < 150 MiB → 用 M0 剖析工具重新归因一次再决定 M2 是否调整顺序。

### M2：列式 methods/callSites/typeRefs（时限 6 天）

- **目标**：拍平最深的嵌套：TypeRef arena（递归拍平 + span）、CallSite 列、参数/throws/typeParameters span 化；`methodById/methodsOf/anchor` 路径走 FactsView。
- **边界**：`ast-extractor.ts` 的提取输出仍是普通对象（提取器不改），由 builder 落列；overlay 分代机制（§4.1）在本卡落地。
- **验证**：同 M1（digest + G1 最终门：lishuedu heapUsed ≤ 200 MiB、cipherlink/exam ≤ 64 MiB）；T2 候选池回放 G5。
- **失败处置**：G1 未达但 ≥ 250 MiB → 分析残余 top 构造器，允许一轮补刀（如 modifiers/annotations 列化）；仍未达 → 记录实测下限并按 0A.4(1) 以「不改语义的最紧形态」收口，更新 §3 门为实测值 +10%（须在 closeout 说明归因）。

### M3：快照 v4 + 惰性加载 + 冷建子进程（时限 6 天）

- **目标**：§4.2 段格式 + §4.4 子进程冷建；OPEN 路径：header 校验 → files 段常驻 → facts/edges 段惰性；worktree 播种改段级复用。
- **边界**：`snapshot.ts` 新增 v4 编解码（v3 读到即删重建，无迁移）；`writeSnapshotAtomic` 原子语义不变；播种器只改数据通道，`WorktreeSeedStatus` 统计语义不变。
- **验证**：T0（段 crc、损坏即弃重建、原子写崩溃测试沿用现有 crash 用例）；T2：G2（≤ 400 MiB）、G3（子进程峰值 ≤ 1536 MiB 且主进程冷建期间增量 ≤ 100 MiB）、G4（≤ 2s 可服务）、edit-to-visible ≤ 500ms 不回退、digest 相等。
- **失败处置**：G4 超时 → files 段瘦身（延迟 entitySearch 段）；G3 超 → 子进程内按源根分片串行。

### M4：跨进程治理与两级 TTL（时限 4 天）

- **目标**：构建信号量（S3）、hibernate/teardown 两级 TTL（S4）、`os.freemem()` 压力响应、（评估后决定）同仓 worktree 段共享。
- **边界**：复用 `cross-process-lease` 机制；`resource-defaults.ts` 增加 `hibernateTtlMs`（默认 300000）；环境变量 `JAVA_LSP_HIBERNATE_TTL_MS` 可覆盖。段共享若 3 天内无法安全落地（跨进程文件生命周期问题）则明确放弃并记录，S2 门按无共享形态执行。
- **验证**：T0（信号量互斥、TTL 状态机、压力触发）；T2 场景基准：S1 ≤ 1 GiB、S2 ≤ 1.4 GiB、S4 休眠 heap ≤ 32 MiB 且回热 ≤ 2s。
- **失败处置**：S2 超门且段共享已放弃 → 收紧默认 `maxActiveRepos`/TTL 并记录，门改为「用户显式放宽时告知内存代价」。

### M5：出口验收（时限 2 天）

- **执行**：主机政策检查 → **T3 三仓配对矩阵**（old=M 轨道前树，new=后树）逐位 identity + p95 ≤ 1.10 → 全部 G/S 门复测 → `measure:production-ts` LOC 核算（净增 ≤ +2,500）→ 写 `docs/phase-m/m-track-closeout.json` + markdown 报告（判定表/身份表/SHA-256/怎么读）→ HANDOFF 记账（含 JIN N1 升级项 RESOLVED）。
- **失败处置**：identity 不过 → 阻塞修复，M 轨道不出口；数字门个别未达 → 按各卡失败处置的收口值统一记录，出口判定 PARTIAL 并明确残差清单。

---

## 8. 风险与控制

| 风险 | 控制 |
|---|---|
| 惰性解码拖慢热查询 | G5 p95 门 + 请求级 memo + 热段 LRU（≤ 32 MiB） |
| 列式增量更新复杂化 | overlay 分代 + 后台压实；增量路径仍是对象形态，复杂度隔离在压实器 |
| 二进制格式损坏 | 段 crc + header checksum；沿用「rebuildable cache 即删重建」语义，无迁移负担 |
| digest 工具本身有洞（物化层作弊） | digest 对比在 FactsView 之上做，且 T3 identity 矩阵兜底端到端 |
| 子进程冷建与 lease/generation 时序冲突 | 子进程只写快照文件，发布仍走主 worker 的 manifest 校验 + 原子 rename 既有时序 |
| LOC 膨胀 | 净增 ≤ +2,500 门；v3 编解码在 M3 后删除 |
| 段共享跨进程生命周期（worktree 删除/GC） | 只读 + crc 校验 + 失败即回退自持 base；3 天评估不过即放弃 |

---

## 9. 预期效果（对用户工作负载）

| 场景 | 现状（最坏） | M 轨道后 |
|---|---|---|
| 单个大仓热驻留 | ~2.3 GiB RSS | ≤ 400 MiB |
| 3 项目 × 2 worktree 全热 | 理论 ~5 GiB+ | ≤ 1.4 GiB |
| 冷建期间 | 峰值驻留不还 | 子进程退出即归还，主进程 +≤100 MiB |
| 切项目回来（休眠回热） | 冷建 46s 或全量 parse | ≤ 2s |
| 磁盘 | ~30 MiB | 量级不变 |
