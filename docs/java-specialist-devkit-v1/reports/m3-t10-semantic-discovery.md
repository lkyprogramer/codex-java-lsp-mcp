# T10 报告：可结束的语义发现实验（T10）— 四向结论

**里程碑：** M3
**结论：** **任务层 INCONCLUSIVE（三轮后端均无净收益/无伤害）→ 运行姿态 KEEP_EXTERNAL**；检索层明确正信号。产品默认线保持 A2 词法发现，dense 路线保留在独立实验包（外部可选），本里程碑**未向产品依赖树新增任何向量/模型依赖**。

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

## 证据 2：agent 层 A/B（12 pilot 任务 × 2 臂 × 3 repeat，三个后端各一轮）

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

### 轮 3：`codex/gpt-6-luna`（本地网关 127.0.0.1:3425，用户提供，reasoning_effort=max）

`/Users/luo/Documents/github/java-devkit-v1-runs/m3/agent-luna2/results-pack.json`（首跑因本地网关上游 Codex OAuth 会话闪断产生 21 例 502 FAILED_RUNTIME，加长退避重试窗口后全量复跑 0 例；72 runs，两臂各 24 MEASURED）

| 臂 | measured | successes | rate |
|---|---|---|---|
| A2 lexical | 24 | 11 | 0.458 |
| A3 +dense hints | 24 | 10 | 0.417 |

逐任务：MYBATIS-01/02、GSON-03 两臂均 3/3（强模型兑现了检索层修复）；唯一任务级差异 PETCLINIC-02（A2 2/3 vs A3 1/3，−1，3 重复噪声级）。

**这轮解除了轮 1 的混淆**：强判官下模型能力不再是瓶颈（两臂成功率都到了 0.42–0.46，GSON-03/MYBATIS 全部兑现），任务层差异仍然≈ 0——dense 的贡献在任务层被干净地测量为**无净收益、也无伤害**。

## 四向判定（docs/10 决策节，三轮后端）

三轮后端汇总（任务层）：轮 1（27B）A2 9/24 vs A3 7/24；轮 2（space-bunny）4/22 vs 5/22；轮 3（GPT-6-Luna max）11/24 vs 10/24。方向 −2/+1/−1，全部在 3 重复采样噪声范围内；检索层（模型无关）恒为 +0.083 机制收益。

- **GO_OPTIONAL**：要求"质量/任务收益明确"。检索层收益明确；但任务层在**强判官下也被干净测得无净收益**（轮 3 解除了轮 1 的后端能力混淆）→ **不满足**。
- **NO_GO**：要求"收益不足或代价/误导显著"。检索层有可复现正收益且零回退；三轮均无误导证据（GSON-03 两轮的失败类型与词法臂相同，提示本身正确指向 gold 行）；代价极小（免费 API、无产品依赖）→ **不满足**（不能因为任务层无增益就否定检索层已验证的收益）。
- **KEEP_EXTERNAL**：要求"独立工具足够好，内部融合无净收益"。三轮证实外部提示块不伤 A2 主线（无系统性回退）、内部融合（进产品任务回路）无任务层净收益 → **成立，为本实验的最终运行姿态**。
- **INCONCLUSIVE**：适用于"产品是否应内建 dense 层"这一子问题——任务层三轮均未达"明确"标准，样本仍为 12 任务×3 重复；但结合检索层正信号与 KEEP_EXTERNAL 姿态，实验整体已可结束。

**最终判定**：**KEEP_EXTERNAL（运行姿态）+ 任务层内建问题 INCONCLUSIVE**：三轮后端（含强判官）无任务层净收益、也无伤害；检索层机制收益真实。docs/10"连续两轮无新可解释净收益即结束分支"条件早已满足（轮 2 即已满足，轮 3 为强判官确认轮）→ **分支关闭**。

**运行姿态**（实验关闭后的工程决定）：产品默认线 = A2 词法发现；dense 保留为独立实验/外部工具选项（`experiments/semantic-discovery/`），**无产品钩子、无新增依赖**；强判官下若未来在更大任务集（>12 任务、更多重复）上重开并出现明确净收益，再按 GO_OPTIONAL 流程重开。

## 负对照与成本分账（docs/10 实验控制）

- exact/anchor 负对照：24 个 dev 任务 query 全部为 text intent（跨语言任务集），运行中 exact 负对照 0 例；exact/anchor 不发 embedding 的行为由离线单测锁死（Z2 门控测试 3/4）
- 建库成本（115 embeddings / 37.8s）与查询成本（24 queries / 21.8s，复跑）分列于 results pack `embedding` 与 `corpusCosts` 字段，未混入 warm 检索耗时
- 模型下载：0（远程 API）；向量库：0（进程内余弦，语料规模 ≤15 声明/语料）

## 未测项

- 更大任务集/更多重复的任务层 A/B（12 任务×3 重复对 ±1 量级的效应量不足）
- 全公开语料规模下的向量库吞吐与建库摊销（需要 `--allow-network` 语料下载）
- K14/K18/K27 中"运行态 provider 心跳/索引失效检测"项：离线契约已锁，真实 provider 的在线心跳 NOT_RUN

## 产物清单

- `experiments/semantic-discovery/`：`provider.mjs`（EmbeddingProvider/DenseDiscoveryIndex/discoveryHint）、`gate.mjs`（Z2 门控）、`semantic-discovery.test.mjs`（8 离线 + 1 可选 E2E）、`compare.mjs`（检索层 A/B）、`agent-ab.mjs`（agent 层 A/B）、`package.json`
- `docs/java-specialist-devkit-v1/configs/experiment.json`：用户授权记录 + embedding provider 身份
- 运行产物（仓库外）：`/Users/luo/Documents/github/java-devkit-v1-runs/m3/`（retrieval-comparison/、agent-full2/、openrouter.env.json 凭据——不进产品仓库）
## 终局增补：三 provider 对照与 docs/14 双缺口关闭（M3 closure）

预注册 provider（lfm-2.5:free，1024 维）的 OpenRouter 免费档是**账户级 50 请求/天**，full profile 建库中途击穿（429），用户先后追加授权两个替代 provider。维度自适应 + 按 model 键控的磁盘缓存保证三轮互不污染；每条 hint/结果包带 provider 身份，**跨 provider 数字不可混比**。

| provider | 维度 | 额度 | 覆盖 |
|---|---|---|---|
| liquid/lfm-2.5-embedding-350m:free（预注册） | 1024 | 50 请求/天 | scoped 检索 A/B + 任务 A/B 轮 1–3 + full 6/12 语料 |
| nvidia/nemotron-3-embed-1b:free（追加） | 2048 | 同上（账户级共享） | repair 矩阵 48 runs + full 9/12 语料 |
| Qwen/Qwen3-VL-Embedding-8B @ SiliconFlow（追加） | 4096 | 无日墙 | **full 12/12 + repair 矩阵 48 runs（终局口径）** |

### Full public corpus（external-full profile，12/12 dense，SiliconFlow 轮）
- 语料：`hydrate-public`（git 固定 SHA 浅 fetch + seed SHA-256 校验，网络已授权），1725 文件；大语料声明量 mybatis 1042 / gson 664 / hikari 488
- **micro：A2 0.5741 → A3 0.6250（+0.0509）**；净增益：notifications +0.333、admissions +0.167、pricing +0.111；其余持平，零回归
- 负对照：36 条文本查询嵌入、exact 0 泄漏；API 190 次调用、0 错误、无模型下载
- 证据：`/Users/luo/Documents/github/java-devkit-v1-runs/m3/retrieval-full-final/`
- **docs/14 "full public corpus 独立 profile 运行" 关闭**

### Repair 轨道（P 轨）从 UNMEASURED → MEASURED
- 冻结判定器 `repair-judge.mjs`（docs/07）：allowed_edits 文件哈希越权拒绝、干净 fixture + 候选叠加、外部 FrozenJudgeRunner 在冻结测试 main 正常返回后写回执、`javac -proc:none --release 8`；离线 RED→GREEN 20/20（8 基线原工程必败 + reference 补丁必过 + 越权必拒，真实 javac/java）
- 矩阵：8 任务 × 2 臂 × 3 重复 = 48 runs（GPT-6-Luna 执行，luna 判官 + 冻结测试双轨；write_file 工具两臂对称；每 run 独立候选拷贝 + 工具追踪）
- **结果：A2 0/24、A3 0/24（dev 0/15+0/15，locked 0/9+0/9）；nemotron 轮与 siliconflow 轮完全一致**
- 归因（工具追踪为证）：非 harness——java_symbol 全部成功、模型确实读对了 gold 文件；是模型行为——读完后拒绝提交修改（"无法安全修复"），唯一一次真实写入（PRICING-03 a3 r2 改 MoneyPolicy.java）改错并被判定器正确判 COMPILE_FAILED。检索/dense hint 不是 repair 的瓶颈
- 证据：`/Users/luo/Documents/github/java-devkit-v1-runs/m3/repair-dev|repair-locked/`（siliconflow 轮为终局口径）
- **docs/14 "实际 Agent QA/repair" 关闭（repair 以诚实的零关闭）**

### 四向判定不变
provider 更替不改变实验结论：KEEP_EXTERNAL 为运行姿态（外部独立实验包，产品零钩子），任务层内建 dense 的 INCONCLUSIVE 维持。SiliconFlow 终局轮的检索层 +0.051（12/12 语料）进一步支持"外部 dense 有真实机制收益、无回归"。
