# R05–R08 独立评审的修复

**基线**: `8a9d485`（R08）。**评审**：独立只读子代理，复现脚本见 `java-specialist-audit-runs/review-fix/repro-*.log`。
**Date**: 2026-10-09

## 结论

评审共提出 2 个 P1、3 个 P2、5 个 P3，本提交全部修复。四个复现脚本在 `8a9d485` 上都是 RED，修复后都是 GREEN（`repro-red.log` → `repro-green.log`）。
新增的仓库测试有 12 个变异检查，每个变异都会让对应测试失败。kit 反例结果不变，仍是 22 PASS / 5 FAIL，剩余失败分别属于 R09（Q03）和 R10（D01–D04）。

## 问题与修复

| # | 级别/任务 | 问题（评审已复现） | 修复 |
|---|---|---|---|
| 1 | P1 / R05 | AMBIGUOUS 引用不产生边，增量刷新只按"指向被改文件的边"找依赖方。删除或新增重复声明后，调用方不会被重新解析，与冷构建结果相反 | 新表 `type_ref_name(name_sym, file_id)`：记录每个文件在类型位置用到的标识符（类型引用、import、调用 receiver、注解），是可能受影响名字的超集。某个文件的 (fqn, path) 声明集合发生变化（新增、删除、移动）时，按变化的简单名把引用方加入重解析范围（`nameDependentPaths`） |
| 2 | P1 / R07 | exact 的简单名路由按 selector 中的单个词命中：`demo.MissingService` → `demo.Demo`（match），`other.Billing#refund` → `other.Billing`；遇到 `$` 截断后再做后缀匹配 | `parseExactSelector` / `matchesExactSelector` 按整个 selector 匹配。`a.b.C`、`Outer$Inner`、`C` 解析为类型；带点的 selector 再按 `Owner.method` 理解一次；`Owner#method(...)` 解析为方法。限定部分必须按 FQN 整段对齐，存储里的 `$` 与 `.` 视为等价。SQL 路由和 oracle 共用同一个谓词 |
| 3 | P2 / R05 | `JAVA_FACTS_REVISION` 只用于 `computeExtractorVersion()`，SQLite 复用判定不看它，报告里"整体重建"的说法不成立 | 建库时写入 meta `factsRevision`；`schemaVersionsMatch` 检查它，值不一致或缺失时整库重建。R05 报告已更正 |
| 4 | P2 / R08 | preview 和 wire 把单独的 CR 当换行，而 tree-sitter 与 rg 只按 LF 计行，导致 preview 相对声明错开一行、仍标为 `source`。原有测试把这种错位固化成了预期 | `splitSourceLines`（discovery 和 wire 两处）与签名文档统一为"LF 结束一行"，CRLF 的 CR 留在本行；把错误的预期改正，并补一个"真实冷构建 + 单独 CR"的用例 |
| 5 | P2 / R07 | 工具描述里写死了 `1..20`，没有引用共享常量 | 描述文本 `STATIC_QUERY_LIMIT_DESCRIPTION` 由 `DISCOVERY_MAX_LIMIT` / `DISCOVERY_DEFAULT_LIMIT` 生成，并写明超限会被拒绝；schema 字段仍是各操作共用的 `SYMBOL_LIMIT_MAX=300`（references/jdt 需要） |
| 6 | P3 / R06 | scope 为 EMPTY 时无条件标 READY；module 只认目录名 | EMPTY 只在索引 READY、且磁盘上没有未索引的同 scope 源根时才是 READY，否则为 `PARTIAL / index_partial`。磁盘探测限定在仓库内。目录名和 layout 名都没匹配时，懒加载 Maven `artifactId` 作为别名（会剥离注释和 `<parent>`）；Gradle 项目名不读取 |
| 7 | P3 / R08 | 声明文件超过 2 MiB 时，结果永久 PARTIAL | 改为流式计算 hash（和索引同一定义，计入单次请求 8 MiB 的读取预算，不保留内容）：新鲜 → READY + `previewOmitted: file_too_large`；已变 → 丢弃；超出请求预算 → 不可验证，结果 PARTIAL |
| 8 | P3 / R08 | 凭据遮盖规则漏掉 `setPassword("…")`、单引号和带引号的键，又会误伤 `tokenizerName = "ws"` | 键名必须是一个标识符词的结尾（camelCase、`_`、`.` 边界），覆盖赋值和"同名调用传入字面量"两种形状，单双引号都处理，键名按原始行判断。多行字面量和 text block 仍不覆盖 |
| 9 | P3 / R08 | 每次 reconcile 都对全部 XML 读文件、算 hash，非 mapper XML 每次都重新解析 | 新表 `resource_scan(path, content_hash, size, mtime_ms)` 记录所有看过的 XML。reconcile 先比 size+mtime，不一致再比 hash；只有 mtime 变化时只更新时间戳，不重新解析；非 mapper XML 看过一次后不再解析 |
| 10 | P3 / R08×R05 | MyBatis XML 绑定到所有同 FQN 的声明，不遵守模块可见性 | `myBatisBindingFilter`：XML 所在模块声明了该 namespace 时，只绑定到本模块的声明，否则绑定到全部（跨模块的 mapper 接口是合法写法）。namespace 的声明发生增删或移动时，该 namespace 的全部 XML 重新绑定（`rebindChangedNamespaces`），增量结果与冷构建一致 |

`SCHEMA_VERSION` 6→7（`type_ref_name`、`resource_scan`、`factsRevision`）：派生库丢弃后重建；兄弟库只在版本完全一致时复用。

## 验证

| 项 | 结果 | 证据（`java-specialist-audit-runs/review-fix/`） |
|---|---|---|
| 评审复现脚本（8a9d485 → 本提交） | 4/4 RED → 4/4 GREEN；R05 删除和新增两种场景下，增量结果都与冷构建相同 | `repro-red.log`、`repro-green.log` |
| 新增测试 | `review-fixes.test.ts`（真实 parser、冷构建和增量写入）、`query-scope.test.ts`、`query-preview.test.ts`（大文件、凭据遮盖、LF 计行） | `targeted-1.log`（相关套件 314/314） |
| 变异检查 | 12 个变异全部被抓住。第一轮"忽略限定段"的变异存活，于是补了 `other.OrderService`、`Billing.Line`、`demo.Billing#cancel` 三个反例 | `mutations/` |
| kit 反例 / 12 源码探针 / 两份冻结自检 / `check_bundle` / kit 单测 | 22/27（不变）/ 12/12 / 5/5 + 5/5（summary `5f6f4cb1…`）/ PASS 357 / OK | `audit-all/`、`probe-12.log` |
| R07、R08 运行态脚本（真实 stdio MCP） | 均 PASS | `runtime-r07.log`、`runtime-r08.log` |
| `build:isolated` / `npm test` | PASS / 1250 + 339 PASS，0 FAIL | `build-isolated.log`、`npm-test.log` |

## 剩余限制

- `type_ref_name` 是超集：常见简单名的声明发生增删时，重新解析的文件会比严格需要的多；大仓库下的开销需在 R09/R12 测量。只有声明集合变化才会触发这条扩展，普通编辑不受影响。
- exact 不做签名级消歧，重载仍报 ambiguous。
- artifactId 别名只读 Maven `pom.xml`。
- 凭据遮盖仍是有限的逐行规则。
- 评审未覆盖的项仍未做：真实 watcher/MCP 下的 K05/K06、K20/K21 时序，三仓矩阵，scope SQL 在大库上的 profile。
