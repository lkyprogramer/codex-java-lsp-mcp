# D15 发现与排序阶段计划（2026-11-12）

用户于 2026-11-12 批准开启本阶段。decision-log 中"Q10 仍为 INCONCLUSIVE 时停止本路线"的规则继续适用于 outline 和 evidence。本阶段是用户单独批准的新范围，不由该规则自动生成。

## 1. 范围

**立项时已确认**
- 停止为 outline 和 evidence 单独做模型验证：不做 v4 QA 新题集，不补 B1。
- 封存检索集的 gold 采用半自动生成，再随机抽检约 25%。

**延后**（由各自决策记录处理）
- evidence v2 的发布合同（D14）。
- outline 和 evidence 的去留。
- evidence 单元大小与源码预算的解耦。

**原定范围**是 `java_symbol operation=query` 静态发现的候选排序，即 exact 路径与 text 路径的结果顺序。Mac 诊断后的调整见 §8、§9。

**本阶段不做**
- driver 的锚点选择策略，例如 Q07 中"首选锚点"取 top-1。这是评测 driver 的行为，不属于产品工作。产品侧改进只计"目标在 `java_symbol` 候选中的名次"。
- agent 零查询（`NOT_PLANNED`）。这是 agent 行为问题，排序改不了，只单独记录。
- outline、evidence 和 ReadUnit。

## 2. 基线口径更正

- **Q02 不是产品默认配置下的数字。** Q02 的 product 必需范围召回 36.25% 对 native rg 42.83%，测量时 driver 用的是 `limit ?? 3` 和 `impactPerTerm ?? 1`（`scripts/ilv2-mac-retrieval-eval.mjs:192-193`）。产品默认是 `DISCOVERY_DEFAULT_LIMIT = 8`（`src/java-index/entity-search.ts:30`）。因此这组数字只是信号，不能当作"产品主路径不如 rg"的结论，也不能作为本阶段的固定门槛。
- **Q07 的首选锚点覆盖 0/4，是 driver 的 top-1 策略造成的。** `java_symbol` 本身不替调用方选择锚点。

## 3. 指标（预注册）

### 产品层（主指标，与 driver 无关）

对每个 (任务, 必需证据范围)，计算目标在该任务的 `planQueries` 各查询词结果中的最佳名次。"命中"沿用 retrieval runner 的读取口径：按 `DRIVER_WINDOW` 在候选的声明行开一个窗口，窗口要完整覆盖目标范围。

- **主指标：** hit@3，以及目标名次分布。
- **次要指标：** hit@1、hit@8、hit@20，以及查询响应的 wire 字节数（p50/p95）。

### 端到端层（次要指标）

- 检索 runner 的必需范围召回。product 和 native 在同一批题、同一次运行中配对比较。
- driver 配置固定：product 用 `limit = 8`（产品默认），另外 `impactPerTerm = 1`，window 不变。
- native 配置不变，即 `filesPerTerm = 3`。

### 采纳规则（封存集上一次性判定）

一个排序改动必须同时满足以下全部条件，才判为 ADOPT：

1. 产品层 hit@3 的配对差值，按任务组做 cluster bootstrap，95% 区间下界大于 0。
2. hit@1 不下降超过 2pp（点估计）。
3. 查询 wire 字节 p50 的增幅不超过 10%。
4. 端到端召回相对 native 非劣：配对差值的 95% 区间下界不低于 −5pp。
5. `npm test`、`gate:pr`、`measure:tool-schema` 全部通过。

第 2 到第 5 条全部满足时，按 hit@3 区间判定：下界 > 0 判 ADOPT；区间跨 0 判 INCONCLUSIVE，不得合并改动或调参后重测；上界 ≤ 0 判 NO_GAIN。第 2 到第 5 条任意一条不满足，直接判不采纳。

## 4. 数据

**dev 回归集**
- 内容：mac10-v3 dev 的 Q02 20 组。这批数据已经暴露，只用于诊断和开发回归，结论不能外推。
- 在开始改代码前，先用产品默认的 limit 8 重测一次基线。
- 同一次运行里补测 Q02 的 14 组 `UNMEASURED`。

**封存检索集（原计划，当前处置见 §10）**
- 原计划在 W1 的 Mac 结果出来前提交抽样规则。实际 W1 Mac 运行先于 §7 规则提交。§7 的 v1 规则保留供追溯。
- **语料**：冻结的三个仓库。可选再加 1 个从未参与调参的仓库，是否加由用户决定。
- **规模与分层**：至少 50 组。按（仓库 × 类别）分层抽样，抽样 seed 为 `d15-sealed-20261112`，抽检 seed 为 `d15-audit-20261112`。两个 seed 随本计划一起提交，之后不得更改。
- **排除**：mac10-v3 用过的 commit 和锚点；证据文件与 v3 重叠超过一半的候选。
- **gold**：只包含"目标声明或证据范围的位置"，不需要答案。
  - 生成：用与产品索引无关的手段，例如编译产物和字节码、javac 删除探针、rg 加人工复核。
  - 抽检：按 seed 随机抽检 25%。某一层的抽检错误率超过 10% 时，该层整体重做。
- **查询来源**：只能来自公开题面，经 `planQueries` 生成，即锚点加反引号片段。
- **使用纪律**：在 W5 之前不打开，W5 只打开一次。

## 5. 工作项

| # | 内容 | 产出 | 状态 |
|---|---|---|---|
| W1 | 排名诊断 | 代码层事实，本节下方；`scripts/ilv2-ranking-diagnosis.mjs`；Mac 上的聚合结果 | Q07 校准通过，20 组 Q02 和 33 组 dev 已测，见 [Mac 结果](results/D15-W1.json) |
| W2 | 在 limit 8 下重测基线，并补测 UNMEASURED | 检索 runner 报告与 ledger | 40 个 slot 已测，原 14 组已补测，仍有 8 组缺少定因证据，见 [Mac 结果](results/D15-W1.json) |
| W3 | 排序改动 | 排序和查询路径诊断 | 已停止，步骤 B 的预算内增益未达到进入实现的门槛，见 §8.6 |
| W4 | 构建封存检索集 | 数据集、抽检记录、身份冻结 | `NOT_RUN`，v1 保留作历史记录，v2 延后 |
| W5 | 封存集上的一次性测量 | 按 §3 判定 | `NOT_RUN`，本阶段没有候选变更进入封存评估 |
| W6 | 阶段结论 | 决策记录 | 已完成，见 §10 |

## 6. W1 排名诊断

### Mac 实测前的代码检查

1. **带大写的单个标识符走 exact 路径。** 锚点通常是 `OrderService`、`getUserInfo` 这类形状，`classifyQuery` 在 auto 模式下判为 `exact`（`src/discovery/query-intent.ts:11-24`）。exact 路径不会回落到 BM25（`src/java-index/sql/entity-search.ts:810-817`）。
2. **exact 路径内部按路径字母序排序。**
   - 同名声明全部视为等价，只按 `entityId` 排序（`entity-search.ts:401`）。
   - `entityId` 的格式是 `[method:]type:v2:<encodeURIComponent(path)>#<fqn>…`（`src/java-index/stable-id.ts:25-32,51-56`），所以排序等于按文件路径的字母序，不区分 main 和 test，也不参考任务中的其他线索。
   - type 备选只要有命中就立即返回，不再看同名 method（`entity-search.ts:386-404`）。
3. **text 路径不融合分数。** identifier、chunk、document 三路各自做 BM25，然后按名次轮转合并（`entity-search.ts:855-871`）。不按分数融合，多路同时命中也不加分。所以在一路中排第 r 的候选，合并后大约落在第 3r 位。
4. **带上下文的消歧目前只能走 text 路径。** 显式 `searchMode=exact` 不接受 `terms`（`src/discovery/query.ts:251-252`）。auto 模式下只要带了 `terms`，就一律走 text 路径，把 query 和 terms 拼成一段文本做 BM25（`query.ts:254-255`）。所以调用方现在就能用 `query=锚点, terms=其他锚点` 带上下文查询，代价是放弃 exact 的名字精确匹配。

### Mac 实测前的候选机制

| 机制 | 预期特征 |
|---|---|
| A. exact 同名歧义，按路径排序 | 响应中 `exact = "ambiguous"`；候选满足路径顺序；目标前面全是同名声明 |
| B. text 路径轮转合并 | 没有 `exact` 字段；目标在单路中名次靠前，合并后被挤后 |
| C. test 源码挤占 | 目标前面有 `src/test` 等非 main 声明，可与 A、B 叠加 |

Q07 中目标名次为 8–11。A 和 B 是运行前提出的候选解释，实际结果见 §8.1。

### 诊断脚本

`scripts/ilv2-ranking-diagnosis.mjs` 的行为：

- **查询**：对每个任务，按 `planQueries` 生成的查询词逐个以产品默认 auto 模式调用 `java_symbol query`，参数 `limit = 20`、`preview = none`。另做两个真实产品探针：响应走了 exact 路径时，用 `searchMode = text` 补查一次；计划中有多个查询词时，用 `query=该词, terms=其余词` 再查一次。全部查询完成后才读取 gold。脚本按 `classifyQuery` 规则本地预测每个词走的路径，与响应中的 `exact` 字段对照，不一致的次数记入 `intentMismatchTerms`。该值非 0 时，路径相关的机制标签不可信。
- **逐个目标输出**：
  - 最佳名次和机制标签：`TOP1`、`EXACT_AMBIGUOUS`、`EXACT_OTHER`、`TEXT_MERGE`、`FILE_ONLY`、`NOT_RETURNED`；
  - 排在目标前面的同名、test、同文件候选数；
  - exact 列表是否符合路径顺序。
- **反事实重排**：对同一份返回列表做两种确定性重排，不增减候选，用来估计纯重排最多能带来多少提升，不代表产品改动后的真实效果：
  - main 优先；
  - 按其他查询词在候选文件中出现与否重排（co-anchor）。
- **探针统计**：`hitAt.orTextRoute` 和 `orWithTerms` 取默认查询与探针中较好的名次，是当前产品的真实行为；`notCovered` 统计默认查询没覆盖、探针能找回的目标数。
- **输出文件**：`summary.json` 只含计数；`rows.jsonl` 和 `responses.jsonl` 含路径和查询词，留在私有目录。

Mac 上的运行方式：环境同 acceptance §5.1，不调用模型。

```bash
node --test scripts/ilv2-ranking-diagnosis.test.mjs
node scripts/ilv2-ranking-diagnosis.mjs --dataset "$ILV2_MAC10_DATASET" \
  --tasks <ds>/tasks-dev.jsonl --gold <ds>/private/gold-dev.jsonl --inputs "$ILV2_MAC10_INPUTS" \
  --server-js dist/server.js --out "$ILV2_RUN_ROOT/d15-w1" [--task-ids <Q02 的 20 组>]
```

需要回传的是 `summary.json`，路径为 `$ILV2_RUN_ROOT/d15-w1/summary.json`。

**口径校准（Mac 上先核对）**：在 `rows.jsonl` 里，Q07 两组的 4 个目标应排在第 8、8、9、11 名，或与 Q07 复测的可见性一致：limit 3 时 0 个可见，limit 8 时 2 个，limit 20 时 4 个。对不上，说明本脚本的窗口命中口径和 Q07 的 witness 定义不一致，`summary.json` 不能直接用来选 W3 方向，先修口径。

拿到结果后，决定 W3 改哪个机制：

- **A 占主导**：分两种情况。
  - `orWithTerms` 已经能拿回大部分目标：先在工具描述中引导调用方带 `terms`，产品不改排序。这是 schema 文本改动，wire 字节要计入。
  - 只有离线的 co-anchor 或 main 优先重排有提升：改 exact 歧义列表的排序，例如 main 优先，或在 exact 路径上接受 `terms` 用于排序。后者是公共 API 变化，需要单独评估兼容性。
- **B 占主导**：改为按分数融合，或给多路同时命中加分。
- **大多数目标是 `NOT_RETURNED` 或 `FILE_ONLY`**：问题不在排序，而在查询词或窗口。这时 W3 需要重新立项，不能硬改排序。

## 7. 封存检索集规则（修订，2026-11-12）

> **已暂停（见 §8.4）。** v1 的主指标只测锚点点名的声明自身的名次，W1 显示这类目标在真实题里几乎都排第一，同名歧义为 0。v1 规则不生成，保留作记录。

规则首次随 `dd435f22` 提交，该提交未包含 W1 的 Mac 结果。规则代码为 `scripts/ilv2-sealed-set.mjs` 中的 `SEALED_RULES`（`sealed-rules/v1`），它的摘要随每份 selection 记录。生成之后修改任何一条规则，都必须换新的 rules 版本，并重新生成。

### 7.1 对 §3、§4 的修订

- **目标必须能被 `java_symbol query` 返回。** exact 路径只返回简单名等于查询词的声明。所以每题必须有一个 role 为 `declaration` 的目标，即锚点所命名声明的头部。头部指从修饰符和注解起到名字所在行，不含 Javadoc。
- **主指标只统计 `declaration` 目标，并且按身份匹配。** 只有声明本身对应的候选才算命中，即同一文件，且候选的 `selection.line`（产品返回的 1 起始名字行）落在声明头部的行范围内。不沿用窗口口径，因为在窗口口径下，所属类型的候选会把它后面约 59 行内的短成员一并计为命中，测到的就不是成员自己的排序了。诊断脚本中对应的字段是 `declarationHitAt`（`matchesTarget`）。
- **`relation` 目标只进端到端层。** 实现类方法、MyBatis 语句这类目标，查询本身返回不了，仍按读取窗口口径计算，只计入检索 runner 读取之后的召回。没有 role 标签的 mac10-v3 gold 也继续用窗口口径。
- **类别与分层。** 共 3 个类别：`declaration`（方法或类型）、`implementations`、`xml`。按（仓库 × 类别）分层。callers、spring、dto-impact 没有不依赖类型解析的可靠静态规则，v1 不纳入。这一点相对 §4 的"沿用 mac10 类别"有所收窄。
- **不按名字唯一性筛选。** 同名声明保留。每题记录 `sameNameCount`，即语料中同名方法或类型的数量，test 源码也计入。生成汇总按 1、2–3、4–7、8+ 四档输出分布，用来确认集合里包含 exact 同名歧义的题。

### 7.2 题面模板（公开内容）

锚点固定为两个裸名 `[所属类型, 成员]`，题面不出现路径，也不出现答案：

| 类别/形状 | 题面 | declaration 目标 | relation 目标 |
|---|---|---|---|
| declaration/method | Locate the declaration of method `M` in type `T`. | `T#M` 的头部 | — |
| declaration/type | Locate the declaration of type `T`, the one that declares `M`. | `T` 的头部；`M` 是 `T` 的可用成员之一，按抽样 seed 选取 | — |
| implementations | Find the implementations of method `M` declared by interface `I`. | `I#M` 的头部 | main 源码中实现 `I`、方法名和参数个数都相同的方法头部，限 1–5 个 |
| xml | Find the MyBatis SQL statement that mapper method `M` of `I` executes. | `I#M` 的头部 | namespace 等于 `I` 的 FQN 的 mapper XML 中，id 唯一的 select/insert/update/delete 元素 |

**代表性检查**：生成之前，请 Mac 对 mac10-v3 的公开题面回传三个计数：每题的锚点数，裸名与带 `#` 或 `.` 的限定名各占多少，反引号片段的占比。这几个计数不涉及任何结果。如果 v3 的锚点以限定名为主，就先修订模板、换新的 rules 版本，再开始生成。

### 7.3 过滤规则

- 目标声明只取 main 源码，即不匹配 `TEST_SOURCE` 的文件。
- 排除以下成员：
  - 访问器：有方法体、名字匹配 `^(get|set|is)[A-Z]`、且声明不超过 3 行。接口方法和抽象方法没有方法体，不按长度认定为访问器，例如 mapper 的 `getById` 会保留；
  - `toString`、`equals`、`hashCode`；
  - 同一类型内有重载的方法，因为同名重载时目标不唯一。
- 关系解析：
  - implements 引用按显式 import、同包、唯一的通配 import 依次解析；
  - 泛型实参不算作超类型；
  - 语料中出现两次的 FQN（例如两个模块各有一份）不参与关系解析；
  - relation 只取直接实现，不含经子接口或抽象基类间接实现的方法。这只影响端到端召回的分母，不影响主指标。
- 曝光排除：
  - 候选的任一锚点等于 mac10-v3 任一题（dev 与 holdout）的 `planQueries` 查询词时，排除；
  - 候选的目标文件中，过半出现在 v3 同一语料的证据文件里时，排除；
  - 未通过 `leaks()` 检查的，排除。

### 7.4 抽样、封存与抽检

- **配额**：每层取 q 题，q 从 6 起逐次加 1，直到计划封存数 Σ round(min(q, n_层) × 0.85) 不少于 50，或 q 已等于最大层的候选数。达不到 50 时生成命令以退出码 1 结束，freeze 也会拒绝。
- **顺序**：层内顺序由 `sha256(d15-sealed-20261112   层   id)` 决定。
- **划分**：由 MAC-10 转换器按同一 seed，以 0.85 的比例划出 holdout，holdout 即封存部分。其余约 15% 为 dev，只用于流水线冒烟。
- **抽检**：每层抽 ceil(25% × 入选数) 题，顺序由 `d15-audit-20261112` 决定。每层通常只抽 1–2 题，所以"错误率超过 10% 则整层重做"实际等于"抽到一个错就整层重做"。重做时该层取同一 seed 顺序中的下一块（`--rounds`），然后重新抽检。
- **可复现**：未抽检题的 `verification.at` 取各冻结 head 中最晚的提交时间，不取当前时钟。同样的输入、规则和 rounds 会得到同样的 `datasetDigest`。
- **独立性**：候选和 gold 只来自冻结 head 的源码文本，不调用产品，不读取产品索引或排序，也不按任何产品结果筛选难度。需要注意，生成器与产品索引共用 tree-sitter-java 解析库，所以只能声称"独立于产品索引和排序"，不能声称"独立解析"。解析层面的错误由人工抽检兜底。

### 7.5 Mac 执行步骤

1. 回传 §7.2 的代表性计数，只含计数。
2. 生成：

   ```bash
   node scripts/ilv2-sealed-set.mjs generate --inputs "$ILV2_MAC10_INPUTS"      --exclude-dataset "$ILV2_MAC10_DATASET" --out "$ILV2_RUN_ROOT/d15-w4-gen"
   ```

   输入 checkout 必须停在冻结 head，并且没有未跟踪或被忽略的文件。`summary.json` 只含计数，可以回传。`selection.json` 和 `audit-sheet.json` 是私有文件。
3. 抽检：由人工逐题填写 `audit-sheet.json` 的 `verdict`、`by`、`at`、`notes`。只看源码片段，不运行产品。
4. 冻结：

   ```bash
   node scripts/ilv2-sealed-set.mjs freeze --selection "$ILV2_RUN_ROOT/d15-w4-gen"      --audit <填好的 audit-sheet.json> --inputs "$ILV2_MAC10_INPUTS" --out <私有数据集目录>
   ```

   有 FAIL 时，命令会给出 `--rounds` 参数。带上它重新执行第 2 步，`--out` 换一个新目录，然后重新抽检。封存数不足 50 时，freeze 在写任何文件之前就会拒绝。
4.1. **口径校准**：只在数据集的 dev 部分（约 15%）跑一次 `ilv2-ranking-diagnosis.mjs`。`declarationTargets` 应等于 dev 部分的题数。`declarationHitAt[20]` 如果为 0，说明产品返回的 `selection.line` 与 gold 头部的行号基准对不上，必须先修正口径，才能进入 W5。
5. 记录：把 `datasetDigest`、各层计数和抽检结论写入 `results/D15-W4.json`。在 W5 之前，不得在 holdout 上运行检索 runner、诊断脚本或任何产品查询。

## 8. W1 结果与重新立项（2026-11-12）

用户于 2026-11-12 批准 A–F 重新立项。步骤 B 的仓库脚本和选择规则随 `ccb88e9` 提交，Mac 上的自有脚本模拟先于该提交，见 §8.6。

### 8.1 W1、W2 事实（[D15-W1.json](results/D15-W1.json)，dev 33 组，104 个目标）

- 校准通过：Q07 的 4 个目标名次为 8、8、9、11；`intentMismatchTerms = 0`。
- 默认查询 hit@1/3/8/20 = 19/19/22/25；`TOP1` 19，`EXACT_AMBIGUOUS` 0，`TEXT_MERGE` 6，`NOT_RETURNED` 78。
- 79 个未命中目标（含 1 个 `FILE_ONLY`）中，60 个发生在 exact 路径之后，其中 34 个能被 text 路径找回。默认与 text 取较好名次时，hit@3/8/20 = 29/42/59。
- 离线重排（main 优先、co-anchor）最多 +1。
- W2：product（limit 8）平均召回 38.9%，native 42.8%，配对 4 好 4 差 12 平。

W1 满足 §6 的重新立项条件。多数目标未进入候选列表，重排无法找回这些目标。exact 路径只查精确匹配的声明。text 探针找回了部分 Java 证据范围，XML 目标没有找回。

### 8.2 步骤 B：合并模拟方案

脚本 `scripts/ilv2-merge-simulation.mjs`，只重放 W1 已捕获的 auto 和 text 列表（limit 20，preview none），不调用产品。text 路径的词（auto 未走 exact 的词）在所有策略下都不变。

| 策略 | exact 命中（match / ambiguous） | exact 未命中（miss） |
|---|---|---|
| `baseline` | 现状 | 现状（空） |
| `fillAfterHit` | exact 结果在前，text 结果去重后补满 | 保持空，符合 R07"未命中不回退" |
| `fillAlways` | 同 `fillAfterHit` | 返回 text 结果，**推翻 R07** |
| `interleaveAlways` | exact 与 text 交替 | 返回 text 结果，**推翻 R07** |

- 去重键：`declaration.id`，加上 `evidenceRange` 的路径和起始行（MyBatis XML 候选单独计）。
- 匹配：沿用诊断脚本的 `matchesTarget`（mac10-v3 gold 无 role，即读取窗口口径）。
- 自检：先按 W1 的 `rows.jsonl` 复算每个目标的默认名次和 text 探针名次，有任何不一致就拒绝输出。任何策略在任何 k 上都不得超过"默认与 text 取较好名次"的上界。
- 输出：各策略 hit@1/3/5/8/20（分 java 与非 java、分类别）；相对 baseline 新增的目标按所在词的路径结果（match / ambiguous / miss / text）归因；L = 3、5、8 下每个 exact 词的候选数和 locator 字节、每题候选总数和不同文件数。head 预览字节只按产品上限给出界（每候选 1024 B、每请求 2048 B），不是实测。
- 只读 dev gold，拒绝 holdout gold。

**仓库脚本的选择规则**
1. 按 hit@3 排序，其次 hit@8，再次 L = 8 时 exact 词 locator 字节 p50 较小者。
2. `fillAlways` 和 `interleaveAlways` 改变 R07 契约。只有在 hit@8 比 `fillAfterHit` 多至少 3 个目标、且 `lostVsBaseline[8] = 0` 时才可入选，入选后还要用户单独批准契约变更。
3. 最优策略相对 baseline 的 hit@8 增益少于 5 个目标时，不进入步骤 D，直接转向 F。
4. 选择与开发都在同一批 33 组 dev 上进行，结论只作为方向，效果以步骤 E 的封存集为准。

### 8.3 计划

| 步骤 | 内容 | 状态 |
|---|---|---|
| A | 目标去向按类别拆分、两条路径的响应大小 | Mac 已离线统计，见 [D15-W1.json](results/D15-W1.json) 的 `stepA` |
| B | 合并模拟，§8.2 | Mac 用自有脚本完成，见 §8.6。仓库脚本未运行 |
| C | 依据 B 选策略，修订 §3 的 wire 规则 | 预算内增益不足，转向 F |
| D | 在 auto 模式实现选定策略 | 不做 |
| E | 封存集 rules v2，主指标随 F 的结论重定 | 延后，规则未冻结，见 §10 |
| F | java_impact 读取预算，§9 | Mac 已测，O2，保持 C0 |

### 8.4 §7 v1 的处置

§7 规则与 `scripts/ilv2-sealed-set.mjs` 保留，v1 不生成。转换器的 `locate` 任务类型、`static-head` 来源与 evidence role 继续可用。v2 的规则制定延后，重启条件见 §10。

### 8.5 Mac 执行步骤（步骤 B）

不需要 build，不启动产品，不调用模型。使用 W1 的私有产物：

```bash
node scripts/ilv2-merge-simulation.mjs --dataset "$ILV2_MAC10_DATASET" --gold "$DS/private/gold-dev.jsonl" \
  --responses "$RUN/d15-w1-dev/responses.jsonl" --rows "$RUN/d15-w1-dev/rows.jsonl" --out "$RUN/d15-b-dev"
```

自检失败（exit 非 0）时停止并回传错误信息。成功时 `strategies.baseline.hitAt` 应为 19/19/·/22/25（@1/3/·/8/20），`bestOfBothHitAt` 的 @3/8/20 应为 29/42/59。summary 以 `stepB` 字段写入 `results/D15-W1.json`。

### 8.6 步骤 B 结果（[D15-W1.json](results/D15-W1.json) 的 `stepB`、`stepBByteBudget`、`w3Assessment`）

- Mac 在本节规则提交（`ccb88e9`）之前，用自有脚本跑了步骤 A、B，并另做了 289 种策略的字节预算扫描。本仓库的 `ilv2-merge-simulation.mjs` 没有运行，结果里没有按 match / miss 拆分的增益。
- limit 8，exact 在前、text 补满：hit@3 19 → 28，hit@8 22 → 42（等于"默认与 text 取较好名次"的上界）；单次响应字节 p50 1590 → 8478。交错合并命中相同。
- §3 的 p50 增幅不超过 10% 之内，最好的策略 hit@3 +1、hit@8 +3，且在同一批 dev 上挑选。
- 按 §8.2 规则 3（增益不足 5 个目标）：不进入 C、D，转向 F。Mac 的结论 `STOP_CURRENT_W3` 与此一致。

## 9. F：java_impact 读取预算（2026-11-12，Mac 运行之前提交）

### 9.1 代码层事实

- 检索 runner 的 product driver 对每个查询词：java_symbol（limit 8）每个候选读一个窗口，再对第 1 个候选调用 java_impact（`mode: "balanced"`、`semanticPolicy: "fast"`、`verbosity: "compact"`），逐个读取返回的 span（`scripts/ilv2-mac-retrieval-eval.mjs:230-249`）。
- balanced 预算为 6 个文件、14 KB（`src/agent-router/read-plan.ts:33`）；recall 为 12 个文件、32 KB，候选池上限也随 mode 变化（`candidateLimit`，balanced 约 26，recall 70）。
- `readPlanMaxItems` 已经是 java_impact 的公开参数（上限 30，`src/tools/impact.ts:62`）；字节上限没有公开参数。W2 中"文件上限 6 → 20 多找回 5 个目标"就是这个参数，不需要改产品。
- 受保护核心（实现、调用、MyBatis 语句等）在任何文件预算下最多 4 个文件，配额释放后也不能超过（`BUCKET_RULES.core.max`，`read-plan.ts:77` 与 `canAddAfterQuotaRelease`）。没有公开参数能改它；被挤掉时 evidence gap 中出现 "Protected core exceeded read-plan limits"。

### 9.2 诊断（预注册）

脚本 `scripts/ilv2-impact-budget-diagnosis.mjs`，不调用模型，只在 dev 上运行。按 driver 的顺序重放 java_symbol 和 java_impact，java_impact 在以下 4 种配置下各调用一次。只认这 4 种，不在 dev 上追加配置。

| 配置 | 参数 | 对应的改动 |
|---|---|---|
| C0 | balanced（6 文件 / 14 KB） | 现状，W2 的 driver |
| C1 | balanced，`readPlanMaxItems: 12` | 调用方传参，或把 balanced 默认文件数改为 12 |
| C2 | balanced，`readPlanMaxItems: 20` | 同上，取 20 |
| C3 | recall（12 文件 / 32 KB） | 调用方换 mode |

- 每次调用同时取 compact（driver 实际读取的 span）和 diagnostic（完整候选池、read plan 和 evidence gap）。两者选出的 span 不一致就拒绝评分。
- 评分沿用 runner 的 `readWindow`、`readSpan` 和 `scoreSlot`。
- **校准**：C0 在 Q02 的 20 组上必须复现 W2 的 product 结果（平均召回 0.38916…，全召回 3 组），否则只写校准块并退出。
- 未读到的目标按原因归类：`SELECTED_RANGE_MISS`（文件已选中但 span 没覆盖）、`UNSELECTED`（在候选池中但未选中）、`POOL_ABSENT`（不在候选池）、`NO_IMPACT_CALL`（没有 impact 调用，例如空查询计划）。
- `UNSELECTED` 只有同时满足两点才记为"被核心上限挤掉"（`coreCapped`）：本次调用的 evidence gap 含 "Protected core exceeded"，且目标文件自身带受保护核心的 reason（`PROTECTED_CORE_KINDS`）。
- impact 调用按锚点词的路径结果（match / ambiguous / miss / text）计数。
- 成本：每题接收的源码字节（W2 的 `receivedBytes`，含重复）和工具响应字节，分别给 p50 / p95 / 均值。
- 敏感性：剔除含 PARTIAL 调用（覆盖不完整或语义未完成）的题后重算平均召回。

### 9.3 判定规则（看数字之前固定）

某配置**合格**需同时满足：
1. dev 33 组的每题平均召回比 C0 高至少 3pp（约等于多一组全召回）；
2. `lostVsC0 ≤ 2`。字节上限固定为 14 KB 时，多选文件可能挤掉 C0 的某个大文件，少量丢失已计入条件 1 的净值；
3. 每题接收字节 p50 增幅不超过 20%。

结论按顺序取第一条成立的：

| 结论 | 条件 | 下一步 |
|---|---|---|
| O1 改默认 | 至少一个配置合格 | 取合格配置中接收字节 p50 最小的。C1、C2 对应把 balanced 默认文件数改为 12 或 20；C3 对应把 balanced 预算改为 recall 的预算。单测和三项工程门；Mac 重跑 W2；封存集 v2 一次性判定 |
| O2 有收益但超预算 | 有配置满足条件 1，但不满足 2 或 3 | 不改默认。记录收益与代价，交用户决定是否放宽条件 2、3；放宽需要先修订本节再看封存集 |
| O3 核心上限 | 没有配置满足条件 1，且 C2 下未读到的 java 目标中至少 1/3 为 `coreCapped`（`unselectedCoreCappedJava / uncreditedJava`） | 另立核心上限卡：需要非公开参数的产品实验构建，单独预注册 |
| O4 收尾 | 以上都不成立（主要是 `POOL_ABSENT`、`NO_IMPACT_CALL`） | 结束 F，写 D15 W6 结论 |

Q02 的 20 组同时报告，用于和 native 的 42.8% 对照，不参与判定。

### 9.4 首轮 Mac 执行步骤

1. `git pull --ff-only`，HEAD 须包含本节的提交；在此之前不要运行 F。**复用 W1/W2 用过的已编译候选**（`dist/server.js` sha256 `a51b04eb…`），不重新 build，保证校准可以逐位复现。该目录已不存在时，从 `13f9dc9a` 之后任一提交重新 build（`src/` 未变），记录新的 build-stamp sha256，由校准决定能否继续。
2. 定向测试：`node --test scripts/ilv2-impact-budget-diagnosis.test.mjs scripts/ilv2-ranking-diagnosis.test.mjs scripts/ilv2-mac-retrieval-eval.test.mjs`，期望 0 失败。
3. 运行（`Q02_IDS` 为 Q02 schedule 中的 20 个 taskId，逗号分隔）：
   ```bash
   node scripts/ilv2-impact-budget-diagnosis.mjs --dataset "$ILV2_MAC10_DATASET" --tasks "$DS/tasks-dev.jsonl" \
     --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" --server-js <W2 的 dist/server.js> \
     --out "$RUN/d15-f-dev" --calibration-task-ids "$Q02_IDS" \
     --expect-mean-recall 0.38916666666666666 --expect-full-recall 3
   ```
   投影不一致或校准失败会以非 0 退出：停下，回传 `summary.json` 的 `calibration` 块和报错原文。校准失败时首先怀疑截止时间：重放每次 impact 固定传 `deadlineMs: 15000`，W2 的 driver 传的是 `min(15000, 剩余时间)`。
4. 回传：新建 `results/D15-F.json`，放 `summary.json` 全文（只有计数）和私有产物的路径与哈希。只认 §9.2 的 4 种配置，不追加扫描。

### 9.5 Mac 结果

首轮旧构建在 C2 有 6 对 compact 和 diagnostic 读取范围不一致，评分前退出。`828f8a3d` 修复输出裁剪，使实际选入读取计划的文件优先保留，两个投影使用同一文件 ID 映射。新构建定向测试 41/41 通过，C0–C3 各 56 对响应的文件 ID 均可解析，读取范围一致。Q02 原 20 组校准复现 W2 的平均召回 38.92% 和全召回 3/20。以下为全量 dev 33 组结果。[D15-F.json](results/D15-F.json)

| 配置 | 平均召回 | 较 C0 提升 | `lostVsC0` | 每题接收源码字节 p50 | 较 C0 增幅 |
|---|---:|---:|---:|---:|---:|
| C0 | 42.42% | — | 0 | 15,154 B | — |
| C1 | 44.44% | +2.02 pp | 2 | 18,068 B | +19.23% |
| C2 | 43.94% | +1.52 pp | 2 | 18,068 B | +19.23% |
| C3 | 46.21% | +3.79 pp | 0 | 22,097 B | +45.82% |

按 §9.3 判为 **O2**。C1、C2 未达到 3 pp 的召回门槛，C3 达到召回门槛但超出 20% 的源码字节预算。用户确认保持 C0，`balanced` 默认仍是 6 个文件、14 KiB。

## 10. W6 收尾决策（2026-11-12）

- **停止 W3。** W1 有 78/104 个目标未返回，main 优先和 co-anchor 重排在 hit@8 均无增益。步骤 B 直接补齐让 hit@8 从 22/104 增至 42/104，响应字节 p50 从 1,590 B 升至 8,478 B。在 p50 增幅 ≤10% 的配置中，hit@8 最多增加 3 个目标，低于 §8.2 进入实现所需的 5 个，hit@3 只增加 1 个。策略从同一批 dev 中选出，结果用于本阶段取舍。步骤 C、D 到此结束。[D15-W1.json](results/D15-W1.json)
- **F 保持 C0。** §9.5 的 O2 结果支持保留现有默认预算。`828f8a3d` 保留为读取计划文件 ID 和输出投影的一致性修复。[D15-F.json](results/D15-F.json)
- **封存集延后。** v1 的主指标关注锚点点名声明的排序，与本轮发现的证据覆盖缺口不匹配。§7 规则与生成工具保留供追溯。v2 尚未冻结，本阶段未生成、抽检或运行 D15 封存集。W4、W5 和正式采纳判定均为 `NOT_RUN`。有新候选改动时，先确定与改动相符的指标和预算，再冻结新版本的采样规则和数据，然后按预设口径做一次性评估。

D15 以现有 dev 证据收尾。W6 未追加真实 Agent 配对。outline、evidence 和 D14 发布合同继续按各自的决策记录处理。[决策日志](decision-log.md#d15-收尾)

## 11. XML-3：MyBatis XML 证据定位（2026-11-12，Mac 运行之前提交）

用户于 2026-11-12 批准。只做定位，不改 `src/`。

### 11.1 已有事实

- F：dev 中 6 道 `category=xml` 题共有 16 个证据范围，其中 15 个 XML、1 个 YAML。C0–C3 均未读到这些范围，C0 和 C3 的逐类归因均为 `POOL_ABSENT`。见 [D15-F.json](results/D15-F.json) 的 `xmlAttribution`。
- XML-2：6 个 gold 范围内原样出现了题面查询词。`java_symbol` 在 limit 20 的 auto 与 text 路径上均未返回指向 XML 的 `evidenceRange`。W2 中 xml 题 native 召回合计 1.0/3，product 为 0。见 `xmlAttribution2`。
- 代码：每条 mapper 语句只建一个检索文档，绑定到"FQN 等于 namespace 的 Java 类型中同名的方法"，文档文本只有 `mybatis <kind> <namespace>.<statementId>`，不含 SQL 正文（`src/discovery/search-document.ts` 的 `pushMyBatisDocuments`）。`<sql>`、`<resultMap>` 不建文档。
- 口径：W1 诊断的 `windowCovers` 只看 `declaration`，不看 `evidenceRange`，数不到 XML 目标。XML-2 显示 XML evidence 从未出现，现有数字不受影响；修复 XML 发现后再用 W1 测量前，须先改这个口径。

### 11.2 诊断（`scripts/ilv2-xml-discovery-diagnosis.mjs`）

每个 XML 目标沿固定阶梯检查，记第一个失败的阶段：

| 阶段 | 含义 |
|---|---|
| `NOT_STATEMENT` | 从 gold 起始行向上查找时，未找到脚本识别的开标签，或最近匹配的标签是 `<sql>`、`<resultMap>` |
| `NO_NAMESPACE_TYPE` | 语料中没有按包路径声明 namespace 的 Java 文件 |
| `NO_SAME_NAMED_METHOD` | 该类型没有与语句 id 同名的方法 |
| `DOC_NOT_RETRIEVED` | 以语句 id 做 `searchMode: "text"` 查询（limit 20），没有候选的 `evidenceRange` 指向这条语句 |
| `DOC_RANK_GT8` | 能返回，但排在第 8 名之后 |
| `TERMS_MISS_DOC` | 能返回，但题面查询词与文档文本没有共享的非通用标识符 |
| `REACHABLE` | 题面查询词本可以检索到它 |

另记两项：绑定成功的目标中题面查询词是否命中文档文本（`termsHitDocAmongBound`）；从 mapper 方法（`namespace#id` 精确查询的首个候选）按 driver 的 balanced/compact 调用 java_impact 时，读取计划是否覆盖该语句（`impactAtMapperMethod`）。前三个阶段是镜像索引规则的文本检查，不读取产品索引。

### 11.3 判读规则（看数字之前固定）

先核对样本是否含 MyBatis 语句目标。样本中有语句目标时，取非 `REACHABLE` 中目标数最多的阶段，并列时都报告。

| 最多的阶段 | 结论 | 下一步 |
|---|---|---|
| `DOC_NOT_RETRIEVED` | 文档缺失或检索缺陷 | 产品缺陷修复，最高优先级：先查该语料的 `mybatis_resource` 与 `search_doc` |
| `DOC_RANK_GT8` | DOCUMENT 层排名 | 并入发现层排名问题，单独预注册 |
| `TERMS_MISS_DOC`，或 `termsHitDocAmongBound.no` 多于 `yes` | 词汇不匹配：文档只有 id 和 namespace，题面说的是 SQL 内容 | 候选改动：把有界的 SQL 正文标识符（表名、列名）写入语句文档；先预注册评估口径和字节预算 |
| `NO_NAMESPACE_TYPE` 或 `NO_SAME_NAMED_METHOD` | 绑定缺口 | 查绑定规则；确属项目约定之外的写法时记为不支持 |
| `NOT_STATEMENT` | 普通配置 XML，或按现有规则不建语句文档的 MyBatis 片段 | 先确认目标类型。确认为 `<sql>` 或 `<resultMap>` 时，再决定是否为片段建文档 |

`impactAtMapperMethod` 中 `ABSENT` 与 `LISTED_NO_SPAN` 合计过半时，另记 impact 路径缺陷：即使从正确的 mapper 方法出发，读取计划也不交付 XML。

### 11.4 Mac 执行步骤

1. `git pull --ff-only`；`npm run build:isolated`（HEAD 须包含本节的提交）。
2. `node --test scripts/ilv2-xml-discovery-diagnosis.test.mjs`，期望 0 失败。
3. 运行：
   ```bash
   node scripts/ilv2-xml-discovery-diagnosis.mjs --dataset "$ILV2_MAC10_DATASET" --tasks "$DS/tasks-dev.jsonl" \
     --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" --server-js "$PWD/dist/server.js" --out "$RUN/d15-xml3-dev"
   ```
   本批 dev 的验收口径为 16 个证据范围（15 个 `.xml`、1 个 YAML），其中 MyBatis 语句目标为 0。脚本按 `.xml` 后缀筛选，预期 `xmlTargets = 15`。
4. 回传：新建 `results/D15-XML3.json`，保留 `summary.json` 全文、定向测试 TAP 计数、build-stamp 的 SHA-256 和私有 `rows.jsonl` 的路径与 SHA-256。

### 11.5 Mac 结果与收尾（2026-11-13）

`a62c2d59` 的 Mac 隔离构建通过，定向测试 3/3 通过、0 跳过。诊断命令退出 0，首轮外层计数校验因预期写成 16 而停止。离线对账确认，16 个证据范围中有 1 个 YAML，15 个 `.xml` 范围全部出现在原始行记录中。对账同时核对了语料文件和目标范围的哈希。[D15-XML3.json](results/D15-XML3.json)

15 个 XML 范围中，2 个来自 Maven POM，13 个来自日志配置。MyBatis 语句目标为 0，全部记录在 `NOT_STATEMENT` 阶段结束。绑定、文档检索、排名和 mapper 锚点读取计划均未测到。这批 dev 无法验证 MyBatis 发现，XML-3 以样本口径校正收尾。若后续重开该验证，需另选含真实 mapper 语句的 dev 样本。

### 11.6 C：MyBatis 普查（2026-11-13，Mac 运行之前提交）

XML-3 的样本里没有 MyBatis 语句目标。普查用来判断有没有必要另选样本、重开 MyBatis 发现验证。脚本是 `scripts/ilv2-mybatis-census.mjs`，只做文本计数，不调用产品，不调用模型，也不读 holdout gold。

- 语料侧（每个语料，排除 `src/test` 和构建产物）：
  - XML 文件数；
  - mapper XML 文件数，判定规则与索引相同，即根元素为 `<mapper>`；
  - 语句数（select/insert/update/delete）；
  - Java 侧信号的文件数：`@Mapper`、`extends BaseMapper<`、`ServiceImpl`/`IService`、`QueryWrapper`/`UpdateWrapper`、`@Select` 等 SQL 注解。
- dev gold 侧：落在 mapper XML 的范围数，落在 mapper 接口的范围数，其他 XML 的范围数，以及涉及 MyBatis 的题数。

判读规则（看数字之前固定）：

| 条件 | 结论 |
|---|---|
| 三个语料的 mapper 语句合计 < 50，或 `plusBaseMapper` 合计大于 mapper XML 文件合计 | 这些仓库以 MyBatis-Plus 或其他方式为主，XML 发现价值低，归档 |
| 不满足上一条，且 dev gold 中 mapper XML 范围 ≥ 5 或涉及 MyBatis 的题 ≥ 3 | 用这些 dev 题预注册 MyBatis 发现验证，复用 XML-3 的阶梯 |
| 不满足上两条（XML 很多，但 dev gold 很少用到） | 交用户决定：另抽样本，或者归档 |

Mac 执行：
```bash
node --test scripts/ilv2-mybatis-census.test.mjs
node scripts/ilv2-mybatis-census.mjs --dataset "$ILV2_MAC10_DATASET" --tasks "$DS/tasks-dev.jsonl" \
  --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" --out "$RUN/d15-mybatis-census"
```
回传：新建 `results/D15-MYBATIS-CENSUS.json`，包含 `summary.json` 全文和定向测试 TAP 计数。

### 11.7 普查结果与归档（2026-11-13）

Mac 上 `cc107335` 的定向测试 3/3 通过、0 跳过，普查退出 0。三个冻结语料中识别到 0 个 mapper XML、0 条 mapper 语句，有 193 个 Java 文件匹配 `extends BaseMapper<`。33 道 dev 题的 104 个证据范围中，0 个落在 mapper XML，2 个落在 mapper Java 文件，分属 2 道题。[普查报告](results/D15-MYBATIS-CENSUS.json)

按 §11.6 第一条归档本批语料的 MyBatis 发现方向。MyBatis 语句检索、排序和 mapper 锚点读取计划仍为 `NOT_RUN`。本阶段结束于普查，不另抽样、不重开 XML-3。

## 12. NOT_RETURNED 拆解（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准。这是 post-ilv2 最后一轮发现层工作：本节判读完成后，无论是否修复，都进入分支收尾（开关去留、文档修正、全量门、合入决策）。

### 12.1 背景

W1 dev 104 个目标中，79 个在 limit 20 下没有任何计划词返回覆盖它的候选：`NOT_RETURNED` 78，`FILE_ONLY` 1（[D15-W1.json](results/D15-W1.json) 的 `w1Dev`）。W1 只记录了"没返回"，没有区分原因。

### 12.2 诊断（`scripts/ilv2-not-returned-diagnosis.mjs`）

第一阶段原样重放 W1：`planQueries` + `diagnoseTask` + `classifyTarget`，读 gold 之前完成全部查询。第二阶段对每个未返回目标做 oracle 探测，记第一个失败的层：

| 层 | 含义 |
|---|---|
| `NON_JAVA` | 目标不在 `.java` 文件里，java_symbol 按设计不返回 |
| `NO_PLAN_TERMS` | 题面没有可用的计划词 |
| `OUTLINE_UNAVAILABLE` | 目标文件的 outline 不是 READY 或没有声明（索引覆盖或解析问题） |
| `WINDOW_UNREACHABLE` | 文件里没有任何声明的名字行能让 runner 的读取窗口（前 20 行、后 60 行、最多 80 行）覆盖目标：即使排第 1 也读不到，属于读取窗口问题，不是发现问题 |
| `ORACLE_MISS` | 用覆盖声明的精确名（`Type#member` 或 `Type`）做 exact 查询，limit 20 内仍没有覆盖候选：索引或 exact 查找丢了它 |
| `NO_VOCAB_OVERLAP` | 计划词与覆盖声明的声明头、紧邻的注释/注解块、外层类型名、文件名没有共享的标识符或中文词元：词法检索够不着 |
| `RANKED_OUT` | 默认查询漏掉，但精确 oracle 能找到且有词汇交集。（首版此处写成"三种查询都没排进前 20"，与代码不符：代码只看默认查询。W1 text 与 with-terms 探针的最好名次自 2026-11-13 起另记为 `altRank`，汇总为 `rankedOutByAltRank`，不改变标签。） |

outline 在这里只作 oracle，诊断会话的 owner 开启 `JAVA_LSP_EXPERIMENTAL_SYMBOL_OPS=1`；重放只调 `operation=query`，不受开关影响。词汇交集是对索引文本的近似，不读索引本身。

### 12.3 判读规则（看数字之前固定）

先核对重放：`replayByMechanism` 应与 W1 dev 一致（TOP1 19、TEXT_MERGE 6、FILE_ONLY 1、NOT_RETURNED 78）。不一致时先报告差异，诊断结论只对当前构建成立。

`NON_JAVA`、`NO_PLAN_TERMS` 属于范围问题，只记录。`OUTLINE_BUDGET_INSUFFICIENT` 记录裁剪后无法判定的目标。

本轮 `RANKED_OUT` 原标签依据默认查询漏失、已知声明名的精确探针命中及词汇交集。用任务、路径和起止行与 dev gold 对账后，取 W1 已保存的 `textRoute` 和 `withTerms` 的最好名次。未执行的探针不提供名次。59 个目标的离线分层如下，原始诊断计数保留。[D15-NR.json](results/D15-NR.json)

| 替代查询最好名次 | 目标数 | 判读 |
|---|---:|---|
| 前 8 | 20 | 替代查询已能在默认名额内找回 |
| 第 9–20 名 | 14 | 替代查询已返回，但落在 Top 8 之外 |
| 两者均未返回 | 25 | 已保存的探针没有命中，无法区分候选生成遗漏与排在第 20 名之后 |

后续按下表判断，排序候选只从有明确截断证据的分组考虑。

> 注：本节第一行以下的说明、上表以及下表最后一个条件行（"有明确截断证据的目标 ≥ 10"），是 2026-11-13 Mac 看到 D15-NR 数据之后改写的（`aead624`）。事前登记的原文为："`RANKED_OUT` 最多且 ≥ 10 → 排序或召回截断 → 预注册一个候选改动，沿用 W3 门槛：hit@8 至少 +5，响应字节 p50 增幅 ≤ 10%"。按原文与改写后的文本，结论相同，见 §12.5。

| 条件 | 结论 | 下一步 |
|---|---|---|
| `ORACLE_MISS` ≥ 5 | 索引或 exact 查找缺陷 | 不论其他层，先按产品缺陷修复并补回归 |
| `OUTLINE_UNAVAILABLE` ≥ 5 | 索引覆盖或解析缺口 | 查对应文件的覆盖与解析状态 |
| 有明确截断证据的目标 ≥ 10 | 可考虑单独验证 Top 8 排序 | 如另行开展，预注册一个候选改动，沿用 W3 门槛：hit@8 至少 +5，响应字节 p50 增幅 ≤ 10%。本轮到离线分层为止 |
| `NO_VOCAB_OVERLAP` 最多 | 题面与代码没有共同词汇（Q06 范畴） | 发现层本轮结束，不做改动 |
| `WINDOW_UNREACHABLE` 最多 | 读取窗口或交付问题，不是发现 | 发现层本轮结束；是否另做读取侧改动交用户决定 |
| 以上都不满足 | 没有集中的可修原因 | 发现层本轮结束 |

### 12.4 Mac 执行

1. `git pull --ff-only`；`npm ci && npm run build:isolated`（HEAD 须包含本节的提交）。
2. `node --test scripts/ilv2-not-returned-diagnosis.test.mjs scripts/ilv2-ranking-diagnosis.test.mjs`，期望 0 失败。
3. 运行：
   ```bash
   node scripts/ilv2-not-returned-diagnosis.mjs --dataset "$ILV2_MAC10_DATASET" --tasks "$DS/tasks-dev.jsonl" \
     --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" --server-js "$PWD/dist/server.js" --out "$RUN/d15-nr-dev"
   ```
   期望 `targets = 104`、`missedTargets = 79`（与 W1 一致时）。
4. 回传：新建 `results/D15-NR.json`，包含 `summary.json` 全文、定向测试 TAP 计数、build-stamp 的 SHA-256 和私有 `rows.jsonl` 的路径与 SHA-256。不读 holdout，不改 `src/`，不在本批 dev 上追加探针。

### 12.5 结果与收尾（2026-11-13）

[D15-NR.json](results/D15-NR.json)：重放与 W1 一致（104 个目标，79 个未返回）。修正 outline 预算误判（`e16d614`）后：`NON_JAVA` 16、`NO_PLAN_TERMS` 3、`OUTLINE_*` 0、`WINDOW_UNREACHABLE` 0、`ORACLE_MISS` 0、`NO_VOCAB_OVERLAP` 1、`RANKED_OUT` 59。`RANKED_OUT` 按题型为 implementations 21、callers 15、dto-impact 14、spring 9；替代探针最好名次为前 8 名 20 个（全部来自 text 路径）、第 9–20 名 14 个、均未返回 25 个。

判读：

- 索引、精确查找、读取窗口均无缺口，没有产品缺陷可修。
- `RANKED_OUT` 主要是关系目标（调用方、实现类、字段影响）。题面锚点是被调用或被实现的类型名，默认查询走 exact 路径只返回该声明本身；关系目标由 `java_impact` 负责，F 已测并保持 C0。
- text 路径可在前 8 名找回的 20 个，即 W3 步骤 B 的收益来源。W3 已测：10% 响应字节 p50 预算内最多 +3 个 hit@8，低于 +5 门槛。按原文规则需要预注册的候选改动就是这一个，现有数据已判它不达标，不再重复。
- 发现层本轮结束，进入分支收尾。

脚本修正（`ilv2-not-returned-diagnosis.mjs`）：计数改为只数自有属性，修复 `coveringKind` 中 `constructor` 键读到原型的问题（D15-NR.json 里该值显示为乱码，是这个缺陷造成的）；`RANKED_OUT` 行另记 `altRank`，汇总为 `rankedOutByAltRank`，把 Mac 的离线分层收进脚本。
