# codex-java-lsp-mcp：JavaIndex 落盘重构方案（Index-on-Disk，SQLite 单写者架构）

状态：**LANDED**（2026-09-09，本机 daemon `03f5a4154081`）。JavaIndex 堆路径已由 index-on-disk 取代。现行操作见 `docs/phase-f/production-operations.md`。
执行手册：`codex-java-lsp-mcp-index-on-disk-ai-execution-manual-2026-09-07.md`（Phase/Task 级，含子代理 review 协议）。**§7 的 X0–X5 由手册的 P0–P3 取代；两者冲突以手册为准。** R1 变更：(1) 用户决定不留过渡期，§9 作废；(2) 迁移策略细化为「适配器复用算法模块」——`SqlFactsStore` / `SqlKnowledgeGraph` 实现现有 `JavaIndexStore` 读接口与 `KnowledgeGraphStore` 同形接口，`plan-query / graph-search / graph-walk / call-resolver / *-edge-builder / graph-builder` 原样复用，只替换 7 处全表扫描；(3) entity search **不用 FTS5**（IDF 公式与现有 BM25 不同会破坏 0 diff），改为 token 表 + 抽出的打分纯函数；(4) 事实存储采用「索引标量列 + 每行 JSONB 原样 facts」混合模型，`files()` 物化即反序列化，消灭字段映射漂移；§2.3 schema 以手册 P0-T1 为准。
作者：Cursor agent（基于 `codex/fs-track` 至 `6885b17`、`docs/phase-fs/fsr-24h-soak-report-2026-09-06.md`、live pid 1611 现场）
取代：`codex-java-lsp-mcp-worktree-family-memory-sharing-plan-2026-08-27.md` §9 FSR 卡（FSR0–FSR4 全部作废）；`codex-java-lsp-mcp-memory-footprint-optimization-plan-2026-08-21.md` 的列式/快照路线（M1–M6 产物随本方案删除）
保留：`codex-java-lsp-mcp-daemon-stability-and-memory-plan-2026-08-25.md` 的 W/S 轨（事件循环、QUERY 不杀 worker、read-plan fail-soft）与 J 轨（JDT LS 治理）；JIN / next-frontier 的工具面与质量门不变

---

## 0. 结论先行

**问题不在看护，在前提。** 过去 17 天（08-21 → 09-06）六份方案、141 次提交、31 次 `fix(`，全部建立在同一个前提上：把一个 6k 文件仓库的 65 万行事实当 JavaScript 对象常驻在 V8 堆里，再用列式压缩、intern、墓碑、compact、流式编码、心跳换气、相对阈值去对抗它。每一轮看护都是一个新状态机，与既有的预热 / hydrate / sweep / 子进程冷建 / 家族池 / seed / overlay / hibernate / idle 状态机组合，在下一个 24–48h 窗里打出新故障。这个循环不会自己收敛。

**方案：把索引从进程堆里拿出来，放到磁盘上。** 每个 repo root 一个 SQLite 数据库（Node 22 内建 `node:sqlite`，live daemon 的 Node 22.16 已可用，含 FTS5、SQLite 3.50）。daemon 只读查询，内存开销 = 每个打开连接的 page cache（默认 32 MiB）；解析与写入由一个可随时丢弃的 builder 子进程独占；watcher 事件是一条单文件事务。**没有 hydrate、没有 snapshot 编解码、没有 recycle / hibernate / heartbeat / compact、没有家族池、没有 1536 MiB 隔离墙、没有"首查在 idle 后报错"这一类问题**——因为不再有任何需要恢复的常驻状态。空闲 = 关连接 = 0 内存；重新打开 = 毫秒。

**代价：** cache 目录格式不兼容（一次性重建，每仓 1–3 分钟）；java-index 相关代码约 18k 行重写为约 6–8k 行；实施约 2–3 周；MCP 工具输出契约不变（`java_impact` 等对外 JSON 不改）。

**执行纪律的改变：** 本方案的任务卡**没有备选路径**。任何门槛只在四个 live 仓（lishuedu / lishu-v2 / cipherlink / exam-parent-v3）的生产规模上测量；fixture 结果只能用于开发调试，不能做决策。门不过就停下报告，不允许"退回旧路径继续"。

---

## 1. 反思：为什么六轮都没解决

### 1.1 时间线（每一轮的看护成为下一轮的故障源）

| 日期 | 方案 | 加了什么 | 下一窗暴露什么 |
| --- | --- | --- | --- |
| 08-21 | M-track | 列式存储、StringTable、分段快照、子进程冷建 | N1 RSS 门 2344 MiB → 仍 500–1100 MiB 堆；hydrate 时 methods 段 244 MB JSON 打爆 1536 隔离 |
| 08-25 | daemon plan S4/S5/M2b | 分块快照 v5、冷启预算、热集免 idle | idle-close 后首查报错；footprint "呼吸" 争议 |
| 08-27 | FS-track FS1/FS2 | 家族 worker 合并、contentHash 共享池 | 家族 worker OOM（own-snapshot 重复 hydrate）、daemon OOM 768、spawn EBADF |
| 08-28 | FSX1–4 | 递归 fs.watch、家族基座单例、daemon 堆治理 | 40.8h 后 worker JsonStringify OOM（快照全量 stringify） |
| 08-30 | FSY1–3 | 工具调用尾部的堆阈值 recycle | 零调用 30.5h 后 OOM：edge-triggered 看护从未运行；墓碑 + append-only intern 单调增长 |
| 09-01 | FSZ1–4 | 5 min 心跳、流式编码、墓碑 compact、heapSplit | 堆主体 75% 落在 `otherBytes` 未归因；lishuedu 一行 gradle 改动 → 丢快照 → 子进程 300.55 s 被 300 s 杀 → 进程内 6k parse → 1139 MiB 平台 22h |
| 09-03 | FSR1–4 | 指纹放松、进度超时、相对阈值 1.6×、skip 帽 500 | 基线不刷新 → 阈值卡 755 → hydrate 过冲触发连打 8 次 → skip 帽让 lishu-v2 从 2959 文件塌成 43，**热 pin 功能失效 24h** |

每一行的"加了什么"都是对上一行症状的正确修复；每一行的"暴露什么"都是修复本身参与制造的。这是系统性信号，不是运气。

### 1.2 三个根本错误

**错误一：前提错——把数据库放在 V8 堆里。** lishuedu 的事实量：6,090 文件、7,319 类型、28,556 字段、25,077 方法、253,711 边、317,406 调用点，约 65 万行。磁盘二进制快照 28 MB；V8 堆里 hydrate 后 500 MiB，进程内 parse 后 1,135 MiB——**18–40 倍膨胀**。V8 堆不是数据库：没有 mmap、没有有界 page cache、没有按需分页、GC 高水位不归还、1.5 GiB 隔离上限、崩溃即全丢、持久化必须全量序列化。业界所有 Java/代码索引器（Eclipse JDT `.index`、IntelliJ `caches/`、clangd `.idx`、Sourcegraph SCIP → 数据库、Meta Glean → RocksDB）都把索引放在磁盘、堆里只留缓存。我们是例外，且为此付出了六轮。

**错误二：方法错——用看护对抗物理。** 当稳态内存由数据规模决定时，任何阈值 + 动作的看护都只有两种结局：阈值太高（1200 绝对值，lishuedu 停在 1139 22h）或阈值太低（1.6× 基线，hydrate 过冲触发连打）。看护越多，状态机越多，组合故障越多。18,193 行非测试代码、78 个 `JAVA_LSP_*` 开关、25 个 worker RPC、10 个定时器——这不是一个索引，是一个操作系统。

**错误三：验证错——允许 fixture 决策与备选路径。** FSR0 要求在生产规模做真实堆归因；执行时因为 "second worker on live cache would race :38456" 改在 **2 文件 fixture** 上跑，`otherBytes` 11 MB 当然占 100%，于是 `fsr2Decision = fallback-event-recycle`——用无意义的样本选了备选路径，跳过了唯一能改变堆体积的 FSR2。我写的卡给了备选，这是规划者的责任。本方案取消所有备选。

### 1.3 现有代码的结构性债（决定"重写"而非"再修"）

- `JavaIndexStore` 不是抽象层：直接暴露 14 个 `readonly Map`（`typesById / methodsById / edgesById / inEdgeIdsByNode / outEdgeIdsByNode / typeIdByFqn / typeIdsBySimpleName / methodIdsByOwnerAndName / fileOwnedNodeIds / fileOwnedEdgeIds / dependentFilesByTypeName / filesByPath / myBatis*`），68 处调用点分布在 `plan-query.ts`(19)、`graph-builder.ts`(16)、`java-index-worker.ts`(11)、`entity-search.ts`(7) 等 10 个文件直接遍历。存储实现无法替换，只能重写调用方。
- 同一份事实有四种表示并存：parse 产出的肥 `JavaFileBundle`、列式 SoA、hydrate 物化的瘦 bundle、SharedFactsPool 共享 bundle。`internOrShare` 对同一 contentHash 先装无边版再装带边版；`resolveAndBuildEdges` 每文件两次 `replaceFile` + 两次全量 `rebuildRegistry()`（`[...typesById.values()]`），6k 文件冷建 = 1.2 万次全量注册表构建，O(N²)——这就是 300 s 冷建的来源。
- `RangePool.memo` 按 handle 追加、`byteSize()` 不计；`knowledgeBuilderBytes` "按设计为 0" 即未测量；heapSplit 的 `donorStoreBytes` 用 `methods × 220 B` 常数估算，差一个数量级。字节账从未真实过。
- 生命周期状态机清单（仅 runtime-manager + worker + client）：prewarm(hydrate/files-only) → OPEN → rest-hydrate → background sweep → cold-build child(lease/timeout) → REFRESH/RECONCILE → snapshot flush(tmp/rename) → compact(tombstone ratio) → heartbeat recycle(threshold/baseline/cooldown) → hibernate(5 min) → index-idle(20 min) → family pool(acquire/release/overlay/frozen) → worktree seed(sibling/fingerprint) → skip cap(500)。任意两个交互都是一个潜在故障；48h 窗已经连续六次证明这一点。

---

## 2. 目标架构：Index-on-Disk

### 2.1 五条设计原则（违反任一条即为方案偏离，reviewer 必须打回）

1. **唯一持久状态是 DB 文件；进程内存只是缓存，可在任意时刻丢弃且无需恢复动作。** 不存在 hydrate、snapshot、seed、overlay、pool 这些概念。
2. **单写者。** 每个 DB 只有一个 builder 子进程写；daemon 与任何其它读者以 WAL 只读连接读。builder 可以被杀、可以崩、可以不存在，DB 始终一致。
3. **内存有界是设计属性，不是阈值动作。** 每连接 `PRAGMA cache_size` 决定上限；不允许出现任何 "heap > X 则 Y" 的代码。若测得内存超门，改 cache_size / SQL 形状 / 语句 LIMIT，不加看护。
4. **生命周期只有 open / close。** 首查 = 打开文件（毫秒）；空闲 = 关连接（0 内存）。删除 hibernate / recycle / heartbeat / index-idle 三层 timer / hot-set 豁免。
5. **只在生产规模验证。** 所有门在四个 live 仓上测；fixture 只用于单测。

### 2.2 组件

```
┌──────────────────────── daemon (http-server, 1 process) ────────────────────────┐
│  MCP tools ──▶ agent-router ──▶ JavaIndexClient(SQL) ──▶ node:sqlite (read-only, WAL)   │
│                                        │                                          │
│  watcher (fs.watch recursive) ──▶ per-root debounce queue ──▶ BuilderSupervisor  │
└──────────────────────────────────────────┬───────────────────────────────────────┘
                                           │ spawn on demand / exit when idle 60s
                              ┌────────────▼─────────────┐
                              │ builder child (1 per root, transient)              │
                              │  tree-sitter parse → ast-extractor → name-resolver │
                              │  → edge-builder → SQL transaction per file         │
                              │  single writer; peak RSS bounded by one file's work│
                              └────────────┬─────────────┘
                                           ▼
                     ~/Library/Caches/codex-java-lsp/<repoHash>/index.sqlite (+ -wal)
```

- **daemon**：不再拥有 JavaIndex worker。`JavaIndexClient` 变成对 DB 的同步查询封装（`DatabaseSync`），查询在主线程执行——当前 worker 里的查询本来就是同步 JS 遍历 Map，worker 存在的唯一理由是装堆；堆没了，worker 也没了。若某 RPC 在生产规模 P95 > 10 ms（见 §5），改 SQL 形状，不开线程。
- **builder**：复用 `parseJavaSourceFile / ast-extractor / name-resolver / edge-builder / mybatis-xml-extractor / framework-edge-builder / persistence-edge-builder` 的纯函数部分；输出不再是 bundle 对象图，而是一批 INSERT。冷建两遍：遍一写声明（files/types/fields/methods/callSites），遍二用 DB 里的类型注册表解析引用写 edges（消灭 O(N²) 注册表重建）。builder 空闲 60 s 自退出；有事件再 spawn（~80 ms）。
- **watcher**：留在 daemon（FSX1 的递归 `fs.watch` 已解决 fd 问题）；事件按 root 去抖 200 ms 后投给 builder；builder 不在则 spawn。

### 2.3 存储

**一 root 一 DB。** 不做家族共享。理由：共享的动机是内存，而落盘后内存与 root 数无关（空闲 root 0 MiB，活跃 root ≤ page cache）。磁盘按 lishuedu 规模估算 100–150 MB / root，worktree 多开 3 个 = 0.5 GB 磁盘，可接受；`PRAGMA auto_vacuum = INCREMENTAL` 防止编辑 churn 膨胀。**新 worktree 的冷启动 = 拷贝 sibling DB 文件（`VACUUM INTO` 或 `cp`，< 1 s）+ reconcile 差异文件**，取代 seed / fingerprint / overlay 全套。

Schema（R0 冻结骨架，字段名以 `index-types.ts` 现有事实为准，细节在 X0 落）：

```sql
PRAGMA journal_mode = WAL;  PRAGMA synchronous = NORMAL;  PRAGMA auto_vacuum = INCREMENTAL;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);            -- schemaVersion, extractorVersion, generation, repoRoot
CREATE TABLE file(id INTEGER PRIMARY KEY, path TEXT UNIQUE, content_hash TEXT, size INT, mtime_ms INT,
                  source_root TEXT, module TEXT, source_set TEXT, package TEXT, parse_state TEXT, generation INT);
CREATE TABLE type (id INTEGER PRIMARY KEY, stable_id TEXT UNIQUE, file_id INT REFERENCES file(id) ON DELETE CASCADE,
                  fqn TEXT, simple_name TEXT, kind TEXT, modifiers TEXT, range BLOB, confidence REAL);
CREATE TABLE field(id INTEGER PRIMARY KEY, stable_id TEXT UNIQUE, owner_type_id INT REFERENCES type(id) ON DELETE CASCADE,
                  name TEXT, type_text TEXT, type_resolved_id INT, modifiers TEXT, range BLOB);
CREATE TABLE method(id INTEGER PRIMARY KEY, stable_id TEXT UNIQUE, owner_type_id INT REFERENCES type(id) ON DELETE CASCADE,
                  name TEXT, is_ctor INT, signature_key TEXT, return_type TEXT, modifiers TEXT, range BLOB, body_range BLOB);
CREATE TABLE param(method_id INT REFERENCES method(id) ON DELETE CASCADE, ord INT, name TEXT, type_text TEXT, type_resolved_id INT);
CREATE TABLE annotation(owner_kind TEXT, owner_id INT, fqn TEXT, simple_name TEXT, args TEXT, range BLOB);
CREATE TABLE call_site(id INTEGER PRIMARY KEY, method_id INT REFERENCES method(id) ON DELETE CASCADE,
                  callee_name TEXT, receiver_text TEXT, arg_count INT, range BLOB);
CREATE TABLE edge(id INTEGER PRIMARY KEY, from_id TEXT, to_id TEXT, kind TEXT, confidence REAL, resolution TEXT,
                  source_file_id INT REFERENCES file(id) ON DELETE CASCADE, range BLOB, generation INT);
CREATE TABLE mybatis_resource(path TEXT PRIMARY KEY, namespace TEXT, file_id INT, facts TEXT /*json*/);
CREATE TABLE mybatis_statement(qualified_id TEXT PRIMARY KEY, resource_path TEXT, range BLOB);
CREATE VIRTUAL TABLE entity_fts USING fts5(name, stable_id UNINDEXED, kind UNINDEXED, tokenize='trigram');
-- indexes: type(fqn), type(simple_name), type(file_id), method(owner_type_id,name), method(name),
--          edge(from_id), edge(to_id), edge(kind,to_id), edge(source_file_id), call_site(method_id), call_site(callee_name), file(content_hash)
```

`ON DELETE CASCADE` 让"删除一个文件"成为一条 `DELETE FROM file WHERE path=?`；这替代了 `fileOwnedNodeIds / fileOwnedEdgeIds / removeFileInternal / 墓碑 / compact` 全部逻辑。`range` 用 16 字节 BLOB（4×int32）。

**内存账（设计值，X0 实测校正）：** 每打开连接 `cache_size = -32768`（32 MiB）；daemon 4 个活跃 root ≈ 128 MiB 上限 + 请求作用域对象；空闲 root 关连接 = 0。builder 峰值 = 单文件 parse tree + 一批语句，估 ≤ 300 MiB，且进程可丢弃。与现状对照：热 pin 500–1,139 MiB × 常驻，worktree 每个 1.5 GiB。

### 2.4 查询映射（25 个 RPC → SQL）

| RPC | 现实现 | 新实现 |
| --- | --- | --- |
| STATUS | worker 状态对象 | `meta` 行 + `SELECT count(*) FROM file` + builder 进程状态；无 `factsHydrated / hydrateBaseline / poolBundles / familyRootCount / tombstoneRatio` |
| OPEN | fork worker + hydrate | 打开连接；DB 不存在则 spawn builder 冷建并返回 `coverage=BUILDING` |
| QUERY_FILES / QUERY_TYPE / QUERY_TYPES | Map 查找 | 主键 / `fqn` / `simple_name` 索引点查 |
| QUERY_ANCHOR | 文件 + 位置 → 符号 | `type/method/field WHERE file_id=? AND range 包含 pos`（range 解包为四列或用 R*Tree；X1 决定，默认四列 + 复合索引） |
| QUERY_CALLERS / CALLEES / CALLEES_BATCH | in/outEdgeIdsByNode Set | `SELECT … FROM edge WHERE to_id=? AND kind IN (…)` / `from_id=?`；batch 用 `IN (?,…)` |
| QUERY_IMPLEMENTERS | typesById 扫 | `edge WHERE kind IN ('IMPLEMENTS','EXTENDS') AND to_id=?` |
| QUERY_TYPE_REFERENCERS | 全量扫 edges | `edge WHERE to_id=? AND kind IN (FIELD_TYPE, PARAM_TYPE, RETURN_TYPE, …)` |
| QUERY_METHODS_WITH_PARAMETER_TYPES | 遍历 methods | `param WHERE type_resolved_id=?` join method |
| QUERY_READ_RANGES | parse-tree cache + fallback | 直接用存储的 `range / body_range`；parse tree 不再常驻（`fallbackReadRange` 语义保留） |
| QUERY_GRAPH_REACHABLE / CONTEXT_GRAPH / GRAPH_DIGEST | java-knowledge GraphStore（内存 40 MiB） | 递归 CTE over `edge`，`maxDepth / maxNodes` 变成 CTE 深度列 + LIMIT；CALLS_EXACT / CALLS_VIRTUAL / DISPATCHES_TO 由 builder 写成 `edge.kind`，图不再是第二份内存结构 |
| QUERY_ENTITY_SEARCH | entity-search.ts 内存倒排（49 MiB） | `entity_fts MATCH ?`（trigram）+ 排序 |
| QUERY_MYBATIS_RESOURCE / _BY_NAMESPACE | Map | 两张表点查 |
| QUERY_REPOSITORY_FACT_MARKERS | 聚合 | `SELECT kind, count(*) … GROUP BY` |
| REFRESH / REFRESH_RESOURCES / RECONCILE | worker 内 parse + replaceFile | 投递给 builder；daemon 侧只返回 `generation` 承诺；`freshness.indexedGeneration` 读 `meta` |
| FLUSH / HIBERNATE | 快照写 / 卸载 | **删除**（无对应概念） |

`java_impact` 等工具的对外 JSON **不变**；变的是 `router-java-index.ts` 下面的 `JavaIndexClient` 实现。

### 2.5 冷建与增量

- **冷建**：builder 遍一并行读文件 + parse，按文件事务写声明；遍二对每文件用 `type(fqn) / type(simple_name) / file.imports` 做名字解析写 edges。每 200 文件 `COMMIT` 一次并更新 `meta.progress`。**没有超时杀**：daemon 只监视 builder 是否存活与 `meta.progress` 是否推进，无进度 ≥ 120 s 才判失败并重 spawn（从 `meta.progress` 续建，不从零）。
- **增量**：watcher 事件 → builder：`BEGIN; DELETE FROM file WHERE path=?; INSERT …; 重解析 dependents(edge.to_id ∈ 本文件旧 stable_id 的 source_file) ; UPDATE meta generation; COMMIT`。dependents 由 `edge(to_id)` 索引一次查出，替代 `dependentFilesByTypeName`。
- **reconcile**（daemon 启动 / worktree 拷贝后）：`file(path, content_hash, mtime_ms)` 与磁盘 stat 对比，差异集合走增量路径。build marker（pom / gradle）变化只触发 layout 重推导 + 受影响 source root 的 reconcile，**永不整库丢弃**。
- **extractorVersion / schemaVersion 变化**：整库重建（唯一合法的全量重建触发）。

### 2.6 生命周期（全部）

```
query 到达 → 连接池取 root 连接（无则 open，DB 无则 spawn builder 冷建 + 返回 BUILDING 降级）
          → 执行 SQL → 返回
空闲 10 min → close 连接（0 内存）
watcher 事件 → 去抖 → builder（无则 spawn）→ 事务 → 退出(空闲 60 s)
daemon 重启 → 什么都不做（DB 在磁盘上）
```

被删除的概念：prewarm(hydrate)、rest-hydrate、background sweep、cold-build lease、snapshot flush/tmp/rename、seed/sibling/fingerprint、overlay/frozen、SharedFactsPool、compact、heartbeat、recycle、hibernate、index-idle、hot-set 豁免、skip cap、`factsHydrated`、`hydrateBaselineHeapMb`、1536 隔离墙、`--max-old-space-size` 剥离逻辑。

---

## 3. 删除清单与保留清单

**删除（X4 一次性）**：`src/java-index/columnar/*`、`snapshot.ts`、`snapshot-v4.ts`、`hydrate-snapshot-view.ts`、`shared-facts-pool.ts`、`worktree-snapshot-seeder.ts`、`build-fingerprint.ts`、`cold-build.ts`（并入 builder）、`cold-build-child.ts`、`java-index-worker.ts`、`java-index-worker-process.ts`、`java-index-worker-query.ts`、`worker-protocol.ts`、`parse-tree-cache.ts`、`index-store.ts`、`java-knowledge/graph-store.ts` 与 `graph-snapshot.ts`（图即 edge 表）、`entity-search.ts`（FTS5）；`repo-runtime-manager.ts` 中 hibernate / recycle / heartbeat / idle 三层 timer / hot-set / prewarm-hydrate 全部分支；`scripts/fsz-live-sample.mjs`、`run-fsz-unit-taps.mjs`；`JAVA_LSP_*` 中与上述相关的开关（目标：78 → ≤ 30）。

**保留并复用**：`ast-extractor.ts`、`edge-builder.ts`、`name-resolver.ts`（改为接 SQL 注册表视图）、`mybatis-xml-extractor.ts`、`framework-index-view.ts`、`java-knowledge/{call-resolver,framework-edge-builder,persistence-edge-builder}.ts`（输出改为 edge 行）、`repo-layout.ts`、`repo-change-coordinator.ts`（watcher）、`router-java-index.ts` / `router-facts.ts`（改 client 实现，不改语义）、全部 `agent-router/*`、`tools/*`、golden / identity / three-repo 测试基础设施。

---

## 4. 兼容性与风险

- **cache 目录不兼容**：首次启动新版本时旧目录内容全部无效；每仓冷建一次（目标 lishuedu ≤ 180 s，见 §5）。用户已明确接受。
- **MCP 对外契约不变**：`java_impact / java_status / java_*` 输出字段、`freshness`、`cost` 语义不变；`java_status` 中与堆相关的诊断字段（`heapSplit` 等）移除，新增 `db.bytes / db.cacheBytes / builder.state`。
- **`node:sqlite` 在 Node 22 标记 experimental**：live daemon 固定 Node 22.16（nvm），API（`DatabaseSync / StatementSync / exec / prepare / run / get / all`）自 22.13 unflag 后未变；启动参数加 `--disable-warning=ExperimentalWarning`。所有 SQLite 调用经 `src/java-index/sqlite-driver.ts`（≤ 120 行）适配，若未来需要可换 `better-sqlite3` 而不动上层。**不引入新的生产 npm 依赖。**
- **同步查询在主线程**：风险是长查询阻塞事件循环。控制：所有图查询有 `maxDepth ≤ 3 / LIMIT ≤ 500` 的 SQL 级上限；X1 在四仓生产规模测每个 RPC 的 P50/P95，任何 P95 > 10 ms 的 RPC 在 X1 内改 SQL 形状（加索引 / 拆查询 / 限制），**不开查询线程**。
- **磁盘占用**：每 root 100–150 MB（含索引），worktree 多开线性增加；`auto_vacuum=INCREMENTAL` + 每次冷建后 `PRAGMA incremental_vacuum`。比现状快照 28 MB 大，换的是内存归零。
- **结果一致性**：这是最大的正确性风险。控制：X1 的差分测试要求新旧实现对同一仓、同一批锚点的**每个 RPC 输出归一化后逐字段相等**（排序后比较），三仓 + ruoyi 观察仓全部 0 差异才能进 X2；T3 三仓 identity 矩阵在 X4 再跑一次对 `main`。
- **builder 崩溃 / 中途被杀**：WAL 保证事务原子；`meta.progress` 让冷建续建。不需要任何恢复代码。
- **JDT LS 不受影响**：J 轨照旧。

---

## 5. 数字门（全部在四个 live 仓生产规模测量；无 fixture 门）

| 门 | 目标 | 测法 |
| --- | --- | --- |
| G-MEM-1 daemon 稳态 | 4 pin 全部活跃时 daemon RSS ≤ 250 MiB；空闲 15 min 后 ≤ 120 MiB | `ps -o rss` 每 5 min，48h |
| G-MEM-2 每 root 增量 | 打开一个额外 root（含 worktree）使 daemon RSS 增加 ≤ 48 MiB；关闭后回落 | 打开 / 关闭对照 |
| G-MEM-3 builder 峰值 | lishuedu 冷建 builder peak RSS ≤ 600 MiB；增量单文件 ≤ 200 MiB | `/usr/bin/time -l` |
| G-MEM-4 无任何进程 > 1 GiB | 48h 内 daemon / builder 任一进程 RSS 峰值 < 1 GiB | 采样最大值 |
| G-BUILD-1 冷建时长 | lishuedu(6.1k 文件) ≤ 180 s；lishu-v2(2.9k) ≤ 90 s；cipherlink / exam ≤ 30 s | wall clock（两遍合计）|
| G-BUILD-2 续建 | 冷建中途 kill -9 builder 后重 spawn 从进度续建，总时长 ≤ 1.3× 正常 | 人工 kill 一次 |
| G-Q-1 查询延迟 | 每个 RPC 在四仓生产规模 P95 ≤ 10 ms（GRAPH_* 类 ≤ 25 ms）；`java_impact` 端到端热 P95 ≤ 300 ms | 差分 harness 计时 |
| G-Q-2 首查 | 空闲关连接后首查 ≤ 300 ms（不存在 hydrate）；新 worktree（sibling DB 存在）首查 ≤ 3 s 含拷贝 + reconcile | 探针 |
| G-ID-1 差分一致 | 25 个 RPC × 三仓 + ruoyi × 采样锚点集（每仓 ≥ 200）：归一化后 0 差异 | X1 harness |
| G-ID-2 T3 identity | `run-three-repo-cold-matrix --runs 3` 新 vs `main`：recall / pRead / rReadMust / token P50 delta 0 | 现有脚本 |
| G-INC-1 增量时效 | 编辑保存 → `freshness.indexedGeneration` 反映 P95 ≤ 2 s | watcher 探针 |
| G-INC-2 编辑 churn 有界 | lishu-v2 模拟 2,000 次编辑后 DB 体积增长 ≤ 10%，daemon RSS 不变 | 脚本 |
| G-SOAK 48h 编辑负载 | 0 FATAL、0 查询错误、0 builder 无进度重 spawn；**不存在**任何 recycle / compact / heartbeat 指标可采 | 采样器只采 RSS / 错误 / builder 事件 |

任何门不过：停在该卡，写 `docs/phase-x/<card>-closeout.json` 说明数字与原因，报告用户。不退回旧实现，不加看护。

---

## 6. 执行合同

- 分支 `codex/index-on-disk`，自 `codex/fs-track` 头（保留 W/S/J 轨与 FSX1 watcher 修复）。提交前缀 `feat(iod):` / `fix(iod):` / `docs(iod):`。
- 每卡产出 `docs/phase-x/<card>-closeout.json`：`{card, sha, gates:[{id, target, measured, pass}], deletedLoc, addedLoc, notes}`。
- T0 = `npm run build && npm test`；T1 = 单卡门；T3 = §5 G-ID-2；48h = G-SOAK。
- 三仓矩阵 load 政策照 `.cursor/rules/three-repo-load-gate.mdc`（load < 20 必跑）。
- **禁止**：在 daemon 或 builder 中新增任何以堆 / RSS 数值为条件的动作；新增 `JAVA_LSP_*` 开关超过本方案列出的 5 个（`JAVA_LSP_SQLITE_CACHE_KB`、`JAVA_LSP_BUILDER_IDLE_MS`、`JAVA_LSP_CONN_IDLE_MS`、`JAVA_LSP_BUILDER_PARALLELISM`、`JAVA_LSP_INDEX_DIR`）；用 fixture 结果填任何 §5 的门；给任何卡写"备选路径"。
- 合 `main` 条件：X0–X4 全部 closeout `pass=true`，G-SOAK 48h 通过，用户确认。

---

## 7. 任务卡

### X0 — 存储层 + builder 冷建（3 天）

- **范围**：`src/java-index/sqlite-driver.ts`（适配）、`src/java-index/schema.sql`（DDL + 迁移版本）、`src/java-index/builder/{builder-main.ts, declare-pass.ts, resolve-pass.ts, write-batch.ts}`、`src/java-index/sql-registry-view.ts`（给 `name-resolver.ts` 的 `TypeRegistryView` SQL 实现，带 ≤ 10k 条 LRU）。
- **锚点**：复用 `parseJavaSourceFile`（`java-index-worker.ts:934` 附近的调用形态）、`ast-extractor.ts`、`edge-builder.ts:buildStaticEdges`、`name-resolver.ts:JavaNameResolver / resolveFileRefs`、`mybatis-xml-extractor.ts`、`java-knowledge/*-edge-builder.ts`。
- **做法**：`bundle → rows` 的映射函数纯且可单测；两遍冷建；每 200 文件一个事务；`meta.progress` 记录已完成文件数与阶段。
- **门**：G-BUILD-1、G-BUILD-2、G-MEM-3；DB 体积 lishuedu ≤ 200 MB；`SELECT count(*)` 各表与 §1.2 快照统计一致（±0）。
- **失败处理**：冷建 > 180 s → profile 两遍各自耗时，优先查解析遍的 SQL 点查是否走索引（`EXPLAIN QUERY PLAN`），其次并行度。builder 峰值 > 600 MiB → 检查 parse tree 是否逐文件释放。不得以"暂时放宽门"收尾。

### X1 — 查询层 + 差分一致（4–5 天）

- **范围**：`src/java-index/sql-client.ts` 实现现 `JavaIndexClient` 的全部 24 个 public 方法（`client.*` 调用清单见 §2.4）；`src/java-index/sql-queries/*.ts` 每 RPC 一个模块；`src/java-knowledge/graph-walk.ts` 改为 CTE；`entity_fts` 替代 `entity-search.ts`；`scripts/diff-index-impl.mjs` 差分 harness。
- **锚点**：`router-java-index.ts` / `router-facts.ts` / `agent-router/*` 对 client 的调用签名不变；`plan-query.ts`(19 处) 与 `graph-builder.ts`(16 处) 的 Map 直读改为 client 方法。
- **差分 harness**：同一仓同时开旧 worker（现 `codex/fs-track` 实现）与新 SQL client，对采样锚点集（每仓 ≥ 200：按文件均匀抽 + golden 场景全集）逐 RPC 调用，输出归一化（数组排序、去 `generation` / 时间戳字段）后 deep-equal；差异写 `docs/phase-x/x1-diff.json` 并逐条归因。
- **门**：G-ID-1（0 差异）、G-Q-1。
- **失败处理**：差异分三类——旧实现 bug（需在 x1-diff 中给出证据并经用户确认后按新实现为准）、新实现 bug（修）、排序 / 浮点表示（归一化修）。任何"差异未归因"不得进 X2。P95 超门：`EXPLAIN QUERY PLAN` 加索引或拆查询；不开线程。

### X2 — 增量 + watcher 接线 + freshness（2–3 天）

- **范围**：`src/java-index/builder/incremental.ts`（单文件事务 + dependents 重解析）、`src/java-index/builder-supervisor.ts`（spawn / idle exit / 无进度检测）、`repo-change-coordinator.ts` 事件出口改投 supervisor、`meta.generation` 与 `freshness` 对接。
- **门**：G-INC-1、G-INC-2、G-Q-2 前半（关连接后首查 ≤ 300 ms）。
- **失败处理**：时效超 2 s → 先量 parse 与事务各占多少；不允许把去抖拉长到掩盖问题。DB 增长 > 10% → 检查 CASCADE 是否生效、`incremental_vacuum` 是否执行。

### X3 — 生命周期收口 + worktree（1–2 天）

- **范围**：`repo-runtime-manager.ts` 重写为连接池 + supervisor 句柄（目标 ≤ 400 行）；worktree 首开 = `VACUUM INTO` sibling DB → reconcile；`application.ts:prewarmPinnedRepos` 改为"确保 DB 存在，缺则后台冷建"，不再 hydrate。
- **门**：G-MEM-1、G-MEM-2、G-Q-2 后半（worktree 首查 ≤ 3 s）；`repo-runtime-manager.ts` 中 `setTimeout/setInterval` ≤ 2（连接 idle、builder idle）。
- **失败处理**：RSS 超门 → 先看连接数与 `cache_size` 乘积，再看请求作用域对象是否被缓存；禁止加任何阈值动作。

### X4 — 删除清单 + T3 + 48h（3 天 + 48h 窗）

- **范围**：§3 删除清单全部落地；`JAVA_LSP_*` 收敛到 ≤ 30；`docs/HANDOFF.md` 更新架构段；`scripts/probe-daemon-acceptance.mjs` 去掉 hydrate / recycle 探针，改 §5 采样。
- **门**：T0 全绿；G-ID-2；G-MEM-4；G-SOAK 48h。
- **失败处理**：T3 delta ≠ 0 → 回到 X1 差分 harness 复现该场景，不在 X4 内"调参"。48h 内出现任何进程 > 1 GiB → 该进程 heap snapshot 归因后修，不加看护。

### X5 — 合 main + 切流（0.5 天，需用户确认）

- `install-runtime.sh` 安装新 release（回滚仍为 `daemonctl.sh rollback-release`）；首启每仓冷建（用户可见 1–3 分钟 `coverage=BUILDING` 降级期，工具返回可重试 gap 而非错误）；旧 cache 目录内容由新版本启动时清理（仅删已识别的旧快照文件名）。

---

## 8. 与其它计划的关系

- **FS-track（08-27）**：§0–§8 的历史与教训保留为记录；§9 FSR0–FSR4 作废，由本方案取代。家族共享的目标（worktree 不重复占内存）由"落盘 + 空闲 0 内存"直接达成，不再需要共享机制。
- **daemon plan（08-25）**：D2（事件循环 P99）、D4（QUERY 超时不螺旋）、D6（新仓 status ≤ 3 s）保留并在 X4 复测；D1 / D3a / D3-idle / D5 / D7 因其针对的机制（footprint 呼吸、hydrate、idle-close 首查、冷建回落、seed）不再存在而作废，替换为 §5 G-MEM / G-Q-2 / G-BUILD。
- **JIN / next-frontier**：工具面、golden、LORO、T3 全部不变；本方案是它们下面的存储层替换，以 G-ID-1 / G-ID-2 保证 0 质量漂移。
- **J 轨（JDT LS）**：独立，不受影响。

---

## 9. 过渡期（R1：作废）

用户决定重构期间不使用本 LSP，不做任何过渡期修补；live `4ce48953d27c` 保持现状直到 P3-T4 切流。FSR 报告 §6 的 P0-1 / P0-2 不修——它们随 P3 删除清单一起消失。

---

## 10. 最后一句

六轮方案的每一张卡单独看都"正确"，合起来却是一条不收敛的路径，因为它们都没有动那个把数据库塞进 V8 堆的前提。本方案动的就是这个前提。它不聪明——只是把索引放回它在所有成熟工具里本来就在的地方：磁盘上。
