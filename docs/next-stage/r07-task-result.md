# R07 — exact / terms / limit 统一语义（Q02 / Q04 / Q05）

**Status**: DONE（R05–R08 评审发现 exact 按单词命中 P1，已在 `r05-r08-review-fixes.md` 修复）（GREEN；源码导出层 + SQL 层 + 真实 stdio MCP `java_symbol` 运行态）
**源码基线**: `77d7e61`（R06）；RED 在该提交的干净 detached worktree 上取得（取证后已移除）
**Date**: 2026-10-09

## RED / GREEN

| 轮次 | 命令 | 结果 | 证据（`java-specialist-audit-runs/`） |
|---|---|---|---|
| RED | `run_audit.py --project <77d7e61 worktree> --cases Q02,Q04,Q05` | 3/3 FAIL：Q02 exact `demo.MissingService` 回退 BM25 返回 `OrderService`；Q04 `limit=20` 被内层固定 10 截断，`truncated=false`；Q05 `terms` 替换了原 query（task=`refund`） | `r07-red/`（sha256 `e6f3820d…`） |
| GREEN | 同命令，本提交 | 3/3 PASS | `r07-green/`（`3f66d82c…`） |
| 全量反例 | 27 条 | 19 PASS / 8 FAIL / 0 ERROR；仅 Q02/Q04/Q05 由 FAIL→PASS；剩余 R08（P01 Q08 Q09）、R09（Q03）、R10（D01–D04） | `r07/audit-all/` |

## 根因

1. `searchDetailed` 的 exact 分支只在 FQN/简单名路由有结果时提前返回，否则落到 BM25（`firstNonEmpty` 只在这条路径上可达）。
2. 三层上限不一致：工具 schema `max(300)`、discovery `DISCOVERY_MAX_LIMIT=20`、SQL `ENTITY_SEARCH_MAX_LIMIT=10`（静默 clamp）；没有任何“还有更多”的信号。
3. `validateArgs` 中 `task = args.terms.join(" ")`。

## 机制（单机制：discovery 输入契约 + 检索结果契约）

1. **上限一份常量**：`ENTITY_SEARCH_MAX_LIMIT = 20` 由 SQL clamp、discovery 校验（`DISCOVERY_MAX_LIMIT` 即它的再导出）和工具描述共用；discovery 默认 `DISCOVERY_DEFAULT_LIMIT = 8`。discovery 对 `limit` 非整数/NaN/±∞/<1/>20 直接报错，不静默截断。内部 legacy 默认值 3（java_impact 词法兜底）不变，所有内部调用方的 limit ≤ 5，提高 clamp 不改变它们的行为。
2. **`selectionLimited`（cap+1）**：每条路由读取 `cap+1` 行，多出的一行只用于判断“还有更多”，从不返回；`truncated`/`stopReason` 只表示预算或截止时间中断，两者语义分开。discovery 结果新增 `selectionLimited`。
3. **exact 无模糊回退**：exact 意图只走名字层（FQN → 类型简单名 → 该名字下没有类型时用方法简单名），返回 `exact: match | miss | ambiguous`；miss 返回空结果，不进入 BM25；多个声明为 ambiguous，候选 `binding: "ambiguous"`。泛型 exact 仍是 `DISCOVERY_UNSUPPORTED`。
4. **terms 补充 query**：task = 原 query + terms（trim 后）；意图只由原 query 判断——只有显式 exact，或整个原 query 是单个 selector 且没有 terms，才走 exact；带 terms 一律 text；`exact + terms` 返回 `DISCOVERY_UNSUPPORTED`。SQL 侧显式 mode 直接生效，不再对拼接后的 task 重新分类（拼接后可超过单个 selector 的 512 上限）。
5. **作用范围**：legacy `SqlEntitySearch.search()`（`java_impact`/context 的词法兜底）保持原有回退行为，只有 discovery 路径（`searchDetailed`）采用新契约；内存 oracle 的 detailed 实现同步改为相同路由。
6. 工具描述补一句静态 query 的 limit/terms/exact 契约；五个工具不变，没有新增参数。

## 回归锁与边界

| 用例 | 层级 | 文件 |
|---|---|---|
| terms 补充原 query 且强制 text；selector+terms 为 text；exact+terms 拒绝 | discovery | `src/discovery/query-contract.test.ts` |
| auto 只在整句为单个 selector 时为 exact（FQN、`Owner#method`）；夹带 FQN 的句子为 text；原 query 不被改写 | 同上 | 同上 |
| 默认 8；1 与 20 通过；0、-1、21、300、2.5、NaN、∞ 拒绝且不触达索引；discovery 与 SQL 上限是同一常量 | 同上 | 同上 |
| UTF-16 边界：256 个 emoji（512 code units）通过、再加 1 个单元拒绝；term 32 个 emoji 通过、65 单元拒绝；空白 term、第 7 个 term 拒绝 | 同上 | 同上 |
| exact miss 原样上报、空候选且 scopeState READY；text 无 exact 字段；selectionLimited 透传；泛型 exact unsupported | 同上 | 同上 |
| exact miss（显式/auto，FQN/简单名）无 BM25 命中；同样的词按 text 搜索可命中 | SQL + oracle | `sql/entity-search-bounded.test.ts` |
| exact match / 两个同 FQN → ambiguous / camelCase 方法 selector 命中方法 / 同名时类型优先；与 oracle 一致 | 同上 | 同上 |
| 21 候选 limit 20 → 20 + selectionLimited；恰好 20 → false；12/10 → true；3/20 → false；均 `truncated=false`；SQL 对超大 limit 夹到 20；与 oracle 一致 | 同上 | 同上 |
| 真实 stdio MCP：显式与 auto exact miss → `miss`/0；两个 `OrderService` → `ambiguous`/2；`updateWidget` → 方法；`limit=20` → 20 + selectionLimited；`limit=21` → 结构化错误；`Widget`+terms → text 结果 | 运行态 | `r07/r07-runtime.mjs`、`r07/runtime-mcp.log` |

变异检查：恢复 exact→BM25 回退、恢复 terms 替换 query、把上限改回 10，三者各自导致新测试失败（1、1、2 条）。

## 回归面

| 项 | 结果 |
|---|---|
| R07 定向（query-contract + bounded） | 17/17；变更前既有 discovery/sql/java-index/tools/根目录测试 614/614 |
| scripts 评测 + live e2e / experiments | 76/76 / 30 + 1 SKIP |
| 原 12 源码探针 | 12/12（sha 未变） |
| 冻结自检（仓库内 / 原版） | 5/5 / 5/5（summary sha 未变） |
| `check_bundle.py` / kit 单测 | PASS 357 / OK |
| `npm run build:isolated` / `npm test` | PASS / 1224 + 338 PASS，0 FAIL（与提交内容相同的工作树，提交时仅增加本报告） |

## 限制与剩余缺口

- 入口已过期的 exact 仍返回成功（Q03）与阶段 deadline 检查属 R09。
- `selectionLimited` 表示“排名截断、还有更多”，不代表索引不完整；索引/预算不完整仍由 `scopeState=PARTIAL` 与 `truncated` 表达。
- exact 的方法简单名路由在没有同名类型时才启用；同一 selector 命中多个重载按 `ambiguous` 上报，不做签名级消歧（需要签名时使用 `Owner#method(...)`）。
- 工具 zod schema 的 `limit` 仍是各操作共用的 `max(300)`（references 等操作使用）；静态 query 的 1..20 在 discovery 边界强制并写入工具描述。（评审修复后描述文本由同一常量生成。）
- **更正（R05–R08 评审）**：本提交的 exact 简单名路由按 selector 中的单个词命中（`demo.MissingService` 命中 `demo.Demo` 并报 `match`），`$` 截断后又做 FQN 后缀匹配；Q02 能通过只是因为样例里碰巧没有 `Demo` 类型。已改为整体 selector 匹配，见 `r05-r08-review-fixes.md`。
