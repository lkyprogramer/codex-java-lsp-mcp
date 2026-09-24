# M3 里程碑报告：预注册实验与单主线收口

**分支：** `codex/java-specialist-devkit-v1`
**代码 HEAD：** `517d50b`（本报告提交前最后代码态；本报告的 docs 提交为最终 HEAD）
**判定：** **M3 = GO** —— 三张任务卡全部以实测证据收口：T10 四向结论 INCONCLUSIVE（agent 层）+ 检索层正信号，效果分支按 docs/10 关闭；T11 NOT_NEEDED（无绑定缺陷触发）；T12 单主线收口完成。M0–M3 全路线收口。

## 任务卡结果

| 卡 | 结果 | 证据 |
|---|---|---|
| T10 语义发现实验 | **INCONCLUSIVE**（分支关闭；产品保持 A2 主线，dense 留独立外部选项） | [m3-t10-semantic-discovery.md](m3-t10-semantic-discovery.md) |
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
  "fullPublicCorpus": "UNMEASURED",
  "permittedToDeploy": false
}
```

- `productRegression=PASS`：本边界 6 命令全绿（下表）。
- `independentRetrieval=MEASURED`：M1 质量对照 + M3 检索层 A2/A3（0.694/0.778）。
- `liveAgentOutcome=MEASURED`：M2 LIVE 144 runs（taskSuccessRate 0.189；product 12/72 vs control 9/72）+ M3 agent A/B 72 runs。
- `fullPublicCorpus=UNMEASURED`：公开语料下载未授权（`--allow-network`），M2-6 遗留。
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

## 未测项（如实公开）

| 项 | 状态 | 阻塞原因 |
|---|---|---|
| fullPublicCorpus（全公开语料 A2/A3/agent 臂） | UNMEASURED | 语料下载需 `--allow-network` 授权（M2-6 同因） |
| agent 层 A/B 第二/三轮（space-bunny / 本地网关 `codex/gpt-6-luna` reasoning=max，用户提供） | 已执行 | 轮 2：4/22 vs 5/22；轮 3（强判官）：A2 11/24 vs A3 10/24 —— 任务层 dense 贡献被干净测得为无净收益、无伤害 → 最终姿态 KEEP_EXTERNAL |
| K22/K23/K24/K28 运行态绑定契约 | NOT_RUN | T11 无触发失败 |
| M2-5 runtime 级 freshness（K15/K19/K21） | 未执行 | 需 per-item runtime 契约回填 + 真实 runtime 环境 |
| 第二轮 embedding 模型对照 | NOT_RUN | 一轮已足够四向判定 + 分支关闭 |
| repair（P 轨）任务 | UNMEASURED | repairTester 未注入（M2 遗留，接口就绪） |

## Reviewer 检查项（对照任务卡）

- [x] 无 gold/taskId/项目特判；冻结标签零修改（dataset/ 零 diff）
- [x] 无生产路径副作用（静态纪律 + 隔离运行目录）
- [x] 每字段 releaseDecision 仅由各自实测证据填写，未混同 testCount
- [x] 实际未完成的测试未写 ALL_PASS（fullPublicCorpus/强模型/运行态契约均如实 UNMEASURED/NOT_RUN）
- [x] semantic 实验关闭后产品完整可用（边界 6 命令 + probe + selfcheck 全绿）
- [x] 提交不是安装授权（permittedToDeploy=false，线上 daemon 未动）