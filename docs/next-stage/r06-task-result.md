# R06 — 真实 source-root AND scope 与 SQL 先过滤（Q01 / Q06 / Q07）

**Status**: DONE（GREEN；源码导出层 + SQL 层 + 真实 stdio MCP `java_symbol` 运行态）
**源码基线**: `3c12b57`（R05）；RED 在该提交的干净 detached worktree 上取得
**Date**: 2026-10-09

## RED / GREEN

| 轮次 | 命令 | 结果 | 证据（`java-specialist-audit-runs/`） |
|---|---|---|---|
| RED | `run_audit.py --project <3c12b57 worktree> --cases Q01,Q06,Q07` | 3/3 FAIL：Q01 cap=1 被 scope 外候选占满后过滤为空；Q06 `module=m`+`sourceSet=test` 变成 `["src/test","m"]` 的 OR，选入 `m/src/main` 和根下 `src/test`；Q07 未知 module 静默去掉 scope（全仓） | `r06-red/`（sha256 `4003cc56…`） |
| GREEN | 同命令，本提交 | 3/3 PASS | `r06-green/`（`f46c8858…`） |
| 全量反例 | 27 条 | 16 PASS / 11 FAIL / 0 ERROR；仅 Q01/Q06/Q07 由 FAIL→PASS；剩余为 R07（Q02 Q04 Q05）、R08（P01 Q08 Q09）、R09（Q03）、R10（D01–D04） | `r06/audit-all/` |

## 根因

1. `SqlEntitySearch.searchDetailed` 每条路由先按 `cap` 截断（`fqnHits/simpleNameHits/rankBm25/docHits(..., cap)`），再 `filterHitsByScope`；注释写“先过滤后 cap”，实现相反。postings 预算同样被 scope 外的行消耗。
2. `validateArgs` 把 `sourceSet` 变成根前缀 `src/test`、把 `module` 变成另一个前缀，两者放进同一个 OR 列表；`module` 目录不存在时直接忽略。

## 机制（单机制：先解析 scope，再把 scope 下推到每条 SQL 路由）

1. **`src/discovery/scope.ts`（新增）**：`resolveSearchScope(roots, {module, sourceSet})` → `UNSCOPED | RESOLVED(sourceRootIds) | EMPTY(UNKNOWN_MODULE|AMBIGUOUS_MODULE|NO_SOURCE_ROOT) | PARTIAL(LAYOUT_UNKNOWN)`。roots 是索引自己的 coverage（即 builder 建库所用的 layout-probe 根），不是 agent 传入的路径；module 与 sourceSet 为 AND；module 先按模块目录精确匹配，再按 layout 模块名，名称同时指向多个目录（`x/core`、`y/core`）→ `AMBIGUOUS_MODULE`，不取并集；没有任何 layout 根时用约定前缀查询，但结果标 `PARTIAL / layout_unknown`，不冒充精确。
2. **`runStaticDiscovery`**：先取 `status`、解析 scope；`EMPTY` 直接返回（不查询、`stopReason: scope_empty`、带 `scope.reason`），绝不退化成全仓；其余把 `sourceRootIds` 作为 `scope.sourceRoots` 传给 `querySearch`；结果新增 `scope` 字段报告实际生效的 scope。
3. **`SqlEntitySearch`**：`scopeSql()` 生成同一谓词（`path = root` 或位于 `root/` 下，与 `filterHitsByScope` 语义一致），以绑定参数 `substr(...)=?` 实现，不拼接路径、不用 `LIKE`，所以 `%`/`_` 没有通配含义；FQN、简单名、identifier/chunk BM25 的 postings 扫描、文档路由（经 `search_doc → entity` 按声明路径）全部在 SQL 内过滤，先于 postings 计费、排序和 cap。SQL 侧的后置 `filterHitsByScope` 删除（不保留双路）；该函数仍是 oracle/审计使用的参照谓词。

无 schema 变更，不需要重建索引。

## 回归锁与边界

| 用例 | 层级 | 文件 |
|---|---|---|
| `scope("m","test") → ["m/src/test/java"]`；module-only、sourceSet-only、根模块 `.`/`""`、模块名与模块目录、嵌套目录 | 纯函数 | `src/discovery/scope.test.ts` |
| 未知 / 同名多目录 / 无该 sourceSet → 明确 EMPTY；无 layout → PARTIAL；`custom/java` 这种无 `src/<set>` 的根不参与 sourceSet scope | 同上 | 同上 |
| discovery 把解析后的 root id 传给索引并报告 scope；未知 module 不发起查询；无 layout 时结果 PARTIAL | discovery + 捕获型 client | 同上 |
| 20 个 scope 外高频候选（排序/得分都在前）+ scope 内第 21 个，`limit=1`：FQN、简单名、identifier、chunk、text（含文档路由）五条路径都返回 scope 内候选；`z`、`z/`、`z/src/main/java` 三种根写法一致；与内存 oracle 逐项一致 | SQL | `sql/entity-search-bounded.test.ts` |
| 前缀兄弟 `zz/`、`z_x/` 不被 `z` 选中；`%`、`z_` 不通配；多根为精确根的并集 | SQL | 同上 |
| postings 预算 3：不带 scope 被外部 postings 耗尽（truncated），带 scope 不截断且只访问目标 postings | SQL | 同上 |
| 真实 stdio MCP（隔离 clone 内 dist）+ layout probe + cold build，22 模块 Maven 仓库：不带 scope `limit=1` 返回噪声模块；`module=z` 返回 z（auto 与 exact）；`m`+`test` 只返回 `m/src/test/java`；未知 module 返回 `EMPTY/UNKNOWN_MODULE` 且无候选 | 运行态 | `r06/r06-runtime.mjs`、`r06/runtime-mcp.log` |

变异检查：把 SQL 恢复为“各路由先 cap 后过滤”后 3 条 R06 SQL 用例全部失败。

## 回归面

| 项 | 结果 |
|---|---|
| targeted（scope / bounded / discovery-unsupported / entity-search） | 27/27 |
| scripts 评测 + live e2e / experiments | 76/76 / 30 + 1 SKIP |
| 原 12 源码探针 | 12/12（sha 与 R04/R05 相同） |
| 冻结自检（仓库内 / 原版） | 5/5 / 5/5（summary sha 未变） |
| `check_bundle.py` / kit 单测 | PASS 357 / OK |
| `npm run build:isolated` / `npm test` | PASS / 1216 + 338 PASS，0 FAIL（与提交内容相同的工作树，提交后仅增加本报告） |

## 限制与剩余缺口

- **评审修复**：EMPTY 只在索引 READY、且磁盘上没有未索引的同 scope 源根时才算 READY；module 可用 Maven artifactId 指定（见 `r05-r08-review-fixes.md`）。
- scope 粒度是 layout-probe 发现的约定 Java 源根（`<module>/src/{main,test}/java`）。Maven `<sourceDirectory>` / Gradle 自定义 sourceSets 目前不被 layout probe 发现，因此也不在索引内；本任务不做 build 文件解析（不猜 `m/src`，而是只认索引实际建库的根）。
- 资源（MyBatis XML）文档按其关联的 Java 声明路径参与 scope；XML 与 Java 之间的“同框架配置”关系与证据归属属 R08（P01）。
- BM25 的 df/avgdl 仍是全库统计（排序归一化），scope 只改变候选集合与预算计费。
- SQLite 在单条语句内部仍会遍历 token 索引中 scope 外的条目；我们的 postings 预算只计 scope 内返回的行。这是 R09 物理预算与是否引入 worker 的度量范围。
- `terms` 替换 query（Q05）、limit 截断语义（Q04）、exact 不回退（Q02）属 R07，未改动。
