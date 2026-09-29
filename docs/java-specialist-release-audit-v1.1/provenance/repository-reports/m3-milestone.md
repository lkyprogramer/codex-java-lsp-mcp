# M3 里程碑报告：预注册实验与单主线收口

**分支：** `codex/java-specialist-devkit-v1`
**代码 HEAD：** `517d50b`（本报告提交前最后代码态；本报告的 docs 提交为最终 HEAD）
**判定：** **M3 = GO** —— 三张任务卡全部以实测证据收口：T10 主判定 **KEEP_EXTERNAL**（四向之一；任务层内建子问题 INCONCLUSIVE，三轮后端含强判官确认无净收益/无伤害），效果分支按 docs/10 关闭；T11 NOT_NEEDED（无绑定缺陷触发）；T12 单主线收口完成。M0–M3 任务卡路线全部收口；docs/14 最终验收清单中 full public corpus / locked 逐 case / repair 三项仍未全绿（见"未测项与验收差距"）。

## 任务卡结果

| 卡 | 结果 | 证据 |
|---|---|---|
| T10 语义发现实验 | **KEEP_EXTERNAL**（主判定，docs/10 四向之一；任务层内建子问题 INCONCLUSIVE，三轮后端确认；分支关闭；产品保持 A2 主线，dense 留独立外部选项） | [m3-t10-semantic-discovery.md](m3-t10-semantic-discovery.md) |
| T11 绑定加深 | **NOT_NEEDED**（零产品 diff，合法完成） | [m3-t11-binding.md](m3-t11-binding.md) |
| T12 收口发布 | 完成（本报告 + 单主线清理 + 边界回归） | 下文 |

## T10 关键数字（真实执行，非模拟）

- 外部向量路线：OpenRouter `liquid/lfm-2.5-embedding-350m:free`（1024 维；zvec 包 npm 404，身份核实偏差已记录）；用户显式授权，凭据仅存仓库外。
- 检索层（24 dev × 8 语料，对齐 SearchDocument 文本面）：A2 micro recall **0.694** → A3 **0.778**；inventory **+0.444**；4 任务纯增益，**零回退**；增益集中于中文跨语言任务。
- agent 层（12 pilot × 2 臂 × 3 重复 = 72 runs MEASURED，同模型/prompt/tools/预算）：A2 **9/24** vs A3 **7/24**；唯一任务级差异 GSON-03（−2）归因模型事实构造错误（提示已正确指向 gold 行）；27B 后端能力封顶使 dense 贡献在任务层不可分离。
- 成本总账：建库 115 embeddings / 37.8s；查询 24 embed / 21.8s（复跑）；向量库 0 下载（远程 API，免费）。

## T11 归因结论

M2 144 行实测 + SOURCE_RECEIVED 交叉验证：失败运行**已读到 gold 文件**、键名正确、事实值错误（PAYMENTS-01 `accept`→`isDuplicate`、GSON-01 `a_U_R_L`→`a_URL` 等）= 27B 模型能力；无 overload/generic/dispatch 绑定缺陷签名；`call-resolver.ts` 已是任务卡要求的保守静态行为 → NOT_NEEDED。K22–K24/K28 运行态项 NOT_RUN（无触发）。

## T12 收口

1. **单主线清理**（`8466486`）：删除未注册的 `java_context` 工具面（`src/tools/java-context.ts` + 测试）及其唯一消费者 N5 重放脚本；`context-engine` 模块保留（`java_impact`/SQL 层仍消费）。工厂测试 9/9 绿。
2. **releaseDecision**（每字段仅从各自实测证据填写）：

```json
{
  "productRegression": "PASS",
  "independentRetrieval": "MEASURED",
  "liveAgentOutcome": "MEASURED",
  "fullPublicCorpus": "MEASURED",
  "permittedToDeploy": false
}
```

终局口径（closure 轮）：`fullPublicCorpus` 由 UNMEASURED 改为 **MEASURED**——`hydrate-public`（网络已授权、固定 SHA）水合 12 语料后 external-full 独立 profile 实测（micro A2 0.574 → A3 0.625，12/12 语料 dense 建成，SiliconFlow Qwen3-VL-Embedding-8B provider）；`liveAgentOutcome` 同步补齐 repair 轨道（48 runs 冻结测试实测，0/33 诚实零）。`permittedToDeploy` 维持 false：本交付是代码 + 测试证据，不触碰线上 daemon。closure 边界证据：`/Users/luo/Documents/github/java-devkit-v1-runs/m3/m3-closure/`（6 命令全 0 退出 + probe 12/12 + selfcheck + preflight 干净）。

- `productRegression=PASS`：本边界 6 命令全绿（下表）。
- `independentRetrieval=MEASURED`：M1 质量对照 + M3 检索层 A2/A3（scoped 0.694/0.778）+ **external-full 12/12 语料 0.574/0.625（closure 轮，SiliconFlow provider）**。
- `liveAgentOutcome=MEASURED`：M2 LIVE 144 runs（taskSuccessRate 0.189；product 12/72 vs control 9/72）+ M3 agent A/B 3×72 runs（QA）+ **closure 轮 repair 48 runs 冻结测试实测（A2 0/24、A3 0/24）**。
- `fullPublicCorpus=MEASURED`：`hydrate-public`（网络已授权）水合 12 语料 1725 文件后 external-full 独立 profile 实测（micro A2 0.574 → A3 0.625，12/12 dense，190 次 API 零错误）；前两轮 lfm 6/12、nemotron 9/12 因 OpenRouter 免费档 50 请求/天截断，如实留档。
- `permittedToDeploy=false`：本交付 = commit + 测试证据；安装/替换线上 daemon 需另行授权（`./install-runtime.sh`，不动 38456 在线服务）。

3. **代码量分账**（`git ls-files` 口径，src 按类别）：
   - 产品非测试（src/ 非 test 非 benchmark）：40,913 行
   - 测试（src/*.test.ts）：36,690 行
   - benchmark（src/benchmark/）：3,278 行
   - scripts/*.mjs：26,642 行（含评测/隔离 harness）
   - 退役/实验（experiments/semantic-discovery/，T10 独立包，非产品依赖）：1,149 行
   - 历史文档（docs/deep 等）不计入代码复杂度（目录移动/保留不视为删除复杂度）

4. **用户说明**：默认链一页可解释——静态事实索引（Tree-sitter + SQL `index.sqlite`）→ `java_symbol` 词法/结构化发现（A2 主线）→ 有界 `java_impact` 影响链；JDT 仅在 service-profile anchor 按需升级（本 devkit 轨道全程 `JDT_BIN=/usr/bin/false`）；dense 语义发现 = 独立外部实验选项，未进产品依赖树。derived-cache 重建机制与 immutable release 保留；未新增 daemon 平台。

## 里程碑边界回归（`/Users/luo/Documents/github/java-devkit-v1-runs/m3/m3-boundary/`）

| 命令 | 退出 | 说明 |
|---|---|---|
| `npm run build:isolated` | 0 | 隔离 detached clone 编译 |
| `npm test`（isolated full） | 0 | **1199 + 296 pass / 0 fail**（M2 边界为 1205 + 305；差额 = T12 删除 java_context 面 6 测试 + N5 重放脚本测试，无新增失败） |
| `npm run gate:pr` | 0 | |
| `npm run gate:release` | 0 | |
| `npm run measure:tool-schema` | 0 | |
| `npm run measure:production-ts` | 0 | 命令名修正（`check:production-ts` 不存在，npm 自身报错误导） |

probe / selfcheck / preflight 见报告提交后的 clean-tree 记录（同目录）。

## M3 提交序列

```
f78b610 docs(m2): final milestone report - live track measured   ← M2 边界
8466486 refactor(m3): remove unregistered java_context tool surface
36c404c experiment(m3): T10 bounded semantic-discovery experiment
517d50b docs(m3): T11 binding deepening - NOT_NEEDED
<本提交> docs(m3): T12 closure + milestone report
```

## 冻结边界验证

- `gates.json` / `dataset/` / `harness/`：bundle→HEAD 零 diff（preflight 记录）。
- 无 gold/taskId 特判（T10 实验包按冻结 task/gold 文件驱动，未改标签）；LIVE 凭据未进仓库（`openrouter.env.json` 在仓库外运行目录）。
- 生产路径零副作用：实验全程 `JDT_BIN=/usr/bin/false`、隔离 HOME/cache；未触碰 38456 在线 daemon。

## K01–K32 完整状态表（docs/14：每项真实 PASS 或明确 BLOCKED/NOT_RUN）

状态口径：PASS=冻结执行路径已真实执行；PARTIAL=函数/fixture 级已过、runtime 级未执行；NOT_RUN=无任何级执行（全部显式列出，不默默消失）。

| K | 类别 | 状态 | 证据 |
|---|---|---|---|
| K01/K02/K04 | identity | PASS | source-probe C1 三项，M3 边界 probe 12/12 |
| K03（main/test 同 FQN 不互覆盖） | identity | NOT_RUN | 需双 sourceSet 真实运行时 |
| K05（删除文件后声明/边/文档移除） | identity | NOT_RUN | 需 watcher 运行时（M2-5 交接项） |
| K06（sibling worktree 同路径异内容） | identity | NOT_RUN | 需多 worktree 真实运行时 |
| K07/K08/K09 | range | PASS | source-probe C3 三项（LF/CRLF 长方法），M3 边界 probe 12/12 |
| K10（emoji UTF-16 列号） | range | PARTIAL | 套件内行号/列号测试绿；冻结的 fixtures/unicode 专项未单独执行 |
| K11（helper 移动后关系不变） | range | PARTIAL | M2 fixture 级 GREEN（`helper-move-k11.test.ts` 双布局，套件内绿）；runtime 级未执行 |
| K12（零预算显式 PARTIAL） | range | PARTIAL | 预算测试在套件内绿（query-budget）；冻结 runtime 场景未执行 |
| K13/K14 | discovery | PASS | source-probe C2 两项（free-text 竞争 + exact 零向量调用），M3 边界 probe 12/12 |
| K15（中文注释变更可检索） | discovery | NOT_RUN | runtime freshness（M2-5 交接项） |
| K16（mapper statement 源码链接） | discovery | PARTIAL | M1 函数级（K16 mybatis 探针，M1 报告记录）；fixtures/resource 专项未单独执行 |
| K17（宽泛词 scope 内先滤后限） | discovery | PARTIAL | M2 T07 QueryWorkBudget 函数级（deadline+postings cap，套件绿）；20 并发 runtime 未执行 |
| K18（secret 值不出 wire） | discovery | PARTIAL | `redactSecretLiterals()` 函数级（M1）+ half-up fixture；fixtures/resource 专项未单独执行 |
| K19（删除/重命名负缓存失效） | freshness | NOT_RUN | M2-5 交接项，需 watcher 运行时 |
| K20（跨 generation 一致性） | freshness | PARTIAL | `generation` 快照语义函数级（M1 记录）；运行时判定未执行 |
| K21（sibling XML-only 变更 hash 对账） | freshness | NOT_RUN | M2-5 交接项 |
| K22/K23/K24 | bindings | NOT_RUN | T11 NOT_NEEDED（无触发失败）；fixture 专项未构造 |
| K25（静态 query 零 JDT 启动） | api | PASS | M1 canary 实测 24/24（JDT_BIN=/usr/bin/false，无 JDT 失败事件）+ `symbol-static.test.ts` 套件绿；M2/M3 全部 live 运行同纪律复现 |
| K26（position/references 保持 JDT 要求） | api | PASS | `symbol-static.test.ts:261` 实名测试，每轮 npm test 绿 |
| K27（provider 故障回退词法） | runtime | PARTIAL | T10 实验包离线 fake 覆盖 timeout/offline/hash 不一致回退（8/8 测试 + 真实端点 E2E）；真实 provider 离线场景未演练 |
| K28（共享 JDT 请求取消隔离） | runtime | NOT_RUN | 需 JDT 运行时（本轨道全程静态纪律） |
| K29（20 并发宽泛查询队列有界） | runtime | PARTIAL | M2 事件循环/预算测量（wire 测量 + query-load）；20 并发专项未重跑 |
| K30（writer 完成后 idle 读连接 WAL 收敛） | runtime | PARTIAL | `sql-client-lifecycle.test.ts` 函数级（套件绿）；长时 idle runtime 未执行 |
| K31/K32（嵌套声明/record/text-block） | syntax | PARTIAL | AST 提取器测试在套件内绿（ast-extractor 覆盖）；冻结 fixtures/syntax 专项未单独执行 |

汇总（32 项全列，无遗漏）：**PASS 10 项**（K01/K02/K04/K07/K08/K09/K13/K14/K25/K26）；**PARTIAL 12 项**（K10/K11/K12/K16/K17/K18/K20/K27/K29/K30/K31/K32：函数/fixture 级已过，runtime 级未执行）；**NOT_RUN 10 项**（K03/K05/K06/K15/K19/K21/K22/K23/K24/K28）。NOT_RUN 的集中原因：① watcher/reconcile 真实运行时（M2-5 交接项，需 per-item 契约回填）② JDT 运行时（本 devkit 轨道静态纪律）③ T11 无触发未构造 fixtures。**无一项被默默丢弃；无一项伪装成 PASS。**

## 未测项与验收差距（对照 docs/14 逐项公开）

| 项 | 状态 | 阻塞原因 / 处置 |
|---|---|---|
| fullPublicCorpus（全公开语料独立 profile，docs/14 明确"不能用 scoped 高分替代"） | **MEASURED（关闭）** | `hydrate-public`（网络已授权，固定 SHA）水合 12 语料 1725 文件；external-full 检索 A/B：micro A2 0.574 → A3 0.625（+0.051），12/12 语料 dense 建成（SiliconFlow Qwen 8B 轮，190 次 API 零错误）；证据 `retrieval-full-final/`。前两轮（lfm 6/12、nemotron 9/12）因 OpenRouter 免费档 50 请求/天截断，如实留档 |
| **locked 集逐 case 结果（docs/14："dev 和未用于调参的 locked 分别有逐 case 结果"）** | **已补齐**（M3 收口后执行） | 12 locked 任务（hikari/ledger/notifications/pagination，自创失败机制 fixture）× 2 臂 × 3 重复，GPT-6-Luna 判官：QA 9 任务两臂各 3/27 成功（逐任务差异：PAGINATION-01 A3 +1、HIKARI-02 A3 +1、HIKARI-01 A3 −2，净 0）；repair 见下行。结果：`/Users/luo/Documents/github/java-devkit-v1-runs/m3/agent-locked/`。解读：locked fixture 设计目标是隔离失败机制，两臂低成功率符合预期；dense 在未见过的自创语料上同样无净收益/无伤害，与 dev 集结论一致（跨语料稳健） |
| Agent repair（P 轨，docs/14 "实际 Agent QA/repair"） | **MEASURED（关闭）** | 冻结判定器接线（docs/07，RED→GREEN 20/20）后实测 8 任务 × 2 臂 × 3 重复 = 48 runs：**A2 0/24、A3 0/24**（nemotron 与 siliconflow 两轮一致）。归因：模型读完 gold 文件后拒绝/写错（非 harness、非检索瓶颈）；repair 以诚实的零关闭 |
| 资源矩阵（task36 变异矩阵）与独立 benchmark 在 M3 边界重跑 | 未重跑 | M3 边界执行了 6 命令 + probe + selfcheck + preflight；task36/独立 benchmark 为 M1 产物未在本边界复跑，列入后续补跑清单 |
| agent 层 A/B 第二/三轮（space-bunny / 本地网关 `codex/gpt-6-luna` reasoning=max，用户提供） | 已执行 | 轮 2：4/22 vs 5/22；轮 3（强判官）：A2 11/24 vs A3 10/24 → 任务层 dense 贡献被干净测得为无净收益、无伤害 → 主判定 KEEP_EXTERNAL |
| K22/K23/K24/K28 运行态绑定契约 | NOT_RUN | T11 无触发失败（上表 K 状态表全量列出） |
| M2-5 runtime 级 freshness（K15/K19/K21 等） | 未执行 | 需 per-item runtime 契约回填 + 真实 runtime 环境 |
| 第二轮 embedding 模型对照 | 已执行（超出原计划） | 三轮后端 + **三 provider 对照**（lfm 1024 / nemotron 2048 / Qwen8B 4096，跨向量空间结论一致：任务层无净收益/无伤害，检索层正收益）→ 分支关闭证据链完整 |

**结论（终局版）**：M3 = GO 的准确含义是**任务卡路线收口 + 实验分支关闭 + 产品边界全绿 + dev/locked 逐 case 覆盖 + docs/14 两项遗留缺口（full public corpus、Agent repair）均已实测关闭**。docs/14 最终验收清单在现有授权下已无不可执行项；剩余 NOT_RUN 仅为 runtime 级契约回填（M2-5 交接）与 JDT 运行时（静态纪律轨道不适用），不属于最终签字阻塞项。

## Reviewer 检查项（对照任务卡）

- [x] 无 gold/taskId/项目特判；冻结标签零修改（dataset/ 零 diff）
- [x] 无生产路径副作用（静态纪律 + 隔离运行目录）
- [x] 每字段 releaseDecision 仅由各自实测证据填写，未混同 testCount
- [x] 实际未完成的测试未写 ALL_PASS（runtime 级契约/独立 benchmark 重跑项如实 NOT_RUN；fullPublicCorpus 与 Agent repair 已在 closure 轮实测关闭）
- [x] semantic 实验关闭后产品完整可用（边界 6 命令 + probe + selfcheck 全绿）
- [x] 提交不是安装授权（permittedToDeploy=false，线上 daemon 未动）