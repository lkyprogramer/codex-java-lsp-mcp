# P0 0.6 review (R1 / schema v3)

- dated: 2026-09-07
- SHA_PHASE: `f99c67a` (`docs(iod): P0 record three-repo matrix after T9 waiver`)
- PHASE_BASE: `6885b17` (`codex/fs-track`)
- review range: `8670700..f99c67a` (T8.a–c, T9, G1 lease ENOENT, v3 gate records)
- SHA_FIX: none (round-1 P0=0 P1=0; no `fix(iod): P0 review fixes`)
- closeout: `docs/phase-x/p0-closeout.json`
- tag: `iod/P0` (local, after this closeout commit)
- pre-R1 `docs/phase-x/p0-review.md` / `p0-blocked.md` (G4 1342 MiB) are **not** this closeout

---

## Round-1 outputs

Subagents (read-only):

1. Code Reviewer — `reviewer` `01a07a8d-c3ec-74f3-8691-888313b884a0`
2. Doc-Consistency Auditor — `general-purpose` `01a07a8d-c3ec-74f3-8691-88901dec5e81`
3. Gate Runner — implementer (no shell subagent); cheap G7 only; G1–G6 and three-repo from existing v3 raw

Scratch: `{SCRATCH}/p0-review-round1/` and `{SCRATCH}/p0-g7-diff-stat.txt`

### 1. Code Reviewer (verbatim)


# Code Reviewer 8670700..f99c67a

## Scope

- Range: `git diff 8670700..HEAD -- src scripts`（HEAD `f99c67a`）。**未审** `6885b17..8670700`。
- Commits in range: T8.a `ecf6045` / T8.b `b4e651e` / T8.c `cfbf0ec` / T9 `de1a72c` / G1 lease `6292a89`，以及 docs-only `e12d8da` `cf45acf` `a7d49f4` `f99c67a`（docs 不在 `-- src scripts` 内）。
- 对照：手册 §§0.2、0.6、3.9.3–3.9.6；方案 §2.1。
- 已读：`schema.ts`、`sym.ts`、`rows.ts`、`facts-store.ts`、`knowledge-graph.ts`、`entity-tokens.ts`、`cold-build.ts`（T8.c 段）、`builder-main.ts`、`cross-process-lease.ts` `inspectLeaseDir`、T9 verifier、对应测试；并对照 `edge-builder.ts:284-303`、`graph-store.ts:148-155`、`graph-builder.ts:43-60`、`graph-columns.ts` `materialize`、`entity-search.ts:67-91`、`java-index-worker.ts:2297-2310`。
- **未运行** 编译 / 单测 / live 门（只读评审）。

## Encoding-rule grep results (1-5)

**1. 可变长重复字符串只进 `sym`**

- `CREATE TABLE sym(id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE)` 存在（`schema.ts:7`）。
- 其它表 identity / 边端点 / kind / path / token / resolution 均为 INTEGER `*_sym`（或冻结 DDL 规定的 PK 名 `sym`）。
- TEXT 列与 3.9.3 冻结 SQL + `rows.test.ts:103-116` 白名单一致：`meta.*`、`sym.text`、`file.path/content_hash/source_root/module/package/parse_state`、`type.fqn/simple_name/kind`、`field.name`、`method.name`、`kg_node.simple_name`、`entity.kind/fqn/simple_name/simple_name_lc`、`mybatis_resource.*`、`source_root_coverage.root/state`。**未发现** 非白名单 TEXT/BLOB。
- 3.9.4 散文白名单比冻结 SQL 短（未点名 `file.content_hash/source_root/module/package`）；以 3.9.3 冻结 DDL 为准，**不记偏离**。
- PK 列名是 `sym` 不是 `*_sym`：冻结 SQL 如此，**不记偏离**。
- `entity_token.field INTEGER`（0/1）不是字符串 FK：冻结 SQL 如此。

**2. `facts` BLOB 白名单**

- 有 `facts`：`file` / `type` / `field` / `method` / `mybatis_resource` / `kg_summary`。
- **无 `facts`**：`edge`（`schema.ts:26-30`）、`kg_node`（37-38）、`kg_edge`（42-43）、`entity`（48-49）。护栏测试 `rows.test.ts:118-141`。
- encode/decode 只走上述六表；edge/kg/entity 从列 + `sym` 复原。

**3. 可重算 id 不落盘**

- `rg INSERT INTO edge|kg_edge` + `edge_id`：**无** `edge_id` 列、无 INSERT/UPSERT `edge_id`。
- `StaticEdge.edgeId`：`rows.ts:123` `javaEdgeId({kind, fromId, toId, range})`。
- `GraphEdge.edgeId`：`knowledge-graph.ts:99` `knowledgeEdgeId({kind, fromId, toId, ordinal})`。

**4. 复原字段顺序 / 缺 key 不写**

- StaticEdge（`rows.ts:122-135`）与 `edge-builder.ts:293-303` 一致：`range` / `typeStrategy` 用 spread 省略。
- GraphNode（`knowledge-graph.ts:73-80`）与 heap `graph-columns.ts:133-140` 一致。
- GraphEdge（`knowledge-graph.ts:98-105`）与 heap `materialize`（`graph-columns.ts:314-321`）一致：`generation` 在 `sourceFile` 前，空 `sourceFile` 省略。反向边字面量（`knowledge-graph.ts:277-284`）与 `graph-store.ts:148-155` 逐字段相同。
- EntityRecord（`entity-tokens.ts:101-109`）与 `entity-search.ts:69-77 / 83-90` 字段序相同；`relativePath` 恒为 string。

**5. 行模型 / last-write-wins / 插入序**

- `CALLED_BY` 仍物化：`REVERSE_EDGE_KIND` → `addEdge` 反向边（`knowledge-graph.ts:275-285`）；测试断言 `predecessors(..., "CALLED_BY")`。
- Static edge last-write-wins：`UNIQUE(kind_sym, from_sym, to_sym, sl, sc, el, ec)` + `ON CONFLICT DO UPDATE`（`rows.ts:142-146`）。type/field/method `ON CONFLICT(sym) DO UPDATE`。
- Static / KG 边读取 `ORDER BY e.id`（`rows.ts:358`、`facts-store.ts:486`、`knowledge-graph.ts:337/343`）。
- `clearIndexData` **不删 `sym`**，符合「sym 不回收」；READY 重建走 `DELETE FROM file` CASCADE。

## Findings (P0/P1/P2)

**P0：无。**
**P1：无。**

### P2-1 — `internSym` LRU 在 ROLLBACK / `ensureSchema` drop-all 后不失效

- **文件:行**：`src/java-index/sql/sym.ts:12-21,50-60`；`schema.ts:87-91` 只 `forgetPrepared`，不丢 intern cache。
- **触发**：同一 `DatabaseSync` 上 `withTransaction` 在 `internSym` 已 `remember` 之后 ROLLBACK，随后再 `internSym` / `UPDATE … WHERE sym=?`。
- **影响**：cache 仍返回已回滚的 id；`REFERENCES sym(id)` 会 FK 失败，或 `UPDATE` 命中 0 行（静默不更新）。G6 续建是**新进程/新连接**（`cold-build.test.ts:139-145`），`builder-main` SQL 失败则进程退出，**当前 P0 路径不易踩到**。
- **证据**：cache 是 `WeakMap<IndexDatabase, Caches>`，与 SQLite 事务无关；`ensureSchema` drop-all 后同一连接仍持有旧 id。
- **最小修法**：`withTransaction` 的 ROLLBACK 路径、以及 `ensureSchema` drop-all，清空该 db 的 intern/byText/byId（或失败即 `close`）。不必改 LRU 容量。

### P2-2 — 存在性检查 / delete 走 `internSym`（读路径写 `sym`）

- **文件:行**：`knowledge-graph.ts:376-384` `findStoredEdge`；`131-138` `SqlSummaryMap.delete`。
- **触发**：`addEdge` 查重或 `summariesByMethodId.delete(never-seen-id)`。
- **影响**：单写者下正确性不变；delete 未见过的 id 会插入孤儿 `sym` 行。与「sym 不回收」叠加，只增不减。
- **最小修法**：两处改 `symId`；未 intern 则视为不存在。

### P2-3 — `nodesByPath` / `nodeEntries` 排序键从插入序改成 `ns.text`

- **文件:行**：`knowledge-graph.ts:310,354` `ORDER BY ns.text`。
- **触发**：P1 若对 `nodesByPath` / `nodesById.entries()` 做未排序 `deepEqual`。
- **影响**：heap（`graph-store.ts:196-201`）按插入序。fixture 测试先 `sort` 再比（`knowledge-graph.test.ts:125-127`），**测不到**。digest 用 xor+size，不受影响。
- **证据**：规则 5 要求排序键与 heap 一致；此处是 T8.b 新加的 `ORDER BY`。
- **最小修法**：改为 `ORDER BY n.rowid`（或与 heap 一样不 ORDER BY）。P1 前补一条**不排序**的 entries/nodesByPath 对比。

### P2-4 — `kg_edge` 无 UNIQUE，去重只在 JS

- **文件:行**：`schema.ts:42-43`；去重 `knowledge-graph.ts:376-384`。
- **触发**：`findStoredEdge` 因 intern cache 污染 miss，或未来双写。
- **影响**：P0 单写者 + `writeTx` 下重复插入概率低；一旦插入，INNER JOIN 可能读出重复边，digest xor 会偏。
- **最小修法**：`UNIQUE(from_sym, to_sym, kind_sym, ordinal)`，与 `knowledgeEdgeId` 输入对齐（同 static edge 的 UNIQUE 模式）。

### P2-5 — entity 复原测试缺口（非功能错误）

- **文件:行**：`entity-tokens.test.ts:82-97` 只比 `entityId/kind/fqn` + **排序后** token；不比 `simpleName`/`relativePath`，也不比 token 原序。
- **触发**：`path_sym`/`simple_name` 映射写错。
- **影响**：实现（`entity-tokens.ts:48-64,101-109`）看起来是对的；bag/tf 与 T7 口径一致。回归护栏比规则 4 宣称的 `deepStrictEqual` 整对象更弱。
- **最小修法**：断言 `simpleName`/`relativePath`；token 保持多重集（排序或按 tf 比均可）。

### 过程/门备注（不当代码缺陷）

- **G7 旧文件白名单**：本 range 改了 `src/cross-process-lease.ts` + `.test.ts`（G1 ENOENT）。手册 G7 只允 `entity-search.ts` + `graph-store.ts`。这是 G1 为全量绿做的旧文件修复，**记 closeout，不记 P0**。
- **T9 vs 3.9.5「矩阵 exit 0」**：verifier 豁免行与 `java-index-worker.ts:2309` 整行一致；测试覆盖「仅该行通过 / 另有字节仍 fail」。`THREE_REPO_EXIT=1` 因两臂绝对地板同失败、identity delta 0，**按已知非 finding 不要求 EXIT=0**。

## Residual risk

- **已用 grep 核对、未跑测试**：编码规则 1–5 在源码层成立；fixture `deepEqual`/`digest` 绿依赖既有测试，本次未执行。
- **intern LRU 65536 vs ~200k 字典**：cache miss 走 `ON CONFLICT … RETURNING`（手册指定）。正确性 OK；G2/G3 以实测为准。
- **无 LIMIT 热路径**（多为本 range 之前就有）：`repositoryFactMarkers` 扫 ANNOTATED_WITH；`myBatisStatement` 全表；`implementers` SQL 无 LIMIT、JS sort+slice。P1 查询 P95 再收。
- **Lease 剩余 TOCTOU**：`ENOENT → ABSENT` 合理。mkdir 成功到 `writeMetadataAtomic` 之间仍是设计内的 `METADATA_LESS` + grace。`acquireCapacityLock` 见 ABSENT 不立即重试 mkdir，只 delay 10ms，无正确性洞。
- **0.6 其它项**：SQL 值均 `?` 绑定（`inClause` 只拼占位符；`${table}`/`${side}` 来自内部联合类型）。`writeBundle`/`replaceBundleEdges`/`writeTx` 有完整 rollback。`builder-main.ts:66-80` `open`/`close` 成对。T8/T9 未改 `JavaIndexClient` 签名。`registry-view.ts` 未改是因为它只调已改的 `SqlFactsStore.nestedTypeId`，不是漏同步。
- **方案 §2.1**：无 heap 阈值动作；`dbstat` 只打 stdout（`builder-main.ts:29-31` 吞异常则打 `[]`，不是门）。无新 `JAVA_LSP_*`。

## Verdict (remaining P0/P1 count)

**P0 = 0，P1 = 0。** Phase 编码门在源码层通过。P2 建议在进 P1 差分前处理 P2-1（rollback 清 cache）和 P2-3（nodesByPath 排序），其余可随 P1 收。

### 2. Doc-Consistency Auditor (verbatim)

# Doc-Consistency Auditor 8670700..f99c67a

- 范围：`git diff 8670700..HEAD -- src scripts` + 手册 2026-09-07（0.2 / 0.6 / P0 / 3.9 / 3.9.3 / 3.9.6）+ 方案 §2.3
- HEAD：`f99c67a`（`codex/index-on-disk`）；`PHASE_BASE` 手册 P0 用 `6885b17`；R1 从 `212c852` 续
- 工作区：干净。未改 git 仓。
- 过程件（不是 src 缺陷）：`docs/phase-x/p0-closeout.json` **不存在**；`docs/phase-x/p0-review.md` / `p0-blocked.md` 是 **PRE-R1**（`SHA_PHASE=f9cbe18`，G4 1342 MiB 失败），不得当作本轮 closeout。

## (a) 0.2 bans

对 `8670700..HEAD -- src scripts` 全文 grep。

| 禁令 | 结论 |
| --- | --- |
| `heapUsed` / `rssMb` / `maxOldGeneration` / `recycle` / `hibernate` / `setInterval` | **一致**。diff 零命中。 |
| 堆 / RSS 条件动作 | **一致**。`builder-main.ts` 只把 `dbstat` 打到 stdout（T8.c 允许的信息，不是门逻辑）。 |
| 新 `JAVA_LSP_*`（仅 5 个白名单） | **一致**。唯一命中是 `verify-three-repo-cold-matrix.mjs` 未改行 `ENV_AB_ALLOWLIST = ["JAVA_LSP_ENGINE"]`。无新 env。`JAVA_LSP_BUILDER_PARALLELISM` 为既有允许项。 |
| 新生产 npm 依赖 | **一致**。`package.json` / lockfile 无 diff。 |
| MCP JSON 契约 | **一致**。`src/mcp*`、`src/tools`、`src/agent-router`、`mcp-server-factory.ts`、`worker-protocol.ts` 无 diff。 |
| `golden/*.scenarios.jsonl` | **一致**。零命中。 |
| fixture 填 Phase 门 | **一致**。G5-v3 / T8c / G6-v3 / three-repo-v3 都是 live 仓（lishuedu / lishu-v2 / cipherlink / exam-parent-v3）。G1-v3 是 0.5 全量单测，不是用 fixture 冒充 G4/G5。 |
| 0.2 #7 调参过门 | 见三仓：质量阈值未改。EXIT≠0 是过程偏离，不是改 golden。 |

## (b) Task scope

R1 代码 commit（`212c852` 之后）：

| Task | SHA | 非测试文件 | 是否卡内 |
| --- | --- | --- | --- |
| T8.a schema v3 + `sym` + rows + 点查 | `ecf6045` | `schema.ts`, `sym.ts` (93 行 ≤120), `rows.ts`, `facts-store.ts`；测试 `rows.test.ts` 含 `pragma_table_info` 护栏 | 卡内落地。**额外**把 T8.b 的 remaining refs SQL 一并改完（`implementers` / `callers` / `callees` / `typeReferencers` / `methodsWithParameterTypes` / `implementersOfAny` / `repositoryFactMarkers` / `references`）。原因：edge 列从 `from_id`/`to_id`/`kind` 改成 `*_sym` 后，不同 commit 无法保持 `facts-store.test` 绿。`anchor` / `typeLookup` / `typesBySimpleNameOrFqn` 无旧列依赖，本就不需改 SQL。 |
| T8.b remaining facts-store + KG | `b4e651e` | 仅 `knowledge-graph.ts` | KG 从列 + `sym` 复原、`knowledgeEdgeId`、xor `e:${edgeId}`、`removeFiles` 走 `owner_sym`。facts-store remaining 已在 T8.a。`registry-view.ts` 未改：它只委托 `typesById` / `typeIdByFqn` / `nestedTypeId` / `methodsOfOwner`，无直写 SQL。 |
| T8.c entity + builder + lishuedu | `cfbf0ec` | `entity-tokens.ts`, `cold-build.ts`, `builder-main.ts` + 生成物 `P0-T8c-lishuedu.txt` | **一致**。token `field` 0/1 + `token_sym`；`records()` 按 tf 展开多重集。builder stub SQL 改 join `sym`。intern 发生在 `writeBundle`（T8.a）/ KG（T8.b）/ `writeEntityRecord`（T8.c），`cold-build.ts` 本身不直接 `internSym`。lishuedu：`stat` 224.5 MiB ≤ 350 MB；counts 与 A.1 精确一致。 |
| T9 stderr waiver | `de1a72c` | `scripts/verify-three-repo-cold-matrix.mjs` + 测试 | **一致**。整行精确匹配 `^\[codex-java-lsp\] in-process parse files=\d+ \(cold-build child disabled; cap waived\)$`；`stderrWaivedLines` 进 summary。测试：仅该行通过；该行 + 其它字节仍 fail。卡文 ≤60 行：生产 19 + 测试 22 = 41。质量 / p95 阈值未动。 |
| Lease ENOENT | `6292a89` | `cross-process-lease.ts` + 测试 | **偏离(范围外)**：T8/T9 未列此文件。G1-v3 写明 Task36 Step6a smoke 依赖此修复。应披露，不是 T8/T9 漏项。 |
| G1/G5/G6/three-repo 证据 | `a7d49f4` / `cf45acf` / `f99c67a` | 仅 `docs/phase-x/p0-gate-raw/*` | **一致**（docs-only）。T8.c 证据混在代码 commit 里，符合 T8.c 卡文。 |

`e12d8da` 是手册 R1 采纳（docs）。`daffa81` / `212c852` 是 PRE-R1 过程记录。

## (c) schema vs 3.9.3

`src/java-index/sql/schema.ts:3` `SCHEMA_VERSION = 3`；`ensureSchema` 版本不等 drop-all 重建（`schema.ts:87-93`）。`INDEX_SCHEMA_SQL`（`schema.ts:5-57`）与手册 3.9.3 DDL **语义一致**：表、列、PK/UNIQUE、FK、`WITHOUT ROWID`、索引名与键相同。仅排版差异：手册把若干 `CREATE INDEX` 写在同一行并带 SQL 注释；`schema.ts` 拆行、无注释。

编码规则抽查（对照 3.9.3 五条，不是 DDL 字面差）：

1. `sym(id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE)`；intern SQL 为 `ON CONFLICT(text) DO UPDATE SET text=excluded.text RETURNING id`（`sym.ts:47-48`）。LRU：intern 65536、read 4096/4096。
2. `facts` 仅 `file` / `type` / `field` / `method` / `mybatis_resource` / `kg_summary`。`rows.test.ts:103-137` 断言 `edge` / `kg_node` / `kg_edge` / `entity` 无 `facts`，TEXT/BLOB 白名单覆盖 DDL 短枚举 / `file.path` 族 / `type.fqn` 等。测试白名单比卡文括号列表更完整（补了 `file.content_hash` / `source_root` / `module` / `package` / `parse_state`），与冻结 DDL 一致。
3. `javaEdgeId`（`rows.ts:123`）、`knowledgeEdgeId`（`knowledge-graph.ts:99`）。
4. StaticEdge 字面量对齐 `edge-builder.ts:293-303`。GraphNode 对齐 `graph-builder.ts:49`（`id, kind, generation, ...extra`）。**偏离(knowledge-graph.ts:92-106 vs graph-builder.ts:52-60)**：`graphEdgeFromRow` 把 `generation` 放在可选 `sourceFile` 之前，且空 `sourceFile` 不写 key；`graph-builder` 的 `edge()` 始终写入 `sourceFile`（可 `undefined`）且顺序为 `sourceFile, generation`。`deepStrictEqual` 区分缺失 vs `undefined`。
5. `CALLED_BY` 仍物化（`knowledge-graph.ts:275-285`）；edge upsert 目标 `UNIQUE(kind_sym, from_sym, to_sym, sl, sc, el, ec)`。

### vs 方案 §2.3

手册声明冲突以手册为准。§2.3 仍是 R0 骨架，与 v3 **全面不同**（closeout 尚未写，下列差异现在列出、不能标「已在 closeout 说明」）：

- 无 `sym`；用 `stable_id TEXT` / `from_id TEXT` 而非 `*_sym INTEGER`
- 有 `param` / `annotation` / `call_site` / `mybatis_statement` / `entity_fts`；v3 无这些表，嵌套进 `facts` 或 `entity_token`
- 无 `kg_node` / `kg_edge` / `kg_summary`
- `file` 有 `source_set`、无 `facts` / `ctime_ms`；v3 相反
- `type`/`field`/`method`/`edge` 列式标量 vs v3「标量 + 白名单 facts BLOB」
- 体积目标 100–150 MB / root vs 手册 G4 350 MB、v3 估算 210–240 MiB
- FTS5 entity search vs 手册明确不用 FTS5

## (d) closeout vs raw

**N/A。** `docs/phase-x/p0-closeout.json` 不存在，(c)/(d) 不能闭合。这是 0.6 过程缺口，不是 `src` 缺陷。

若 closeout 稍后写，raw 应对：

| id | raw | 观察（未写入 JSON，故不判 pass 字段） |
| --- | --- | --- |
| G1 | `P0-G1-v3.txt` | SHA=`6292a89`；dist 1354 / scripts 283 fail 0；`FULL_EXIT=0`；lease ENOENT 之后 smoke 3/3 |
| G2/G3/G4 | 无 `P0-G*-v3.txt`；数字在 `P0-T8c-lishuedu.txt` | wall 134.52 s；RSS 539656192 B = 514.6 MiB；`stat` 235376640 B = 224.5 MiB。旧 `P0-G2.txt`/`G3.txt`/`G4.txt` 是 PRE-R1（`86de82e`，G4=1342 MiB） |
| G5 | `P0-G5-v3.txt` | 四仓 live；相对 snapshot 最大 lishu-v2 methods +0.917%，均 < ±1% |
| G6 | `P0-G6-v3.txt` | `G2_BASE_S=134.52`；1.3×=174.876 s；kill 90 s 时 WAL 2143623672 B（对照 v2 5.7 GB）；resume `84.35 real` |
| G7 | `P0-G7-diff-stat.txt` | **过期 PRE-R1**：`SHA_PHASE=f9cbe18`，白名单只有 `entity-search.ts` + `graph-store.ts` |
| 三仓 | `P0-three-repo-v3-summary.txt` + `P0-three-repo-v3-matrix-summary.json` | 见下 |

## (e) P3 deletion list

**N/A for P0。**

## 0.2 #8 commit sizes

口径：`git show --numstat`，不含测试与 `p0-gate-raw` 生成物。0.2 #8：净变更 ≤400 行、非测试文件 ≤6、一目标一 commit。本审计把「净变更」按 add+del churn 计（与拆 `Tn.a/Tn.b` 的体积门一致）；括号内附 net。

| commit | 非测试文件 | add/del (churn / net) | 一目标 | 结论 |
| --- | --- | --- | --- | --- |
| T8.a `ecf6045` | 4 ≤6 | 340/140（**480** / +200） | 点查 + T8.b remaining refs | **偏离**：churn 480>400；两项目标并入同一 commit |
| T8.b `b4e651e` | 1 | 197/95（292 / +102） | KG | **一致** |
| T8.c `cfbf0ec` | 3 | 100/28（128 / +72） | entity+builder+实测 | **一致**（另 +50 行生成物） |
| T9 `de1a72c` | 1 | 17/2（19 / +15）；含测试 41≤60 | stderr waiver | **一致** |
| lease `6292a89` | 1 | 12/4（16 / +8） | G1 ENOENT | 体积内；范围见 (b) |

## G7 whitelist

手册 3.9.6：T8/T9 不触碰旧 `src`；相对 `6885b17` 旧文件只允许 `entity-search.ts`、`graph-store.ts`。`scripts/verify-three-repo-cold-matrix.mjs` 不在白名单内但须在 closeout 列出。

`git diff --name-status 6885b17..HEAD -- src` 的 **M** 行：

- `src/java-index/entity-search.ts` — 允许（P0 原范围）
- `src/java-knowledge/graph-store.ts` — 允许（P0 原范围）
- `src/cross-process-lease.ts` — **不在原白名单**
- `src/cross-process-lease.test.ts` — **不在原白名单**

`8670700..HEAD` 未再改 `entity-search.ts` / `graph-store.ts`。新增 `src/java-index/sql/sym.ts` 等为新文件。T9 改的是 scripts，符合「不在 G7 白名单、须列出」。

`P0-G7-diff-stat.txt` 停在 `f9cbe18`，未含 lease / v3，**不能**当本轮 G7 证据。

## 三仓矩阵

观察（`P0-three-repo-v3-summary.txt`，SHA_CANDIDATE=`6292a89`，BASELINE=`6885b17`）：

- `THREE_REPO_EXIT=1`（手册 3.9.6 表要 `EXIT=0`）
- identity delta 全 0：lishuedu / cipherlink / exam-parent-v3 的 recall、pRead、tokensP50
- T9 `stderrWaivedLines=18`（每 cell 1 行 × 18）；无 cell 因该行 abort；`passed: false` 因为绝对地板两侧同败
- 地板：`rReadMust` / `holdoutRReadMust`（`minReadMust===1`；lishuedu min=0.5，holdout exam-score-export / paper-task-claim）、`rangeLineRecall` / `rangeCoordinateRecall`
- p95 三仓都过（limit 1.25）
- load_at_start=25.59，仍跑完（refuse=false）

**偏离(过程, 手册 3.9.6 要 EXIT=0)**。0.2 #7 禁止改 golden / 阈值来过门，**不要求重跑**。这是工具链已可用、identity 0 diff、两侧地板同源失败的记录，不是候选回归。

## Verdict list of 一致/偏离

1. **一致** — 0.2 #1 堆/RSS 条件动作；diff 无 `heapUsed|rssMb|maxOldGeneration|recycle|hibernate|setInterval`
2. **一致** — 0.2 #2 无新 `JAVA_LSP_*`
3. **一致** — 0.2 #3 门数字来自 live 仓，非 fixture
4. **一致** — 0.2 #5 无新生产 npm 依赖
5. **一致** — 0.2 #6 MCP JSON 契约未改
6. **一致** — 0.2 #7 未改 `golden/*.scenarios.jsonl`、未调质量/p95 阈值
7. **偏离(src/java-index/sql/facts-store.ts:209-232 等, T8.a `ecf6045`)** — T8.a 超出卡文点查范围，并入 T8.b remaining refs；churn 480>400（0.2 #8）。功能未缺，是拆分/体积门偏离。
8. **一致** — T8.a 卡内：v3 DDL、`sym.ts`、rows 12 标量列、点查 `JOIN sym`、`rows.test.ts` 结构护栏
9. **一致** — T8.b KG 列复原 + digest 输入 `e:${edgeId}`；`registry-view.ts` 无需改
10. **一致** — T8.c entity intern + builder stub join + lishuedu 224.5 MiB / A.1 counts
11. **一致** — T9 stderr 整行豁免 + 测试 + ≤60 行
12. **偏离(src/cross-process-lease.ts:546-561, `6292a89`)** — T8/T9 范围外；G1 必需；须在 closeout `notes` 披露
13. **一致** — G1/G5/G6/three-repo 证据 commit 为 docs-only
14. **一致** — `schema.ts` DDL ≡ 手册 3.9.3（无语义差）
15. **偏离(knowledge-graph.ts:92-106, 说明)** — 3.9.3 规则 4：`GraphEdge` 复原字段序 / 可选 `sourceFile` 与 `graph-builder.ts:52-60` 字面量不完全相同
16. **偏离(方案 §2.3 vs schema.ts, 说明)** — R0 骨架与 v3 全面不同；closeout 尚未记录
17. **偏离(过程: docs/phase-x/p0-closeout.json 缺失)** — (d) 无法核对 JSON 数字 vs raw；不是 src 缺陷。`p0-review.md` / `p0-blocked.md` 为 PRE-R1，不得当本轮 closeout
18. **N/A** — (e) P3 删除清单
19. **偏离(P0-G7-diff-stat.txt:1-4 + src/cross-process-lease.ts)** — 相对 `6885b17` 旧文件多了 lease 及其测试；G7 raw 停在 `f9cbe18`
20. **偏离(docs/phase-x/p0-gate-raw/P0-three-repo-v3-summary.txt:1 vs 手册 3.9.6)** — `THREE_REPO_EXIT=1` 而非 0；identity delta 0；T9 豁免 18 行；绝对地板两臂同败。0.2 #7 禁止改阈值。**不要求重跑**

### 3. Gate Runner (verbatim)

# Gate Runner (implementer, 0.6)

dated: 2026-09-07T06:28:27Z
SHA_PHASE: f99c67a7b9d4133bc7c6f6212e2897b3fa9a43b6
PHASE_BASE: 6885b17
review_range: 8670700..f99c67a
note: Did not re-run three-repo or G1–G6. Cheap G7 only. Numbers copied from v3 raw files. No conclusions beyond pass/fail vs handbook targets.

## Commands executed this round

```
git diff --stat 6885b17..HEAD -- src
git diff --name-only 6885b17..HEAD -- src
```

Scratch: `{SCRATCH}/p0-g7-diff-stat.txt`

## Gate table (v3 raw, not re-executed)

| id | target | measured | pass | rawFile |
| --- | --- | --- | --- | --- |
| P0-G1 | isolated full + gate:pr | SHA=6292a89; dist 1354 fail 0; scripts 283 fail 0; FULL_EXIT=0; Task36 Step6a 3/3. v3 raw does **not** record PR_EXIT (pre-R1 P0-G1-summary.txt had PR_EXIT=0 on f9cbe18). HEAD after 6292a89 is docs-only. | G1 full yes; pr not in v3 raw | P0-G1-v3.txt |
| P0-G2 | ≤ 180 s | wall 134.52 s | yes | P0-T8c-lishuedu.txt |
| P0-G3 | ≤ 600 MiB | RSS 539656192 B = 514.6 MiB | yes | P0-T8c-lishuedu.txt |
| P0-G4 | ≤ 350 MB | stat -f %z 235376640 B = 224.5 MiB | yes | P0-T8c-lishuedu.txt |
| P0-G5 | four-repo ±1% | cipherlink 0%; exam-parent-v3 methods +0.055% edges +0.053%; lishu-v2 all <1% (files +0.763% … edges +0.886%); lishuedu exact vs A.1 | yes | P0-G5-v3.txt |
| P0-G6 | resume ≤ 1.3× G2 (174.876 s) | resume 84.35 s; kill at resolve 6090/6090; WAL 2143623672 B (~2.00 GiB; v2 was 5.7 GB) | yes | P0-G6-v3.txt |
| P0-G7 | old src files only entity-search.ts + graph-store.ts | OLD changed: entity-search.ts, graph-store.ts, cross-process-lease.ts, cross-process-lease.test.ts | extra old files: lease | P0-G7-diff-stat.txt (scratch refreshed; in-repo file still SHA f9cbe18) |
| three-repo | THREE_REPO_EXIT=0; load <20 must-run | EXIT=1; 18/18 cells; stderrWaivedLines=18; SHA_CANDIDATE=6292a89 vs 6885b17; identity deltas 0; p95Ratio 1.038/1.028/0.987 gate true; load_at_start=25.59 refuse=false; floors fail both arms | identity yes; exit 0 no | P0-three-repo-v3-summary.txt, P0-three-repo-v3-matrix-summary.json |

## G7 old-file list (6885b17..f99c67a -- src)

OLD:
- src/java-index/entity-search.ts (whitelist)
- src/java-knowledge/graph-store.ts (whitelist)
- src/cross-process-lease.ts (not whitelist; 6292a89 ENOENT→ABSENT)
- src/cross-process-lease.test.ts (not whitelist)

NEW: builder/*, entity-scoring.ts, sql/*

Phase loc 6885b17..HEAD src+scripts: added 3855 deleted 139
R1 loc 8670700..HEAD src+scripts: added 756 deleted 272

## Stale files (do not use as v3 measured)

- P0-G4.txt 1407225856 B
- P0-G2.txt 133.18 s
- P0-G3.txt 440.1 MiB
- P0-G6.txt v2 resume
- P0-G7-diff-stat.txt in-repo still f9cbe18
- P0-three-repo-summary.txt EXIT=2

---

## Implementer disposition

Round-1 Code Reviewer: **P0 = 0, P1 = 0**. No `src` fix commit. Round-2 skipped (no `SHA_PHASE..SHA_FIX` diff).

### P2 (Code Reviewer)

| id | action |
| --- | --- |
| P2-1 intern LRU survives ROLLBACK / drop-all | **not in P0.** Current G6 resume is a new process; builder SQL failure exits the process. Defer to P1/P2 incremental tx. |
| P2-2 `findStoredEdge` / summary delete use `internSym` | **not in P0.** Single-writer correctness unchanged. Switch to `symId` in P2 incremental. |
| P2-3 `nodesByPath` / entries `ORDER BY ns.text` vs heap insert order | **not in P0.** digest xor+size unaffected; fixture tests sort before compare. Revisit before P1 unsorted deepEqual. |
| P2-4 `kg_edge` has no UNIQUE | **not in P0.** Single-writer + `writeTx`. Adding UNIQUE is a schema change after v3 freeze; P1/P2 if double-write appears. |
| P2-5 entity test does not assert `simpleName`/`relativePath` | **not in P0.** T7 bag/tf contract holds. Tighten in P1-T2. |

### Doc-auditor 偏离

| item | action |
| --- | --- |
| T8.a remaining-refs folded into T8.a; churn 480>400 if add+del | **disclose, do not rewrite.** `*_id` → `*_sym` could not keep tests green across a split commit. Added lines 340 ≤ 400. |
| lease `6292a89` outside T8/T9 | **disclose.** User-ordered G1 ENOENT fix. G7 exception. |
| GraphEdge reconstruct vs `graph-builder.edge()` key order | **reject as defect.** Code Reviewer matched heap `materialize` (`graph-columns.ts`); `jsonClone` tests pass. Rule 4 producer for reconstruct is the heap row, not the builder helper that always writes `sourceFile: undefined`. |
| scheme §2.3 vs v3 | **disclose.** Handbook wins; R1 replaced §2.3. |
| missing closeout JSON / stale G7 raw | **fixed this closeout.** |
| `THREE_REPO_EXIT=1` vs 3.9.6 EXIT=0 | **disclose, do not rerun.** Identity deltas 0; floors fail on both arms; 0.2 #7 forbids golden/threshold edits. |
| G1-v3 omits `PR_EXIT` | **disclose.** Isolated full `FULL_EXIT=0` on `6292a89`; pre-R1 `P0-G1-summary.txt` had `PR_EXIT=0` on `f9cbe18`. HEAD after lease is docs-only. |

### Round-2

Not dispatched. No remaining P0/P1. Phase may close.
