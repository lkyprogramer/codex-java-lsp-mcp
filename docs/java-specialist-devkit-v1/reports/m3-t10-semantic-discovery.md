# T10 报告：可结束的语义发现实验（T10）— 四向结论

**里程碑：** M3
**结论：** **INCONCLUSIVE**（agent 层任务收益）+ **检索层明确正信号**；运行姿态 = **KEEP_EXTERNAL 式**：产品默认线保持 A2 词法发现，dense 路线保留在独立实验包（外部可选），本里程碑**未向产品依赖树新增任何向量/模型依赖**。

## 实验设置（对齐 docs/10 的阶段 Z0–Z2）

- **stock 外部向量路线**：文档指定的 `zvec` npm 包在 registry 上不存在（404）；按"执行前核实包导出/模型身份"纪律，改用用户显式授权的外部 embedding 端点：**OpenRouter `liquid/lfm-2.5-embedding-350m:free`**（1024 维、批量、免费；身份已核实：`/v1/embeddings` 单条+批量+usage 全通）。此偏差如实记录，模型身份锁定在 `providerIndexIdentity`（`openrouter:liquid/...:dim1024:<corpus>`）。
- **独立 package**：`experiments/semantic-discovery/`（自有 package.json，零产品依赖；仅复用冻结的 harness scripts 做 agent 回路，复用产品 `dist/server.js` 生产路径做 A2 臂）。
- **对齐表示**（docs/10 归因前提）：dense 索引与 A2 共用产品 SQL 索引里的同一批 SearchDocument 文本面（signature/comment/framework 文档按声明归并），lexical/dense 在同一文档集上比较。
- **Z1 契约**：提示只带 `provider/path/ranges/rank/providerIndexIdentity/indexedContentHash`，authority 恒为 `DISCOVERY_HINT`；hash 与磁盘对不上 → 降级为 path-only（调用方必须重读重定位，不承认旧行号）。
- **Z2 门控**：exact/已知 anchor 不发 embedding；provider 故障/超时/未授权安静回退 A2，有限退避、无重试风暴。离线 fake 单测 8/8 覆盖（`semantic-discovery.test.mjs`），真实端点 E2E 1/1。
- **预算等同**：两臂同模型（`openclaw/Qwen3.8-27B-WORK`）、同 system prompt、同 tools（java_symbol+read）、同 16 轮预算、同 nudge/forced-answer 机制；A3 唯一差异 = 任务文本追加 precomputed 外部提示块。

## 证据 1：检索层 A/B（24 dev 任务 × 8 语料，A2=生产 `java_symbol`，A3=A2+top-8 dense 提示）

`/Users/luo/Documents/github/java-devkit-v1-runs/m3/retrieval-comparison/results-pack.json`

- micro recall：**A2 0.694 → A3 0.778**（+0.083）
- 逐语料：inventory **+0.444**（0.444→0.889）、payments +0.111、pricing +0.111；access/admissions/petclinic/mybatis/gson ±0
- 4 个任务纯增益（INVENTORY-01 0→1.0、INVENTORY-02 0.33→0.67、PAYMENTS-02 0→0.33、PRICING-02 0.67→1.0），**零检索层回退**
- 增益全部发生在**中文跨语言任务**（词法原理不可达，正是 dense 的设计目标场景）
- 成本总账：建库 115 条 embedding / 52 次 HTTP / 37.8s（8 语料全部）；查询侧 24 次任务 query embed

## 证据 2：agent 层 A/B（12 pilot 任务 × 2 臂 × 3 repeat，两个后端各一轮）

### 轮 1：`openclaw/Qwen3.8-27B-WORK`（M2 同一后端）

`/Users/luo/Documents/github/java-devkit-v1-runs/m3/agent-full2/results-pack.json`（首跑因端点偶发 429 产生 30 例 FAILED_RUNTIME，加有限退避后复跑 0 例，复跑为判定依据）

| 臂 | measured | successes | rate |
|---|---|---|---|
| A2 lexical | 24 | 9 | 0.375 |
| A3 +dense hints | 24 | 7 | 0.292 |

逐任务：PETCLINIC-02 / MYBATIS-02 两臂均 3/3；其余 9 个任务两臂均 0/3（与 M2 全矩阵一致）；唯一任务级差异 = GSON-03（A2 3/3，A3 1/3，−2）。

**关键交叉证据**：GSON-03 的 A3 失败答案是 `first: "_someField"`（gold `"_SomeField"`）——dense 提示**正确指向了 gold 文件与行**（hints 全在 FieldNamingPolicy.java），模型读到了正确代码仍构造出错误事实值；失败类型与 A2 的 WRONG_ANSWER 相同（模型能力），不是发现层误导。同时 M2 已证明 PAYMENTS-01 检索 recall=1.0 时 27B agent 仍 0/3：**该后端的任务成功率被模型能力封顶，agent 层 A/B 在本后端无法把 dense 贡献从模型噪声中分离出来**。

### 轮 2：`stealth/space-bunny-alpha`（OpenRouter，用户提供，零成本）

`/Users/luo/Documents/github/java-devkit-v1-runs/m3/agent-full3/results-pack.json`（72 runs 全部 MEASURED，0 FAILED_RUNTIME；兼容性已验证：tool_calls / usage / max_tokens≤32K）

| 臂 | measured | successes | rate |
|---|---|---|---|
| A2 lexical | 22 | 4 | 0.182 |
| A3 +dense hints | 22 | 5 | 0.227 |

逐任务差异：PETCLINIC-02 +1、MYBATIS-01 +1、GSON-03 −1（净 +1）。该后端仍非 GPT-4 级（PAYMENTS-01 仍答 `contains`/`Set`、GSON-03 仍答 `_someField`），任务层方差依然主导；但**方向与检索层一致（A3 ≥ A2）**，且 A2 臂 INVENTORY-02 出现真实发现层失败（"未能定位：仓库检索未返回任何声明"）——A3 的 dense 提示在检索层已修复该任务的 recall（0.33→0.67），agent 层未完全兑现。

## 四向判定（docs/10 决策节，两轮后端）

- **GO_OPTIONAL**：要求"质量/任务收益明确"。检索层收益明确且两轮一致；任务层轮 1 无净收益（−2，27B 噪声主导）、轮 2 小正信号（+1，方差仍大于效应）→ **不满足"明确"**。
- **NO_GO**：要求"收益不足或代价/误导显著"。检索层有可复现正收益、零回退；两轮误导证据均不成立（GSON-03 两轮的失败类型与词法臂相同，提示本身正确指向 gold 行）→ **不满足**。
- **KEEP_EXTERNAL**：要求"独立工具足够好，内部融合无净收益"。外部提示块未伤 A2 主线（两轮均无系统性回退），但"足够好"仍未确立 → 部分成立。
- **INCONCLUSIVE**：两个后端（27B / space-bunny，均为开放权重中端）下的任务层方差都大于 dense 效应；GPT-4 级后端的对照未授权 → **维持判定**。两轮均已执行（docs/10 的"连续两轮"条件满足）：无新的**可解释**任务层净收益 → **分支关闭**。

**运行姿态**（实验关闭后的工程决定）：产品默认线 = A2 词法发现；dense 保留为独立实验/外部工具选项（`experiments/semantic-discovery/`），**无产品钩子、无新增依赖**；若后续授权 GPT-4/Claude 级后端重跑同 72 行 A/B 且 A3 出现明确净收益，再按 GO_OPTIONAL 流程重开。

## 负对照与成本分账（docs/10 实验控制）

- exact/anchor 负对照：24 个 dev 任务 query 全部为 text intent（跨语言任务集），运行中 exact 负对照 0 例；exact/anchor 不发 embedding 的行为由离线单测锁死（Z2 门控测试 3/4）
- 建库成本（115 embeddings / 37.8s）与查询成本（24 queries / 21.8s，复跑）分列于 results pack `embedding` 与 `corpusCosts` 字段，未混入 warm 检索耗时
- 模型下载：0（远程 API）；向量库：0（进程内余弦，语料规模 ≤15 声明/语料）

## 未测项

- GPT-4/Claude 级后端的 agent 层 A/B —— 需额外授权（本轮两个开放权重中端后端均不足以把任务层方差压到效应量以下）
- 全公开语料规模下的向量库吞吐与建库摊销（需要 `--allow-network` 语料下载）
- K14/K18/K27 中"运行态 provider 心跳/索引失效检测"项：离线契约已锁，真实 provider 的在线心跳 NOT_RUN

## 产物清单

- `experiments/semantic-discovery/`：`provider.mjs`（EmbeddingProvider/DenseDiscoveryIndex/discoveryHint）、`gate.mjs`（Z2 门控）、`semantic-discovery.test.mjs`（8 离线 + 1 可选 E2E）、`compare.mjs`（检索层 A/B）、`agent-ab.mjs`（agent 层 A/B）、`package.json`
- `docs/java-specialist-devkit-v1/configs/experiment.json`：用户授权记录 + embedding provider 身份
- 运行产物（仓库外）：`/Users/luo/Documents/github/java-devkit-v1-runs/m3/`（retrieval-comparison/、agent-full2/、openrouter.env.json 凭据——不进产品仓库）