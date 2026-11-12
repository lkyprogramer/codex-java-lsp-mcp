# D15 发现与排序阶段计划（2026-11-12）

用户于 2026-11-12 批准开启本阶段。decision-log 中"Q10 仍为 INCONCLUSIVE 时停止本路线"的规则继续适用于 outline 和 evidence。本阶段是用户单独批准的新范围，不由该规则自动生成。

## 1. 范围

**已确认**
- 停止为 outline 和 evidence 单独做模型验证：不做 v4 QA 新题集，不补 B1。
- 封存检索集的 gold 采用半自动生成，再随机抽检约 25%。

**延后**（本阶段不处理，阶段末再定）
- evidence v2 的发布合同（D14）。
- outline 和 evidence 的去留。
- evidence 单元大小与源码预算的解耦。

**本阶段做**：`java_symbol operation=query` 静态发现的候选排序，即 exact 路径与 text 路径的结果顺序。

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

**封存检索集**（具体规则以 §7 为准，§7 与本节不一致时按 §7 执行）
- 原计划在 W1 的 Mac 结果出来前提交抽样规则。实际 W1 Mac 运行先于 §7 规则提交，封存集仍待生成。
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
| W3 | 排序改动 | 按 W1 中实测余量最大的机制选择，只在 dev 上开发 | 按 §6 末条重新立项，改为 §8 的 A–F |
| W4 | 构建封存检索集 | 数据集、抽检记录、身份冻结 | §7 的 v1 规则暂停，不生成；改用 §8 步骤 E 的 v2 |
| W5 | 封存集上的一次性测量 | 按 §3 判定 | 等 W3、W4 |
| W6 | 结论；必要时用目标宿主的真实 schema 做小样本配对 | 决策记录 | 等 W5 |

## 6. W1 排名诊断

### 代码层事实（已读代码，未运行）

1. **带大写的单个标识符走 exact 路径。** 锚点通常是 `OrderService`、`getUserInfo` 这类形状，`classifyQuery` 在 auto 模式下判为 `exact`（`src/discovery/query-intent.ts:11-24`）。exact 路径不会回落到 BM25（`src/java-index/sql/entity-search.ts:810-817`）。
2. **exact 路径内部按路径字母序排序。**
   - 同名声明全部视为等价，只按 `entityId` 排序（`entity-search.ts:401`）。
   - `entityId` 的格式是 `[method:]type:v2:<encodeURIComponent(path)>#<fqn>…`（`src/java-index/stable-id.ts:25-32,51-56`），所以排序等于按文件路径的字母序，不区分 main 和 test，也不参考任务中的其他线索。
   - type 备选只要有命中就立即返回，不再看同名 method（`entity-search.ts:386-404`）。
3. **text 路径不融合分数。** identifier、chunk、document 三路各自做 BM25，然后按名次轮转合并（`entity-search.ts:855-871`）。不按分数融合，多路同时命中也不加分。所以在一路中排第 r 的候选，合并后大约落在第 3r 位。
4. **带上下文的消歧目前只能走 text 路径。** 显式 `searchMode=exact` 不接受 `terms`（`src/discovery/query.ts:251-252`）。auto 模式下只要带了 `terms`，就一律走 text 路径，把 query 和 terms 拼成一段文本做 BM25（`query.ts:254-255`）。所以调用方现在就能用 `query=锚点, terms=其他锚点` 带上下文查询，代价是放弃 exact 的名字精确匹配。

### 候选机制（未运行，等 Mac 数据区分）

| 机制 | 预期特征 |
|---|---|
| A. exact 同名歧义，按路径排序 | 响应中 `exact = "ambiguous"`；候选满足路径顺序；目标前面全是同名声明 |
| B. text 路径轮转合并 | 没有 `exact` 字段；目标在单路中名次靠前，合并后被挤后 |
| C. test 源码挤占 | 目标前面有 `src/test` 等非 main 声明，可与 A、B 叠加 |

Q07 中目标名次为 8–11，A 和 B 都能解释这个结果。Mac 结果回来之前，根因只能写作"候选机制"，不能当作结论，`src/` 的排序也不动。

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

本节在步骤 B 的任何数字产生之前提交。用户于 2026-11-12 批准 A–F 重新立项。

### 8.1 W1、W2 事实（[D15-W1.json](results/D15-W1.json)，dev 33 组，104 个目标）

- 校准通过：Q07 的 4 个目标名次为 8、8、9、11；`intentMismatchTerms = 0`。
- 默认查询 hit@1/3/8/20 = 19/19/22/25；`TOP1` 19，`EXACT_AMBIGUOUS` 0，`TEXT_MERGE` 6，`NOT_RETURNED` 78。
- `NOT_RETURNED` 中 60 个发生在 exact 路径之后，其中 34 个能被 text 路径找回。默认与 text 取较好名次：hit@3/8/20 = 29/42/59。
- 离线重排（main 优先、co-anchor）最多 +1。
- W2：product（limit 8）平均召回 38.9%，native 42.8%，配对 4 好 4 差 12 平。

推断：§6 的"大多数目标是 `NOT_RETURNED`"成立，排序不是主要瓶颈。exact 路径只返回锚点点名的声明本身，题目需要的调用方、实现和 XML 不在结果中。

### 8.2 步骤 B：合并模拟（预注册）

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

**选择规则（看数字之前固定）**
1. 按 hit@3 排序，其次 hit@8，再次 L = 8 时 exact 词 locator 字节 p50 较小者。
2. `fillAlways` 和 `interleaveAlways` 改变 R07 契约。只有在 hit@8 比 `fillAfterHit` 多至少 3 个目标、且 `lostVsBaseline[8] = 0` 时才可入选，入选后还要用户单独批准契约变更。
3. 最优策略相对 baseline 的 hit@8 增益少于 5 个目标时，不进入步骤 D，直接转向 F。
4. 选择与开发都在同一批 33 组 dev 上进行，结论只作为方向，效果以步骤 E 的封存集为准。

### 8.3 计划

| 步骤 | 内容 | 状态 |
|---|---|---|
| A | 目标去向按类别拆分、两条路径的响应大小。并入步骤 B 的输出（`hitAt8ByCategory`、`perLimit`），不再单独跑 | 并入 B |
| B | 合并模拟，§8.2 | 脚本已完成，Mac 未运行 |
| C | 依据 B 选策略；修订 §3 的 wire 规则（exact 词从 1 个候选变成最多 8 个，p50 增幅不超过 10% 必然不成立），在看封存集结果前提交 | 等 B |
| D | 在 `src/discovery/query.ts` 的 auto 模式实现选定策略；显式 `searchMode=exact` 不变，补入候选用 `matchedBy` 区分；单测、三项工程门；Mac dev 上重跑 W1、W2 | 等 C |
| E | 封存集 rules v2：主指标改为默认查询下全部 required 目标的窗口命中（limit 8），类别配比参考 B 的类别分布 | 等 B |
| F | java_impact 读取文件上限（W2 中 6 → 20 多找回 5 个目标），单独立卡 | D 之后 |

### 8.4 §7 v1 的处置

§7 规则与 `scripts/ilv2-sealed-set.mjs` 保留，v1 不生成。v2 修订主指标后换新 rules 版本。转换器的 `locate` 任务类型、`static-head` 来源与 evidence role 继续可用。

### 8.5 Mac 执行步骤（步骤 B）

不需要 build，不启动产品，不调用模型。使用 W1 的私有产物：

```bash
node scripts/ilv2-merge-simulation.mjs --dataset "$ILV2_MAC10_DATASET" --gold "$DS/private/gold-dev.jsonl" \
  --responses "$RUN/d15-w1-dev/responses.jsonl" --rows "$RUN/d15-w1-dev/rows.jsonl" --out "$RUN/d15-b-dev"
```

自检失败（exit 非 0）时停止并回传错误信息。成功时 `strategies.baseline.hitAt` 应为 19/19/·/22/25（@1/3/·/8/20），`bestOfBothHitAt` 的 @3/8/20 应为 29/42/59。summary 以 `stepB` 字段写入 `results/D15-W1.json`。

