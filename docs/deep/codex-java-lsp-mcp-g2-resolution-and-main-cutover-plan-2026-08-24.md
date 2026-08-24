# G2 过拟合裁决与 main 一次性切换计划（A/B → F，AI 自主执行）

- 日期：2026-08-24
- 状态：**ADOPTED**。本文档是收尾阶段唯一行动真源，接替 `docs/deep/codex-java-lsp-mcp-jin-n5-live-postmortem-and-value-harvest-plan-2026-08-23.md`（该文 E/C/G/O/L1 各卡已收口，其 F 轨由本文档细化后继续）。
- **裁决记录（2026-08-24 11:53）**：A1→A2a→B0 已走完并到达 B3 停点（NOT_IN_POOL 40.8% 结构性）。用户裁决**选 C：ruoyi 降观察仓**（完整依据见 `docs/phase-b/b3-escalation.md` 用户裁决节）。G2 记 `OBSERVATION`，LORO 门改为「三仓折 GO + ruoyi 仅记账」，F1 解锁并新增 ruoyi old-vs-new 对照观察行；选项 B（图层改造）登记为未来项目，入场条件 = 真实使用中出现可归因 `NOT_IN_POOL` 缺口。**B3 停点已解除，执行 AI 从 F1 直接开跑，一路到 F3 无需再请示。**
- **基线修订（2026-08-24，用户：对比基线 / 立项修 cipherlink holdout）**：第一次 F1 用 github `main` `48e665b` 当 old，判定 FAIL。该 `main` 是 54 文件 / 9461 LOC 的前 V4 树，不是计划所述「V4-final 旧链路」。HEAD 三仓质量与 V4-final new（cipherlink recall/pRead/rReadMust 0.839/0.663/0.91，holdout rReadMust 0.55）逐位相同。F1 重跑 **old = N0 `09772b2`**（紧凑输出前的质量 identity 点；N0.5 已对它测过 token −27%）。cipherlink holdout 残差单独立项 `docs/phase-f/cipherlink-holdout-project.md`，不阻塞本次合并，holdout 仍不入目。
- 交付目标：解除 G2 过拟合阻塞 → 通过 F1 对比矩阵 → **一次性合并 `codex/jin-main` 到 `main` 替换现有 LSP 链路** → soak 收尾。用户已于 2026-08-23 授权全程自主执行（含最终合并）；本文档把唯一例外（G2 不可解）定义为硬升级点。
- 执行 AI 首读顺序：本文档 §0–§2 → `docs/phase-f/final-panel.md` → `docs/phase-g/g2-closeout.json` → `HANDOFF.md` 前 60 行。

---

## 0. 执行者必读

### 0.1 硬禁令（违反任何一条即本轮工作作废）

1. **不再有任何 live 外呼。** L1 已双模型 MEASURED FAIL 并执行 kill（`docs/phase-l/l1-closeout.json`）。禁止第四次 live，禁止以任何理由重新注册 `java_context` 到 `PUBLIC_JAVA_TOOLS`（handler 与 EvidenceBundle planner 代码留在分支即可，不删除、不复活）。
2. **holdout 永不入目**：三仓 holdout 与 ruoyi 12 条 holdout 场景的内容禁止读取、禁止用于任何调参或诊断。A/B 轨全部工作只允许触碰 `evaluationSplit: tuning` 场景。
3. 不得发明 TaskSuccess 或任何未测数字。达不到门就按卡内失败处置记账，门数值不放宽。
4. 隔离约束：所有会启动 Node worker/JavaIndex 的命令走 `sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs`，`JDTLS_BIN=/usr/bin/false`，`PATH=/opt/homebrew/bin` 在前；T3 输出目录必须不存在（已存在 exit 2）。
5. 三仓 load 政策：1 分钟 load < 20 必须跑；≥ 20 只记录不拒绝。唯一主机硬门：可用内存 ≥ 4 GiB。
6. B 轨改默认链的刀**最多两把**（B2 卡内定义）；每把必须先过三仓非劣门再看 ruoyi。两把用尽仍不过 → 升级（§0.2），不得加第三把。
7. 合并只发生一次（F2），merge commit 不 squash；F2 之前 `main` 一个字节不动。
8. 密钥不入库；raw 矩阵 cell 与 live trace 不入库；golden 场景文件冻结后只能整体替换（带新 manifest 与 SHA），不能就地编辑单条。
9. N4/V3.2 时代「不要再踩的坑」清单（`HANDOFF.md`）全部继续有效——特别是：不跨模块优先装箱、不按方法拆 hop、不给 hop0 挂全部 owner 字段 IMPORTS、不全局灌 extraNames、不 type-header +1。

### 0.2 自主决策协议

- 本手册给出决策默认值的事项直接执行，不请示。
- 未覆盖的实现分叉：选「改动更小、更可回滚」一侧，收口 JSON 记 `decision` 字段。
- **唯一升级点**：B 轨两把刀用尽、ruoyi 留出折仍超门（或 A 轨判定 golden 可信但 B0 诊断显示缺口是图/索引层结构性缺失）。此时停止,产出升级报告（§5 B3 卡），等用户裁决。除此之外一路执行到 F3。
- 每卡独立提交，前缀 `feat(a1):` 式样；收口 JSON 入 `docs/phase-{a,b,f}/`；每卡收口后更新 `docs/phase-f/final-panel.md` 一行。

### 0.3 背景地图（30 秒版）

- 本仓是 Java 智能检索 MCP 服务器（tree-sitter 索引 + 图 + `java_impact` 读取计划）。工作分支 `codex/jin-main`。github `main` 是前 V4 五工具树；本分支上 V4 线的 F1 分母是 N0 `09772b2`，不是 `main` HEAD。
- 分支上已完成且有硬证据的收益：N0.5 紧凑输出（token −27%，质量 identity）、M/M6 内存栈（单仓热堆 838→173 MiB，G1 全绿）、N2a/N3 图内核（内部能力，不改工具面）、O3（G5 稳态达标）。
- 已处决：`java_context` 工具（三次 live 全败，公开工具面回到 5 个：`java_status/java_impact/java_symbol/java_diagnostics/java_runtime`）。
- 已记账的残差（允许带入合并，F1 风险栏复述）：O1 child 冷建 RSS 1851 > 1536；O2 lishuedu 冷建 83.5s > 60s（有快照兜底，正确性无关）。
- **当前唯一阻塞**：G2 leave-one-repo-out 上 ruoyi-vue-pro 留出折 recall −17.9% / pRead −51.6% / rReadMust −47.7%，远超 15% 门；第一次修复（71f3b8d）打错层（修了 N4 planner，LORO 测的是 impact 默认链），二败升级。
- goldens：三仓 `/tmp/codex-java-v3-golden-20260809/{lishuedu,cipherlink,exam-parent-v3}`；ruoyi 检出 pin `2bbe79b3`，场景 manifest `docs/phase-g/g1-golden-manifest.json`（40 场景 / 12 holdout）。若 `/tmp` 检出已被清理，按 manifest 记录的 pin 重新 detached clone，路径写回收口 JSON。

### 0.4 G2 的两种竞争解释（A 轨要裁决的问题）

- **H-golden**：ruoyi golden 的 mustHit 推导噪声大。ruoyi（yudao 框架）是大型多模块 + MyBatis-Plus + 大量代码生成的仓库，commit-derived 推导规则只在三仓上验证过；大 commit 的顺手改动、codegen、测试文件都可能混进 mustHit，把分数拉低。
- **H-chain**：`java_impact` 默认链（candidate 生成 + `read-plan-budget` bucket 规则 + balanced maxFiles）在三仓上隐性过拟合，对结构不同的仓迁移性差。
- 两者可能并存。A 轨先量化 H-golden；扣除 golden 噪声后仍超门才进 B 轨修链。

---

## 1. 执行顺序与决策树

```
A1 ruoyi golden 质量审计（只看 tuning）
 ├─ 噪声率 ≥ 30% ──→ A2a 中性规则重推导 golden → 重跑 LORO
 │                     ├─ 过门 → F1
 │                     └─ 仍超门 → B0
 ├─ 噪声率 < 30%（golden 可信）──→ B0 缺口归因诊断（只看 tuning）
 │                     ├─ 缺口主体是选择/预算层 → B1/B2 修链（≤2 刀）→ LORO 重跑
 │                     │        ├─ 过门 → F1
 │                     │        └─ 两刀用尽仍超门 → B3 升级报告（停）
 │                     └─ 缺口主体是候选池结构性缺失（图/索引层）→ B3 升级报告（停）
 └─ A2b：重推导后场景 < 20 条（golden 不可救）──→ ruoyi 降级为观察仓，
                        LORO 门改记「三仓折 GO + ruoyi 观察」→ F1（收口 JSON 记降级理由）
F1 对比矩阵（vs main HEAD）→ F2 合并 + attestation → F3 soak → 计划 COMPLETE
```

预估总时长：A 轨 0.5–1 天；B 轨（若进入）1–2 天；F 轨 1 天 + 24–48h soak。

---

## 2. 数字门汇总

| 门 | 值 | 属卡 |
|---|---|---|
| golden 噪声率裁决线 | 抽样 tuning 场景 NOISY 占比 ≥ 30% → 走 A2a | A1 |
| 重推导后规模下限 | 可用场景 ≥ 20（含 ≥6 holdout）否则 A2b 降级 | A2 |
| LORO 过拟合门 | ~~每个留出折回撤 ≤ 15%~~ **选 C 后修订：三仓折 ≤ 15% GO；ruoyi 折仅记账观察，不设门** | A2a 已跑（三折 GO）；F1 补 ruoyi 观察行 |
| B 轨三仓非劣门 | 每把刀：三仓 tuning recall/pRead/rReadMust/RangeLineRecall 每项 ≥ 基线 − 0.005，token P50 涨幅 ≤ +3%，p95Ratio ≤ 1.10 | B1/B2 |
| B 轨刀数上限 | 2 | B2 |
| F1 质量门 | vs main：recall/pRead/rReadMust/RangeLineRecall/holdout 每项 ≥ main − 0.005 | F1 |
| F1 token 门 | estimatedTokens P50 三仓降幅 ≥ 20% | F1 |
| F1 延迟门 | p95Ratio ≤ 1.10 | F1 |
| F1 内存门 | G1 ≤ 200/64/64（实测锚 173/29/46 不回退 +10% 以上）；S1 ≤ 1024；S2 ≤ 1433.6 | F1 |
| F1 工具面门 | 公开工具恰为 5 个，schema 总量不高于 main 现状 | F1 |
| F3 soak 门 | 24–48h 无正确性回归（quality 指标漂移或 crash） | F3 |

---

## 3. 测试分级

| 级 | 含义 | 使用 |
|---|---|---|
| T0 | 定向单测（隔离 targeted） | 每卡必跑 |
| T1 | 隔离全量 dist+scripts | B1/B2、F1 |
| T2 | 单链路 replay/诊断（不烧矩阵） | A1、B0 |
| T3 | 三/四仓 cold 矩阵 + LORO | A2a、B2 收口、F1 |
| T4 | live 外呼 | **本计划禁止** |

---

## 4. 任务手册

### A1 ruoyi golden 质量审计（预估 0.5 天，LOC ≤ +150，审计脚本不计生产）

- **目标**：量化 H-golden，产出噪声率与逐场景标签。
- **范围**：新脚本 `scripts/audit-golden-quality.mjs`（读 golden jsonl + pin 树 + 源 commit diff，纯只读）；不改 `src/`。
- **输入**：ruoyi tuning 场景全量（28 条 = 40 − 12 holdout）。**holdout 一条不读**（0.1(2)）。
- **NOISY 判定（对每条场景，命中任一即 NOISY；规则先于看分数固定，本卡不得增删）**：
  1. `mustHit` 文件数 > 8；
  2. `mustHit` 中测试文件（`src/test/**` 或 `*Test.java`）占比 > 0；
  3. `mustHit` 中代码生成产物（路径含 `/codegen/`、文件头含 generator 标记、或 yudao `*-do/*DO.java` 之外的模板批量文件——以「同 commit 内 ≥5 个同后缀同目录文件被整批修改」为机械判据）占比 ≥ 50%；
  4. `mustHit` 跨 ≥ 4 个 Maven module；
  5. anchor 文件不在 `mustHit` 所属任何 module 的依赖邻域（同 module 或直接依赖）；
  6. 源 commit 是 merge commit 或 diff 涉及文件 > 30 个（大杂烩提交）。
- **产出**：`docs/phase-a/a1-audit.json`：逐场景 `{scenarioId, noisy: bool, reasons[]}` + `noisyRate` + 三仓同规则对照组（各抽 10 条 tuning 场景跑同一审计，用于校准规则本身是否过严——若三仓 noisyRate 也 ≥ 30%，说明规则过严，记 `RULE_TOO_STRICT`，改用「ruoyi noisyRate ≥ 三仓均值 × 2」为裁决线）。
- **验证**：T0（审计脚本单测：每条 NOISY 规则一个正反例）；T2（脚本在 pin 树上全量跑通）。
- **退出条件**：a1-audit.json 入库 + 裁决结论（`GOLDEN_NOISY` / `GOLDEN_TRUSTED`）写入收口。
- **失败处置**：pin 树无法恢复（上游仓不可达）→ 用 `docs/phase-jin/jin-commit-tasks-ruoyi-vue-pro.json` 内嵌 diff 信息做降级审计，记 `AUDIT_DEGRADED`。

### A2a golden 重推导（条件卡：A1 判 GOLDEN_NOISY；预估 0.5 天，LOC ≤ +200）

- **目标**：用中性噪声过滤规则重推导 ruoyi golden，重跑 LORO。
- **过滤规则 = A1 的 NOISY 判据取反**（只剔除，不新增挑选逻辑；禁止参考任何链路得分挑场景——这是防「把 golden 修到链路能过」的过拟合红线）。
- **流程**：`scripts/generate-commit-tasks.mjs` 原链路 + 过滤器 → 新 golden + 新 manifest（SHA、规则版本）整体替换 → tuning/holdout 重切分（确定性哈希，与三仓同规则）→ **新 holdout 仍不入目** → 重跑 `scripts/leave-one-repo-out.mjs` 四折。
- **验证**：T0（过滤器单测）；T2 加载 smoke；T3（LORO 一次）。
- **退出条件**：四折全部 ≤ 15% → 收口记 `G2_RESOLVED_BY_GOLDEN`，直进 F1；仍超门 → 记 `GOLDEN_FIXED_CHAIN_STILL_FAILS`，进 B0。
- **A2b 分支**：过滤后可用场景 < 20 条 → golden 不可救，ruoyi 降级为观察仓：LORO 门改记「三仓三折 GO + ruoyi 仅观察不设门」，收口 JSON 记降级理由与观察数字，直进 F1。**降级不是失败**，是「该仓的 commit 风格不适合本推导法」的诚实记录。

### B0 缺口归因诊断（条件卡：A1 判 GOLDEN_TRUSTED 或 A2a 后仍超门；预估 0.5 天，LOC ≤ +150，诊断脚本不计生产）

- **目标**：对 ruoyi tuning 场景逐条回答：mustHit 缺失文件卡在哪一层？
- **方法**：复用 V5R Phase 4 oracle 口径（`docs/phase-v5r/v5r-phase4-holdout-oracle.json` 的分类法，但**只跑 tuning**）：对每个 miss 文件标注
  - `NOT_IN_POOL`（候选池根本没有——图/索引/candidate 生成层缺口）；
  - `IN_POOL_EVICTED`（在池但被 `read-plan-budget`/bucket/maxFiles 挤出——选择层缺口）；
  - `RANGE_MISS`（文件选了但 range 不对）。
- **产出**：`docs/phase-b/b0-diagnosis.json`：分层占比 + top 缺失模式（如「MyBatis-Plus Mapper 全部 NOT_IN_POOL」）。
- **裁决**：`IN_POOL_EVICTED + RANGE_MISS ≥ 60%` → 选择层问题，进 B1/B2；`NOT_IN_POOL > 40%` → 结构性缺口（修它意味着动图/索引架构，超出收尾范围）→ 直接 B3 升级。
- **验证**：T0 + T2。

### B1 第一刀（条件卡；预估 0.5 天，LOC ≤ +120）

- **目标**：按 B0 的最大缺失模式在**选择层**落一把最小的刀。
- **候选假设池（按 B0 结果选一，禁止自创超出此池的刀；每把刀先核实 binding 约束是 maxFiles 还是 maxReadBytes——HANDOFF 已证明选错杠杆等于白跑矩阵）**：
  1. bucket 规则（`src/agent-router/read-plan-budget.ts` 的 `anchor:1, core:4, framework:2, support:1, lexical:1`）对大型多模块仓的 core/framework 配比失衡 → 按候选池规模自适应（仅当仓库 module 数 ≥ N 时调整，N 默认 8，三仓不受影响）；
  2. balanced `maxFiles` 对大仓过紧 → 同样的规模条件化放宽（显式预算参数仍是硬约束，不得覆盖——HANDOFF 既有坑）；
  3. MyBatis-Plus 风格（无 XML mapper、注解/Wrapper 查询）候选权重不足 → framework adapter 的证据权重条件化（只在检出 MyBatis-Plus 依赖时生效）。
- **红线**：刀必须是「条件化生效」——三仓行为逐位不变优先；做不到逐位不变则走三仓非劣门（§2）。
- **验证**：T0 + T1；T3：三仓矩阵非劣门 + ruoyi tuning 分数变化（只看 tuning）；然后 LORO 四折。
- **退出条件**：LORO 全折 ≤ 15% → `G2_RESOLVED_BY_CHAIN`，进 F1；改善但未过门 → B2；无改善或三仓非劣门破 → 回滚本刀，B2 换假设。

### B2 第二刀（条件卡；同 B1 规格）

- 与 B1 同规格，从假设池换一条。**这是最后一把刀**。
- **退出条件**：过门 → F1；仍超门 → 回滚（若三仓非劣门破）或保留（若三仓非劣且 ruoyi 有改善），进 B3。

### B3 升级报告（条件卡；预估 0.2 天，LOC 0）

- 产出 `docs/phase-b/b3-escalation.md`：G2 不可解的完整证据链（A1 审计、B0 归因、B1/B2 刀与数字）、三个供用户选择的方向（接受风险合并 / 立项图层改造 / ruoyi 降观察仓）及各自后果。
- 更新 final-panel，**停止执行，等用户**。这是本计划唯一的停点。

### F1 合并包组装 + 对比矩阵（预估 1 天，LOC 0 新增；前置：G2 已解除或 A2b 降级）

- **包内容**：`codex/jin-main` 全量现状（含 A/B 轨落地的刀；`java_context` 已 kill、planner flag-off 留分支）。
- **对比矩阵**：`npm run benchmark:three-repo-matrix -- --runs 5`，old = N0 `09772b2`，new = 合并候选树，AB/BA/AB 串行 cold-nolsp。**预期非 identity（token）**，质量预期与 N0.5 相同（identity vs N0）。按 §2 F1 四门裁决（质量非劣 −0.005 容差 / token −20% / p95 1.10 / 内存不回退）。github `main` 那次矩阵留在 `docs/phase-f/f1-closeout.json`，当作错树对照，不重开为门。
- **附加验证**：
  1. `sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile full`（T1 全量）；
  2. `run-memory-benchmark.mjs` 在候选树复测 G1/S1/S2；
  3. **ruoyi old-vs-new 对照观察行（选 C 裁决新增，必做）**：在 ruoyi golden（A2a 重推导版，只用 tuning + 汇总指标，holdout 仍不入目）上跑 old = N0 `09772b2`、new = 合并候选树的对照。预期：质量指标逐位相同（identity 论证相对 **N0/V4 线**，不是 github `main`）+ estimatedTokens P50 下降 ≥ 20%。质量若非逐位相同 → 说明 N0 之后默认链被移动，立即停下二分定位；token 未降 → 按 F1 token 门失败处置。对 github `main` 的那次观察留在 `f1-ruoyi-observation.json`；N0 对照写入 `docs/phase-f/f1-ruoyi-observation-n0.json`；
  4. `npm run measure:production-ts` LOC 台账；
  5. `npm run measure:tool-schema`：5 工具，总 token ≤ main 现状。
- **产出**：`docs/phase-f/f1-closeout.json`（全部门 + SHA + executableTree）。
- **失败处置**：任一门 FAIL → 二分定位到合并块（M / N0.5 / 图内核 / O / B 刀各自独立可摘），摘除后重跑；token 门差 <2 个百分点时允许以三仓逐仓明细复核后放行（N0.5 实测 −27%，正常不该贴线）；质量门无放行通道。
- **残差复述**：O1 1851 MiB、O2 83.5s 写入 f1-closeout 风险栏（不阻塞）。

### F2 合并 + attestation（预估 0.5 天；前置：F1 全 GO）

- **合并**：`main` ← `codex/jin-main`，merge commit 不 squash，信息引用本文档与 f1-closeout SHA。用户已预授权，无需再确认。
- **attestation**：`npm run gate:pr` / `gate:nightly` / `gate:release` 三层全过，任一层 FAIL 修复后重跑该层，不得跳层；生产默认核查清单入 `docs/phase-f/f2-attestation.json`：
  - 公开工具 = 5（无 `java_context`）；
  - 生产路径不读 `JAVA_LSP_ENGINE`；
  - `JAVA_LSP_COLD_BUILD_CHILD` 默认开（隔离验证环境除外）；
  - `HIBERNATE`/`BUILD_SLOT`/TTL 默认值与 M4 收口一致；
  - stdio + HTTP smoke 各一次。
- **失败处置**：attestation 揭示 F1 未覆盖的回归 → revert merge commit，回分支修复，重走 F1。

### F3 soak 与收尾（预估 24–48h 日历时间）

- 合并后 24–48h：nightly profile 一轮；在用户真实负载（2–3 项目并行 + worktree）下观察 RSS/休眠/构建信号量，记 `docs/phase-f/f3-soak.md`。
- 回滚预案：发现正确性回归（quality 漂移或 crash）→ 立即 revert merge commit（单点回滚），记 `F3_ROLLBACK`，回分支修复重走 F1。
- **收尾动作（soak 通过后）**：
  1. `HANDOFF.md` 重写头部：main 已切换、分支归档、残差清单（O1/O2、G5 1.12 若未收、ruoyi 处置结果）、坑清单增补（G2 修错层、C 轨离线门无法预测多轮成本、live 必须跑在已提交树上）；
  2. final-panel 全表置 COMPLETE/FAIL_RECORDED 终态；
  3. 最终价值报告 `docs/phase-f/final-report.md`：main 前后对比（token −27%、单仓热堆 838→173 MiB、G5 达标、工具面 5 个、java_context 三次 live 处决记录）。
- **退出条件**：本计划记 `COMPLETE`。

---

## 5. 风险与控制

| 风险 | 控制 |
|---|---|
| A2a 变成「修 golden 直到链路能过」 | 过滤规则 = A1 预注册判据取反，禁止参考链路得分挑场景；规则版本入 manifest |
| B 刀为过 LORO 门在 ruoyi tuning 上过拟合 | 三仓非劣门前置 + 刀数 ≤2 + 条件化生效红线 + holdout 全程不入目 |
| B0 诊断误判层次 | 分类口径复用已验证的 Phase 4 oracle 法；60%/40% 裁决线预注册 |
| F1 大合并组装错误 | 分块可摘 + 三层 attestation + merge 单点 revert |
| soak 期用户负载未覆盖回归面 | nightly profile 补充 + 回滚预案常备 |
| pin 树/goldens 已被 /tmp 清理 | 各卡「失败处置」均带重建路径（manifest pin 重 clone） |

---

## 6. 一句话总结

先用预注册的中性审计裁决「golden 噪声还是链路过拟合」（A 轨），该修 golden 修 golden、该修链最多两把条件化的刀（B 轨），LORO 过门后跑 F1 四门对比矩阵，一次性合并 `main` 替换旧 LSP 并 soak 收尾——全程唯一停点是 B 轨两刀用尽仍不过门，其余一路自主执行到 COMPLETE。
