# Index-on-Disk 重构：AI 自主开发执行手册（Phase / Task 级）

状态：ADOPTED（R0，2026-09-07）；**R1 修订（2026-09-07，§3.9）：P0-G4 阻塞裁决 → schema v3 归一化 + P0-T8 / P0-T9，用户已批准（2026-09-07）**
上位方案：`codex-java-lsp-mcp-index-on-disk-rearchitecture-plan-2026-09-06.md`（以下称「方案」）。本手册把方案 §7 的 X0–X5 细化为 4 个 Phase、23 个 Task，并规定 Task 级与 Phase 级的验证、Phase 末的子代理 review 协议。方案与本手册冲突时，以本手册为准（本手册基于三份只读代码探索写成，锚点更准）。
用户决定：**不留过渡期**，重构期间不使用本 LSP；以最快切换为目标。

---

## 0. 执行者必读

### 0.1 角色与模型档位

| 角色 | 谁 | 模型要求 | 权限 |
| --- | --- | --- | --- |
| Implementer | 主代理 | 非 fast 档 | 读写工作区、跑 T0/T1、提交 |
| Code Reviewer | 子代理（generalPurpose） | 非 fast 档 | 只读，针对干净 SHA |
| Doc-Consistency Auditor | 子代理（generalPurpose） | 非 fast 档 | 只读 |
| Gate Runner | 子代理（shell） | 可用 fast 档 | 只跑命令、收集原始输出，不做结论 |

Reviewer 与 Implementer 必须分离；review 只针对已提交的干净 SHA。

### 0.2 硬禁令（违反即停止并报告）

1. 不在 daemon / builder 任何位置新增以 heap / RSS 数值为条件的动作。
2. 不新增 `JAVA_LSP_*` 开关，除本手册列出的 5 个：`JAVA_LSP_SQLITE_CACHE_KB`（默认 32768）、`JAVA_LSP_BUILDER_IDLE_MS`（60000）、`JAVA_LSP_CONN_IDLE_MS`（600000）、`JAVA_LSP_BUILDER_PARALLELISM`（`min(4, cpus-1)`）、`JAVA_LSP_INDEX_DIR`（默认 `$JAVA_LSP_CACHE_BASE/<repoHash>/index.sqlite` 所在目录）。
3. 不用 fixture 结果填任何 Phase 门；Phase 门只认四个 live 仓（lishuedu / lishu-v2 / cipherlink / exam-parent-v3）。
4. 不写「备选路径」；Task 门不过 → 修到过或停下报告。不允许退回旧实现。
5. 不引入新的生产 npm 依赖；SQLite 只用 `node:sqlite`。
6. 不改 MCP 工具对外 JSON 契约（`java_impact` 等字段与语义）。`java_status` 仅允许删除堆诊断字段、新增 `db.*` / `builder.*`。
7. 不修改 `golden/*.scenarios.jsonl`、不调参以通过差分或 T3。
8. 单 Task 净变更 ≤ 400 行（不含测试与生成物）、非测试文件 ≤ 6 个、一个目标、一个 commit。超出则拆分为 `Tn.a / Tn.b` 并在本手册对应 Task 下追加一行说明（这是唯一允许改本手册的情形）。
9. 不 push、不合 main、不 install 到生产 runtime，除 P3-T4 明示且用户确认。

### 0.3 分支与提交

- 分支：`codex/index-on-disk`，从 `codex/fs-track` 头（当前 `6885b17`）切出。
- 提交前缀：`feat(iod): Pn-Tm <目标>` / `fix(iod): Pn-Tm <内容>` / `docs(iod): Pn <内容>`。
- 每个 Task 一个 commit；Phase 末 review 修复合成一个 `fix(iod): Pn review fixes` commit。
- 每个 Phase 完成后打 tag `iod/Pn`（本地，不 push）。

### 0.4 Task 级验证（「必要测试」的定义）

只跑三样，不跑全量：

```bash
# 1) 编译（隔离 clone + tsc）
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile
# 2) 本 Task 新增/修改的测试文件 + 被直接修改模块已有的测试文件（dist 路径）
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- \
  node --test --test-concurrency=1 dist/<path>/<a>.test.js dist/<path>/<b>.test.js
# 3) Task 卡里写明的「实测」（若有）
```

测试文件在 `src/**/*.test.ts`，编译到 `dist/**/*.test.js`。最小 Java fixture：`fixtures/generic-java`（4 个 .java）；索引路径单测用 `fixtures/java-index-v2`（27 个 .java）。

### 0.5 Phase 级验证

```bash
# 全量单测 + 脚本测试 + stdio smoke
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile full
# PR 门
sh scripts/run-isolated-node.sh scripts/run-v4-gates.mjs --profile pr
```

再加该 Phase 的数字门（见各 Phase「门」表），全部在 live 仓上测。live 仓路径由 `~/.config/codex-java-lsp/projects.json` 的 `aliases[].root` 读取（`JAVA_LSP_PROJECTS_JSON` 可覆盖）；三仓矩阵另用 `--lishuedu/--cipherlink/--exam-parent-v3`。

### 0.6 Phase 末 review 协议（必须派发子代理）

前置：Phase 内全部 Task 已提交，`git status` 干净，记录 `SHA_PHASE`，`PHASE_BASE` = 上一 Phase tag（P0 用 `codex/fs-track` 头）。

**第一轮（三个子代理并行、只读）：**

1. **Code Reviewer**（generalPurpose，非 fast）
   输入：`git diff PHASE_BASE..SHA_PHASE -- src scripts`，本手册对应 Phase 章节，方案 §2.1 五条原则。
   要求：按严重度（P0 阻塞 / P1 必修 / P2 建议）输出 findings，每条含 `文件:行`、触发条件、影响、证据、建议修复。重点：SQL 参数化（禁止字符串拼接）、事务边界（每文件事务是否完整回滚）、连接泄漏（open 后是否必 close）、builder 子进程生命周期（僵尸、孤儿、双写）、同步查询阻塞风险（无 LIMIT 的查询）、错误吞没、与 `JavaIndexClient` 原签名的偏离。
2. **Doc-Consistency Auditor**（generalPurpose，非 fast）
   输入：同上 diff + 本手册 + 方案。
   要求：逐条核对 (a) 0.2 硬禁令有无违反（grep `heapUsed|rssMb|maxOldGeneration|recycle|hibernate|setInterval` 等）；(b) 本 Phase 每个 Task 的「范围」是否都落地、有无范围外改动；(c) schema 与方案 §2.3 是否一致，差异是否已在 closeout 说明；(d) closeout JSON 数字是否与原始产物（`docs/phase-x/<phase>-gate-raw/`）一致；(e) 删除清单是否漏项（P3）。输出 `一致 / 偏离(文件:行, 说明)` 列表。
3. **Gate Runner**（shell）
   要求：按本 Phase「门」表逐条执行命令，原始 stdout/stderr 落 `docs/phase-x/<phase>-gate-raw/<gate-id>.txt`，不解读。

**Implementer 处理：** 汇总三份输出 → P0/P1 全部修复；P2 逐条写明采纳或不采纳理由 → 只重跑受影响 Task 的测试 + Phase 全量 → commit `fix(iod): Pn review fixes`。

**第二轮（一个子代理）：** Code Reviewer 只看修复 diff `SHA_PHASE..SHA_FIX`。无 P0/P1 → Phase 通过。

**上限：** 两轮修复仍有 P0/P1 → 停止，写 `docs/phase-x/<phase>-blocked.md` 报告用户。

**产出：** `docs/phase-x/<phase>-closeout.json`（`schemaVersion:"iod-phase-closeout/v1"`, `phase`, `sha`, `shaFix`, `dated`, `decision`, `gates:[{id,target,measured,pass,rawFile}]`, `review:{round1:{p0,p1,p2},round2:{p0,p1}}`, `addedLoc`, `deletedLoc`, `notes`）与 `<phase>-review.md`（三份子代理原文 + 处置表）。

---

## 1. 迁移策略（为什么这样拆）

三份只读探索确认：

- 算法模块 `context-engine/plan-query.ts`、`graph-search.ts`、`java-knowledge/graph-walk.ts`、`call-resolver.ts`、`framework-edge-builder.ts`、`persistence-edge-builder.ts`、`graph-builder.ts` 对 `JavaIndexStore` 的依赖是 **`.get()` 点查 + `files()` + 少量 store 方法**，全表扫描只有 6 处（清单见附录 A.3）；对 `KnowledgeGraphStore` 只用 `nodesById.get/has/entries`、`successors`、`predecessors`、`upsertNode`、`addEdge`、`removeFiles`、`digest`、`generation`。
- 因此**不重写算法**：实现 `SqlFactsStore`（读接口 + 流式迭代）与 `SqlKnowledgeGraph`（`KnowledgeGraphStore` 同形读写）两个适配器，把 6 处全表扫描替换为带索引的读方法（旧内存实现同样加上该方法，保证差分测试双端可跑），算法模块原样复用。
- `EntitySearchIndex` 的四层打分（FQN → SIMPLE_NAME → BM25 identifier → BM25 chunk，IDF = `ln(1+(N-df+0.5)/(df+0.5))`）与 FTS5 内建 bm25 的 IDF 不同，直接换 FTS5 会在排序边界产生 diff。**不用 FTS5**：token 表 + 抽出现有打分纯函数，0 diff 可达。
- 事实嵌套结构复杂（`JavaTypeRef.resolution`、注解 args、`callSites`、`localTypes`…），逐字段映射是最大漂移源。**混合模型**：每行「索引用标量列 + `facts` JSONB 原样对象」。`files()` 物化 = 反序列化 JSONB，不做字段映射。`callSites` 留在 method JSON 内（查询侧不单独查它；CALLS 边由 builder 派生）。

数据流：

```
builder(子进程)：parse → JavaFileBundle → rows(标量+JSONB) → resolveFileRefs/buildStaticEdges(经 SqlRegistryView) → edge rows
                 → graph-builder(经 SqlFactsStore → SqlKnowledgeGraph) → kg_node/kg_edge rows → entity token rows
daemon(主线程)：SqlJavaIndexClient → SqlFactsStore/SqlKnowledgeGraph/SqlEntitySearch → 原算法模块 → 原 RouterJavaIndex → 原工具
```

---

## 2. Phase / Task 总表

| Phase | 目标 | Task | 预估 |
| --- | --- | --- | --- |
| P0 存储与 builder | 冷建 lishuedu 进 SQLite，行数与旧快照一致 | T1–T7；R1 追加 T8（schema v3 归一化）、T9（矩阵工具） | 4–5 天 + R1 约 2 天 |
| P1 查询层与差分 | 新 client 对 25 个 RPC 0 diff | T1–T6 | 5 天 |
| P2 增量与生命周期 | watcher → builder；连接 open/close；worktree 拷贝 | T1–T6 | 4 天 |
| P3 删除与切换 | 删旧实现、T3 identity、安装切流 | T1–T4 | 3 天 + 观察 |

依赖：P0 → P1 → P2 → P3 严格串行；Phase 内 Task 按编号串行（标注「可并行」的除外）。

---

## 3. Phase P0：存储层与 builder 冷建

目标：新增代码与旧实现并存，不改任何旧行为；P0 结束时 `builder-main.ts --mode cold` 能把 lishuedu 建进 `index.sqlite`，各表行数与 §附录 A.1 的快照统计一致。

### P0-T1 sqlite driver + schema + 迁移

- **范围**：新增 `src/java-index/sql/driver.ts`（≤120 行：`openIndexDb(path, {readOnly, cacheKb})`、`withTransaction(db, fn)`、`prepareCached(db, sql)`、`close`；设 `journal_mode=WAL`、`synchronous=NORMAL`、`auto_vacuum=INCREMENTAL`、`cache_size=-<cacheKb>`、`foreign_keys=ON`、`temp_store=MEMORY`）、`src/java-index/sql/schema.ts`（DDL 字符串 + `SCHEMA_VERSION=1` + `ensureSchema(db)`：`meta.schemaVersion` 不等则 drop-all 重建）。
- **Schema（v2，冻结；R1 起以 §3.9 的 schema v3 为准，下文仅存档说明 G4 为何失败）**：

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: schemaVersion, extractorVersion, stableIdVersion, repoRoot, generation, indexedGeneration,
--       buildState(EMPTY|BUILDING|READY), buildProgress(json), graphDigest, graphGeneration, layoutJson
CREATE TABLE file(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, size INTEGER, mtime_ms REAL,
  ctime_ms REAL, source_root TEXT, module TEXT, package TEXT, parse_state TEXT, generation INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX file_content_hash ON file(content_hash);  CREATE INDEX file_source_root ON file(source_root);
CREATE TABLE type(id INTEGER PRIMARY KEY, type_id TEXT NOT NULL UNIQUE, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  fqn TEXT, simple_name TEXT NOT NULL, kind TEXT NOT NULL, owner_type_id TEXT, facts BLOB NOT NULL);
CREATE INDEX type_fqn ON type(fqn);  CREATE INDEX type_simple ON type(simple_name);  CREATE INDEX type_file ON type(file_id);
CREATE INDEX type_owner_simple ON type(owner_type_id, simple_name);
CREATE TABLE field(id INTEGER PRIMARY KEY, field_id TEXT NOT NULL UNIQUE, owner_type_id TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, facts BLOB NOT NULL);
CREATE INDEX field_owner ON field(owner_type_id);  CREATE INDEX field_file ON field(file_id);
CREATE TABLE method(id INTEGER PRIMARY KEY, method_id TEXT NOT NULL UNIQUE, owner_type_id TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, is_ctor INTEGER NOT NULL, arity INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX method_owner_name ON method(owner_type_id, name);  CREATE INDEX method_file ON method(file_id);
CREATE TABLE edge(id INTEGER PRIMARY KEY, edge_id TEXT NOT NULL UNIQUE, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
  source_file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE, facts BLOB NOT NULL);
CREATE INDEX edge_from_kind ON edge(from_id, kind);  CREATE INDEX edge_to_kind ON edge(to_id, kind);  CREATE INDEX edge_file ON edge(source_file_id);
CREATE TABLE mybatis_resource(path TEXT PRIMARY KEY, namespace TEXT, content_hash TEXT, facts BLOB NOT NULL);
CREATE INDEX mybatis_ns ON mybatis_resource(namespace);
CREATE TABLE source_root_coverage(root TEXT PRIMARY KEY, state TEXT NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE kg_node(id TEXT PRIMARY KEY, kind TEXT NOT NULL, relative_path TEXT, java_index_id TEXT, owner_file TEXT, facts BLOB NOT NULL);
CREATE INDEX kg_node_path ON kg_node(relative_path);  CREATE INDEX kg_node_jid ON kg_node(java_index_id);  CREATE INDEX kg_node_owner ON kg_node(owner_file);
CREATE TABLE kg_edge(id INTEGER PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, owner_file TEXT, facts BLOB NOT NULL);
CREATE INDEX kg_edge_from ON kg_edge(from_id, kind);  CREATE INDEX kg_edge_to ON kg_edge(to_id, kind);  CREATE INDEX kg_edge_owner ON kg_edge(owner_file);
CREATE TABLE kg_summary(method_id TEXT PRIMARY KEY, facts BLOB NOT NULL);
CREATE TABLE entity(entity_id TEXT PRIMARY KEY, kind TEXT NOT NULL, fqn TEXT NOT NULL, simple_name_lc TEXT, relative_path TEXT, owner_file TEXT,
  ident_len INTEGER NOT NULL, chunk_len INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX entity_fqn ON entity(fqn);  CREATE INDEX entity_simple ON entity(simple_name_lc);  CREATE INDEX entity_owner ON entity(owner_file);
CREATE TABLE entity_token(entity_id TEXT NOT NULL REFERENCES entity(entity_id) ON DELETE CASCADE, field TEXT NOT NULL, token TEXT NOT NULL, tf INTEGER NOT NULL,
  PRIMARY KEY(entity_id, field, token)) WITHOUT ROWID;
CREATE INDEX entity_token_lookup ON entity_token(field, token);
CREATE TABLE entity_df(field TEXT NOT NULL, token TEXT NOT NULL, df INTEGER NOT NULL, PRIMARY KEY(field, token)) WITHOUT ROWID;
```

`facts` 用 `jsonb(?)` 写入、`json(facts)` 读出。
- **测试**：`src/java-index/sql/driver.test.ts`（:memory: 建库、PRAGMA 生效、事务回滚、schemaVersion 不匹配重建）。
- **门**：T0 编译 + 本测试通过。

### P0-T2 行映射：bundle ↔ rows

- **范围**：新增 `src/java-index/sql/rows.ts`：`fileRow(bundle)`, `typeRows(bundle)`, `fieldRows`, `methodRows`（`arity = parameters.length`）, `edgeRows(bundle.edges, fileId)`, `myBatisRow(resource)`；`writeBundle(db, bundle, fileId?)`（同一事务内 `DELETE FROM file WHERE path=?` → INSERT 全部）；`readBundle(db, path): JavaFileBundle|undefined`（从 `file.facts` + 该 file 的 type/field/method/edge facts 重组，字段顺序与 `JavaIndexStore.files()` 产出的 bundle 完全一致）。
- **锚点**：`JavaFileBundle` 形状见 `src/java-index/index-types.ts`；`files()` 的重组顺序见 `index-store.ts`（类型按 `allTypeIds` 顺序、边按 `fileOwnedEdgeIds` 插入序 — 读代码确认后在测试里固化）。
- **测试**：`rows.test.ts`：用 `parseJavaSourceFile` 解析 `fixtures/java-index-v2` 全部文件 → `writeBundle` → `readBundle` → `assert.deepEqual` 原 bundle；再与 `new JavaIndexStore().replaceFile(bundle); store.files([path])[0]` 的输出 deepEqual（这是 P1 差分 0 diff 的基础）。
- **门**：deepEqual 全通过。

### P0-T3 `SqlFactsStore`（读适配器 + 流式迭代）

- **范围**：新增 `src/java-index/sql/facts-store.ts`，实现附录 A.2 列出的 **读接口**：`typesById / methodsById / fieldsById / filesByPath / typeIdByFqn / typeIdsBySimpleName / methodIdsByOwnerAndName` 以 `{ get(k), has(k), size }` 形式（`size` 走 `count(*)`；**不提供** `values()`，避免误用全扫描）；方法 `files(paths)`, `file(path)`, `methodsOfOwner(typeId)`, `typeByFqn(fqn)`, `implementers(typeId, limit)`, `callers(methodId, limit)`, `callees(methodId, limit)`, `typeReferencers(typeId, kinds, limit)`, `methodsWithParameterTypes(typeIds, limit)`, `anchor(path, line, col)`, `typeLookup(typeText, scopeFile)`, `myBatisResource(path)`, `myBatisResourceForNamespace(ns)`, `myBatisStatement(qid)`, `repositoryFactMarkers(importPrefixes, annotationPrefixes)`；新增读方法 `implementersOfAny(typeIds): string[]`（替代 plan-query:225 全扫：`edge WHERE kind IN ('IMPLEMENTS','EXTENDS') AND to_id IN (...)` 再按 plan-query 的 `refTargetsType` 语义复核）、`typesBySimpleNameOrFqn(simple, fqn)`（替代 persistence-edge-builder:57）；builder 侧流式 `iterTypes() / iterFields() / iterMethods() / iterEdges() / iterFiles()`（`StatementSync.iterate`）。请求作用域 LRU（`Map`，上限 2048 项，每次 `files()`/RPC 结束清空）。
- **锚点**：各方法语义以 `index-store.ts` 同名方法为准（`implementers` :600-614 走 `inEdgeIdsByNode` kind∈{IMPLEMENTS,EXTENDS}，去重，默认 limit 40；`referencesVia` :893-913：`callers` kind∈{CALLS,METHOD_REFERENCE} 走入边、`callees` kind∈{CALLS,CONSTRUCTS,METHOD_REFERENCE} 走出边、`typeReferencers` 走入边按请求 kinds，默认 limit 80；`methodsWithParameterTypes` :645-664 走 `PARAM_TYPE` 入边且 fromId 必须是 method；`typeLookup` :564-598 把 registry 交给 `JavaNameResolver`；`anchor` :462-555 member 优先于 type、更深嵌套优先、无候选则 FILE 锚点；`myBatisResourceForNamespace` 仅当该 namespace **恰好 1 个** path 才返回 resource）。**排序**是显式比较器，SQL 用同样的键 `ORDER BY`：`implementers` = `compareTypes`（文件路径, range.start, typeId）；`callers/callees/typeReferencers` = `compareReferences`（sourceFile, range.start, sourceId）；`methodsWithParameterTypes` = owner fileId, method.range, methodId；`calleesBatch` 保输入序；`files(paths)` 保输入序、缺文件省略不报错。差分测试兜底。
- **测试**：`facts-store.test.ts`：fixtures/java-index-v2 双端灌入（旧 store 与 SQL），对每个方法、每个输入（全部 typeId/methodId/path 枚举）deepEqual。
- **门**：全部 deepEqual。
- **拆分（2026-09-07）**：`P0-T3.a` 点查 Map / `files` / `typeByFqn` / `methodsOfOwner` / mybatis / `iter*`；`P0-T3.b` 引用查询、`anchor`、`typeLookup`、`implementersOfAny`、`typesBySimpleNameOrFqn`、`repositoryFactMarkers`。

### P0-T4 `SqlRegistryView` + resolver 集成

- **范围**：新增 `src/java-index/sql/registry-view.ts`：`buildSqlRegistryView(store: SqlFactsStore): TypeRegistryView`，实现 `byId / byFqn / bySimpleName / nestedByOwnerAndSimpleName / methodsByOwnerTypeId`（`nestedByOwnerAndSimpleName` 的 key 构造方式照抄 `name-resolver.ts:buildTypeRegistryView`），带 LRU。
- **测试**：`registry-view.test.ts`：对 fixtures 每个文件，`resolveFileRefs(raw, new JavaNameResolver(view), view)` 与 `buildStaticEdges(...)` 的输出，SQL view vs `buildTypeRegistryView([...types])` deepEqual。
- **门**：deepEqual。

### P0-T5 builder：冷建两遍 + 进度 + CLI

- **范围**：新增 `src/java-index/builder/builder-main.ts`（CLI：`--repo <root> --db <path> --mode cold [--parallelism N]`）、`builder/cold-build.ts`（遍一：`walkJavaFiles`（复用 `manifest.ts` / `repo-layout.ts` 的源根发现）→ 并行 parse（`Promise` 池，`JAVA_LSP_BUILDER_PARALLELISM`）→ 每 200 文件一个事务 `writeBundle`；遍二：每文件 `readBundle` → `resolveFileRefs` → `buildStaticEdges` → 同事务 `UPDATE file/type/field/method facts` + `INSERT edge`；每 200 文件 `meta.buildProgress = {phase, done, total}`；结束写 `source_root_coverage`、`meta.buildState=READY`、`indexedGeneration`、`meta.counts = {files, types, methods, edges}`（每个写事务末都刷新，供 `status()` 免 `count(*)`））、`builder/progress.ts`。MyBatis XML 在遍一顺带解析（`mybatis-xml-extractor.ts`）写 `mybatis_resource`。**续建**：启动时读 `meta.buildProgress`，`phase=declare` 则跳过已有 `file.path`；`phase=resolve` 则从 `done` 继续。**无超时自杀逻辑**。
- **锚点**：`parseJavaSourceFile(args)` 签名见 `src/java-index/java-index-file-parse.ts:70-78`（需要 `ParseTreeCache`；builder 用 `maxEntries=8` 的小缓存，逐文件释放）；`cold-build.ts:320` 现有两遍逻辑可参考但不复用其 store。
- **测试**：`cold-build.test.ts`：fixtures/java-index-v2 冷建 → 各表 count 与 `JavaIndexStore` 全量装载后的 `filesByPath.size / typesById.size / methodsById.size / edgesById.size` 相等；kill 模拟（遍二中途抛错）→ 重跑从进度续建、最终结果相同。
- **实测（Task 内）**：`node dist/java-index/builder/builder-main.js --repo <lishuedu> --db /tmp/iod-lishuedu.sqlite --mode cold`，记录 wall clock、`/usr/bin/time -l` 峰值 RSS、DB 字节、各表 count。
- **门**：fixture 测试通过；lishuedu count 与附录 A.1 一致（files 6090±当前工作树差异、types 7319、fields 28556、methods 25077、edges 253711，允许因工作树变化 ±1%）。时长/内存/体积在 P0 Phase 门判。

### P0-T6 `SqlKnowledgeGraph`（`KnowledgeGraphStore` 同形读写）

- **范围**：新增 `src/java-index/sql/knowledge-graph.ts`，实现附录 A.4 的读写接口：`nodesById {get,has,size}`、`edgesById {size}`、`successors(id, kind?)`、`predecessors(id, kind?)`（`kg_edge` 双向索引；`REVERSE_EDGE_KIND` 反向物化照抄 `graph-store.ts:addEdge`）、`upsertNode(node, ownerFile?)`、`addEdge(edge, ownerFile?)`、`removeFiles(paths)`（按 `owner_file` 删）、`summariesByMethodId {get,set}`、`generation`、`digest()`（算法已确认为增量 xor：`graph-store.ts:98-107` = `sha256(nodeXor ‖ ":" + nodes.size + ":" ‖ edgeXor ‖ ":" + edges.size)`；SQL 实现把 `nodeXor` / `edgeXor` 存 `meta.graphNodeXor` / `meta.graphEdgeXor`，`upsertNode / addEdge / removeFiles` 在同一事务内同步更新，`digest()` 用 `meta` 两值 + 两表 count 计算；节点/边的 hash 输入字节序列必须逐字照抄旧实现）；新增读方法 `nodesByPath(path): GraphNode[]`、`nodeIdForJavaIndexId(jid): string|undefined`。
- **同时**：给旧 `KnowledgeGraphStore` 加同名 `nodesByPath` / `nodeIdForJavaIndexId`（线性实现），供 P1 双端。
- **测试**：`knowledge-graph.test.ts`：fixtures 经 `graph-builder` 分别灌旧图与 SQL 图 → 节点/边集合、`digest()`、每个节点 `successors/predecessors` deepEqual（排序后）。
- **门**：deepEqual 含 digest。

### P0-T7 builder 遍三：知识图 + entity token + 收口

- **范围**：`builder/cold-build.ts` 增加遍三：`new KnowledgeGraphBuilder(sqlFactsStore, sqlKnowledgeGraph)`（`graph-builder.ts` 现有 API，全表遍历改用 `iter*`——这是 builder 侧，允许全扫）；entity：新增 `src/java-index/sql/entity-tokens.ts`，把 `entity-search.ts` 的 `tokenize / identifierTokens / chunkTokens / fileStem / extractFqnCandidates / identifierLexemes` 与 BM25 打分抽成纯函数模块 `src/java-index/entity-scoring.ts`（旧 `EntitySearchIndex` 改为 import 该模块，行为不变），builder 对每个 type/method 写 `entity / entity_token / entity_df`。
- **测试**：`entity-tokens.test.ts`：fixtures 双端，`entity` 行集合与旧 `EntitySearchIndex.toSnapshot()` 的 records 一一对应（entityId/fqn/kind/tokens 多重集相等）；`entity-search.test.ts` 旧测试继续通过（抽函数不改行为）。
- **门**：deepEqual；旧测试绿。

### P0 Phase 门

| id | 目标 | 命令 / 测法 |
| --- | --- | --- |
| P0-G1 | 全量测试绿 | 0.5 两条命令 |
| P0-G2 | lishuedu 冷建 ≤ 180 s | P0-T5 实测命令，wall clock |
| P0-G3 | builder 峰值 RSS ≤ 600 MiB | `/usr/bin/time -l`，`maximum resident set size` |
| P0-G4 | DB ≤ 350 MB（lishuedu） | `stat -f %z`。>350 MB：在本 Phase 内对 `facts` 列启用 `zlib.deflateRawSync`（rows.ts 一处编解码），重测；仍 >350 停下报告 |
| P0-G5 | 四仓 count 与旧快照一致（±1%） | 四仓各建一次，`SELECT count(*)` |
| P0-G6 | 续建 | lishuedu 冷建 90 s 时 `kill -9`，重跑总时长 ≤ 1.3× G2 |
| P0-G7 | 新旧代码共存、旧行为不变 | `gate:pr` 绿；`git diff --stat PHASE_BASE..SHA -- src` 中被修改的旧文件只允许：`entity-search.ts`（import 抽出模块）、`graph-store.ts`（新增两方法） |

→ 0.6 review 协议 → `docs/phase-x/p0-closeout.json`。

### 3.9 P0 修订 R1（2026-09-07）：G4 阻塞裁决、schema v3、P0-T8 / P0-T9

**生效条件：用户已于 2026-09-07 批准。** 执行从 `212c852` 继续 T8.a→b→c → T9 → G1–G7 复跑。0.2 第 8 条约束的是执行者；本节是规划者修订。

#### 3.9.1 裁决

| `p0-blocked.md` 列出的选项 | 裁决 |
| --- | --- |
| 1. 把 G4 抬到 ~1400 MB | **否**。1342 MiB 不是磁盘问题而是 B-tree 键宽问题：200 B 文本键一页 4 KiB 只装 ~15 个内部键，树更深、page cache（32 MiB/连接）命中率随之崩，P1-G3 的查询 P95 会先撞墙。抬门等于把缺陷藏到下一 Phase。 |
| 2. 改冻结 schema | **是，但形式是归一化，不是删索引 / 删反向边 / 删表**。见 3.9.3。 |
| 3. 推迟 entity 表到 P1 | **否**。edge + kg 两族在 zlib 后仍 ~790 MiB，删掉 entity 也过不了门。 |

**G4 = 350 MB 不变。** 归一化后 lishuedu 估算 ≈ 210 MiB（3.9.2），留 ≥ 35% 余量。

#### 3.9.2 根因（lishuedu `86de82e` zlib DB，`dbstat`，实测）

1342 MiB 中 **1190 MiB（89%）落在四张表族**，它们共享同一个缺陷：**stable-id 文本（60–213 B）作为行键 / 索引键逐行重复，且 `facts` 再把同一批字符串编码一遍**。zlib 对逐行 300–500 B 的高熵标识符 blob 只省 ~35%，对键和索引（占体积 60%）完全无效——G4 卡里给的 zlib 杠杆打错了部件，这是规划者的错误。

| 表族 | 行数 | 实测 MiB | B/行 | 行里装了什么 | 纯冗余部分 |
| --- | --- | --- | --- | --- | --- |
| `edge` + 4 索引 | 253,711 | 335 | 1,385 | `edge_id` 213 B（= `edge:${kind}:${from}:${to}:${range}`，`stable-id.ts:47` 纯函数可重算）、`from_id` 124、`to_id` 60、`facts` 335（`StaticEdge` 全部字段都能从列复原） | `edge_id` 列 + 其 UNIQUE 自动索引 63 MiB + `facts` |
| `kg_edge` + 3 索引 | 270,720 | 363 | 1,405 | `from_id` 179、`to_id` 173、`owner_file` 108、`facts` 240（`GraphEdge` = `{edgeId, kind, fromId, toId, sourceFile, generation}`，`edgeId` 由 `knowledgeEdgeId` 重算） | `facts` 整列 |
| `kg_node` + 4 索引 | 67,989 | 94 | 1,445 | `id` 198、`java_index_id` 105、`owner_file` 108、`facts` 211（`GraphNode` 六字段全是列） | `facts` 整列 |
| `entity_token` + lookup | 1,155,427 | 398 | 361 | 每行重复 `entity_id` 121 B + `field` 7 B + `token` 8 B；lookup 索引再抄一遍 | 键宽本身 |
| `entity` + 3 索引 | 32,396 | 42 | 1,350 | `facts` 351 B 含 `identifierTokens/chunkTokens` 数组，与 `entity_token` 重复 | `facts` 中的 token 数组 |
| 其余（method 48 / field 22 / kg_summary 22 / type 7 / file 7 / entity_df 2） | — | 108 | — | `method.facts` 1,081 B/行是 `callSites`，真实载荷 | — |

字典规模（实测）：Java ids 60,952 个 / 6.43 MB 文本；边端点不在 Java ids 里的 7,917 个 / 0.86 MB；KG 节点 id 67,989 个 / 13.48 MB；entity id 32,396 个（与 KG id 不重叠）/ 3.7 MB；路径 6,090 个；token 34,146 个。**全部去重后 ≈ 25 MB 文本**——这就是 v2 里被重复了 ~40 次的东西。

v3 估算（含 SQLite B-tree 开销 ×1.3）：`sym` 表 + UNIQUE(text) ≈ 58 · `edge` 族 ≈ 22 · `kg_edge` 族（保留 CALLED_BY 物化）≈ 13 · `kg_node` 族 ≈ 4 · `entity_token` 族 ≈ 25 · `entity` ≈ 10 · 未变部分 ≈ 108（`kg_summary` 主键改 sym 后略降）→ **≈ 210–240 MiB**；即使 `sym` 估算偏差 2×，仍 < 300 MiB。附带收益：G6 时 WAL 在 90 s 已写 5.7 GB，写放大来自同一缺陷，v3 预计 G2 更快（不作承诺）。

#### 3.9.3 schema v3（冻结，替代 3.1 的 v2；`SCHEMA_VERSION=3`，`ensureSchema` 版本不等 drop-all 重建即可，P0 无存量数据）

编码规则（五条，reviewer 按此 grep）：

1. **所有可变长、会重复的字符串只在 `sym(id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE)` 里存一次**：Java stable id（type/field/method）、边端点（含未解析的外部类型 id）、KG 节点 id、entity id、相对路径 / owner 文件、边 kind、KG 节点 kind、token、`resolution.kind` / `typeStrategy`。其它表只存 `INTEGER` 外键，列名后缀 `_sym`。短枚举列（`type.kind`、`entity.kind`、`parse_state`、coverage `state`）与 `file.path`（`file` 表本身就是路径字典）保留 TEXT。
2. **`facts` BLOB 只保留在字段有嵌套结构、逐字段映射有漂移风险的表**：`file`、`type`、`field`、`method`、`mybatis_resource`、`kg_summary`（继续 `deflate-raw`）。`edge`、`kg_node`、`kg_edge`、`entity` **没有 `facts` 列**，对象从列 + `sym` 复原。
3. **可重算的 id 不落盘**：`StaticEdge.edgeId` 读时 `javaEdgeId({kind, fromId, toId, range})`；`GraphEdge.edgeId` 读时 `knowledgeEdgeId({kind, fromId, toId, ordinal})`。
4. **复原对象的字段顺序照抄产出处的对象字面量**（`edge-builder.ts:290-300`、`graph-store.ts:148-155` 反向边、`graph-builder.ts` 节点 / 边字面量、`entity-search.ts` records）；可选字段（`range`、`typeStrategy`、`sourceFile`、`relativePath`、`simpleName`、`javaIndexId`）缺失时**不写 key**，`deepStrictEqual` 区分 `undefined` 与缺失。
5. **行模型、去重语义、排序键与 v2 / 旧内存实现完全一致**：`CALLED_BY` 继续物化（归一化后仅 ~3 MiB，取消物化换不到体积却引入语义风险）；type/field/method/edge 继续 last-write-wins upsert；`ORDER BY id` 的插入序语义不变。T8 是编码改动，不是模型改动——现有双端 deepEqual 测试是唯一裁判。

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sym(id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE);
CREATE TABLE file(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, size INTEGER, mtime_ms REAL,
  ctime_ms REAL, source_root TEXT, module TEXT, package TEXT, parse_state TEXT, generation INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX file_content_hash ON file(content_hash);  CREATE INDEX file_source_root ON file(source_root);
CREATE TABLE type(sym INTEGER PRIMARY KEY REFERENCES sym(id), file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  fqn TEXT, simple_name TEXT NOT NULL, kind TEXT NOT NULL, owner_sym INTEGER, facts BLOB NOT NULL);
CREATE INDEX type_fqn ON type(fqn);  CREATE INDEX type_simple ON type(simple_name);  CREATE INDEX type_file ON type(file_id);
CREATE INDEX type_owner_simple ON type(owner_sym, simple_name);
CREATE TABLE field(sym INTEGER PRIMARY KEY REFERENCES sym(id), owner_sym INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, facts BLOB NOT NULL);
CREATE INDEX field_owner ON field(owner_sym);  CREATE INDEX field_file ON field(file_id);
CREATE TABLE method(sym INTEGER PRIMARY KEY REFERENCES sym(id), owner_sym INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, is_ctor INTEGER NOT NULL, arity INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX method_owner_name ON method(owner_sym, name);  CREATE INDEX method_file ON method(file_id);
CREATE TABLE edge(id INTEGER PRIMARY KEY, kind_sym INTEGER NOT NULL, from_sym INTEGER NOT NULL, to_sym INTEGER NOT NULL,
  file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  sl INTEGER NOT NULL, sc INTEGER NOT NULL, el INTEGER NOT NULL, ec INTEGER NOT NULL,          -- range；无 range 时四列均为 -1
  confidence REAL NOT NULL, res_kind_sym INTEGER NOT NULL, res_strategy_sym INTEGER, generation INTEGER NOT NULL,
  UNIQUE(kind_sym, from_sym, to_sym, sl, sc, el, ec));                                          -- = edgeId 的全部输入，承接 last-write-wins upsert
CREATE INDEX edge_from_kind ON edge(from_sym, kind_sym);  CREATE INDEX edge_to_kind ON edge(to_sym, kind_sym);  CREATE INDEX edge_file ON edge(file_id);
CREATE TABLE mybatis_resource(path TEXT PRIMARY KEY, namespace TEXT, content_hash TEXT, facts BLOB NOT NULL);
CREATE INDEX mybatis_ns ON mybatis_resource(namespace);
CREATE TABLE source_root_coverage(root TEXT PRIMARY KEY, state TEXT NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE kg_node(sym INTEGER PRIMARY KEY REFERENCES sym(id), kind_sym INTEGER NOT NULL, path_sym INTEGER, simple_name TEXT,
  jid_sym INTEGER, owner_sym INTEGER, generation INTEGER NOT NULL);
CREATE INDEX kg_node_path ON kg_node(path_sym);  CREATE INDEX kg_node_jid ON kg_node(jid_sym);  CREATE INDEX kg_node_owner ON kg_node(owner_sym);
CREATE TABLE kg_edge(id INTEGER PRIMARY KEY, from_sym INTEGER NOT NULL, to_sym INTEGER NOT NULL, kind_sym INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  file_sym INTEGER, owner_sym INTEGER, generation INTEGER NOT NULL);
CREATE INDEX kg_edge_from ON kg_edge(from_sym, kind_sym);  CREATE INDEX kg_edge_to ON kg_edge(to_sym, kind_sym);  CREATE INDEX kg_edge_owner ON kg_edge(owner_sym);
CREATE TABLE kg_summary(method_sym INTEGER PRIMARY KEY REFERENCES sym(id), facts BLOB NOT NULL);
CREATE TABLE entity(sym INTEGER PRIMARY KEY REFERENCES sym(id), kind TEXT NOT NULL, fqn TEXT NOT NULL, simple_name TEXT NOT NULL, simple_name_lc TEXT NOT NULL,
  path_sym INTEGER, owner_sym INTEGER, ident_len INTEGER NOT NULL, chunk_len INTEGER NOT NULL);
CREATE INDEX entity_fqn ON entity(fqn);  CREATE INDEX entity_simple ON entity(simple_name_lc);  CREATE INDEX entity_owner ON entity(owner_sym);
CREATE TABLE entity_token(entity_sym INTEGER NOT NULL REFERENCES entity(sym) ON DELETE CASCADE, field INTEGER NOT NULL, token_sym INTEGER NOT NULL, tf INTEGER NOT NULL,
  PRIMARY KEY(entity_sym, field, token_sym)) WITHOUT ROWID;                                     -- field: 0=identifier 1=chunk
CREATE INDEX entity_token_lookup ON entity_token(field, token_sym);
CREATE TABLE entity_df(field INTEGER NOT NULL, token_sym INTEGER NOT NULL, df INTEGER NOT NULL, PRIMARY KEY(field, token_sym)) WITHOUT ROWID;
```

`sym` 访问：写侧 `INSERT INTO sym(text) VALUES (?) ON CONFLICT(text) DO UPDATE SET text=excluded.text RETURNING id`（单语句，node 22 的 SQLite ≥ 3.35 支持 RETURNING；`DO NOTHING RETURNING` 冲突时不返回行，不能用），builder 侧 `Map` LRU 上限 65,536 项；读侧 text→id / id→text 两个 LRU 各 4,096 项，请求结束不必清（`sym` 只增不改）。点查形态：`SELECT t.facts FROM type t JOIN sym s ON s.id=t.sym WHERE s.text=?`。`sym` 不回收：P2 增量删文件不删 `sym` 行（孤儿是几十字节，冷建整库重建时自然消失）。

**P1/P2 卡文中的伪 SQL**（`to_id IN (...)`、`token IN (...)`、`WHERE type_id=?`、`owner_file`）一律按 v3 读作 `*_sym IN (SELECT id FROM sym WHERE text IN (...))` 或 join；卡文不逐条改。

#### 3.9.4 P0-T8 归一化（编码改动，三段）

前置：`git status` 干净，从 `212c852` 继续。每段一个 commit，前缀 `fix(iod): P0-T8.x ...`。

**P0-T8.a schema v3 + sym + rows + 点查**

- **范围**：`sql/schema.ts`（v3 DDL，`SCHEMA_VERSION=3`）；新增 `sql/sym.ts`（`internSym(db, text)`, `symText(db, id)`, `symId(db, text): number|undefined`, 两侧 LRU，≤ 120 行）；`sql/rows.ts`：type/field/method 行改 `sym/owner_sym`，`edgeRows` 改为 12 个标量列（无 `facts`、无 `edge_id`），`readBundle` 的 edge 复原经 `javaEdgeId` + `sym` join，`replaceBundleEdges` 与 `writeBundle` 的 upsert 目标改为 `UNIQUE(kind_sym, from_sym, to_sym, sl, sc, el, ec)`；`sql/facts-store.ts` 的 `typesById / methodsById / fieldsById / typeIdByFqn / typeIdsBySimpleName / methodIdsByOwnerAndName / files / file / methodsOfOwner / typeByFqn / iter*` 改走 sym join。
- **测试**：`rows.test.ts`、`facts-store.test.ts`、`driver.test.ts` 原断言不改继续绿；`rows.test.ts` 新增 **结构断言**：`pragma_table_info` 校验 `edge / kg_node / kg_edge / entity` 无 `facts` 列，且除白名单（`sym.text`、`file.path`、`type.fqn/simple_name/kind`、`field.name`、`method.name`、`kg_node.simple_name`、`entity.kind/fqn/simple_name/simple_name_lc`、`mybatis_resource.*`、`source_root_coverage.*`、`meta.*`、各 `facts`）外没有任何 TEXT/BLOB 列——这是防止缺陷回流的回归护栏。
- **门**：T0 + 上述测试绿。

**P0-T8.b 引用查询 + 知识图**

- **范围**：`sql/facts-store.ts` 其余（`implementers / callers / callees / typeReferencers / methodsWithParameterTypes / implementersOfAny / typesBySimpleNameOrFqn / anchor / typeLookup / repositoryFactMarkers`，排序键不变）；`sql/knowledge-graph.ts`：`kg_node / kg_edge / kg_summary` 按 v3 读写，`GraphNode / GraphEdge` 从列复原，`edgesById.size`、xor digest 的 hash 输入字节序列**逐字不变**（`e:${edgeId}` 用重算的 edgeId），`removeFiles` 按 `owner_sym`，`nodesByPath / nodeIdForJavaIndexId` 走 `path_sym / jid_sym`；`sql/registry-view.ts` 同步。
- **测试**：`facts-store.test.ts`、`knowledge-graph.test.ts`、`registry-view.test.ts` 原断言不改继续绿（含 digest deepEqual）。
- **门**：deepEqual 含 digest。

**P0-T8.c entity + builder 收口 + 实测**

- **范围**：`sql/entity-tokens.ts` 按 v3 写 `entity / entity_token / entity_df`（token 经 `sym`），`records()` 从列 + `entity_token(tf)` 复原（多重集语义，与 T7 测试口径一致）；`builder/cold-build.ts` 三遍接入 `sym`（遍一 intern 类型/成员 id，遍二 intern 边端点与 kind，遍三 intern KG id / 路径 / token）；`builder-main.ts` 结束时打印 `dbstat` 按表族的 MiB 与 B/行（仅 stdout 信息，不是门逻辑）。
- **测试**：`entity-tokens.test.ts`、`cold-build.test.ts` 原断言不改继续绿。
- **实测（Task 内）**：lishuedu 冷建（P0-T5 命令），记录 wall、峰值 RSS、`stat -f %z`、各表 count、`dbstat` 表族体积；写入 `docs/phase-x/p0-gate-raw/P0-T8c-lishuedu.txt`。
- **门**：count 与 A.1 一致；`stat -f %z` ≤ 350 MB（这是 G4 的提前验证，不是新门）。若 > 350 MB：先看 `dbstat` 哪个表族偏离 3.9.2 的估算 > 2×，按规则 1/2 找漏掉的 TEXT 列或多余 `facts`；不允许改门、不允许删索引 / 删表。

#### 3.9.5 P0-T9 三仓矩阵工具修复（scripts only）

`P0-three-repo-summary.txt` 的 `THREE_REPO_EXIT=2` 不是 P0 代码导致，是工具缺陷，但它会阻塞 P1-G5 / P3-G2 的 identity，必须在 P0 内修掉并用一次干净的矩阵证明工具可用。

- **真源**：`run-three-repo-cold-matrix.mjs:41` 设 `JAVA_LSP_ISOLATED_VALIDATION=1` 且不设 `JAVA_LSP_COLD_BUILD_CHILD`，`java-index-worker.ts:2297-2309`（`f1969ee`，FSR1-4 引入）在隔离 + child 禁用 + 文件数 > `IN_PROCESS_PARSE_FILE_LIMIT`(500) 时 `console.error` 一行 `in-process parse files=N (cold-build child disabled; cap waived)`；`verify-three-repo-cold-matrix.mjs:423-425` 要求 `.stderr` 为空 → 未打分即 exit 2。三个 live 仓都 > 500 文件，所以 **自 `f1969ee` 起正式矩阵在任何 SHA 上都不可能通过**（`f1969ee..6885b17` 之间没有矩阵产物可反证）。基线 `6885b17` 不可改代码，只能改工具。
- **修法（选定）**：`verify-three-repo-cold-matrix.mjs` 的 stderr 检查改为「去掉所有**整行精确匹配** `^\[codex-java-lsp\] in-process parse files=\d+ \(cold-build child disabled; cap waived\)$` 的行后必须为空」，并把每个 cell 被豁免的行数写进 `matrix-summary.json`（`stderrWaivedLines`）。不选「隔离下启用 cold-build child」：那会把两臂的冷启动路径从历次 FSR 矩阵一直使用的进程内 parse 换成 child + hydrate（FSZ 报告里 300 s 超时被杀的就是这条路），破坏与历史矩阵的可比性。这不是 0.2 第 7 条的「调参」：质量与 p95 阈值一字不动，只放过一条隔离环境自身产生的说明行。
- **范围**：`scripts/verify-three-repo-cold-matrix.mjs` + 对应 `scripts/*.test.mjs` 用例（含：仅该行 → 通过；该行 + 任意其它字节 → 仍 fail）。≤ 60 行。
- **门**：scripts 测试绿；随后 3.9.6 的矩阵复跑 exit 0。
- **P3 备注**：切流后候选臂不再有进程内 parse，但基线臂（旧 daemon）仍会打这一行；该豁免保留到 P3-G2 完成后随旧代码一起删除（P3-T2 清单追加此项）。

#### 3.9.6 P0 门复跑（T8/T9 之后，全部重跑；G4 目标不变）

| id | 目标 | 说明 |
| --- | --- | --- |
| P0-G1 | 全量绿 | 0.5 两条 |
| P0-G2 | ≤ 180 s | 预计低于 133 s（写量降 ~5×），实测为准 |
| P0-G3 | ≤ 600 MiB | builder 侧新增 `sym` LRU ≤ 65,536 项，预计 +10–20 MiB |
| P0-G4 | **≤ 350 MB（不变）** | `stat -f %z`；同时把 `dbstat` 表族体积表填进 closeout `notes` |
| P0-G5 | 四仓 count ±1% | lishu-v2 重复 FQN 的 last-write-wins 语义由 `UNIQUE(kind_sym, from_sym, to_sym, sl, sc, el, ec)` 承接，结果应与 `26e2b66` 记录一致 |
| P0-G6 | kill -9 续建 ≤ 1.3× G2 | 同时记录 kill 时 WAL 字节，与 5.7 GB 对照 |
| P0-G7 | 旧文件 diff 只允许两处 | T8/T9 不触碰旧 `src` 文件；`scripts/verify-three-repo-cold-matrix.mjs` 是 scripts，不在 G7 白名单范围内但须在 closeout 列出 |
| 三仓 cold-nolsp `--runs 5` | `THREE_REPO_EXIT=0` | `.cursor/rules/three-repo-load-gate.mdc`：load < 20 必跑。两臂都是旧 daemon 代码，预期 identity；这次的意义是证明 T9 后工具链可用，为 P1-G5 铺路 |

复跑完成 → 0.6 review 协议（diff 范围 `8670700..SHA_T9`，Reviewer 重点按 3.9.3 五条规则 grep）→ `p0-closeout.json`（`notes` 记录 R1、v2→v3 体积对照、T9 豁免）→ tag `iod/P0`。

---

## 4. Phase P1：查询层与差分一致

目标：`SqlJavaIndexClient` 实现 `JavaIndexClient` 全部 public 方法（附录 A.5），对四仓 25 个 RPC 与旧 worker 实现 0 diff；旧实现仍在，daemon 尚未切换。

### P1-T1 读接口类型化 + 6 处全扫描替换

- **范围**：新增 `src/java-index/facts-reader.ts`（`FactsReader` = `Pick<JavaIndexStore, 附录 A.2 读成员>` + `implementersOfAny` + `typesBySimpleNameOrFqn`）、`src/java-knowledge/graph-reader.ts`（`GraphReader` = 附录 A.4 读成员 + `nodesByPath` + `nodeIdForJavaIndexId`）。给 `JavaIndexStore` 加 `implementersOfAny`、`typesBySimpleNameOrFqn`（线性实现）。把 `plan-query.ts`、`graph-search.ts`、`graph-walk.ts`、`call-resolver.ts`、`framework-edge-builder.ts`、`persistence-edge-builder.ts`、`graph-builder.ts`（仅读侧类型）、`java-index-worker-query.ts` 的参数类型改为 `FactsReader` / `GraphReader`；替换 6 处全扫描：`plan-query.ts:190,225,440`、`graph-search.ts:42,107`、`graph-walk.ts:20`、`persistence-edge-builder.ts:57`（后者在 builder 侧也走同一方法）。
- **测试**：现有 `plan-query.test.ts`、`graph-search.test.ts`、`graph-walk` 相关、`persistence-edge-builder.test.ts`、`call-resolver.test.ts`、`graph-builder.test.ts` 全部不改断言继续绿。
- **门**：T0 + 上述测试绿。旧 worker 行为不变（P1-T5 差分会证明）。

### P1-T2 `SqlEntitySearch`

- **范围**：新增 `src/java-index/sql/entity-search.ts`：`search(task, limit)` 四层照 `entity-search.ts:307-338`：层 1 `entity WHERE fqn = ? OR fqn LIKE '%.' || ?`（候选 ≤ 数百，JS 侧排序 entityId）；层 2 `entity WHERE kind='type' AND simple_name_lc IN (...)`（排序：名长降、df 升、entityId）；层 3/4：`entity_token WHERE field=? AND token IN (...)` 取候选 (entity_id, tf) + `entity_df` + `count(*) entity` 与平均长度（`meta` 缓存或 `SELECT avg(ident_len)`），调用 `entity-scoring.ts` 的 BM25 纯函数打分。`limit` 夹 `[1,10]`，默认 3。
- **测试**：`sql/entity-search.test.ts`：fixtures 双端，对 ≥ 50 个 task 文本（golden 场景 `task` 字段抽样 + 构造）结果 deepEqual。
- **门**：deepEqual。

### P1-T3 `SqlJavaIndexClient` 骨架 + 点查 RPC

- **范围**：新增 `src/java-index/java-index-client-api.ts`（`interface JavaIndexClientApi` = 附录 A.5 全部签名；`JavaIndexClient implements JavaIndexClientApi`；`RouterJavaIndex` 构造参数与 `ToolContext.javaIndexClient` 类型改为接口——`src/tools/context.ts:47-50`、`router-java-index.ts:225-229`）；新增 `src/java-index/sql/sql-client.ts`：构造 `(repoRoot, dbPath)`；`open()` 打开只读连接（DB 不存在 → 状态 `EMPTY`，P2 接 builder）；`status()/localStatus()` 从 `meta` 组装 `JavaIndexStatus`（无堆字段；`factsHydrated:true`、`hibernated:false`、`pendingForeground:0` 常量以兼容 `isJavaIndexPrewarmReady` 与 `summarizeCoverage`）。**注意**：`agent-router/index.ts:251/435` 每个工具请求前后各调一次 `status()` 组 freshness，所以 `files/types/methods/edges` 计数**不得**每次 `count(*)`，由 builder 在每个事务末写入 `meta.counts`（P0-T5/P2-T1 同步补这一行），`status()` 只读 `meta`；实现 `queryAnchor / queryType / queryTypes / queryFiles / queryImplementers / queryTypeReferencers / queryCallers / queryCallees / queryCalleesBatch / queryMethodsWithParameterTypes / queryMyBatisResource / queryMyBatisResourcesByNamespace / queryRepositoryFactMarkers`（委托 `SqlFactsStore`；`queryAnchor` 的 `coverage` 与 `queryType(s)` UNRESOLVED 的 `coverage` 不是 store 直出，须照 worker 的 `coverageStateFor(sourceRoot, generation)` / `worstTypeLookupCoverage(generation)` 从 `source_root_coverage` 覆盖；返回值经 `worker-protocol.ts` 的 `validate*` 校验以保证形状一致）；`close()` 关连接。`refresh/refreshResources/reconcile/ensureFresh/awaitPrewarmReady/flush/hibernate/recycle` 本 Task 抛 `NOT_IMPLEMENTED`（P2 实现或删除）。
- **测试**：`sql-client.test.ts`：fixtures 建库后，每个已实现方法与 `JavaIndexClient`（真 fork worker，现有测试已有此模式 `java-index-client.test.ts`）输出 deepEqual。
- **门**：deepEqual；T0。

### P1-T4 图与上下文 RPC

- **范围**：新增 `src/java-index/sql/sql-queries.ts`：把 `java-index-worker-query.ts` 中 `QUERY_GRAPH_DIGEST / QUERY_GRAPH_REACHABLE / QUERY_CONTEXT_GRAPH / QUERY_ENTITY_SEARCH / QUERY_READ_RANGES` 五个 case 的处理体移植为函数（输入 `FactsReader + GraphReader + SqlEntitySearch`），`sql-client.ts` 对应方法委托之；`QUERY_READ_RANGES` 用 `readBundle` 的 range/bodyRange + `fallbackReadRange`（不再依赖 parse-tree cache；语义以 `java-index-worker.ts:577-604` 为准）。`QueryHandlerDeps` 里的 `coverageStateFor / worstTypeLookupCoverage / unresolvedTypeLookup` 从 `source_root_coverage` 与 `meta` 读。
- **测试**：`sql-queries.test.ts`：fixtures + golden `generic-java.scenarios.jsonl` 的锚点，五个 RPC 双端 deepEqual（`ContextGraphResult` 去除 `elapsedMs` 类时间字段后比较）。
- **门**：deepEqual。

### P1-T5 差分 harness（生产规模）

- **范围**：新增 `scripts/diff-index-impl.mjs`：参数 `--repo <root> --db <path> --anchors <n=200> --out <json>`；流程：若 DB 缺则调 builder 冷建；启动旧 `JavaIndexClient`（fork worker，`open` + `awaitPrewarmReady({hydrate:true})`）与 `SqlJavaIndexClient`；锚点集 = 该仓 golden 场景全部 `file/line/column` ∪ 均匀抽样文件的第一个 method 起点；对 25 个 RPC 逐个调用（参数派生规则写在脚本头注释：如 `queryCallers` 的 methodId 来自 `queryAnchor` 结果、`queryContextGraph` 用 `intent=IMPLEMENTATION_CHANGE|PERSISTENCE_FLOW` 两档、`queryEntitySearch` 用 golden `task`）；归一化（数组按稳定键排序、去 `elapsedMs/generation/observedAt/heap*`）→ deepEqual；输出 `{repo, rpc: {name: {calls, diffs, p50Ms:{old,new}, p95Ms:{old,new}}}, diffSamples[≤5/rpc]}`。
- **测试**：`scripts/diff-index-impl.test.mjs`：对 fixtures/java-index-v2 跑通、0 diff。
- **门**：fixtures 0 diff。生产规模在 Phase 门。

### P1-T6 差分归零

- **范围**：对四仓跑 P1-T5，逐条归因 diff：新实现 bug → 修（改 `sql/*`）；排序/浮点表示 → 修归一化并在脚本注释记录理由；旧实现 bug → 写入 `docs/phase-x/p1-diff-triage.md` 附证据，**暂以旧实现为准**（保证 identity），登记为 P3 后可选修复。允许多个 commit，每个 ≤ 400 行。
- **门**：四仓 `diffs=0`。

### P1 Phase 门

| id | 目标 | 测法 |
| --- | --- | --- |
| P1-G1 | 全量测试 + gate:pr 绿 | 0.5 |
| P1-G2 | 四仓 25 RPC diffs = 0 | `scripts/diff-index-impl.mjs` × 4，产物 `docs/phase-x/p1-diff-<repo>.json` |
| P1-G3 | 查询 P95（新实现，lishuedu）：点查类 ≤ 10 ms；`queryFiles`(单文件) ≤ 15 ms；`queryContextGraph` ≤ 25 ms；`queryEntitySearch` ≤ 15 ms | 同上产物 `p95Ms.new` |
| P1-G4 | 主线程阻塞：diff 运行期间 `setInterval(1ms)` 漂移采样 P99 ≤ 30 ms | harness 内置采样 |
| P1-G5 | 旧行为不变 | 三仓 `--runs 2` identity（`--baseline codex/fs-track`）内容 delta 0（旧实现仍是 daemon 实际路径） |

P1-G3 超门：`EXPLAIN QUERY PLAN` 加索引或拆查询；**不开线程**。→ review → `p1-closeout.json`。

---

## 5. Phase P2：增量、监视、生命周期

目标：daemon 切到 `SqlJavaIndexClient`；watcher 事件走 builder；连接 open/close；旧 worker 代码仍在但不再被 `createRuntime` 使用。

### P2-T1 builder 增量模式

- **范围**：`builder-main.ts` 增 `--mode serve`：stdin 逐行 JSON 作业 `{id, kind: refresh|resources|reconcile, generation, changed[], deleted[]}`，stdout 逐行 `{id, ok, indexedGeneration, files, error?}`；新增 `builder/incremental.ts`：`refresh`：单事务内 `deleted` → `DELETE FROM file`（级联）；`changed` → parse → `writeBundle` → resolve+edges；**dependents** = `SELECT DISTINCT source_file_id FROM edge WHERE to_id IN (本文件旧/新 type_id, method_id, field_id)` 的文件重做 resolve+edges（照 `java-index-worker.ts:resolveAndBuildEdges` 的语义，不递归）；知识图：`removeFiles([path, ...dependents])` → 对这些文件 `graphBuilder.addBundle` + call/framework/persistence 边（`graph-builder.ts` 现有增量 API）；entity：按 `owner_file` 删后重写并调整 `entity_df`；事务末 `meta.indexedGeneration = generation`、`meta.counts` 增量更新。`resources`：MyBatis XML 重解析 + 受影响 namespace 的 KG 重绑（照 `java-index-worker.ts:2551-2563`）。`reconcile`：`file(path, content_hash, mtime_ms)` 与磁盘 stat 对比（`manifest.ts` 现有扫描）→ 差异集合走 refresh；BUILD_CHANGE 时先 `layout.refresh()` 并对源根变化的文件集处理；**不整库丢弃**。
- **测试**：`incremental.test.ts`：fixtures 冷建 → 改一个文件的方法签名 → refresh → 该文件与 dependents 的 edges/KG/entity 与「重新冷建」结果 deepEqual；删文件 → 级联行数为 0；reconcile 发现外部改动。
- **门**：deepEqual。

### P2-T2 `BuilderSupervisor`

- **范围**：新增 `src/java-index/builder-supervisor.ts`：`submit(job): Promise<result>`（无进程则 `fork(builder-main.js, ['--mode','serve',...])`，execArgv 不带 heap 参数）；作业串行（单写者）；空闲 `JAVA_LSP_BUILDER_IDLE_MS` 后发 `{kind:"exit"}` 并等待退出；进度看门狗：作业进行中每 30 s 读 `meta.buildProgress`，120 s 无推进 → `SIGKILL` → 重 fork → 重提交同作业（最多 2 次，之后作业以 error 结束、不影响其它作业）；`coldBuild(repo, db): Promise<void>`（`--mode cold` 一次性子进程，同一看门狗）；`status(): {state: idle|busy|cold-building|absent, pid?, queued}`。子进程 stdio `["pipe","inherit","inherit"]`。
- **测试**：`builder-supervisor.test.ts`：假 builder 脚本（fixture）验证串行、idle 退出、看门狗重启、并发 submit 排队。
- **门**：测试绿。

### P2-T3 client 增量方法 + 接线 coordinator

- **范围**：`sql-client.ts` 实现 `refresh(generation, changed, deleted, opts)` → `supervisor.submit(refresh)`；`refreshResources` → `resources`；`reconcile` → `reconcile`；`ensureFresh(files, generation)` → 若 `meta.indexedGeneration < generation` 且 files 中有 `file.generation < generation` 则 `refresh(changed=files)`；`awaitPrewarmReady` → 等待 `meta.buildState=READY`（budget 内轮询 250 ms）；`flush/hibernate/recycle` → 无操作、返回当前 status（P3 删除接口）。`repo-runtime-manager.ts:applyBatchToJavaIndex`（:975-1002）**不改映射**，只是 client 换实现。
- **测试**：`sql-client-incremental.test.ts`：fixtures + 真 supervisor：`refresh` 后 `queryFiles` 反映新方法；`ensureFresh` 触发条件。
- **门**：测试绿。

### P2-T4 连接生命周期与 `status`

- **范围**：`sql-client.ts`：`open(generation, options)`（`options` 为现有 `JavaIndexOpenOptions{leaseRoot?, worktree?, siblingCacheBase?}` 加可选 `siblingDbPath?`）：DB 存在 → 打开只读连接、`state=READY`；不存在 → 若 `options.siblingDbPath`（P2-T6 传入）存在则 `VACUUM INTO` 拷贝后提交 `reconcile` 作业，否则 `supervisor.coldBuild` 后台启动、`state=BUILDING`，两者都立即返回（工具层已有 `coverage=DEGRADED` 的可重试 gap 语义）；空闲 `JAVA_LSP_CONN_IDLE_MS` 关连接（下一次查询自动重开，毫秒级）；`status()` 组装：`state`、`indexedGeneration`、`files/types/methods/edges` count、`coverage`（`source_root_coverage`）、`pendingBackground = supervisor.queued`、新增 `db:{bytes, cacheKb}`、`builder: supervisor.status()`。`JavaIndexStatus` 类型（`index-types.ts:257-288`）新增可选 `db` / `builder`，堆字段标 `@deprecated`（P3 删）。
- **测试**：`sql-client-lifecycle.test.ts`：idle 关连接后查询自动重开；DB 缺失时 `open` 返回 BUILDING 且 builder 启动；`status` 字段。
- **门**：测试绿。

### P2-T5 manager 切换 + 删 hot-set/hydrate 语义

- **范围**：`repo-runtime-manager.ts`：`createRuntime`（:1367-1373）改为 `new SqlJavaIndexClient(repoRoot, indexDbPath(repoRoot), supervisor)`，`RouterJavaIndex` 不变；`prewarmRepo` 改为「`open` + 若 BUILDING 则等待 READY（预算 `PREWARM_INDEX_MS`）」，删除 `hydrate` 选项与 `recycle/hibernate` 调用；删除 `hibernateTimer / indexIdleTimer`、`hibernateEntry`、`maybeRecycleHighHeap`、`pollIdleHeapRecycle`、`startHeapRecycleWatch/stopHeapRecycleWatch`、`evictOldestNonHotFamilyPeer`、`hydrateBaselineHeapMb`、`hibernated`；**保留** `idleTimer`（JDT 槽位）与 `pressureTimer` 中仅 JDT 的 `stopEntry` 分支（去掉 hibernate 分支）；`RuntimeEntry` 删除对应字段。`application.ts:prewarmPinnedRepos` 去掉 `parsePrewarmHotSet` 与 `hydrate` 参数（`JAVA_LSP_PREWARM_HOT` 保留为 no-op 一个 Phase，P3 删）。`resource-defaults.ts` 相关默认值先保留（P3 删）。
- **测试**：`repo-runtime-manager.test.ts` 中 hibernate/recycle/heap 相关用例删除，其余绿；新增用例：prewarm 在 BUILDING 时等待、idle 只影响 JDT。
- **实测**：canary daemon（`JAVA_LSP_HTTP_PORT=38457 node dist/http-server.js`，独立 cache base）对四仓 `java_status` / `java_impact`。
- **门**：测试绿；canary 四仓 `java_impact` 成功。

### P2-T6 worktree 拷贝 + 状态工具 + 启动参数

- **范围**：`createRuntime` 计算 `siblingDbPath`：同 `gitCommonDir` 家族（`worktree-identity`/`family-worker-pool.ts` 现有 familyHash 逻辑）下其它 root 的 `index.sqlite` 中最近修改者；传给 `open`。`src/tools/status.ts`：`summarizeJavaIndex` 去掉 `factsHydrated / hibernated / worktreeSeed`，加 `db` / `builder`；diagnostic 分支输出完整 status（已无堆字段）。`run-daemon.sh:36` 追加 `--disable-warning=ExperimentalWarning`，保留 `--max-old-space-size=768`（daemon 现在只装缓存，768 足够；P3 复核）。`install-runtime.sh` canary 命令同样加该 flag。
- **测试**：`worktree-seed.test.ts`（新）：两个 fixture 拷贝模拟家族，第二个 root `open` 走 `VACUUM INTO` + reconcile 后 count 一致；`status.test.ts` 字段。
- **门**：测试绿。

### P2 Phase 门（canary daemon，四仓 live）

| id | 目标 | 测法 |
| --- | --- | --- |
| P2-G1 | 全量测试 + gate:pr 绿 | 0.5 |
| P2-G2 | 首查（连接已关）≤ 300 ms；新 worktree（sibling DB 存在）首查 ≤ 3 s | 探针：关连接后 `java_impact`；lishu-v2 新建 worktree 后 `java_status` + `java_impact` |
| P2-G3 | 编辑时效：保存 → `freshness.indexedGeneration` 反映 P95 ≤ 2 s（20 次） | 脚本改 lishu-v2 一文件 → 轮询 `java_status` |
| P2-G4 | 编辑 churn：lishu-v2 脚本化 2000 次修改/还原 → DB 增长 ≤ 10%，daemon RSS 前后差 ≤ 20 MiB | `stat`、`ps -o rss` |
| P2-G5 | daemon RSS：四仓各查一次后 ≤ 250 MiB；15 min 空闲后 ≤ 120 MiB | `ps -o rss` |
| P2-G6 | 每 root 增量：新开一个 root 后 RSS 增 ≤ 48 MiB；关连接后回落 | 对照 |
| P2-G7 | 无任何进程 > 1 GiB（含 builder 冷建期） | 冷建期间 `ps` 采样 |
| P2-G8 | 差分仍 0 diff（daemon 已切新 client） | `diff-index-impl.mjs` × 4 复跑 |

→ review → `p2-closeout.json`。

---

## 6. Phase P3：删除与切换

### P3-T1 删除 worker/store/协议层

- **范围**：删 `java-index-worker.ts`、`java-index-worker-process.ts`、`java-index-worker-query.ts`、`java-index-worker-mybatis.ts`、`worker-protocol.ts`（**保留** `validate*` 与类型：先移到 `src/java-index/index-validate.ts`，再删原文件）、`java-index-client.ts`（旧类；`JavaIndexClientApi` 接口留）、`family-worker-pool.ts`、`index-store.ts`、`parse-tree-cache.ts`（builder 用到的最小 LRU 若依赖它，先内联到 builder）、`cold-build.ts`、`cold-build-child.ts`、`hydrate-snapshot-view.ts`、`entity-search.ts`（旧类；`entity-scoring.ts` 留）、`java-knowledge/graph-store.ts`、`graph-snapshot.ts`、`graph-columns.ts`；对应测试文件（附录 A.6 列表）删除；`diff-index-impl.mjs` 改为只做 SQL 端自检（或删除，closeout 记录）。
- **门**：T0 全绿（此时全量测试文件数下降为正常现象，closeout 记录前后数量）。

### P3-T2 删除快照/列式/家族/seed + 开关收敛

- **范围**：删 `snapshot.ts`、`snapshot-v4.ts`、`columnar/*`、`shared-facts-pool.ts`、`worktree-snapshot-seeder.ts`、`build-fingerprint.ts`、`manifest.ts` 中仅供快照的部分、`scripts/fsz-live-sample.mjs`、`run-fsz-unit-taps.mjs`、`fsr2-heap-unify.test.ts`、`fsr4-soak-gates.test.ts`、`cold-build-watch.test.ts`；`resource-defaults.ts` 删 `DEFAULT_HIBERNATE_TTL_MS / DEFAULT_COLD_HIBERNATE_TTL_MS / parsePrewarmHotSet / DEFAULT_PREWARM_HOT`；删环境变量读取：`JAVA_LSP_PREWARM_HOT / HIBERNATE_TTL_MS / COLD_HIBERNATE_TTL_MS / INDEX_IDLE_TTL_MS / WORKER_HEAP_RECYCLE_MB / WORKER_HEAP_RECYCLE_INTERVAL_MS / COLD_BUILD_CHILD / PARSE_TREE_SOURCE_BYTES / MAX_BACKGROUND_SWEEPS / IDLE_PREWARM / JAVA_INDEX_RPC_TELEMETRY`（后者若 telemetry 仍有用则保留并在 closeout 说明）；`install-runtime.sh:739-751` 透传列表同步删除已无读取的变量；`worktree-cache-cleanup.ts` 中识别旧快照文件名的逻辑改为识别 `index.sqlite*`，并在启动时删除 `java-index-snapshot*.json.gz*` / `java-knowledge-graph.json.gz` 旧文件；P3-G2 完成后删除 `verify-three-repo-cold-matrix.mjs` 中 P0-T9 加的 `cap waived` 行豁免（3.9.5）。
- **门**：T0 绿；`rg -c "process.env.JAVA_LSP_" src --glob '!*.test.ts'` 的去重变量数 ≤ 30；`rg -n "heapUsed|rssMb|hibernat|recycle" src --glob '!*.test.ts'` 仅剩 JDT 相关命中（逐条列入 closeout）。

### P3-T3 脚本与文档

- **范围**：`scripts/probe-daemon-acceptance.mjs` 重写探针：D2（healthz P99）、D4（短 deadline 重试）、D6（新仓 status ≤ 3 s）保留；删 D3a/D3b/D7/FSX_*；新增 P2-G2/G5/G6 探针；`HANDOFF.md` 架构段重写（存储层、builder、生命周期、删除清单、陷阱：不要再加看护）；`README.md` 相关段；方案文档状态行更新为 `IMPLEMENTED（P3）`；FS/daemon 两份计划状态行标注「JavaIndex 部分已由 index-on-disk 取代」。
- **门**：`node scripts/probe-daemon-acceptance.mjs` 对 canary 全绿。

### P3-T4 T3 identity + 发布切流（需用户确认后执行安装）

- **范围**：三仓 identity：

```bash
sh scripts/run-isolated-node.sh scripts/run-three-repo-cold-matrix.mjs \
  --baseline main --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> \
  --output-dir /tmp/iod-identity-<id> --runs 2
sh scripts/run-isolated-node.sh scripts/verify-three-repo-cold-matrix.mjs \
  --matrix-dir /tmp/iod-identity-<id>/matrix --manifest /tmp/iod-identity-<id>/run-manifest.json --expected-runs 2
```

  内容 identity：recall / pRead / rReadMust / token P50 delta 0（formal floors 双臂同败的历史情况按 closeout 惯例记录，不计入）。`gate:release` 绿。ruoyi 观察仓：`scripts/run-f1-ruoyi-observation.mjs`（`--runs 5`）质量 bit-identical。
  **安装**：向用户报告以上结果，获确认后 `install-runtime.sh`（现有流程：canary smoke → switch_current → LaunchAgent），首启四仓自动冷建（1–3 分钟 `BUILDING`）。
- **门**：identity delta 0；`gate:release` 绿；安装后 `daemonctl.sh smoke` 绿；四仓 `java_impact` 成功。

### P3 Phase 门

| id | 目标 |
| --- | --- |
| P3-G1 | 全量测试 + `gate:release` 绿 |
| P3-G2 | 三仓 identity 内容 delta 0；ruoyi 观察 bit-identical |
| P3-G3 | 代码规模：`src/java-index/**` + `src/java-knowledge/**` + `repo-runtime-manager.ts` 非测试行数 ≤ 9,000（当前 18,193 + 2,664）；`JAVA_LSP_*` ≤ 30；`repo-runtime-manager.ts` 中 `setTimeout/setInterval` ≤ 3（JDT idle、pressure、连接 idle） |
| P3-G4 | 切流后 P2-G5/G6/G7 在生产 daemon 复测通过 |
| P3-G5 | 切流后 48h 观察（非阻塞，用户正常使用）：0 FATAL、0 查询错误、0 看门狗重启；采样器只采 RSS / 错误 / builder 事件，不存在任何 recycle/compact 指标 |

→ review → `p3-closeout.json` → 合 main 需用户确认。

---

## 7. 停止条件与报告

以下任一发生即停止本 Phase，写 `docs/phase-x/<phase>-blocked.md`（现象、数字、已尝试、需要用户决定的问题），不再继续：

1. Task 门连续 3 次尝试不过。
2. Phase 门任何一条在两轮 review 修复后仍不过。
3. 差分出现无法归因的 diff（既不是新实现 bug、也不是归一化、也拿不出旧实现 bug 的证据）。
4. 需要违反 0.2 任何一条才能推进。
5. 发现方案 §2 的前提性错误（如 `node:sqlite` 在 22.16 缺某必需 API）。

报告格式：结论一句 → 数字 → 已完成 Task 清单 → 阻塞点与证据 → 需用户决定的问题（≤ 3 个）。

---

## 附录 A：锚点清单（来自只读探索，写卡依据）

### A.1 lishuedu 快照统计（P0-G5 基准，2026-09-06 live 快照）

files 6,090 · types 7,319 · fields 28,556 · methods 25,077 · edges 253,711 · callSites 317,406（在 method 内）· parameters 34,211 · annotations 13,340 · 磁盘 28,129,898 B · extractor `schema-3|facts-2|tree-sitter-0.25.0|tree-sitter-java-0.23.5`。

### A.2 `JavaIndexStore` 读成员（`FactsReader` 范围）

Map 类：`typesById`、`methodsById`、`fieldsById`、`filesByPath`、`typeIdByFqn`、`typeIdsBySimpleName`、`methodIdsByOwnerAndName`（查询侧仅 `get/has/size`）。方法：`files(paths)`、`file(path)`、`methodsOfOwner(typeId)`、`typeByFqn(fqn)`、`implementers(typeId, limit)`、`callers`、`callees`、`typeReferencers(typeId, kinds, limit)`、`methodsWithParameterTypes(typeIds, limit)`、`anchor(path, line, col)`、`typeLookup(typeText, scopeFile)`、`myBatisResource(path)`、`myBatisResourceForNamespace(ns)`、`myBatisStatement(qid)`、`repositoryFactMarkers(importPrefixes, annotationPrefixes)`。新增：`implementersOfAny(typeIds)`、`typesBySimpleNameOrFqn(simple, fqn)`。
**不进入** `FactsReader`：`edgesById`、`inEdgeIdsByNode`、`outEdgeIdsByNode`、`fileOwnedNodeIds`、`fileOwnedEdgeIds`、`dependentFilesByTypeName`、`installedBundles`、`replaceFile`、`removeFiles`、`toSnapshotData`、`loadSnapshotData`、`ingestSnapshotFacts`、`attach*`、`compactColumnar`、`columnarStats`、`*Bytes()`。

### A.3 查询侧全表扫描（P1-T1 替换清单）

| 位置 | 扫描 | 过滤 | 替换为 |
| --- | --- | --- | --- |
| `context-engine/plan-query.ts:190` | `graph.nodesById.entries()` | `relativePath===path && javaIndexId∈wanted` | `graph.nodesByPath(path)` 再过滤 |
| `plan-query.ts:225` | `store.typesById.values()` | implements∪extends 命中 target | `store.implementersOfAny(targetIds)` |
| `plan-query.ts:440` | `graph.nodesById` | `javaIndexId` 有值 → 映射 | `graph.nodeIdForJavaIndexId(jid)` 按需 |
| `context-engine/graph-search.ts:42` | `graph.nodesById` | 按 path 分组 | `graph.nodesByPath(path)` |
| `graph-search.ts:107` | `graph.nodesById.entries()` | `relativePath===start \|\| id===start` | `graph.nodesByPath(start)` ∪ `nodesById.get(start)` |
| `java-knowledge/graph-walk.ts:20` | `graph.nodesById` | 同上 | 同上 |
| `java-knowledge/persistence-edge-builder.ts:57` | `store.typesById.values()` | `simpleName===simple \|\| fqn===name`，唯一命中 | `store.typesBySimpleNameOrFqn(simple, name)` |

builder 侧全扫（`graph-builder.ts:74-101`、`entity-search.ts:369-393`、`rebuildRegistry`）走 `iter*`，不在此表。

### A.4 `KnowledgeGraphStore` 接口（`GraphReader` + 写）

读：`nodesById {get,has,size,entries}`、`edgesById {size}`、`successors(id, kind?)`、`predecessors(id, kind?)`、`summariesByMethodId.get`、`generation`、`digest()`；新增 `nodesByPath(path)`、`nodeIdForJavaIndexId(jid)`。写：`upsertNode(node, ownerFile?)`、`addEdge(edge, ownerFile?)`（反向物化 `CALLED_BY` for `CALLS_EXACT|CALLS_VIRTUAL|DISPATCHES_TO|CONSTRUCTS|METHOD_REFERENCE`）、`removeFiles(paths)`、`clear()`。节点 kind 与边 kind 清单见探索报告（graph-builder 产出：REPOSITORY/MODULE/SOURCE_ROOT/FILE/TYPE/FIELD/METHOD/CONSTRUCTOR/JAVA_RESOURCE/MYBATIS_NAMESPACE/MYBATIS_STATEMENT；边 CONTAINS/DECLARES/EXTENDS/IMPLEMENTS/PERMITS/IMPORTS/ANNOTATED_WITH/MODULE_DEPENDS_ON/CALLS_EXACT/CALLS_VIRTUAL/DISPATCHES_TO/CONSTRUCTS/METHOD_REFERENCE/CALLED_BY/SPRING_INJECTS/SPRING_BEAN_BINDS_TO/CONSUMES_EVENT/PUBLISHES_EVENT/MYBATIS_METHOD_BINDS_STATEMENT/MYBATIS_STATEMENT_USES_ENTITY/REPOSITORY_MANAGES_ENTITY/JPA_RELATION）。

### A.5 `JavaIndexClient` public 签名（`JavaIndexClientApi`）

```
open(generation, options?, requestOptions?): Promise<JavaIndexStatus>
status(requestOptions?): Promise<JavaIndexStatus>
refresh(generation, changed, deleted, requestOptions?, priority?): Promise<JavaIndexStatus>
refreshResources(generation, paths, requestOptions?): Promise<JavaIndexStatus>
ensureFresh(files, generation, requestOptions?): Promise<void>
reconcile(generation, requestOptions?): Promise<JavaIndexStatus>
awaitPrewarmReady(requestOptions?): Promise<JavaIndexStatus>
flush / hibernate (requestOptions?): Promise<JavaIndexStatus>   // P2 no-op，P3 删除并同步删 RouterJavaIndex 调用
recycle(requestOptions?): Promise<void>                          // 同上
queryAnchor(file, line, column, ro?): Promise<AnchorFacts|undefined>
queryType(typeText, scopeFile?, ro?): Promise<JavaTypeLookupResult>
queryTypes(queries, ro?): Promise<JavaTypeLookupResult[]>
queryImplementers(typeId, limit, ro?): Promise<JavaTypeFacts[]>
queryTypeReferencers(typeId, edgeKinds, limit, ro?): Promise<IndexedReference[]>
queryCallers / queryCallees (methodId, limit, ro?): Promise<IndexedReference[]>
queryCalleesBatch(methodIds, limit, ro?): Promise<Array<{methodId, callees}>>
queryMethodsWithParameterTypes(typeIds, limit, ro?): Promise<string[]>
queryFiles(files, ro?): Promise<JavaFileBundle[]>
queryReadRanges(requests, ro?): Promise<IndexedReadRangeResult[]>
queryMyBatisResource(relativePath, ro?): Promise<MyBatisMapperResourceFacts|undefined>
queryMyBatisResourcesByNamespace(namespaces, ro?): Promise<MyBatisResourceByNamespaceBatch>
queryGraphDigest(ro?): Promise<GraphDigest>
queryGraphReachable(fromRelativePath, maxHops, ro?): Promise<GraphReachable>
queryContextGraph(input, ro?): Promise<ContextGraphResult>
queryEntitySearch(task, limit?, ro?): Promise<EntityHit[]>
queryRepositoryFactMarkers(importPrefixes, annotationPrefixes, ro?): Promise<{importPrefixFound, annotationPrefixFound}>
close(): Promise<void>
localStatus(): JavaIndexStatus
```

`RouterJavaIndex` → client 映射、`applyBatchToJavaIndex` 映射（storm/BUILD_CHANGE → reconcile；JAVA_ADD/CHANGE → changed；JAVA_DELETE → deleted；RESOURCE_CHANGE → refreshResources）均不变。

### A.6 P3 删除的测试文件

`index-store.test.ts`、`shared-facts-pool.test.ts`、`snapshot.test.ts`、`snapshot-v4.test.ts`、`hydrate-snapshot-view.test.ts`、`worker-protocol.test.ts`（validate 测试迁到 `index-validate.test.ts`）、`java-index-client.test.ts`、`java-index-worker.test.ts`、`java-index-worker-process.test.ts`、`columnar/*.test.ts`、`java-knowledge/graph-columns.test.ts`、`graph-snapshot.test.ts`、`fsr2-heap-unify.test.ts`、`fsr4-soak-gates.test.ts`、`cold-build-watch.test.ts`、`resource-defaults.test.ts` 中 hibernate 段、`repo-runtime-manager.test.ts` 中 hibernate/recycle/heap 段、`router-integration.test.ts` 中 snapshot 段（改用 builder 建库）。`new JavaIndexStore()` 的 knowledge/context 测试（`call-resolver / graph-builder / framework-edge-builder / persistence-edge-builder / plan-query`）改为用 `SqlFactsStore`（:memory: + `writeBundle`）。

### A.7 manager 消费者（P2-T5 影响面）

`application.ts`（:88 initialize、:197 shutdownAll、:225 forceTerminateOwnedJdtls、:265 prewarmRepo、:295 retainedRepoRoots）、`mcp-server-factory.ts`（:135-143 activeRepos/resourceStatus、:166 shutdownAll、:185 withContext、:249 resourceStatus）、`repo-ownership-lease.ts`、`benchmark-agent-impact.ts`。`http-server.ts` 不直接调用。

### A.8 常用命令

```bash
# 编译
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile
# 单测试文件
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test --test-concurrency=1 dist/java-index/sql/rows.test.js
# 全量
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile full
# 门
sh scripts/run-isolated-node.sh scripts/run-v4-gates.mjs --profile pr|nightly|release
# 冷建（P0 实测）
/usr/bin/time -l node --disable-warning=ExperimentalWarning dist/java-index/builder/builder-main.js --repo <root> --db /tmp/iod-<id>.sqlite --mode cold
# 差分（P1）
node scripts/diff-index-impl.mjs --repo <root> --db /tmp/iod-<id>.sqlite --anchors 200 --out docs/phase-x/p1-diff-<id>.json
# canary daemon（P2）
JAVA_LSP_HTTP_PORT=38457 JAVA_LSP_CACHE_BASE=/tmp/iod-cache node --disable-warning=ExperimentalWarning --max-old-space-size=768 dist/http-server.js
```
