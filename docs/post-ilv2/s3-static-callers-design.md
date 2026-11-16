# S3 静态方法级调用方查询：设计稿（2026-11-16，未实现）

用户于 2026-11-16 决定：S3 进入设计，且触发封存评估（decision-log"封存集"条款）。本稿只做设计，不改 `src`。

> **2026-11-16 独立评审后更正，见 §7。**§0、§2、§3.4、§4.1、§6 中被更正的内容以 §7 为准，原文保留供追溯。用户已选：只推进到探针（§8），探针按 §7 的口径重写。

## 0. 结论（部分已被 §7 更正）

- **S3 不是"把查询接进 impact"就能见效。**反查能力已存在，不需要改 schema；但 dev 上的瓶颈在读取计划预算和评分口径，不在查询。
- **dev 上直接相关的目标只有 4 个**（D18 C_OWNER_BOUND），都已在候选池里，只是没有受保护 reason。机制上预计最多救回 1–2 个，其余取决于与现有 core 的优先级竞争（§2）。
- **"调用位置列表"这种输出（05 §5.5）在现有评分下得 0 分**，因为评分只认完整覆盖 gold 范围且哈希一致的交付源码。
- 建议：先跑零代码的 Mac 探针（§4.1）。探针显示 `queryCallers` 能返回未命中目标，再实现"进池 + 受保护 reason"的最小版本，并按 §4.3 做封存评估。

## 1. 已核对的事实

| 事实 | 位置 |
|---|---|
| 边表有 `edge_to_kind(to_sym, kind_sym)` 索引，反查不需要改持久化格式 | `src/java-index/sql/schema.ts:54` |
| `callers(methodId, limit=80)` 查 `CALLS`、`METHOD_REFERENCE` 入边，按路径排序；超过 limit 时多读到第二个路径后截断。返回 `sourceFile`、`range`、`confidence`、`sourceSet` | `src/java-index/sql/facts-store.ts:286,601-641` |
| 查询链已打通：`query-ops` 的 `callers`、`request-view.queryCallers`、`router.queryCallers`；但 `src` 中没有生产调用方 | `snapshot/query-ops.ts:233`、`java-index-router.ts:450` |
| impact 的 `CALLS` 证据全部是下游：锚点方法调用了谁 | `relationship-provider.ts:343,352,1046` |
| `CALLS` 边只按"接收者声明类型 + 名字 + 参数个数唯一"或"同 owner / 父类链"绑定，同名重载有歧义时不出边 | `edge-builder.ts:251-334` |
| 接收者声明为接口、锚点是实现类方法时，调用边指向接口方法，不指向实现类方法 | 同上（按声明类型绑定，不做动态分派） |
| 冷索引首次解析可能缺跨文件 `CALLS` 边，下游方向靠 `resolvedAnchorCallTargets` 补，入向没有对应补偿 | `relationship-provider.ts:1036-1045` 注释 |
| 读取计划：C0 为 6 个文件、14 KiB；core 桶最多 4 个文件；没有受保护 reason 的候选只能竞争 support、lexical 各 1 个位置 | `read-plan.ts:33,75-81,504-537` |
| 评分只给"完整覆盖 gold 范围且哈希一致"的交付源码记分，部分覆盖记为 partial | `scripts/ilv2-mac-retrieval-eval.mjs:64-91` |
| 封存集 v1 不含 callers：没有不依赖类型解析的可靠静态规则 | `d15-discovery-ranking.md` §7.1 |

## 2. dev 上的上限（已被 §7 F2 更正）

- callers 类 16 个目标，S1 后命中 7 个，未命中 9 个。
- 其中 4 个是 D18 的 C_OWNER_BOUND：都已在池中，带的是 `typeReference` 弱 reason。接收者形态：1 个 owner 静态调用，3 个变量声明类型为 owner。
- 这 4 个里 3 个所在调用核心超限：core 已满，新 reason 只有在优先级高于现有 core 文件时才能入选；按 §3.4 的建议放在最低档，就救不回来。
- 剩下 1 个未超限、池里只有 4 个候选却没入选，给它受保护 reason 后进入 core 桶，**预计**能入选（推断，未验证）。
- 另外 5 个未命中目标是否受益未知，只能由 §4.1 的探针回答。
- 结论：dev 上 S3 的机制收益在 1–2 个目标之间，不足以单独证明价值，这也是需要封存评估的原因。

## 3. 设计（推荐方案，带选项）

### 3.1 输出形态

| 方案 | 内容 | 现有评分 | 建议 |
|---|---|---|---|
| A 进池 | 调用方文件以新 reason `CALLER` 进候选池并受保护，读取范围取调用方方法的整段 | 能测 | **首版做这个** |
| B 位置列表 | 按 05 §5.5 在输出里附调用位置列表（路径、行、置信度），Agent 自己读 | 得 0 分，要另定指标，且需要模型在环评估（Q10 已是 INCONCLUSIVE） | 不做；A 的结果出来后再议 |

读取范围必须是调用方方法的整段（边的 `sourceId` 对应的方法范围），只给调用点附近的窗口会被评为 partial。

### 3.2 锚点

- **方法锚点**：`methodAt(anchor)` 得到 methodId，直接 `queryCallers`。
- **类型锚点**：首版不做。若做，需要对类型的公开方法逐个反查，扇出和预算都要另定。§4.1 的探针先数清 dev 上 callers 题的锚点有多少解析到方法。
- **接口分派**：锚点是实现类方法时，大多数调用点绑定在接口方法上。首版同时反查锚点方法覆写的接口或父类方法，结果标 `callerVia: "declared-supertype"`，优先级低于直接调用方。这一条要用户确认（§6 第 3 项）。

### 3.3 上限

- 一跳，不做传递。
- 调用方文件最多 8 个（与 05 §5.5 一致），查询 limit 取 16 条边。
- 去掉测试源码（`sourceSet` 为 test 的）和锚点自身所在文件。
- 排序：直接调用方先于接口分派；同档按边的 `confidence` 降序，再按路径。

### 3.4 优先级（安全论证不成立，见 §7 F1）

- `CALLER` 进 `PROTECTED_CORE_KINDS`，但 `protectedCorePriority` 取所有现有受保护 kind 之下的最低档（低于 S1 备选的 2.39）。
- 理由：门要求已命中目标丢失 0 个；放在最低档，core 已满时它只会落选，不会挤掉现有文件。代价是核心超限的那 3 个目标仍然救不回来。
- 最坏情况：core 未满的调用会多读最多 4 个调用方文件（core 桶上限），受 14 KiB 总预算约束。

### 3.5 完整性与失败

- 查询截断、冷索引未完成或预算耗尽时，在 `evidenceGaps` 里标 PARTIAL，不输出确定的"无调用方"（08 执行计划第 4 条）。
- 查询失败沿用 `rethrowRelationshipTerminal`：deadline 和取消上抛，其他错误降级为无结果并记 gap。

### 3.6 不做

- 类型锚点扇出、二跳、位置列表输出（方案 B）、动态分派推断、改 schema。

## 4. 评估

### 4.1 第 0 步：Mac 离线探针（不改 `src`；口径已由 §8 取代）

做法同 D18：用当前 main 的构建和 dev 语料，对 callers 题逐题记录：

- 锚点是否解析到方法；
- `queryCallers`（含接口分派反查）返回的文件里，有几个是未命中的 gold 目标；
- 截断次数，冷索引缺边的迹象。

只回传计数。**停止条件：返回的未命中目标为 0，S3 不进入实现和封存评估。**

### 4.2 dev 工程门（随实现提交固定）

- 基线改为 S1 的重放（`rows.jsonl` sha256 `18b61c2a…`，需要 Mac 保留 S1 运行的 `s1-replay` 目录），不再是 F。
- 门沿用 S1：平均召回不低于基线、已命中目标丢失 0、接收字节 p50 增幅 ≤ 20%。
- 同样只能说明"缺口补上"，不算收益。

### 4.3 封存评估（采纳依据）

callers 的 gold 需要类型解析，这是 v1 排除 callers 的原因。可选规则：

| 规则 | 独立性 | 偏差 | 成本 |
|---|---|---|---|
| G1 名字唯一 | 只取语料中名字和参数个数全局唯一的方法，文本中 `.name(` 且参数个数一致的调用点即为调用方；不读产品索引 | 偏向名字少见的方法，低估同名歧义场景 | 低，可沿用 `ilv2-sealed-set.mjs` 的生成和抽检流程 |
| G2 编译器绑定 | 用 javac 在每个语料上做精确绑定 | 最准 | 高：每个语料要能编译，需要依赖和 JDK |
| G3 人工标注 | 人工确认每题调用方 | 准，但规模小 | 高 |

建议 G1 加人工抽检，并在结果里写明偏差。比较对象除 S1 基线外，还要包含原生 rg 驱动（D18 §5.2：新方案至少要赢过它）。采纳规则、样本量、预算在生成前冻结，只跑一次。

## 5. 风险

- 收益可能很小：dev 上的直接证据只有 4 个目标，其中 3 个受 core 上限约束。
- 最低档优先级保证不丢已命中目标，但也限制了收益；若想救回核心超限的目标，需要另行调整 core 上限或优先级，那是另一个决定。
- 接口分派反查会引入"调用的是接口，运行时不一定到这个实现"的候选，需要在 reason 上区分。
- 冷索引入向缺边会造成漏报，首版只能标 PARTIAL，不补偿。

## 6. 需要用户决定（评审意见见 §7.2）

1. 是否先跑 §4.1 探针，并接受"返回 0 个未命中目标就停止"。（建议：是）
2. 输出形态首版只做方案 A。（建议：是）
3. 是否包含接口分派反查。（建议：包含，低于直接调用方）
4. `CALLER` 优先级取最低档，接受核心超限时救不回。（建议：是）
5. 封存 gold 规则选 G1 / G2 / G3。（建议：G1 加人工抽检）

## 7. 独立评审后的更正（2026-11-16）

评审为只读，未运行代码。下面的事实项我已抽查代码确认；标"推断"的未运行验证。

### 7.1 更正

| 编号 | 原稿 | 更正 |
|---|---|---|
| F1 | §3.4"最低档受保护，只会落选、不会挤掉现有文件" | 不成立。受保护文件固定进 core 桶（`read-plan.ts:852-855`），core 满后不能回落到其他桶。已命中的 7 个 callers 目标全靠非 core 桶入选（D19：受保护 reason 0/7），给它们加 `CALLER` 后，在 core 超限的调用里会失去名额（推断）。`protectedCorePriority` 的兜底值是 0（`read-plan.ts:704`），与 MyBatis、Spring 调用路径类文件同档，"低于 2.39"不是最低。core 未满时新调用方是替换非 core 文件，不是多读。方案 A 的形态需改为二选一：`CALLER` 不进 core，只作普通证据加分；或进 core 但另起一轮、最多占 1–2 个位置、未入选时回落原桶 |
| F2 | §2"最多救回 1–2 个" | 改为已知 4 个里 0–1 个。9 个未命中 = `SELECTED_RANGE_MISS` 2 + `UNSELECTED` 7（D16）；`UNSELECTED` 中 `TYPE_ANCHOR_ONLY` 3 个（D17），首版不覆盖；2 个范围类目标可能通过调用点位置受益。寄望的那 1 个有未核对前提：同包静态调用不生成 `CALLS` 边（本机冒烟已复现），且其 reason 并非 `typeReference` |
| F3 | §4.3 G1 | 与"接口分派反查"互斥：接口方法与实现同名同参，G1 构造上排除整个覆写族。G1 与产品绑定规则、原生 rg 驱动同构，gold 范围未定义会决定胜负。需先定 gold 范围（建议取调用语句行），排除库常见方法名，用解析器数参数 |
| F4 | §4.1 停止规则 | 只挡最差情况，返回不等于可得分。口径改为 §8 |
| F5 | §1 调用边 | 缺口更大：有声明类型的接收者不走父类链；同包静态调用、链式调用、lambda 参数、继承字段、`var` 等没有声明类型，可能落入"无限定调用"分支生成假边（推断）；构造器的 `CONSTRUCTS` 边指向类型，构造器锚点的调用方恒为空 |
| F6 | §3.3 | `callers()` 截断无标志，且在截断后才填 `sourceSet`；需用 `limit+1` 判截断，按文件聚合后再截 |
| F7 | §3.2 | 不用 `methodAt`：行不在任何方法内时回退到前一个方法（`java-index-router.ts:832-838`）。改用 `queryAnchor` 的 `symbolKind` |
| F8 | §3.5 | 沿用 `rethrowRelationshipTerminal` 会在 deadline 时丢掉该锚点已算出的下游证据；应做成独立 provider 或放在最后 |
| F9 | — | `coreExceededCalls` 等脚本口径按 gap 字符串计，最低档 `CALLER` 常落选会让它膨胀；受保护集合有多处副本，需列明 |
| F10 | §0 第 3 条 | "位置列表得 0 分"是 `product-mcp/v1` 驱动只读 spans 的属性，不是评分函数的属性 |
| F11 | — | 与 S1：既是备选实现又是调用方的文件窗口会变大，可能丢掉 S1 新得的名额，需由工程门检验 |

### 7.2 §6 决定项的评审意见与用户选择

| 决定 | 评审 | 状态 |
|---|---|---|
| 1 先跑探针 | 修改：口径与停止规则重写 | 用户选择只推进到探针，按 §8 |
| 2 首版只做方案 A | 同意先 A，形态按 F1 改 | 待探针结果 |
| 3 接口分派反查 | 默认延后，dev 证据为 0 且 G1 测不到 | 探针只计数，不进首版 |
| 4 最低档优先级 | 不同意 | 作废 |
| 5 G1 | 修改后可用；50 题大概率 INCONCLUSIVE，应先用探针的效应反推样本量 | 待探针结果 |

## 8. 探针（`scripts/ilv2-s3-callers-probe.mjs`）

不改 `src`，不跑模型，不重放。输入是 S1 重放的 `responses.jsonl` 与 `rows.jsonl`（rows sha256 `18b61c2a…`，脚本强制校验）和当前 main 的 `dist`。对每道 dev callers 题的每次 C0 调用：

1. 在冻结语料上用 `runSqlColdBuild` 建索引，`queryAnchor` 取锚点的 `symbolKind`；
2. 方法锚点：`queryCallers(methodId, 81)`，去掉测试源码和锚点自身文件，按文件聚合，取前 8 个；另对锚点覆写的直接 repo 超类型方法（同名同参个数）反查，单独计为 via-supertype；
3. 用该次调用记录的读取计划判断。

| 计数 | 含义 |
|---|---|
| `anchorKinds` | 锚点为 METHOD、TYPE、CONSTRUCTOR 等的调用数 |
| `truncatedAtDesignLimit` / `AtProbeLimit` | 直接调用边超过 16 / 80 的调用数 |
| `returned` | 未命中目标被直接返回、经超类型返回、未返回的数量 |
| `returnedSpanCredits` | 返回且调用方法范围覆盖 gold、gold 末行在 80 行读取上限内 |
| `blockedByCore` / `blockedByBytes` | 上一项中因 core 超限或已满、因字节放不下而不可达的数量 |
| `reachable` | 直接返回、范围可得分、core 未超限且有空位、锚点 + core + 新范围 ≤ 14 KiB |
| `reachableViaSupertype` | 同上，但经超类型返回（只报告） |
| `reachableTaskGroups` | `reachable` 涉及的任务组数 |
| `creditedAtRisk` | 已命中、被返回、在该次调用中入选且无受保护 reason、而 core 超限或已满的目标数，即 F1 的预计丢失 |

**停止规则（运行前固定）：**`reachable < 2`、或 `reachableTaskGroups < 2`、或 `creditedAtRisk > 0`，任一成立即停止 S3，结论记为"找调用方用原生搜索"。都不成立时，按 F1 选定方案 A 的形态，再定封存评估方案（样本量由 `reachable` 反推）。

限制：可达性由记录的计划近似（行的 UTF-8 字节，非产品精确切片），未用 `CALLER` reason 重跑规划器；评估驱动等索引 FRESH 才查询，冷索引缺边在此观察不到，不计。

### 8.1 Mac 步骤

```bash
cd <Mac 上的仓库>
git fetch origin && git checkout docs/s3-design && git pull --ff-only
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile --keep --name s3-probe | tail -1
DIST=<上一行 JSON 的 validationRoot>/candidate/dist   # 本分支 src 与 main 相同
S1RUN=<S1 那次运行的 $RUN>         # 其中有 s1-replay/responses.jsonl 与 rows.jsonl
OUT=<Mac 运行根>/post-ilv2-s3-probe-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M)
"$ILV2_NODE_BIN" --test scripts/ilv2-s3-callers-probe.test.mjs
"$ILV2_NODE_BIN" scripts/ilv2-s3-callers-probe.mjs --dataset "$ILV2_MAC10_DATASET" \
  --tasks "$DS/tasks-dev.jsonl" --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" \
  --dist "$DIST" --responses "$S1RUN/s1-replay/responses.jsonl" --rows "$S1RUN/s1-replay/rows.jsonl" --out "$OUT"
```

`$OUT/summary.json` 只含计数，回传为 `docs/post-ilv2/results/S3-PROBE.json`；`probe-rows.jsonl` 含路径与任务 ID，留在 Mac。预计数分钟（每个语料一次冷建索引）。

### 8.2 验证状态（提交时）

- 单元测试 10/10：已运行并通过（计划状态、调用方聚合与截取、80 行上限、可达与预计丢失判定、停止规则、类型 id 解析、带假索引的端到端汇总与脱敏）。
- 真实索引冒烟：用 `src` 加载器对一个 4 文件小工程冷建索引后调用 `callersOf`，已运行并通过：字段类型为实现类的调用是直接调用方；经接口变量的调用只出现在 via-supertype；同包静态调用 `Impl.util(1)` 没有边；类型锚点不查询。
- 对真实语料运行：无法在 Linux 运行（语料只在 Mac）。Mac：未运行。
