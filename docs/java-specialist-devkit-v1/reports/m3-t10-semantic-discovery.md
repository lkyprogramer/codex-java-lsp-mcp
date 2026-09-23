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

## 证据 2：agent 层 A/B（12 pilot 任务 × 2 臂 × 3 repeat = 72 runs，全部 MEASURED）

`/Users/luo/Documents/github/java-devkit-v1-runs/m3/agent-full2/results-pack.json`（首跑因端点偶发 429 产生 30 例 FAILED_RUNTIME，加有限退避后复跑 0 例，复跑为判定依据）

| 臂 | measured | successes | rate |
|---|---|---|---|
| A2 lexical | 24 | 9 | 0.375 |
| A3 +dense hints | 24 | 7 | 0.292 |

逐任务：PETCLINIC-02 / MYBATIS-02 两臂均 3/3；其余 9 个任务两臂均 0/3（与 M2 全矩阵一致）；唯一任务级差异 = GSON-03（A2 3/3，A3 1/3，−2）。

**关键交叉证据**：GSON-03 的 A3 失败答案是 `first: "_someField"`（gold `"_SomeField"`）——dense 提示**正确指向了 gold 文件与行**（hints 全在 FieldNamingPolicy.java），模型读到了正确代码仍构造出错误事实值；失败类型与 A2 的 WRONG_ANSWER 相同（模型能力），不是发现层误导。同时 M2 已证明 PAYMENTS-01 检索 recall=1.0 时 27B agent 仍 0/3：**该后端的任务成功率被模型能力封顶，agent 层 A/B 在本后端无法把 dense 贡献从模型噪声中分离出来**。

## 四向判定（docs/10 决策节）

- **GO_OPTIONAL**：要求"质量/任务收益明确"。检索层收益明确，但任务收益在 27B 后端不可分离且 GSON-03 出现 −2 波动 → **不满足**。
- **NO_GO**：要求"收益不足或代价/误导显著"。检索层有可复现正收益、零回退；误导证据仅 n=3 内 2 例且失败类型与词法臂相同 → **不满足**。
- **KEEP_EXTERNAL**：要求"独立工具足够好，内部融合无净收益"。部分成立（外部提示块确实不伤 A2 主线），但"足够好"未确立 → 不完全满足。
- **INCONCLUSIVE**：样本 12 任务 × 3 重复、单一 27B 后端、单一 embedding 模型；任务层方差被后端能力噪声主导 → **满足，且是四项中唯一与证据严格一致的判定**。

**运行姿态**（实验关闭后的工程决定）：产品默认线 = A2 词法发现；dense 保留为独立实验/外部工具选项（`experiments/semantic-discovery/`），**无产品钩子、无新增依赖**；若后续用强模型后端重跑 agent A/B 且 A3 出现可解释净收益，再按 GO_OPTIONAL 流程重开。按 docs/10 "连续两轮无新可解释净收益即结束分支"：本分支已做一轮干净对照，agent 层无净收益信号，**该效果分支就此关闭**，保留本报告。

## 负对照与成本分账（docs/10 实验控制）

- exact/anchor 负对照：24 个 dev 任务 query 全部为 text intent（跨语言任务集），运行中 exact 负对照 0 例；exact/anchor 不发 embedding 的行为由离线单测锁死（Z2 门控测试 3/4）
- 建库成本（115 embeddings / 37.8s）与查询成本（24 queries / 21.8s，复跑）分列于 results pack `embedding` 与 `corpusCosts` 字段，未混入 warm 检索耗时
- 模型下载：0（远程 API）；向量库：0（进程内余弦，语料规模 ≤15 声明/语料）

## 未测项

- 强模型后端（GPT/Claude 级）下的 agent 层 A/B —— 需额外授权与预算
- 第二轮 embedding 模型（多语言模型）对照
- 全公开语料规模下的向量库吞吐与建库摊销（需要 `--allow-network` 语料下载）
- K14/K18/K27 中"运行态 provider 心跳/索引失效检测"项：离线契约已锁，真实 provider 的在线心跳 NOT_RUN

## 产物清单

- `experiments/semantic-discovery/`：`provider.mjs`（EmbeddingProvider/DenseDiscoveryIndex/discoveryHint）、`gate.mjs`（Z2 门控）、`semantic-discovery.test.mjs`（8 离线 + 1 可选 E2E）、`compare.mjs`（检索层 A/B）、`agent-ab.mjs`（agent 层 A/B）、`package.json`
- `docs/java-specialist-devkit-v1/configs/experiment.json`：用户授权记录 + embedding provider 身份
- 运行产物（仓库外）：`/Users/luo/Documents/github/java-devkit-v1-runs/m3/`（retrieval-comparison/、agent-full2/、openrouter.env.json 凭据——不进产品仓库）