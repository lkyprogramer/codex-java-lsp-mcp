# M1 里程碑报告 —— Java Specialist Devkit v1

## 身份与范围

- **source SHA（本里程碑终点）**：`557ffb7c2e39ebcde10d25421a9abe2e09fedb58`（`557ffb7`，branch `codex/java-specialist-devkit-v1`）
- **基线 bundle 提交**：`81151e6`（docs bundle，230 文件）；M0 终点 `be83f51` + 审查修复 `301df55` / `0425598` / `534375a`
- **dirty tree**：tracked diff 为空（`tracked_diff_sha256 = e3b0c44…` = 空串哈希，终态 preflight 实测）；未跟踪 `.commandcode/` 仅被 git status 列出，不进入哈希
- **installed runtime SHA**：UNMEASURED（全程静态轨道；MCP canary 中 `JDT_BIN=/usr/bin/false` 强制任何 JDT 启动立即失败）
- **host**：node v22.19.0，javac 25.0.1，python 3.12.12
- **dataset_hash**：`c34a7c7c2f261bb273bc622739eae6beff8479ca96512c48942638cd912b8c4d`
- **corpus_hash**：`2c6021e29ef78cae1aec4865343ef47d8802c40a4449599a00126a9984882d42`（bundled-scoped，split=dev，24 任务）
- **scorer/profile**：词法控制臂（T01 BM25 基线，M0 报告）；本里程碑新增 adapter 轨道 `static-m1`（kit `adapters/mcp_static.py`，只读函数/位置证据，无模型）
- **模型 / 付费 API**：无（不调用任何模型；token 结论全部 UNMEASURED）
- **轨道**：FUNCTION_PROBE（probe-source 12 项契约）+ SCOPED（bundled-scoped canary，真实隔离 MCP server 127.0.0.1:38457）+ 合成负载测量（1k/10k 文件）；LIVE / FULL / RELEASE 轨道（真实 Agent / 全语料）均未运行

## 假设与改动

| Task | 机制假设 | 改动 | 为何不是 task/gold 特判 |
|---|---|---|---|
| T04 查询意图分流（commit `13e0882`，7 文件，260+/39-） | 旧检索把任务意图句（含多词、CJK）当作单一 exact 名称查询，`OrderService rollback refund` 类查询在 entity 层零命中 | 新 `src/discovery/query-intent.ts`：`classifyQuery(task, mode)` 纯函数（显式模式覆盖；auto：空白/CJK→text，点号/`#`/括号/PascalCase→exact，其余 text）；text 意图走三路合并（entity BM25 + search-doc 词法 + 名称前缀），exact 走原短路径链；`sql-client.querySearch` 接 `searchMode`；in-memory oracle 同实现保持 parity | 分类只读查询文本本身，白名单式代码形态判定；不读 task ID、gold、冻结标签；同一分类器对任意查询一致 |
| T05 源码链接搜索文档（commit `1df7a6b`，11 文件，+763/−12） | 旧词法检索只覆盖实体 token（名称/签名），自然语言注释、字符串常量、javadoc 里的关键信息完全不可检索 | `SearchDocument` + `buildSearchDocuments()`（type/method 级，带 leading javadoc/注释，`redactSecretLiterals()` 去除密钥形态字面量）；`search_doc`/`search_doc_token`/`search_doc_df` 三表（schema v5，`SEARCH_DOCUMENT_REPRESENTATION_VERSION` 校验）；`entity-search` 增加 DOCUMENT 层 docHits + 实体级去重；`search-docs.ts`（`replaceSearchDocuments`/`rebuildSearchDocDf`/`runInWriteTx`）；冷建/增量 writer 接线；ast-extractor 暴露 `JavaLeadingComment` | 文档由 AST 派生纯函数，按 representation version 全量替换；无 taskId/gold 读取；K15/K16/K18 函数探针验证 |
| T07 有界 SQL 查询与查询成本（commit `cb3c58c`，11 文件，+782/−9） | 旧 `search()` 对宽查询遍历全部命中词元、每行回查 avgLength（全表 SCAN），且无 deadline：10k 语料宽查询 ~1.7s，超 warm_static 预算量级 | `QueryWorkBudget`（deadline + 独立 postings 上限，`DEFAULT_QUERY_MAX_POSTINGS=20000`，fake-clock 可测）；`searchDetailed()` 结构化结果（`stopReason`: deadline/postings/truncated/index_partial）；`commitEntityStats` 让 avgLength 走 meta（消灭全表 SCAN，EXPLAIN 实证）；`filterHitsByScope` 在 cap 前做路径前缀过滤；`querySearch(task, options, requestOptions)` 支持父级 `DeadlineBudget`；in-memory oracle `searchEntitiesDetailed` parity；`measure-query-load.ts` 合成负载脚本 | 预算是资源约束（对任意查询一致生效），不是路由；postings cap 有独立 EXPLAIN 证据；10k 结果如实标注 UNMEASURED-on-real-corpus |
| T06 java_symbol 静态后端 + MCP canary（commit `557ffb7`，11 文件，+794/−16） | 旧 `operation=query` 唯一走 JDT `workspaceSymbols`：无 JDT/索引未就绪时直接报错或要求 LSP 会话，静态索引里的声明信息无法经 MCP 暴露 | `symbolNeedsJdt()` 单谓词（`operation!=="query" || backend==="jdt"`）同时驱动 factory 的 `mayStartLsp`/`requireLspEnabled`/`semanticPolicy` 与 handler 分支；`runStaticDiscovery()` 组装 `java-discovery/v1`（`attachLocators` 回填 line/column/contentHash/module，preview 以 sha256 内容哈希门控，`scopeState` PARTIAL 映射）；`EntityHit` 定位字段扩展；README 文档化；`run-m1-static-canary.ts`（隔离 38457 端口，拒绝生产 38456，`JDT_BIN=/usr/bin/false`，spawn kit harness `run-adapter --arm static-m1`） | `query` 默认走静态是能力升级而非按任务豁免；canary 使用 kit 自带 adapter 与冻结数据集，adapter 只读 `schemaVersion`/`candidates`/`previewKind`，无 gold 短路；JDT 通道原样保留（`backend=jdt`） |

新增依赖：无。删除/替换的旧分支：`operation=query` 的 JDT `workspaceSymbols` 通道从默认降级为 `backend=jdt` 显式选择（行为保留）；`search()` 无预算路径保留（`searchDetailed` 为新增端口，旧调用方不受影响）。

## 执行证据

原始日志全部位于仓库外 `RUN=/Users/luo/Documents/github/java-devkit-v1-runs/m1/`。

| Command | Exit | Raw log（$RUN/…） | SHA-256（前 12 位） | Meaning |
|---|---:|---|---|---|
| `python3 -m harness.preflight`（M1 开工，T06 提交前） | 0 | preflight-m1.json | acbf2f2402ae | source_sha=cb3c58c…（当时 HEAD），环境齐备 |
| T04 RED：`query-intent.test.ts` + `entity-search` intent 用例 | 1 | t04-red.log | fe67a9bcaba2 | 新意图分流断言按真实行为失败（非模块缺失） |
| T04 GREEN 定向 | 0 | t04-green.log | fe160ffaef48 | 意图/三路合并断言全绿 |
| T04 probe（C2 多词查询） | 0 | probe-c2-t04.json | bf6d56162bf0 | M0 遗留唯一失败项 `OrderService rollback refund` → PASS |
| T04 全组 probe | 0 | probe-t04.json | 1e06c9b35626 | 12/12 |
| T04 全量产品测试 | 0 | t04-full-3.log | ecf583dd4049 | 1171 + 295 全绿 |
| T05 定向（K15/K16/K18 search-docs） | 0 | t05-targeted-3.log / probe-t05.json | dbcbf5930f1c / 1e06c9b35626 | schema v5 + 文档层检索 + 实体级去重通过，probe 12/12 |
| T05 全量产品测试 | 0 | t05-full-3.log | 76107c3b85d7 | 1176 + 295 全绿 |
| T07 RED（budget + bounded 两组新断言） | 1 | t07-red-budget.log / t07-red-bounded.log | 6b8a41282e6f / 297cdd499366 | deadline/postings 上限断言按真实行为失败 |
| T07 GREEN（同两组） | 0 | t07-green-budget.log / t07-green-bounded.log | de9c7b6e98d9 / 575da7b03920 | 预算与结构断言全绿 |
| T07 全量产品测试 | 0 | t07-full-2.log | f4bdaa5e0202 | 1187 + 295 全绿 |
| T07 合成负载 1k 文件 | 0 | t07-load-1k/query-load-report.json | f0ff130a96ec | 建库 1.94s；20 查询队列 P95=45.7ms；0 超时；exact 查询 postingsVisited=0（COVERING INDEX entity_fqn） |
| T07 合成负载 10k 文件 | 0 | t07-load-10k/query-load-report.json | 494bf2c99598 | 建库 26.5s；队列 P95=63.8ms；0 超时；宽查询无界 1.7s → 有界 62ms（postings stop）；EXPLAIN：postings→COVERING INDEX entity_token_lookup，avgLength meta 化后消除全表 SCAN |
| T06 RED→GREEN（K25/K26 + e2e） | 1→0 | t06-red.log → t06-t3run.log | 49f0a3d159b3 → 08a157c7fbf0 | 静态 query 无 JDT 依赖、exact FQN、position/references 不回归、query→impact 同库串联 4/4 |
| T06 全量产品测试 | 0 | t06-full-3.log | 53da4ce50309 | 1191 + 295 全绿 |
| T06 MCP canary（真实 JavaLspHttpServer @ 127.0.0.1:38457，`JDT_BIN=/usr/bin/false`，kit `run-adapter --split dev --arm static-m1`） | 0 | t06-canary/m1-dev-adapter.json + run-adapter-raw.log | be8d00baa9b5 / 2c8f509f9023 | **24/24 任务 status=OK，0 PARTIAL/ERROR/UNSUPPORTED**；dataset_hash 一致；server 全程未拉起 JDT（launcher=/usr/bin/false 下无失败事件） |
| 边界：`npm run build:isolated` | 0 | m1-boundary/1-build-isolated.log | 15d5b7367f53 | 隔离克隆编译通过（HEAD 557ffb7，executableTree=70494a7c…） |
| 边界：`npm test` | 0 | m1-boundary/2-npm-test.log | afcc1197ac77 | 1191 + 295 pass，0 fail |
| 边界：`npm run gate:pr` | 0 | m1-boundary/3-gate-pr.log | b99f9cea4ffe | PR-fast 门通过 |
| 边界：`npm run gate:release` | 0 | m1-boundary/4-gate-release.log | a872abc835b6 | 发布门（全量+smoke 档）通过 |
| 边界：`npm run measure:tool-schema` | 0 | m1-boundary/5-tool-schema.log | 4c7db6564650 | 工具 schema 测量通过 |
| 边界：`npm run measure:production-ts` | 0 | m1-boundary/6-production-ts.log | 707c89ddf422 | 生产 TS 盘点，inventorySha256=6406cba04deb… |
| 终态 preflight（HEAD 557ffb7） | 0 | m1-boundary/preflight-final.json | 03566c316d1e | source_sha=557ffb7…，tracked_diff 空（e3b0c44…），环境齐备 |
| 终态全组 probe（12 项） | 0 | m1-boundary/7-probe-source.json | 1e06c9b35626 | **12/12 PASS**（含 M0 唯一失败项 C2 多词查询） |

统一产品回归命令 6/6 全部在本环境执行并通过（M0 审查附录遗留事项就此关闭）。未运行：真实 Agent（LIVE）、全语料（FULL）轨道、`gate` 数值门（见下）。

## 逐任务差异

| Task / variant / repeat | Baseline（M1 前） | Candidate（M1 后） | First causal break | Closed / new / known |
|---|---|---|---|---|
| T04 / C2 多词查询（probe） | FAIL（BM25 单路由，多词 AND 后零实体命中；M0 终态 11/12） | PASS：text 意图三路合并（entity + search-doc + 名称前缀），probe 12/12 | `classifyQuery` 将意图句判为 text 并进入合并路由 | Closed（M0 遗留项 #1） |
| T05 / K15-K18（search docs） | 无文档层：注释/javadoc 内容不可检索 | 12/12 保持 + search-doc 层命中（词元、df、实体级去重）；1176+295 绿 | `replaceSearchDocuments` 写入 + `docHits` 并入合并排名 | New（无已知回退） |
| T07 / 1k、10k 合成负载 | 无界查询（宽查询 10k 语料 1.7s，avgLength 全表 SCAN） | 有界：P95 45.7ms(1k)/63.8ms(10k)，宽查询 62ms（postings stop），EXPLAIN 全走覆盖索引 | `searchDetailed` 预算 + `commitEntityStats` meta | New（真实语料数值 UNMEASURED） |
| T06 / canary 24 任务（static-m1 臂，isolated MCP） | `operation=query` 无 JDT 时不可用/报错（canary 首跑 24×ERROR，adapter exit 2） | 24/24 status=OK，0 PARTIAL；全程无 JDT 拉起 | `symbolNeedsJdt` 谓词 + `runStaticDiscovery` + `attachLocators`/preview 哈希门控 | New；旧 `backend=jdt` 通道保留（K26 回归 0） |
| 产品回归 | M0 终点 1160+295 | 1191+295（+31 测试），6/6 边界命令 + 12/12 probe 全绿 | — | 无回退 |

## 成本与统计

- **模型 usage**：无模型调用，token/费用结论 UNMEASURED（provider usage 字段不适用）
- **adapter 轨道**（static-m1，dev split 24 任务，primary 变体 ×1）：24 OK / 0 PARTIAL / 0 ERROR；无缺失字段；候选数 0–8/任务（小语料，含空候选的合法查询）
- **查询成本**（合成语料，`measure-query-load`，同一脚本两种规模）：

  | 规模 | 建库 | 20 查询队列 P50 | P95 | 超时 | 备注 |
  |---|---:|---|---:|---:|---|
  | 1,000 文件 | 1.94s | — | 45.7ms | 0 | exact 查询 postingsVisited=0 |
  | 10,000 文件 | 26.5s | — | 63.8ms | 0 | 宽查询无界 1.7s → 有界 62ms |

  以上为机制证据（有界性、索引路径、无超时），**不是** `warm_static_p95=150ms` / `event_loop_p95=20ms` 等发布门的实测值；真实语料与真实 MCP 长会话下的 P95 属 LIVE/FULL 轨道，本里程碑 UNMEASURED。
- **冷暖分离**：canary 首查询含索引冷建（每 staged repo 独立），后续查询走已建索引；`run-adapter-raw.log` 记录逐任务 elapsed（0.2–2s 量级，含阶段化复制）。

## 限制与决定

1. **发布门数值全部 UNMEASURED**：correctness_floor / qa_contract_floor / warm_static_p95 / event_loop_p95 / anchored_impact_p95_ratio 需要真实 Agent + 全语料（LIVE/FULL/RELEASE 轨道）；本里程碑仅有 FUNCTION_PROBE + SCOPED canary + 合成负载，**不得以探针或自检替代发布验收**
2. **10k 负载为合成语料**：文件规模与依赖形态非真实仓库，数值只证明有界性机制，不外推为性能门 PASS
3. **canary 是隔离轨道**：38457 端口 + `JDT_BIN=/usr/bin/false`，证明"无 JDT 时静态通道经真实 MCP server 端到端可用"；不等同于生产 38456 服务行为
4. **installed_runtime_sha=UNMEASURED**：JDT/LSP 全程未启用；`backend=jdt` 通道代码保留但本轮未被激活
5. **冻结面完好**：`gates.json` / `schemas/` / `dataset/` / `harness/` 自 bundle 至 HEAD 0 行 diff（preflight 校验）；`LIVE_TRACE_V1_FIELD_NAMES` 未扩展；source 报告保护字段未被覆盖

**决定**：**GO**（M1 完成度）——四张任务卡（T04/T05/T07/T06）机制全部落地并提交（`13e0882`/`1df7a6b`/`cb3c58c`/`557ffb7`），M0 唯一探针失败项（C2 多词查询）关闭，probe 12/12，统一产品回归 6/6（1191+295 全绿），真实隔离 MCP canary 24/24 OK 且全程无 JDT。M2 入口条件：开启真实 Agent（LIVE）轨道与全语料基线/对比，实测五项发布门数值；届时 canary 结论方可外推为发布结论。