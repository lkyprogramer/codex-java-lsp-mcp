# R08 — 证据路径/hash 归属与有界新鲜 preview（P01 / Q08 / Q09）

**Status**: DONE（GREEN；源码导出层 + 真实 parser/writer 路径 + 真实 stdio MCP `java_symbol` 运行态）
**源码基线**: `791c520`（R07）；RED 在该提交的干净工作树上取得
**Date**: 2026-10-09

## RED / GREEN

| 轮次 | 命令 | 结果 | 证据（`java-specialist-audit-runs/`） |
|---|---|---|---|
| RED | `run_audit.py --project . --cases P01,Q08,Q09` | 3/3 FAIL：P01 MyBatis 文档 `path`/`contentHash` 是 Java 文件、行号却是 XML 的 300–310；Q08 文件 hash 已变仍返回 READY + 旧 locator；Q09 单个 preview 100025 字节 | `r08-red/`（sha256 `4a766bcd…`） |
| GREEN | 同命令，本提交 | 3/3 PASS | `r08-green/`（`7deaa693…`） |
| 全量反例 | 27 条 | 22 PASS / 5 FAIL / 0 ERROR；仅 P01/Q08/Q09 由 FAIL→PASS；剩余 R09（Q03）、R10（D01–D04） | `r08/audit-all/`（`1e3a324e…`） |

## 根因

1. `buildSearchDocuments` 对 MyBatis statement 使用 Java 文件的 `path/contentHash`，只换了 XML 行号；存储层只有一个 `path_sym`（Java 文件），无法表达证据来源。
2. XML-only 更新（`applyResources`）只重同步图，不替换 search-doc；reconcile 只扫描 Java，worktree 中只改 XML 时旧 SQL 证据继续生效（K21）。
3. 文档检索命中后只返回声明定位，preview 总是声明头，丢失真实命中来源。
4. `previewAt` 在 hash 不一致时只是不给 preview，候选仍以 READY 返回旧 line/column；同步 `readFileSync`、无字节上限、每个候选重复读文件；`(?<=\r\n|\n|\r)` 把 CRLF 拆成两行。
5. `searchDetailed` 的各条 SQL 各自取 WAL 快照，并发写入可让 generation 与 locator 来自不同版本。

## 机制

1. **target 与 source 分离**：`SearchDocument.source = {relativePath, contentHash, startLine, endLine}`，`representationVersion = 2`；MyBatis 文档 target 是 Java mapper 方法，source 是 XML 路径/hash/元素行范围；没有定位到元素范围的 statement 不生成文档（不再借用 Java 行号）。文档 ID 包含 target、kind、source 路径/范围/hash 与版本。`path/contentHash/startLine/endLine` 保留为 v1 扁平别名，只在 `finish()` 中由 `source` 一次性赋值。
2. **存储**：`search_doc` 新增 `source_path_sym`（`SCHEMA_VERSION 5→6`，派生库丢弃重建，兄弟库只在版本一致时复用）；`path_sym` 仍是所属 Java 文件（Java 重写的撤销句柄）。`replaceSearchDocumentsForSource` 按来源文件替换。
3. **XML-only 更新与 reconcile**：resource job 按 XML 来源替换文档并重建 df/统计；reconcile 按内容 hash（非 mtime）比对 `mybatis_resource`，先写 XML（不发布 generation），再由 Java 遍历发布，避免读者看到“generation N + 旧 XML 证据”。从未索引过的非 mapper XML 是 no-op，不触发 df 重建。
4. **命中来源**：DOCUMENT 命中带 `evidence`（来源路径/hash/范围/kind）；discovery 用它取 preview，`matchedBy` 按来源 kind 报 `comment/framework/identifier`。
5. **新鲜度**：每个请求重新读文件、重算 hash（与索引同一定义）。声明文件 hash 不一致或文件已删 → 丢弃候选，计 `droppedStale`，结果 `PARTIAL / source_changed`；证据来源（如 XML）不一致 → 保留已验证的声明 locator，`previewOmitted: source_changed`，结果 PARTIAL。hits 的 generation 与 status 不一致 → `PARTIAL / changed_during_request`。
6. **有界读取**（本轮安全初值，未经 profile）：每文件每请求最多读一次（异步、请求内缓存）；2 MiB/文件、8 MiB/请求读取，超限只给 locator + `previewOmitted`，结果 `PARTIAL / read_budget`；deadline 到期停止读取（`deadline`）；preview 只取整行，≤4096 字节/片段、≤16384 字节/请求，范围按实际保留的行重算，不切断 UTF-8 字符；单行超 4096 → `preview_byte_cap`（locator 仍 READY）。
7. **秘密**：preview 逐行套用索引同款字面量红act，并新增“secret 命名键直接赋值字面量”规则（`API_TOKEN = "..."`、`"password": "..."`）；发生红act时 `previewKind: "redacted-preview"`，评测 wire 只把 `source` 记作收到的源码。
8. **SQL 快照**：`searchDetailed` 在单个读事务（`withReadSnapshot`）内执行全部路由、locator 与 generation 读取。
9. **评测侧**：`eval-tool-wire` / `evaluate-java-task` / `compare.mjs` 用 `evidenceRange.relativePath/contentHash` 记账（XML 证据记到 XML 文件）。

## 回归锁与边界

| 用例 | 层级 | 文件 |
|---|---|---|
| 两个 namespace 同名 statement：source 为各自 XML 路径/hash/元素行，target 为各自 Java 方法；ID 含 source 与 v2；DOCUMENT 命中带 XML evidence（K16/P01） | 真实 parser + cold build | `src/java-index/builder/r08-evidence.test.ts` |
| XML-only resource job：新 hash/新行号，旧文档消失，其他 XML 与 Java 行不变，检索看到新文本 | 真实 writer | 同上 |
| reconcile：只改 XML / 删除 XML 均被替换；无变化的二次 reconcile 文档不变（K21） | 同上 | 同上 |
| Java 重写 mapper 后 XML 来源文档仍在、来源仍是 XML | 同上 | 同上 |
| 扫描中另一连接提交（改 hash + generation 99）：结果 generation 与 locator 同一快照；下次请求看到新值（K20） | SQL 双连接 | 同上 |
| 改动/删除的文件 → 丢弃 + PARTIAL；未变文件 READY，evidenceRange 带路径/hash（Q08） | discovery | `src/discovery/query-preview.test.ts` |
| status/hits generation 不同 → `changed_during_request` | 同上 | 同上 |
| 100 KB 单行无 preview；12×1000 字节行只保留 4 行且 range=1..4；恰好 4096 字节通过（Q09） | 同上 | 同上 |
| 8 个文件：请求总量 16000 ≤ 16384，第 6 个缩短为 1 行并报真实范围，其余 `preview_budget`，locator 全保留 | 同上 | 同上 |
| >2 MiB 文件 `file_too_large`；5 个近 2 MiB 文件第 5 个 `read_budget`；deadline=0 → `deadline` | 同上 | 同上 |
| 同文件多候选只读一次；改内容后同尺寸仍按 hash 判定为 stale；repo 外路径不读 | 同上 | 同上 |
| CRLF 一行一终止符、单独 CR、中文/emoji、无结尾换行的末行、越过 EOF → `range_invalid` | 同上 | 同上 |
| `API_TOKEN` canary 不出现在结果任何位置且标 `redacted-preview`；`tokenizer.split(",")` 不被误红act | 同上 | 同上 |
| DOCUMENT 命中 preview 取 XML 行并按 XML hash 校验；XML 过期 → `source_changed` + PARTIAL | 同上 | 同上 |
| wire：XML 证据记到 XML 路径/hash；`redacted-preview` 不产生 SOURCE 切片 | scripts | `scripts/eval-tool-wire.test.mjs` |
| 真实 stdio MCP：`mybatis select` 命中 `OrderMapper#load`，evidenceRange 为 XML 3–5 行；Big 单行 `preview_byte_cap` 且 READY（响应 677 字节）；Secret 标 `redacted-preview` 且响应无 canary；磁盘改 A.java 后首个查询 `PARTIAL/source_changed/droppedStale=1`，watcher 刷新后 READY 新 hash、行 5；只改 XML 后首个查询 `previewOmitted=source_changed`，随后 READY 且 preview 为 `<update` | 运行态 | `r08/r08-runtime.mjs`、`r08/runtime-mcp.log`（`4b875e55…`） |

变异检查（`r08/mutations/`）：保留 stale locator、去掉字节上限、XML 来源改回 Java、XML-only 不替换文档、去掉读快照、reconcile 忽略 XML、CRLF 拆分回退、去掉 preview 红act，8 个变异各自导致新测试失败（2/2/4/2/1/1/1/1 条）。

## 回归面

| 项 | 结果 |
|---|---|
| R08 定向 + 既有 discovery/sql/builder/symbol-static/wire | 153/153（`r08/targeted-r08.log`，`14287640…`） |
| scripts 评测 + live e2e / experiments | 77/77 / 30 + 1 SKIP |
| 原 12 源码探针 | 12/12（`1e06c9b3…`） |
| 冻结自检（仓库内 / 原版） | 5/5 / 5/5（summary sha `5f6f4cb1…` 未变） |
| `check_bundle.py` / kit 单测 | PASS 357 / OK |
| `npm run build:isolated` / `npm test` | PASS / 1239 + 339 PASS，0 FAIL（与提交内容相同的工作树）。首轮在去掉 `/opt/homebrew/bin` 的 PATH 下有 1 条失败（`benchmark can run a no-lsp token baseline` 需要 `rg`），单独复跑确认是环境原因，日志保留为 `r08/npm-test-no-rg-path.log` |

## 限制与剩余缺口

- 过期 locator 采用丢弃 + PARTIAL，不在新快照中按 ID 重定位；watcher 刷新后下一次请求恢复 READY。
- 字节/IO 上限是安全初值，previewBytes/IO 与 event-loop 延迟的 profile 属 R09。
- 文档命中在跨路由合并时按实体去重：若同一实体先由 identifier 路由命中，该候选的 preview 仍是声明头。
- 无元素范围的 statement（重复 id/不匹配标签）不生成可检索文档。
- 红act规则是有限的名称/形状规则，不声称识别所有密钥；配置文件（properties/yaml）的 key 检索与 canary（K18 的配置部分）不在本轮范围。
- reconcile 每次对 resource 根下的 XML 读取并计算 hash（无 mtime 快路径）；mapper 数量大的仓库需在 R09/R12 度量。
- 符号链接仅做词法 repo 内检查；内容必须与索引 hash 一致才会展示，与改动前行为相同。
