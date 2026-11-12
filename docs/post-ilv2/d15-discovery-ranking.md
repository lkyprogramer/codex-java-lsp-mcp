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

**封存检索集**
- 在 W1 的 Mac 结果出来之前，先固定抽样规则，作为 D15 的一部分提交。
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
| W1 | 排名诊断 | 代码层事实，本节下方；`scripts/ilv2-ranking-diagnosis.mjs`；Mac 上的聚合结果 | 代码事实和脚本已完成，Mac 未运行 |
| W2 | 在 limit 8 下重测基线，并补测 UNMEASURED | 检索 runner 报告与 ledger | 未开始 |
| W3 | 排序改动 | 按 W1 中实测余量最大的机制选择，只在 dev 上开发 | 等 W1 |
| W4 | 构建封存检索集 | 数据集、抽检记录、身份冻结 | 等抽样规则提交 |
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
