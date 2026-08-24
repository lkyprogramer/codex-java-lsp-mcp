# 下一代优化方案：天花板评估与「更快、更准、更省 token」路线（R/T/Q/X 四轨）

- 日期：2026-08-24
- 状态：**ADOPTED（R1 修订版，2026-08-24）**（生产切换后的下一周期计划真源；接替已 COMPLETE 的 G2/cutover 计划）
- R1 修订：§4 重写为任务级开发手册（AI 自主执行版）——补充执行合同（分支/提交/收口 JSON/测试命令真源/三振规则）、每卡的精确改动锚点（文件+行号级）、入场条件、决策默认值与失败处置；据代码现状更正 Q1 的 `hydrate:false` 靶点（`type-reference.ts:135`、`anchor.ts:133`，原写的 candidate-collectors 两点已是 `hydrate:true`）；明确 `impactSchema` 目前无 `intent` 参数（X1 负责引入）。
- 前提：`main` 已于 e48a253 切换到新链路（F1-N0 GO + F2 attestation），生产 cutover runbook 已入库，soak 进行中。
- 本文档回答三个问题：①当前架构离天花板还有多远；②社区（2026）在这个问题上收敛到了什么共识；③下一周期怎么打「更快、更准、更省 token」。

---

## 0. 执行者必读

### 0.1 继承的硬禁令（全部有效）

1. holdout 金标永不入目、不用于调参（三仓 + ruoyi）。
2. 不得发明 TaskSuccess；live 外呼需用户授权 + 进程环境 key；密钥不入库。
3. `java_context` 已处决（三次 live 全败），**禁止以任何名义把「新公开工具」当作交付物**——这是本项目最贵的一课：新工具面 = 新交互形状 = 模型不会用。本计划所有能力演进都通过 `java_impact` 的可选参数落地，默认行为逐位不变（identity 门）。
4. 隔离验证、T3 输出目录、load 政策、门不放宽、每卡独立提交 + 收口 JSON 的纪律照旧。
5. **生产在线**：从本周期起 `main` 是生产，任何合并前必须过 F1 同款四门（质量非劣 −0.005 / token 不升 / p95 ≤1.10 / 内存不回退）。

### 0.2 本计划的元原则：证据先行（Evidence-First）

上一周期最大的教训不是某个技术选型错了，而是**投资顺序错了**：JIN 花整轮建图和新工具，最终对 Agent 零转化；而真正落袋的三项收益（紧凑合同、内存、图内核）全部来自「先有测量、再动刀」。因此本计划：

- **R 轨（真实使用遥测）是所有其他轨的入场券**。合成 golden 已经把能榨的信息榨完了（B0 归因、oracle 分解都做了）；下一步的刀必须由你日常真实使用的缺口驱动。
- 每张 T/Q/X 卡都带**入场条件**，未满足不开工。宁可闲置，不做投机性改造。

---

## 1. 天花板评估：四个维度，两个已到顶，两个还有大空间

### 1.1 内存 —— **已到天花板，关闭**

单大仓热驻留 838 → 57 MiB（−93%），三仓全热 415 MiB，五 runtime 725 MiB，休眠 9 MiB。继续压榨（mmap 段共享、跨进程去重）复杂度陡增而收益对 24 GB 机器为零感知。**除非未来单仓规模 10 倍增长，永久关闭此方向。**

### 1.2 延迟 —— **热路径已到顶，冷路径有残差但是罕见路径**

warm p95 20–77ms、比旧 main 快 26–47%，已是进程内内存查询的物理量级。残差全在冷路径：冷建 83.5s（门 60s）、首查询 hydrate 7.5s、child 峰值 1943 MiB。这些有快照/播种/后台 hydrate 三层兜底，日常几乎碰不到。**保留 O 轨残差卡编号，只在真实使用中每周命中 ≥1 次时才开工（R 轨遥测负责计数）。**

### 1.3 token —— **单次调用接近下限，但「每任务总 token」还有一整档**

单次 `java_impact` 输出 P50 2830–3393 estimatedTokens，其中大头是 `plannedSourceBytes`（读取计划驱动的源码读取），压缩单次输出的边际空间已小。**真正的空间在交互形状**：现在每次调用回吐同一形状的全量 readPlan，而 2026 年社区共识（§2）是分层出量——fold/preview/full 三档明细、骨架先行、按需下钻。LocAgent 用 fold/preview/full 三档在 92.7% 文件级精度下把成本压到私有 SOTA 的 14%。目标：**每任务总 token 再降 30–50%**，杠杆是「少读不需要的源码」而不是「把同样的东西写得更短」（社区有反例：激进压缩反而让总成本 +67%，因为模型看不懂了要多问）。

### 1.4 准确率 —— **离天花板最远，是下一周期的主战场**

| 口径 | 现值 | 天花板参照 |
|---|---|---|
| 三仓 tuning rReadMust | 0.88–0.925 | 1.0（oracle 证明池内可达 0.825+） |
| 三仓 holdout rReadMust | 0.40–0.625 | LocAgent 文件级 Acc@5 92.7% |
| ruoyi（外部仓）pRead / rReadMust | 0.298 / 0.538 | 旧 main 0.345 / 0.614（还倒挂） |

B0 归因已经把缺口拆成三层（外部仓口径）：`NOT_IN_POOL` 40.8%（候选池结构性缺失：enum/config/properties、MyBatis-Plus Mapper、DI 接线、codegen）、`IN_POOL_EVICTED` 39.5%（预算/桶规则挤出——**在池里却没选上，最便宜的矿**）、`RANGE_MISS` 19.7%（文件对了 range 不对——V3.2-27 已定位到 `hydrate:false` 候选缺方法级位置）。三层各有明确修法，没有一层是「架构做不到」。

**结论：架构没到天花板。** 内存和热延迟到顶了；token 有一整档（交互形状）；准确率的三层矿都还没挖。而且图内核（N2a/N3 边 + 实体入口 + `QUERY_CONTEXT_GRAPH`）已作为内部能力随 F2 合入生产——LocAgent 证明这套东西用对交互形状能到 92.7%，本项目缺的从来不是图，是喂给模型的方式。

---

## 2. 社区调研综述（2026-08）与对本项目的启示

### 2.1 检索三模态共识

2026 年的共识不是「语义打败 grep」也不是反过来，而是**三模态混合**：词法（rg/BM25）答「文本在哪」、结构（tree-sitter/ast-grep）答「代码形状在哪」、图（调用/实现/引用）答「谁真的在用」；让 Agent 按问题选工具、对照磁盘验证。纯 embedding RAG 因过期税和 token 低效被主流放弃（Sourcegraph Cody 也弃纯 embedding 改 BM25+代码图）。
**启示**：本项目已有词法+结构+图三模态，但都焊死在 `java_impact` 单一出口后面，Agent 无法按问题选路。X1 卡（任务类别模式）直接对应这一条。

### 2.2 「LSP 省 token」实测证伪与自适应路由（arXiv 2608.13568）

五臂消融的结论与本项目 N5 live 惊人一致：符号命名明确的定位任务上语义工具**费 token**（+6%~+118%）且模型有得选时根本不用它（0–6% 使用率）；只有引用完整性任务且标识符词法歧义高时语义才赢（precision 1.00 vs 0.76）；模型自己已有「按任务选工具」的潜在路由能力（引用类任务上主动用语义工具 45–57%）。论文结论：**做 adaptive router（按任务类别 + 词法噪声路由），别做 LSP-always**。
**启示**：这解释了 java_context 为什么死——它把所有任务都推进同一条「图搜索+装箱」路径。正确姿势是让 `java_impact` 按 intent/任务类别分模式出量，词法歧义度（一次廉价 rg 计数即可估计）决定要不要走语义精确化。

### 2.3 LocAgent（ACL 2025）：同款图，赢在交互形状

四层稀疏实体索引（FQN → 全局名字典 → BM25 倒排 → 代码块倒排）+ 三个工具（SearchEntity / TraverseGraph / RetrieveEntity）+ **fold/preview/full 三档出量**，文件级 92.7%、函数级 77%。消融：砍多跳 −5.5pp，砍 SearchEntity −18pp。
**启示**：本项目的实体入口（30/30 top-3）和异构图与它同构，缺的是三档明细出量和「按需下钻」的循环。T1 卡直接借鉴 fold/preview/full。

### 2.4 Aider repo map：token 预算化的个性化 PageRank 骨架

tree-sitter 抽签名 → 文件依赖图 → 个性化 PageRank（当前会话文件加权）→ 二分搜索装进 1K token 预算。每轮对话自动附带，是「任务无关的地图 + 任务相关的排序」。
**启示**：本项目没有「开局地图」——Agent 第一跳只能拿 anchor 换 readPlan。一份 ~1K token 的仓库骨架（模块拓扑 + 高 PageRank 符号签名）能砍掉大量试探性首跳。T3 卡。

### 2.5 骨架/CODEMAP 与语义密度（arXiv 2604.07502）

「程序骨架」作为新工件类别：模块拓扑、入口点、调用链一行摘要、签名+docstring，省略实现体。**警告性实验**：激进压缩输入 −17% 反而总成本 +67%——压缩必须保语义密度，不是无脑减字节。
**启示**：T3 骨架要以「导航够用」为界；C2 时代「首呼字节门达标但 live 总 token 恶化」就是本项目自己踩过的同一个坑。

### 2.6 MCP token 工程实践

lazy manifest（工具 schema 按需加载）、输出过滤（只回有效行）、tool-result clearing（旧结果可重取则从上下文清除）。
**启示**：本项目 schema 已精简（5 工具 1308 token）；可补的是**结果可重取性**——给输出加稳定引用 ID，让宿主 Agent 敢清历史（T2 卡）。

### 2.7 SCIP（Sourcegraph）：编译器级精确索引

scip-java 走构建集成（Maven/Gradle），编译器精度的定义/引用/实现，跨仓可用。
**启示**：对 `NOT_IN_POOL` 40.8% 这层（tree-sitter 静态解析够不着的 DI 接线、注解处理、codegen），SCIP 是现成的补池数据源，代价是要求项目可构建 + 索引时延。作为 Q3 的备选路线做一次 spike，不是默认路线。

### 2.8 Serena：符号级「编辑」是本项目完全空白的半场

Serena 的 token 节省一半来自检索、另一半来自**符号级编辑**（`replace_symbol_body` 不需要旧文本、`insert_after_symbol` 不需要行号）。本项目只做读侧。
**启示**：登记为 X2 远期项（写侧超出「检索服务」定位，且 Cursor/Claude Code 宿主自己有编辑器）；只在真实使用出现「编辑失败率可归因于行号漂移」的证据时评估。

---

## 3. 战略与执行顺序

```
R 轨（真实使用遥测，2 张卡）—— 一切的入场券，先行
   ↓ 累计 ≥2 周 / ≥200 次真实调用的缺口画像
T 轨（更省 token）：T1 三档出量 → T2 可重取引用 → T3 开局骨架
Q 轨（更准）：Q1 range 精度 → Q2 选择层预算 → Q3 发现层补池（条件） 
X 轨（探索）：X1 任务类别自适应路由（T1 之后）；X2 符号级编辑（远期登记）
   ↓ 每卡独立过 F1 同款四门后即可合 main（生产在线，小步合并取代大包）
```

优先级排序的依据：**准确率空间最大（Q），token 次之（T），延迟最小（仅冷路径）**。但 T1 排在 Q 前面开工，因为它同时是 X1 的地基且离线可完全验证；Q3（发现层）最贵，放最后且带条件。

止损与收口线（本周期的「天花板」定义，达到即收）：

| 维度 | 收口目标 |
|---|---|
| 每任务总 token（真实使用遥测口径） | 相对切换日基线 −30% |
| 三仓 holdout rReadMust | 均值 ≥ 0.75（现 0.53） |
| ruoyi pRead / rReadMust | 不再倒挂旧 main（≥ 0.345 / 0.614） |
| 真实使用「找不到」投诉率 | R 轨遥测口径下降趋势 |

---

## 4. 任务手册（AI 自主执行版）

### 4.0 执行合同（每张卡都适用，先读完再开工）

**分支与提交**

- 每卡在 `codex/frontier-<卡号小写>`（如 `codex/frontier-r1`）分支开发，基于最新 `main`。
- 一卡一个（或少数几个）提交，提交信息沿用仓库风格：`feat(r1): ...` / `fix(q1): ...` / `docs(r2): ...`。
- 过门后合 `main`（merge 单点，保可 revert）。**生产在线，禁止未过门合并。**

**收口 JSON（每卡必写，格式对齐 `docs/phase-f/f0-closeout.json`）**

```json
{
  "schemaVersion": "<track>-<card>-closeout/v1",
  "track": "r|t|q|x",
  "card": "R1",
  "dated": "YYYY-MM-DD",
  "decision": "GO | FAIL | PARTIAL | SKIPPED_ENTRY_NOT_MET",
  "entryCondition": { "required": "...", "actual": "...", "met": true },
  "scope": ["改动文件清单"],
  "gates": { "每个数字门": "实测值 vs 门值" },
  "isolation": { "t0": { "tests": 0, "fail": 0, "jdtlsBin": "/usr/bin/false", "executableTree": "<sha>", "logSha256": "<sha>" } }
}
```

落 `docs/phase-<track>/<卡号小写>-closeout.json`，同时更新 `docs/phase-f/final-panel.md` 追加一行卡状态。

**测试分级命令（真源，直接照抄）**

| 级别 | 命令 | 何时跑 |
|---|---|---|
| T0 隔离验证 | `npm run build && npm test` | 每张改 `src/` 的卡 |
| T1 PR 门 | `npm run gate:pr` | 每张改 `src/` 的卡 |
| identity 快检 | `npm run benchmark:agent-impact` 改动前后各跑一次，输出逐字节 diff | 「默认行为不变」类卡（R1/T1/T2/T3/X1 的默认路径） |
| T3 三仓矩阵 | `npm run benchmark:three-repo-matrix -- --runs 5` + `npm run benchmark:three-repo-verify`，输出目录 `docs/phase-<track>/` | 改变默认输出/选择/索引行为的卡（Q1/Q2/Q3）收口时 |
| ruoyi 观察行 | `node scripts/run-f1-ruoyi-observation.mjs`（隔离壳内跑，参考 package.json 其他脚本的 `run-isolated-node.sh` 包法） | Q 轨每卡 |
| LORO 四折 | `scripts/run-g2-loro.mjs` | Q2/Q3 收口留档（观察，不设门） |
| F1 四门裁决 | `scripts/adjudicate-f1-doors.mjs`（基线 = 当前 main 切换点 e48a253 的 F1-N0 口径） | 有 T3 产物的卡收口时 |

- T3 遵守三仓 load 政策：1 分钟 load < 20 必须执行正式矩阵，不得以主机不安静为由缩样本（真源 `docs/phase-v4/three-repo-host-load-policy.md`）。
- holdout 金标（三仓 + ruoyi）**永不打开阅读**；调参只准看 tuning 分数。

**失败处置（统一三振规则）**

1. 每卡最多 3 次修复尝试；每次尝试必须有新证据（新归因、新 diff），禁止盲目重跑。
2. 三振或超过卡内时限 → 写 `decision: FAIL` 收口 + `git checkout` 复原未合并改动 + 在 final-panel 登记 blocker → 跳到下一张不依赖它的卡。
3. 以下情况**必须停下问用户**，其余一律按卡内默认值自主决策：改公开工具协议的必选字段、删除/迁移用户数据、放宽任何已定数字门、需要外呼付费 API。

**红线速查（继承自 HANDOFF，全部有效）**

- 不加新公开 MCP 工具（`src/mcp-server-factory.ts:22-25` 现有 `java_status` / `java_impact` / `java_symbol` / `java_diagnostics` 四件套封顶）。
- 新能力一律挂可选参数或环境变量，默认关或默认等价（identity）。
- V3.2-27 证伪的「type 声明行凑合 range」修法禁止再试；V3.2-28 两轮 REJECT 的「无条件放宽预算」禁止再试。
- 显式参数（如 `readPlanMaxItems`）语义不可被默认值改动覆盖。

---

### R 轨：真实使用遥测（入场券，先行）

#### R1 调用遥测落盘

- **时限 0.5 天 | LOC ≤ +200 | 入场：无（立即可开工）**
- **目标**：生产 `java_impact` 每次调用记一行本地 JSONL 元数据。**不记源码内容、不记文件路径明文之外的仓库信息、不外发。**
- **改动范围**：
  - 新文件 `src/telemetry/impact-telemetry.ts` + `impact-telemetry.test.ts`。
  - 挂接点（已核实）：`src/mcp-server-factory.ts` 的 `track()` **只是注册名收集器，不是调用包装器，不能挂**。默认挂接点是同文件的 `register()`（`:199` 附近 `server.registerTool` 处）——在这里统一包一层 callback 计时即可覆盖全部四个工具；`java_impact` 记详单（需从 result 取 cost/metrics），其余三个工具只记 `{ts, tool, elapsedMs, ok}` 一行计数。若 `register()` 处拿不到解析后的 result 结构，备选挂接点：`src/tools/impact.ts` 的 `javaImpact()` 返回前（`withPhaseMs` 处已同时持有 result 与耗时）。两点择一，卡内自决。
- **明确不改**：`src/agent-router/**`、`src/tools/impact.ts` 的业务逻辑、任何输出字段。
- **JSONL 字段（详单）**：`ts`（ISO）、`tool`、`repoHash`（复用 index/manifest 现有 repoHash，取不到则 `sha1(repoRoot).slice(0,12)`）、`mode`、`verbosity`、`anchorsCount`、`readPlanItems`、`plannedSourceBytes`、`estimatedTokens`（取自 `result.cost`）、`elapsedMs`、`coldPath`（判据：`metrics.phaseMs` 含 hydrate/coldBuild 相关阶段则 true，取不到则按 `elapsedMs > 2000` 分桶并标注 `coldPathHeuristic: true`）、`error`（布尔）。
- **落盘设计**：
  - 目录：`JAVA_LSP_CACHE_BASE`（已有约定）下的 `telemetry/` 子目录；`JAVA_LSP_TELEMETRY_DIR` 可覆盖。
  - 文件按天：`impact-YYYYMMDD.jsonl`；模块初始化时删除 >30 天旧文件。
  - 写入：进程内数组缓冲 + 定时（5s）或缓冲满 50 条时 `fs.appendFile`；进程退出 flush；**任何写失败静默丢弃**（遥测绝不能影响主路径——参考现有 `JAVA_LSP_RESOURCE_TELEMETRY_FILE` 的处理方式，`scripts/sample-java-runtime-resources.mjs` 有先例）。
  - 开关：`JAVA_LSP_TELEMETRY=0` 完全关闭（默认开）。
- **验证**：T0；T1；identity 快检（输出必须逐字节不变）；本机 smoke——对本仓跑一次 `java_impact` 后确认 JSONL 出现且字段齐全；微基准确认单次记录开销 <1ms（在 test 里用 1000 次循环计时断言）。
- **退出**：门全过 → 合 main → 写 `docs/phase-r/r1-closeout.json` → **开始积累真实使用数据，同时 Q1 可并行开工**。
- **失败处置**：挂接点如与 `track()` 现实现冲突（如它是纯计数器不传结果），改为在 `src/tools/impact.ts` 的 `javaImpact()` 返回前挂（该函数在 `withPhaseMs` 处已能拿到 result 与耗时）；这是卡内默认值，不必询问。

#### R2 缺口画像报告

- **时限 0.5 天 | LOC ≤ +150（纯脚本）| 入场：R1 合 main 后累计 ≥14 天或 ≥200 条详单，二者先到即可**
- **目标**：新脚本 `scripts/report-usage-profile.mjs`（+ `.test.mjs`）聚合遥测 → `docs/phase-r/r2-usage-profile.md`。
- **报告必答的六个问题**（每题给出数字 + 直接裁决下游哪张卡入场）：
  1. 日均调用次数、mode/verbosity 分布 → 基线画像；
  2. estimatedTokens P50/P95 与长尾场景 → T 轨收口线的分母；
  3. 同 repoHash 下重复锚点（同 file+line）比例 → **>15% 则 T2 入场**；
  4. coldPath 周命中次数 → **≥1 次/周则 O 轨残差卡解冻，否则继续闲置**；
  5. readPlanItems 分布（是否经常打满上限）→ Q2 的旁证；
  6. error 率与失败模式 → 是否有未知缺口。
- **边界**：只读 JSONL，不改 `src/`；报告中不得出现源码片段。
- **退出**：报告入库 + 收口 JSON 写明每个下游入场条件的裁决结果（met / not met）。

---

### T 轨：更省 token（交互形状）

#### T1 三档出量 fold/preview/full

- **时限 1.5 天 | LOC ≤ +350 | 入场：R1 已合（无需等 R2）**
- **目标**：`java_impact` 新增可选参数 `detail`，默认 `full` = 现行为逐字节不变。
- **改动范围（按数据流顺序）**：
  1. `src/tools/impact.ts` 的 `impactSchema` 加 `detail: z.enum(["fold","preview","full"]).optional().default("full")`。**注意与既有 `verbosity`（compact/standard/diagnostic）正交**：`verbosity` 管诊断字段多少，`detail` 管 readPlan 内容形态；两者不得合并，schema 描述里写清分工。
  2. `src/agent-types.ts` 的 `ImpactOptions` 加 `detail` 字段并在 `javaImpact()` 透传。
  3. 成形层：`src/agent-router/output-compact.ts`（fold/preview 的裁剪在此做，不动 `read-plan.ts` 的选择逻辑——**选什么不变，只变回吐多少**）。
  4. 新文件 `src/agent-router/skeleton.ts` + test：preview 档的签名物化。
  5. `src/agent-router/output-v6.ts` 的 `withConvergedCostV6`：fold/preview 下 `estimatedTokens` 按裁剪后实际字节重算（readBytes 语义保持「计划让 Agent 读的量」，fold 档该值应为 0 或近 0）。
- **三档定义**：
  - `fold`：每个 readPlan 条目只保留 `{path, bucket, reason(一行), refId, lineCount}`，去掉 range 明细；目标单跳 ≤ full × 0.1。
  - `preview`：fold + 类型/方法签名骨架（类声明行、方法签名 `name(params): returnType`、注解名——全部从列式 facts 物化，`src/java-index/index-store.ts` 的现有 getter 取，**禁止新解析、禁止读源文件**；facts 缺失的条目降级为行号区间）。
  - `full`：现行为，逐字节不变。
- **refId**：`sha1(repoHash + "|" + path + "|" + startLine + "|" + endLine).slice(0,12)`，纯派生、无状态、跨进程稳定。
- **验证**：
  - T0（`output-shape.test.ts` 加 fold/preview 形状断言；`skeleton.test.ts` 覆盖 facts 缺失降级）；T1。
  - identity 快检：默认 `full` 路径改动前后逐字节 diff 为空——这是本卡最硬的门。
  - 新脚本 `scripts/measure-detail-tiers.mjs`：对三仓 tuning 场景（**不碰 holdout**）测「`fold`→`preview`→`full` 三跳累计 estimatedTokens vs 一次 `full`」，门：三跳累计 ≤ full × 1.15，fold 单跳 ≤ full × 0.1。
  - 收口时跑一次 T3 留档（默认路径 identity，理论上应全同；不同即 FAIL）。
- **失败处置**：骨架物化发现签名列不全（如泛型参数缺）→ 默认降级方案：preview 只给「方法名 + 起止行」不拼签名文本，门不变；仍不过 → 砍掉 preview 档只留 fold/full，收口写 PARTIAL。

#### T2 稳定引用 ID 与按需取回（expand）

- **时限 0.5 天 | LOC ≤ +150 | 入场：R2 裁决「重复锚点/重复读取 >15%」为 met**
- **目标**：配合宿主 Agent 的 tool-result clearing——旧结果被清后凭 refId 重取，无需重新完整分析。
- **设计（默认选无状态方案，禁止引入会话缓存）**：`impactSchema` 加 `expand: z.array(z.string().length(12)).max(30).optional()`；带 `expand` 的请求正常走分析，但输出**只含**命中 refId 的条目的 full 形态。refId 是纯派生的，同 anchors + 同 repo 状态下必然复现；repo 变更导致 range 漂移时 refId 自然失配，返回 `expandMisses: [id...]` 提示重新分析——**fail-closed，不做模糊匹配**。
- **验证**：T0（幂等：同请求跑两次输出一致；expand 条目与 full 模式对应条目逐字节一致；miss 路径返回 expandMisses）；T1；identity 快检（不带 expand 时不变）。
- **失败处置**：若「重分析再过滤」的耗时让 expand 失去意义（p95 无改善）→ 本卡定位改为纯「引用 ID 稳定性」交付（T1 已含 refId），expand 参数砍掉，收口写 PARTIAL 并在 final-panel 说明。

#### T3 开局仓库骨架（repo map）

- **时限 1 天 | LOC ≤ +300 | 入场：R2 显示会话首跳试探特征（同 repo 首次调用后 5 分钟内跟随 ≥2 次不同锚点调用的会话占比 >30%），或用户显式要求**
- **目标**：`java_status` 加可选 `map: z.boolean().optional().default(false)`；`map:true` 时附带 ≤1200 token 的仓库骨架。
- **改动范围**：`src/tools/status.ts`（schema + 出参）；新文件 `src/context-engine/repo-map.ts` + test。
- **骨架内容与算法（默认决策，不必调研）**：模块拓扑（`src/java-index/manifest.ts` 现成）+ 高中心性类型的签名行。中心性用**入度**（列式 edges 按目标类型计数，`src/java-index/index-store.ts` / `columnar/` 现成数据），**不实现 PageRank**——Aider 用 PageRank 是因为它无图存储，我们有真边，入度够用。预算装箱用 `src/context-engine/token-estimator.ts` 现成估算器，从高到低装到 1200 token 截断。
- **缓存**：随 snapshot 物化一次存内存，增量索引后失效重建；生成耗时门（热）≤200ms。
- **验证**：T0（预算门断言 ≤1200；`map:false` 出参逐字节不变）；T1；identity 快检。
- **失败处置**：入度中心性对多模块仓失真（全是 common 包）→ 默认第二方案：按 module 分组各取 top-K 再合并；再不行 FAIL 收口，等 X1 的 intent 数据再议。

---

### Q 轨：更准（三层矿按成本递增）

#### Q1 RANGE_MISS：方法级候选位置

- **时限 1 天 | LOC ≤ +250 | 入场：无（立即可开工，可与 R1 并行）**
- **背景更正（执行前必读）**：上一版计划写的 `collectTypeGraphCandidates`/`collectImportGraphCandidates` 两点已在后续提交改为 `hydrate:true`（`src/agent-router/candidate-collectors.ts:102,155` 现状）。当前生产链剩余的 `hydrate:false` 点是：
  - `src/agent-router/type-reference.ts:135`（`findTypeReferences`，type 引用候选）；
  - `src/agent-router/anchor.ts:133`（`findImplementers`，接口实现方向的锚点扩展）。
- **第一步（强制，产物先行）**：写一次性诊断脚本 `scripts/diagnose-range-miss.mjs`——对三仓 + ruoyi 的 **tuning** 场景统计 readPlan 中 top-of-file fallback range（起始行 1 且长度 ≤30 的假 range）出现次数，并按候选来源（type-reference / anchor-implementer / 其他）归因。产物 `docs/phase-q/q1-range-miss-attribution.json`。**没有这份归因禁止翻任何 hydrate 开关。**
- **第二步**：只对归因占比 ≥20% 的来源动刀。默认修法：该来源候选**进入 readPlan 前**（即选择层排名后、成形前）按需对 top-10 补 hydrate 拿真实方法级位置——不是把采集层全量翻成 `hydrate:true`（那是性能反模式）。
- **红线**：V3.2-27 证伪修法禁止；`hydrate` 补取必须有数量上限（10）与耗时上限（单场景 ≤200ms，超则截断保留假 range）。
- **验证**：T0；T1；T3 三仓（门：RangeLineRecall 三仓均不降、目标均值 +5pp；tokens P50 不升；p95Ratio ≤1.10）；ruoyi tuning 观察行（`run-f1-ruoyi-observation.mjs`）。
- **失败处置**：第一振——hydrate 上限收缩到 top-5；第二振——只对 must-hit 桶候选 hydrate；三振 FAIL 收口，把归因 JSON 留给 Q3 参考。

#### Q2 IN_POOL_EVICTED：规模自适应选择预算

- **时限 1.5 天 | LOC ≤ +300 | 入场：Q1 已收口（GO 或 FAIL 均可，但归因产物必须存在）**
- **第一步（强制，产物先行）**：写 `scripts/diagnose-eviction.mjs`——对三仓 + ruoyi 的 tuning 场景，记录每个「进池但未进 readPlan」的 must 文件被淘汰瞬间的 binding 约束（`maxFiles` 打满？`maxReadBytes` 打满？bucket 配额打满？排名分不够？），输出分布到 `docs/phase-q/q2-eviction-attribution.json`。改锚点：`src/agent-router/read-plan.ts`（BUCKET_RULES 与装箱主循环）、`src/agent-router/read-plan-budget.ts`。**产物未出禁止改任何预算旋钮。**
- **第二步**：只调 binding 占比最高的那一个旋钮，且**条件化**：模块数真源是 `src/repo-layout.ts` 的模块识别逻辑（先读它确认取法；若无现成计数则用默认退化口径「repoRoot 下含 `pom.xml`/`build.gradle` 的一级子目录数」，卡内自决），仅 `moduleCount ≥ 8`（ruoyi 量级，默认阈值）时放宽对应上限一档；小仓路径必须逐字节 identity。
- **红线**：全局默认值不动；显式 `readPlanMaxItems` 参数语义不动；一次只动一个旋钮（第二个旋钮 = 第二张卡，重新走门）。
- **验证**：T0；T1；identity 快检（本仓 <8 模块，应逐字节不变）；T3 三仓非劣（四门全过）；ruoyi tuning pRead/rReadMust 需提升（门：pRead ≥ 0.345 或 rReadMust ≥ 0.614 至少其一，即不再倒挂旧 main 的一半）；LORO 四折跑一次留档（观察，不设门——G2 教训：LORO 是评估器不是调参器）。
- **失败处置**：第一振换旋钮前必须先重看归因 JSON；三振 FAIL → ruoyi 缺口正式归入 Q3 的发现层问题。

#### Q3 NOT_IN_POOL：发现层补池（条件卡）

- **时限 spike 0.5 天 + 实施 2 天 | LOC ≤ +500 | 入场：Q1+Q2 均已收口，且 ruoyi rReadMust 仍 <0.614，且 R2 报告第 6 题显示真实使用存在「找不到」类缺口**
- **Spike（先做，产物定路线）**：`scripts/spike-q3-coverage.mjs` 对 B0 归因清单（`docs/phase-b/` 下 ruoyi 的 NOT_IN_POOL 文件列表）逐文件静态判定：「配置绑定边 / enum 用例边 / DI 接线边三类新边中的哪一类能把它带入候选池」。产物 `docs/phase-q/q3-spike-coverage.json`。
  - **择路默认值**：三类边合计覆盖 ≥60% → 走 Q3a；<60% → 对 ruoyi 跑一次 scip-java（Docker，`ghcr.io` 镜像）测构建+索引时长与产物可用性，写入 spike 产物后**停下向用户汇报择路**（Q3b 引入外部工具链，属于协议级变更）。
- **Q3a 实施**：
  - 改动范围：`src/java-index/ast-extractor.ts`（注解/enum 常量提取，先确认现有提取覆盖）、`src/java-index/edge-builder.ts`（新边类型三种，枚举值命名跟随现有 StaticEdge 风格）、`src/java-index/framework-index-view.ts`（Spring 注解已有处理，优先复用）。
  - **注意**：新边类型意味着列式快照 schema 变更 → 必须 bump snapshot schemaVersion（旧快照自动失效重建），走 `src/java-index/columnar/` 现有版本升级路径；这会触发一次全量冷建，索引期预算门必须复测。
- **验证**：T0；T1；索引期预算门（对 lishuedu 跑 `scripts/run-java-runtime-resource-benchmark.mjs` 同款口径：冷建时长与 child RSS 峰值回退均 ≤10%）；T3 三仓非劣；ruoyi tuning 分数；LORO 留档。
- **失败处置**：新边导致池膨胀挤爆选择层（tokens 上升）→ 新边候选默认只进「补池不占预算」的 must-hit 检查路径，不直接抢 readPlan 席位（实现为新边候选权重打折，默认 0.5）；三振 FAIL → 把 ruoyi 缺口正式登记为「架构外问题」（需编译器级索引），归档待 Q3b 立项。

---

### X 轨：探索（均带严格入场条件）

#### X1 任务类别自适应出量路由

- **时限 2 天 | LOC ≤ +300 | 入场：T1 已合 main，且 R2 报告已出**
- **背景事实（执行前必读）**：`impactSchema` 目前**没有** `intent` 参数（JIN 的 intent enum 在 `src/context-engine/intent-types.ts`，只在内部图链路用）。本卡把它引到公开参数面。
- **目标**：吸收 arXiv 2608.13568 的结论——定位类任务默认省着给，引用完整性类且词法歧义高才全量给。
- **改动范围**：
  1. `src/tools/impact.ts`：加 `intent: z.enum(INTENTS).optional()`，直接 import `src/context-engine/intent-types.ts` 的冻结 9 值枚举（`IMPLEMENTATION_CHANGE` / `DOWNSTREAM_BEHAVIOR` / `UPSTREAM_IMPACT` / `CONTRACT_CHANGE` / `PERSISTENCE_FLOW` / `DATAFLOW_TRACE` / `FRAMEWORK_WIRING` / `TEST_PLANNING` / `DIAGNOSTIC_ONLY`），**不发明新值**（加值需按 JIN 0A.4(4b) 修订手册）。
  2. 路由逻辑（新文件 `src/agent-router/detail-router.ts` + test）：**只决定 detail 档位的默认值**，预注册映射表（卡内默认，改表 = 重跑 replay 门）：
     - 未传 `intent` 或开关关 → `full`（现行为）；
     - `DIAGNOSTIC_ONLY` / `TEST_PLANNING` / `IMPLEMENTATION_CHANGE`（定位为主）→ `fold`；
     - `DOWNSTREAM_BEHAVIOR` / `UPSTREAM_IMPACT` / `CONTRACT_CHANGE`（引用完整性为主）且词法歧义度 ≥3（判据：候选池内同 simpleName 的类型数，`src/agent-router/candidate-helpers.ts` 现有数据可取）→ `full`；歧义度 <3 → `preview`；
     - `PERSISTENCE_FLOW` / `DATAFLOW_TRACE` / `FRAMEWORK_WIRING`（跨层追踪）→ `preview`；
     - **显式传 `detail` 永远压过路由。**
  3. 开关 `JAVA_LSP_ADAPTIVE_DETAIL`（unset/0 = 关，默认关）。
- **红线**：路由只碰出量档位；排序、选择、预算逻辑一行不改。不加新工具。
- **验证**：T0；T1；identity 快检（开关关 = 逐字节不变）；新脚本 `scripts/replay-adaptive-detail.mjs` 在三仓 tuning 场景上对比开关开/关的 token 与 must 覆盖（门：token P50 降 ≥20% 且 mustHitFileCoverage 不降——fold 档的覆盖按「refId 列表命中」口径计）。
- **退出**：门过 → 合 main（默认关）→ 真实使用开着遥测对照 2 周 → R 轨数据支持则另开小卡把默认翻开。
- **失败处置**：覆盖口径争议（fold 不给 range 算不算命中）按预注册口径执行不重开辩论；三振 FAIL → 开关及路由代码整体 revert，只保留 intent 参数透传（为遥测积累任务类别分布，本身零行为影响）。

#### X2 符号级编辑（远期登记，不排期）

- Serena 证明写侧有对等 token 收益（`replace_symbol_body` 免旧文本、免行号），但超出本项目「检索服务」定位且宿主编辑器已覆盖大半。**入场条件**：真实使用出现可归因于「行号漂移/整文件重写」的编辑失败证据，且用户显式立项。未满足前不建卡、不写代码。

---

### 4.9 执行顺序快照（依赖图）

```
立即可开工：R1、Q1（互不依赖，可并行）
R1 合并后：T1
R1 + 14天/200条：R2
R2 之后（按裁决）：T2、T3、O 残差解冻与否
Q1 收口后：Q2
Q1+Q2 收口且条件满足：Q3（spike 先行）
T1 + R2 之后：X1
每卡收口即合 main，全轨收口条件见 §3 止损线
```

---

## 5. 数字门汇总

| 门 | 值 | 属卡 |
|---|---|---|
| 遥测单次开销 | < 1ms（测试内 1000 次循环断言） | R1 |
| 默认路径 identity | `benchmark:agent-impact` 前后逐字节 diff 为空 | R1/T1/T2/T3/X1 |
| fold 单跳 | ≤ full × 0.1 | T1 |
| fold→preview→full 三跳累计 | ≤ full × 1.15 | T1 |
| expand 幂等 | 同请求两次输出一致；条目与 full 逐字节一致 | T2 |
| 骨架预算 / 生成耗时 | ≤ 1200 token / 热 ≤ 200ms | T3 |
| RangeLineRecall | 三仓不降、目标均值 +5pp；tokens 不升；p95Ratio ≤ 1.10 | Q1 |
| hydrate 补取上限 | top-10 且单场景 ≤ 200ms | Q1 |
| ruoyi tuning 不再倒挂 | pRead ≥ 0.345 或 rReadMust ≥ 0.614 至少其一（Q2）；两项全达（Q 轨收口） | Q2/Q3 |
| 索引期预算 | 冷建时长 / child RSS 峰值回退均 ≤ 10% | Q3 |
| X1 replay | tuning token P50 降 ≥ 20% 且 mustHitFileCoverage 不降 | X1 |
| 三仓 holdout rReadMust | 均值 ≥ 0.75 | Q 轨收口 |
| 每任务总 token | 遥测口径 −30% vs 切换日 | T 轨收口 |
| 每次合并 | T0 + T1 必过；有 T3 产物的卡过 `adjudicate-f1-doors.mjs` 四门 | 全部 |

---

## 6. 风险与控制

| 风险 | 控制 |
|---|---|
| 重蹈 java_context 覆辙（新交互形状模型不会用） | 不加新工具；一切走 `java_impact` 可选参数且默认 identity；X1 默认关、遥测对照后才默认开 |
| 压缩过度反而涨总成本（社区 +67% 反例） | T1 三跳累计门 ≤1.15×；语义密度优先于字节数 |
| Q2 重蹈 V3.2-28 两轮 REJECT | 入场即复核 binding 约束；三仓非劣门前置；条件化生效 |
| Q3b 引入构建依赖拖垮索引期 | 先 spike 覆盖测试再择路；索引期预算门 10% |
| 遥测隐私 | 只记元数据不记源码；本地落盘不外发；一键关 |
| 生产在线回归 | 小步合并 + 每步 F1 四门 + merge 单点 revert |

---

## 7. 一句话总结

内存和热延迟已经打穿到底，token 还剩「交互形状」一整档（三档出量 + 可重取引用 + 开局骨架），准确率离天花板最远且三层矿（range 精度 → 池内挤出 → 发现缺口）都有明确修法；2026 社区共识（三模态混合 + 按任务类别自适应路由 + fold/preview/full 分层出量）与本项目三次 live 的血泪教训完全互证——下一周期用真实使用遥测当入场券，按 R→T/Q→X 的顺序小步合并，每步 F1 四门守生产，收口线：每任务 token −30%、holdout rReadMust ≥0.75、外部仓不再倒挂旧 main。
