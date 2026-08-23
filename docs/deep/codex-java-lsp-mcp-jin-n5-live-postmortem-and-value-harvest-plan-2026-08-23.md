# JIN N5 live 双败尸检与全量收口计划（E/C/G/O → L1 → F 一次性替换 main）

- 日期：2026-08-23（R1 修订同日）
- 状态：**ADOPTED R1**。本文档是 N5 live 二次 FAIL 之后的行动真源；JIN 计划 §15 N6 条目由本文档正式作废。
- **R1 修订（2026-08-23，用户指示）**：
  1. 用户当前不急用生产链路。**合 `main` 从「尽早收割」改为「全部优化完成后一次性替换现有 LSP」**——中间任何阶段不合 main、不发布。
  2. §6 任务手册扩写到 AI 自主执行级：每张卡含目标、前置、范围、边界、开发要点、验证命令、退出条件、失败处置、决策默认值。执行 AI 不需要向用户请示本手册已覆盖的任何决策。
  3. L1 外呼授权：用户 2026-08-23 指示「自主完成所有开发测试验证」视为对 L1 双模型 live 的一次性授权。key 只从进程环境读取；环境无 key 时记 `BLOCKED_EXTERNAL` 等待，不得编造数字。
- 上游真源（其硬禁令全部继承）：
  - `docs/deep/codex-java-lsp-mcp-v5r-postmortem-and-java-intelligence-next-clean-slate-plan-2026-08-20.md`（JIN R1，0A 章）
  - `docs/deep/codex-java-lsp-mcp-memory-footprint-optimization-plan-2026-08-21.md`（M 轨，已收口）
- 证据基座：
  - `docs/phase-jin/jin-n5-02-live-summary.json`（2026-08-22 OpenRouter `stealth/ox-alpha`）
  - `docs/phase-jin/jin-phase-n5-20260821.md`（两次 live 并列记录）
  - `docs/phase-m/m6-5-memory.json`、`HANDOFF.md` M6-1～M6-5 节

---

## 0. 执行者必读

### 0.1 硬禁令（违反任何一条即本轮工作作废）

1. 不得发明 TaskSuccess；live 数字只能来自真实外呼。密钥不入库、不进产物 JSON、不进日志。
2. **全程不合 `main`**，直到 F 轨终卡（F3）通过。中间不发布、不打 release tag。
3. 生产 `java_impact` 默认链的 first-plan identity 是全程硬门：E/C/G/O 任何卡不得改变默认链的排序、选择、输出（T3 identity 验证）。C 轨只改 `java_context`。
4. 不得为 golden 过拟合。N4「不要再踩」清单继续有效（跨模块装箱、按方法拆 hop、全局 extraNames、type-header +1 等）。第四仓 holdout 冻结后不看不调参。
5. 隔离约束：所有会启动 Node worker/JavaIndex 的验证必须走 `sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs`，`JDTLS_BIN=/usr/bin/false`，`PATH=/opt/homebrew/bin` 在前。T3 输出目录必须不存在（已存在 exit 2）。
6. 修 harness（E 轨）与修工具（C 轨）分开提交、分开验证。同一次 live 里不得同时首次启用未经离线验证的评分口径和工具输出。
7. L1 只跑一次（双模型各一轮算同一次）。FAIL 即执行 kill 条款，**没有第四次 live**。
8. 门数值不放宽。达不到就按卡内失败处置记账（记录实测下限、降级、或 kill），不改门。
9. 三仓 load 政策不变：1 分钟 load < 20 必须跑 T3；≥ 20 只记录不拒绝。唯一主机硬门：可用内存 ≥ 4 GiB。

### 0.2 自主决策协议

- 本手册已给出决策默认值的事项：直接采用默认值执行，不请示。
- 手册未覆盖的实现分叉：选择「改动更小、更可回滚」的一侧，在收口 JSON 里记 `decision` 字段说明。
- 只有三类事项升级给用户：(a) 需要新的外呼授权范围（超出 L1 双模型 6 任务 × 2 臂）；(b) 不可逆破坏性操作；(c) 本文档门体系自相矛盾。
- 每张卡独立提交；收口 JSON 入对应 `docs/phase-{e,c,g,o,l,f}/`；全局进度面板 `docs/phase-f/final-panel.md`（F0 卡建立）每卡收口后更新一行。

### 0.3 现状地图（2026-08-22 收口时点）

- **M 轨全胜**：G1 173/29/46 MiB 全达标（起点 838/170/207）；G4 1534ms；S1/S2/S4 全过；T3 identity ×2 轮。内存问题关闭，不得以内存为由重开架构工程。
- **JIN 组件有价值的证据**：N0.5 紧凑合同 token −27.6/−28.3/−27.3%（质量 identity）；N3 图查询 mustHit 1.00/1.00/0.96、p95 20–37ms；实体入口 30/30 top-3；N2a 边 8/8 图可达。
- **JIN 失败的证据**：N4 装箱 RangeLineRecall FAIL（3/4 轴 PARTIAL）；N5 live 两次 FAIL（见 §1.2）。
- **branch**：全部工作在 `codex/jin-main`。`main` 仍是 V4-final 时代的链路。
- **goldens**：`/tmp/codex-java-v3-golden-20260809/{lishuedu,cipherlink,exam-parent-v3}`。第四仓 commit tasks 已提取：`docs/phase-jin/jin-commit-tasks-ruoyi-vue-pro.json`（pin `2bbe79b3`）。

---

## 1. 证据（收口数字）

### 1.1 M 轨（含 M6 极致收口）

| 门 | 结果 |
|---|---|
| G1 单仓热堆 | 173 / 29 / 46 MiB 全达标 |
| G4 快照可服务 | 1534ms ≤ 2000 GO |
| G5 稳态 warm p95 | 拆门后稳态 lishuedu 1.12（略超 1.10，残差 → O3） |
| S1/S2/S4 | GO / GO / 休眠 9 MiB·108ms GO |
| 残差 | child 冷建 RSS 2311 > 1536（→ O1）；resolveAll 46s 占冷建大头（→ O2） |

### 1.2 JIN N5 live 两次 MEASURED FAIL

| 轮 | 模型 | localization | tool rounds | tokens |
|---|---|---|---|---|
| 8/21 | `openclaw/Qwen3.8-27B-WORK`（有 502/503） | jin 1/5 = old 1/5 | 66 vs 26 | 197618 vs 25845 |
| 8/22 | `stealth/ox-alpha`（干净） | **jin 0/6 vs old 1/6** | 22 vs 29 | **43543 vs 25402** |

8/22 逐任务 jin 在 6/6 上覆盖 ≤ old（exam-score-export 6/13 vs 13/13、candidate-pay-order 2/12 vs 7/12 最大）。presign / pay-order 两条 V5R 遗留 false 未闭合。Serena 臂两轮 UNAVAILABLE。

---

## 2. 机制诊断（五条，均有代码级证据）

### D1 覆盖率口径结构性不对称——jin 的候选面没被计入

评分为 `taskSuccessFromCoverage(requiredContextFiles, observedPaths)` 全覆盖二值；`observedPaths` 由 `collectImpactPaths()`（`scripts/run-agent-trace-live.mjs:105-119`）统计 `files[] + readPlan[] + contexts[]` 路径。old 臂 `java_impact` 每次回吐宽候选面 `files[]`（十余条路径）+ `readPlan`；jin 臂 `java_context` 只回吐 2000-token 装箱后的 `contexts[]`（3–6 文件）。图搜索内部遍历到的宽 frontier（T2 replay 证明 MeQueryService/ClientReleaseMapper/PayAccount 都在候选集）**从未出现在输出中**。不是「图没找到」，是「找到了但没说」。

### D2 系统提示词压制导航

`ARM_SYSTEM_PROMPTS.jin`（`run-agent-trace-live.mjs:85-86`）："Prefer one search… Do not use mode=navigate unless…"。听话的 `ox-alpha` 平均 3.7 轮就停；不听话的 Qwen 多跳 66 轮反而拿到并列。两轮合并证明成绩由模型服从性决定，不是工具能力。JIN 的立身之本（多跳导航，V5R live 曾闭合 paper-task discovery gap）被 harness 亲手关掉。

### D3 java_context 输出超重

jin 单次调用均摊 prompt 1502 token（33038/22）vs old 634（18387/29），2.4×。`compactContextForModel` 每次携带 spans 逐条明细 + coverage + resolvedIntent + anchor 回显 + unresolved + next。装箱源码证据在「Agent 自己会读文件」的场景里是同一份码字付两次钱。

### D4 评分与样本量不支持二值裁决

全覆盖二值 + n=6：9/10 与 2/12 同记 false；old 自身跨模型从 4/6 → 1/5 → 1/6 漂移大于臂间差。但逐任务配对 hit-rate jin 6/6 全输是有效信号，主因即 D1–D3。

### D5 Serena 第三臂从未运行

15A.8 planner kill 判据依赖 C 臂，两轮均 `SERENA_MCP_COMMAND` 未设，判据悬空。

---

## 3. 判决与执行顺序

1. **N6 一次性切换（原语义：java_context 替代 java_impact）正式取消。**
2. **「JIN 组件无价值」不成立**（§0.3 证据）。失败的是「EvidenceBundle 装箱 + 一发流交互 + 不公平 harness」的组合。
3. **最终形态（F 轨交付物）**：`main` 上的新一代链路 = 现 `codex/jin-main` 的 N0/N0.5 紧凑合同 + M/M6 内存栈 + N2a/N3 图内核 + O 轨残差修复 + （L1 GO 时）重构后的 `java_context` 补充工具。`java_impact` 仍是默认工具；「替换现在的 LSP」指整条分支成果替换 `main` 旧链路，不指换默认工具。
4. **执行顺序**：

```
并行开工：E 轨（harness 公平）｜ C 轨（java_context 重构）｜ G 轨（第四仓评价基建）｜ O 轨（内存/冷建残差）
        ↓ E、C、G 全收口
L1 终局 live（双模型，一次性）
        ↓ GO → java_context 入包；FAIL → kill 后出包
F 轨：合并包组装 → 对比矩阵 → 一次性合 main 替换 + attestation + soak
```

5. **止损线**：L1 若 jin 配对 hit-rate 仍不优于 old → `java_context` 从公开工具面撤下（代码留分支），EvidenceBundle planner 封存，F 轨照常推进（不含 java_context）。没有第四次 live。

---

## 4. 数字门汇总

| 门 | 值 | 属卡 |
|---|---|---|
| T3 identity（默认链不动） | 三仓质量指标逐位相同 | E/C/O 各卡 |
| C 轨字节门 | java_context 首呼字节 P50 ≤ java_impact compact × 1.2 | C2 |
| C 轨离线覆盖门 | 6 holdout required ∈ candidates∪evidence ≥ 0.9 | C1/C3 |
| 工具 schema | java_context ≤ 700 token（`measure:tool-schema`） | C1 |
| G 轨过拟合门 | leave-one-repo-out 留出仓回撤 ≤ 15% | G2 |
| L1 配对门 | jin−old 逐任务 hit-rate 均值 ≥ 0 且 ≥4/6 任务不劣 | L1 |
| L1 token 门 | jin token/task ≤ old × 1.1 | L1 |
| O1 | child 冷建峰值 RSS ≤ 1536 MiB | O1 |
| O2 | lishuedu 冷建合计 ≤ 60s（现 77.6s） | O2 |
| O3 | G5 稳态三仓 ≤ 1.10 | O3 |
| F 对比门 | vs main：质量逐位不劣 + token P50 降幅 ≥ 20% + p95Ratio ≤ 1.10 | F1 |
| LOC | 各卡上限见 §6；F 轨合并不新增 | 全部 |

---

## 5. 测试分级（沿用 JIN T0–T4）

| 级 | 含义 | 本计划使用 |
|---|---|---|
| T0 | 定向单测（隔离 targeted profile） | 每张卡必跑 |
| T1 | 隔离全量 dist+scripts | C 轨每卡、O 轨每卡、F1 |
| T2 | 单链路 replay/smoke（不经模型、不烧三仓） | C1/C2/C3 覆盖门、E1 重放、G1 加载 smoke |
| T3 | 三仓（或四仓）cold 矩阵 | O 轨各卡收口、G2、F1；E/C 轨不烧 T3（不碰默认链，靠 T0/T2 + F1 兜底） |
| T4 | 真实模型外呼 | 仅 L1 |

---

## 6. 任务手册（AI 自主执行）

通用纪律：每卡独立提交，提交信息前缀 `feat(e1):` 式样；收口 JSON schema `{track}-{card}-closeout/v1`；失败按卡内处置记账后继续后续卡（除非标注「阻塞后续」）；每卡时间盒超出 2 倍预估时中断并记 `TIMEBOX_EXCEEDED`。

### E 轨：harness 公平性修复（全部零外呼）

#### E1 配对评分 + miss 归类（预估 0.5 天，LOC ≤ +250，harness 不计生产）

- **目标**：报表主指标从全覆盖二值改为逐任务配对 hit-rate；miss 文件逐个归类。
- **范围**：`scripts/run-agent-trace-live.mjs`、`scripts/run-agent-trace-matrix.mjs`、对应 test 文件。新报表 schema `java-intelligence-jin-n5-three-arm-trace/v2`。
- **边界**：不改 `src/`；v1 字段全部保留（新旧口径并报，防「为 jin 放水」质疑）。
- **开发要点**：
  1. `v2` 增加 `pairedHitRate`：逐任务 `{task, old: hit/required, jin: hit/required, delta}` 与均值、方向计数。
  2. miss 归类：对每个 required 缺失文件标 `IN_POOL_NOT_PACKED`（出现在 java_context candidates/frontier 内部但未输出——C1 落地前用 T2 replay 的候选集判断）/ `DISCOVERY_GAP`（两臂工具输出与内部候选集都没有）/ `SINGLE_ARM_MISS`。方法沿用 `docs/phase-v5r/v5r-phase4-holdout-oracle.json` 的口径。
  3. 两臂皆 `DISCOVERY_GAP` 的文件在 v2 里单列 `unreachableRequired[]`，主指标同时报「含」与「不含」两个版本。
- **验证**：T0（新增配对计算/归类单测）；T2 重放——用 8/22 scratch raw trace 离线重算出 v2 报表，v1 字段与已入库 summary 逐位一致（这是回归锚）。raw trace 若已被清理，改用 `jin-n5-02-live-summary.json` 的 cells 做降级锚并记 `REPLAY_DEGRADED`。
- **退出条件**：T0 全绿 + 重放锚一致。
- **失败处置**：重放不一致 → 修 harness 而不是改锚；两次修复仍不一致则记 `HARNESS_DRIFT` 并升级（0.2(c)）。

#### E2 提示词对称化（预估 0.2 天，LOC ≤ +50）

- **目标**：删除 jin 臂导航压制；两臂同构模板。
- **范围**：`ARM_SYSTEM_PROMPTS`（`run-agent-trace-live.mjs`）及其快照测试。
- **开发要点**：两臂统一为：「用 <tool> 探索该任务的影响面。若结果提示未覆盖的方向（unresolved / next / evidenceGaps），继续调用直到你能完整描述影响面，或到 8 轮上限。不要索要整文件，不要发明路径。」jin 版补一句 intent 必填说明。提示词全文与 SHA-256 写入 v2 报表。
- **验证**：T0 快照测试锁定两臂文本。
- **退出条件**：T0 全绿。
- **决策默认值**：轮上限维持 `MAX_LIVE_ROUNDS = 8` 不调。

#### E3 观测对等（预估 0.2 天，LOC ≤ +80；依赖 C1）

- **目标**：`collectImpactPaths` 统计 C1 新增的 `candidates[]` 与带路径的 `unresolved[]`。
- **边界**：只改 harness 采集，不改工具。
- **验证**：T0 单测覆盖新来源；构造 jin 假结果验证 candidates 路径进入 observed。
- **退出条件**：T0 全绿。

#### E4 Serena 臂 + 双模型接线（预估 0.5 天，LOC ≤ +120）

- **目标**：第三臂可用或正式废弃；L1 双模型参数化。
- **开发要点**：
  1. Serena 安装尝试**限两种方式**：`uvx --from git+https://github.com/oraios/serena serena-mcp-server` 与 pip 包（若存在）。任一成功 → 设 `SERENA_MCP_COMMAND`，跑 1 条任务 smoke（可用离线 mock 模型驱动一轮工具调用即可，不外呼）。两种都失败 → 收口 JSON 记 `SERENA_ABANDONED`，并把 kill 判据正式改为 old/jin 配对（写入本文档 §3.5 修订记录）。
  2. 双模型：`run-agent-trace-matrix.mjs` 支持 `--model-profile` 两档（`local-qwen`：`192.168.10.29:28343`；`openrouter`：`stealth/ox-alpha` 或环境指定），报表记录各自 host/model。
- **边界**：不外呼真实模型（smoke 用 mock）；Serena 二进制不入库。
- **验证**：T0 + smoke 日志。
- **退出条件**：Serena 二选一处置完成 + 双模型参数就绪。

### C 轨：java_context 形态重构

#### C1 candidates / evidence / next 分层输出（预估 1 天，LOC ≤ +300）

- **目标**：修 D1——把图搜索的宽候选面如实输出。
- **范围**：`src/tools/java-context.ts` 输出层与 schema；planner 内部把「frontier 可见集」透出为只读列表的最小接线。
- **边界**：**不改**图结构、候选生成、排序、装箱选择算法；**不改** `java_impact` 任何路径；不新增 worker 命令。
- **开发要点**：
  1. `candidates[]`：frontier top-N（**默认 N=24**）路径级条目 `{path, role, hop, reason}`，reason 一行短语（如 `CALLS←PayService.create`），不带 span、不带源码。
  2. `contexts[]` 改名 `evidence[]`（schema 版本号 +1），语义不变。
  3. `next[]` 强化：每条给可直接照抄的参数 `{action, file, line, direction?, closure?, reason}`。
  4. schema 重测：`npm run measure:tool-schema`，java_context ≤ 700 token。
- **验证**：T0；T1；T2 离线覆盖门——扩展 `scripts/run-jin-n5-context-replay.mjs` 断言 6 条 holdout 的 required 文件出现在 `candidates ∪ evidence` 的比例 **≥ 0.9**，结果入 `docs/phase-c/c1-replay.json`。
- **退出条件**：三级验证全过 + schema ≤ 700。
- **失败处置**：覆盖 < 0.9 → 先升 N（24→32，上限 40），仍不达则逐文件分析缺失属 `DISCOVERY_GAP` 的比例；若缺失全为 discovery gap（图里就没有），记实测下限并放行（这不是输出层的锅），在收口 JSON 里逐文件列名。
- **决策默认值**：N=24；role 枚举沿用图节点角色；不做分页。

#### C2 输出瘦身（预估 0.5 天，LOC ≤ +100；依赖 C1）

- **目标**：修 D3——单次返回字节可控。
- **开发要点**：spans 聚合为 `"12-48,60-75"` 区间串；删除 resolvedIntent / anchor 回显；unresolved 只留 `{path, role}`；evidence 默认最多 4 文件。
- **验证**：T0；T2 字节门——同锚点同任务对 6 条 holdout 测 java_context 首呼与 java_impact compact 首呼的序列化字节，P50 比值 ≤ **1.2**，入 `docs/phase-c/c2-bytes.json`。
- **失败处置**：超门先降 candidates N（24→16→12），再降 evidence 文件数（4→3→2），仍超则记实测下限放行并在 L1 风险栏标注。**不砍 candidates 层本身**（它是 D1 的修复，砍它等于回到失败形态）。

#### C3 装箱预算再定位（预估 0.5 天，LOC ≤ +60；依赖 C1/C2）

- **目标**：candidates 已披露后，evidence 收窄到 anchor 邻域最必要的 1–3 文件，单次返回 token 再降 ≥ 30%。
- **边界**：只改装箱条数/预算常量，不改选择算法。
- **验证**：T0；T2 重跑 C1 覆盖门（candidates 兜底后仍 ≥ 0.9）+ C2 字节门。
- **失败处置**：覆盖跌破 0.9 → evidence 回 4 文件，收口记 `C3_REVERTED`，不阻塞 L1。

### G 轨：评价基建（第四仓）

#### G1 第四仓 golden 冻结（预估 1 天，LOC ≤ +400，脚本/golden 不计生产）

- **目标**：`YunaiV/ruoyi-vue-pro`（pin `2bbe79b3`）生成并冻结 golden scenarios。
- **前置**：commit tasks 已在 `docs/phase-jin/jin-commit-tasks-ruoyi-vue-pro.json`。
- **开发要点**：
  1. 用 `scripts/generate-commit-tasks.mjs` 同链路推导 scenarios（mustHit 从 commit diff 推导，规则与三仓一致，不得手工挑选）。
  2. 规模：≥ 20 条，其中 ≥ 6 条标 `evaluationSplit: holdout`；tuning/holdout 切分用与三仓相同的确定性哈希规则。
  3. 冻结：golden jsonl + 生成参数 + SHA-256 入 `docs/phase-g/g1-golden-manifest.json`。**冻结后 holdout 不看内容、不调参**。
  4. 仓库检出到 `/tmp/codex-java-v4-golden-<date>/ruoyi-vue-pro`（detached，pin commit）。
- **验证**：T0（生成器已有测试通过）；T2 加载 smoke（golden 能被 benchmark 链加载、场景 anchor 文件存在于 pin 树）。
- **退出条件**：manifest 入库 + smoke GO。
- **失败处置**：mustHit 推导质量不足（如 >30% 场景的 mustHit 少于 2 文件或含生成噪声）→ 记 `G1_QUALITY_FAIL`，该仓降级为「仅 leave-one-repo-out 观察仓」，四仓门相应降为三仓 + 观察，不得硬凑场景。
- **决策默认值**：场景数取推导结果自然数量（20–40 之间截断到 40）；不为凑数放宽推导规则。

#### G2 leave-one-repo-out 矩阵（预估 0.5 天 + 机器时间，LOC 0；依赖 G1）

- **入口**：`scripts/leave-one-repo-out.mjs`（协议「不调参」）。四仓四折。
- **门**：留出仓 recall/pRead/rReadMust 相对其余仓均值回撤 ≤ **15%**。
- **验证**：T3 量级一次；结果入 `docs/phase-g/g2-loro.json`。
- **失败处置**：超 15% = 过拟合信号 → **阻塞 F 轨**，回溯 N4 各刀找过拟合来源（优先怀疑「不要再踩」清单里已知的装箱刀），修复后重跑一次；二次仍超 → 升级用户（0.2(c)，这说明链路对你的其他仓库可能无效，是方向性问题）。

### O 轨：残差优化（与 E/C/G 并行，均不碰默认链质量路径）

#### O1 child 冷建峰值 RSS（预估 1 天，LOC ≤ +200）

- **现状**：真实 child RSS 2311 MiB > 门 1536（M6-4）。child 已流式写段，但 resolve 阶段全量 facts 仍在内存。
- **开发要点**（按序尝试，任一达门即停）：
  1. child 内按 source-root 分批 resolve + 段落盘后释放（batch 边界用现有段结构）；
  2. `--max-old-space-size` 约束 + 显式 gc 点；
  3. 仍超则按两批子进程串行（parse 批 / resolve 批）。
- **边界**：不改快照 v4 格式（M 轨已冻结）；facts digest 必须与改前逐位一致。
- **验证**：T0 + T1；`sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node scripts/run-memory-benchmark.mjs` 复测三仓，child 峰值 ≤ 1536 且 digest 不变；T3 identity 一次。
- **失败处置**：三招用尽仍超 → 记实测下限，门保留 MISS 状态入 F1 风险栏（child 是隔离进程，超门不伤主进程，允许带残差合并）。

#### O2 冷建时长（预估 1 天，LOC ≤ +200；依赖 O1 收口）

- **现状**：lishuedu 真实冷建 77.6s（resolveAll 46.1s 大头，parse 19.4s）。门：≤ 60s。
- **开发要点**：resolveAll 内并行分片（child 内 worker pool，默认并行度 = min(4, 物理核/2)）；或增量 resolve 复用（type registry 按 source-root 分区）。选改动小的先测。
- **边界**：facts digest 逐位不变；确定性（同输入同输出）必须保持——digest 就是这个门。
- **验证**：同 O1 链路 + `docs/phase-o/o2-cold.json` 记三仓时长；T3 identity 一次。
- **失败处置**：并行化引入非确定性（digest 漂移）→ 立即回滚该刀，记 `O2_NONDETERMINISM`，改走增量复用路线；两条路都不达 → 记实测下限放行（冷建有快照兜底，属体验项非正确性项）。

#### O3 G5 稳态收口（预估 0.3 天，LOC ≤ +80）

- **现状**：稳态 warm p95 lishuedu 1.12 vs 门 1.10。
- **开发要点**：先归因（M6-5 之后 v4 rest 从磁盘按段再读，首触段的解码是否漏进稳态样本）；若是测量口径问题（首触段计入了稳态），修 benchmark 的预热轮数（默认预热 2 轮后再计稳态）；若是真实解码开销，给段解码结果加 LRU（上限 64 MiB，计入 G1 复测）。
- **验证**：`run-memory-benchmark.mjs` 复测：G5 三仓 ≤ 1.10 且 G1 173/29/46 不回退；T0/T1。
- **失败处置**：LRU 导致 G1 回退 → 缩 LRU（64→32→16 MiB）；不可兼得则 G5 记实测下限放行（1.12 对交互无感知）。

### L1：终局 live（T4，一次性）

- **前置**：E1–E4、C1–C3 全收口；G 轨不阻塞 L1（并行即可）；T0/T1 全绿。
- **授权**：见文档头 R1 修订第 3 条。key 从进程环境读取（OpenRouter key 与本地 host）；无 key → `BLOCKED_EXTERNAL` 等待，不得编造。
- **执行**：`run-agent-trace-matrix.mjs --authorize-external --execute-live --max-tasks 6`，双模型各一轮（`local-qwen` + `openrouter`），臂 = old/jin（+ Serena 若 E4 装上）。raw trace 留 scratch 不入库，摘要 v2 报表入 `docs/phase-l/l1-live-summary.json`。
- **退出卡**（以双模型逐任务配对均值为准；两模型方向不一致记 `MODEL_SENSITIVE` 并以合并配对均值裁决）：

| 门 | 目标 |
|---|---|
| 配对 hit-rate | jin−old 均值 ≥ 0 且 ≥4/6 任务不劣（每模型分别看，合并裁决） |
| token/task | jin ≤ old × 1.1 |
| V5R 遗留 false | presign、pay-order 至少一条在任一臂闭合 |
| 无 cap / runtime 丢弃 | GO |

- **GO** → `java_context`（重构后形态）以补充工具身份进入 F 轨合并包；JIN 计划记 `HARVESTED`。
- **FAIL** → 立即执行 kill：`java_context` 从 `PUBLIC_JAVA_TOOLS` 移除（`src/mcp-server-factory.ts`），EvidenceBundle planner 代码留分支不入包；JIN 计划记 `KILLED_AFTER_THREE_LIVES`；F 轨照常推进。**不做第四次 live，不「再调一刀」。**

### F 轨：一次性合 main 替换（终局）

#### F0 进度面板（随第一张卡建立，LOC 0）

- 建 `docs/phase-f/final-panel.md`：全部卡片状态表（PENDING/COMPLETE/FAIL_RECORDED/BLOCKED），每卡收口后更新。

#### F1 合并包组装 + 对比矩阵（预估 1 天，LOC 0 新增）

- **前置**：E/C/G/O/L1 全部收口（含带残差记账的放行项）。
- **包内容**：`codex/jin-main` 全量（N0/N0.5、M/M6、N2a/N3 图内核、O 轨修复、E/C harness 与工具改动），减去 L1 FAIL 时的 `java_context` 注册（kill 已在 L1 卡执行）。N4 的 EvidenceBundle planner 不在公开路径上，保持 flag-off 原样合入。
- **对比矩阵**：`npm run benchmark:three-repo-matrix -- --runs 5`，old = `main` HEAD，new = 合并候选树。**预期非 identity**，门：
  1. 质量（recall/pRead/rReadMust/RangeLineRecall/holdout）三仓逐位**不劣**；
  2. tokens P50 三仓降幅 ≥ 20%（N0.5 已证 −27%，此门是防合并组装出错的回归锚）;
  3. p95Ratio ≤ 1.10；
  4. `run-memory-benchmark.mjs` 在候选树上 G1/S1/S2 不回退。
- **验证**：T1 全量 + 上述 T3/内存复测；四仓在位则 G2 矩阵同时复跑一次。
- **失败处置**：任一门 FAIL → 二分定位到具体合并块（M / N0.5 / 图内核 / O 各自独立可摘），摘除后重跑；不得整包硬合，不得为过门调参。

#### F2 合并执行 + attestation（预估 0.5 天）

- 合并方式：merge commit（保留分支历史），不 squash。合并信息引用本文档与 F1 收口 JSON SHA。
- attestation：`npm run gate:pr` / `gate:nightly` / `gate:release` 三层全过；`measure:production-ts` LOC 台账入 `docs/phase-f/f2-attestation.json`；生产默认核查清单（公开工具数与 L1 裁决一致、不读 `JAVA_LSP_ENGINE`、schema token 预算、`JAVA_LSP_COLD_BUILD_CHILD` 默认开）。
- **失败处置**：gate 任一层 FAIL → 修复后重跑该层；不得跳层。

#### F3 soak 与回滚预案（预估 1 天日历时间）

- 合并后 24–48h 内：nightly profile 跑一轮；用户真实工作负载（2–3 项目并行）下观察 `HIBERNATE`/`BUILD_SLOT`/RSS 表现，记录 `docs/phase-f/f3-soak.md`。
- 回滚预案：merge commit 单点 revert 即整体回滚；F3 期间发现正确性回归（quality 或 crash）立即 revert 并记 `F3_ROLLBACK`，回到分支修复后重走 F1。
- **退出条件**：soak 无正确性回归 → 本计划记 `COMPLETE`，`main` 即新一代链路。

---

## 7. 风险与控制

| 风险 | 控制 |
|---|---|
| 全部完成前 main 长期不动，分支漂移 | 全程只有一条工作分支 `codex/jin-main`；F1 对比矩阵以合并时点 main HEAD 为 old，漂移自动被门捕获 |
| candidates 层泄露噪声路径稀释 Agent 注意力 | N 上限 + role/hop 标注 + C1 覆盖门与 C2 字节门双向约束 |
| E1 改口径被质疑放水 | v1/v2 并报 + 8/22 raw trace 重放锚 |
| L1 双模型结论相反 | 预注册：以合并配对均值裁决，记 MODEL_SENSITIVE，不得选择性引用 |
| G1 第四仓 golden 质量不足 | 降级为观察仓的显式处置路径，宁缺毋滥 |
| O2 并行化破坏确定性 | facts digest 逐位门 + 立即回滚条款 |
| 一次性大合并风险集中 | F1 分块可摘设计 + F2 三层 gate + F3 soak + merge commit 单点回滚 |

---

## 8. 一句话总结

不急用就不抢收：四轨并行把公平（E）、形态（C）、评价面（G）、残差（O）全部做完，用一次预注册的双模型 live（L1）裁决 `java_context` 去留，然后一次性把整条新链路合进 `main` 替换旧 LSP——每张卡的决策默认值、验证命令、退出条件和失败处置都已写死，执行 AI 全程无需请示。
