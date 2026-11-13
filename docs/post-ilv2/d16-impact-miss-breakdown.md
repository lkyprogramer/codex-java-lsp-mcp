# D16 java_impact 未命中拆表（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准。离线、无模型、不调用产品：只重读 D15 步骤 F 已经落盘的私有产物。

## 1. 背景与要回答的问题

D15-F 在 C0 下，implementations 命中 8/21，callers 7/16（[D15-F.json](results/D15-F.json) `dev.C0.creditedByCategory`）；C3 加大预算后 implementations 仍为 8。F 的标签（`UNSELECTED`、`POOL_ABSENT` 等）不足以判断原因，有三个混杂：

1. 锚点是 driver 第一个 java_symbol 候选，56 次调用中 25 次锚在 ambiguous 或 text 结果上（`callsByAnchorExact`）。锚点错了，候选池自然没有目标。
2. F 全部用 `semanticPolicy: "fast"`（`scripts/ilv2-impact-budget-diagnosis.mjs`），产品默认是 `auto`。
3. F 的 `unselectedByRole` 用的是输出角色。`output-v6.ts` 的 `roleOf` 没有收录 `IMPLEMENTATION`、`implementation`、`typeGraph:implementation-lookup`，只带这些 reason 的文件在输出里可能落到 `related`（推断：未核实诊断投影的 `role` 是否全部由 `roleOf` 产生），而 `read-plan.ts` 选择时把它们当受保护核心。所以 `related` 不一定是"弱关系"，角色审计给出实际数量。

要回答：implementations/callers 的未命中，是关系缺失、选择策略、锚点伪影，还是本来就是弱关系？

## 2. 方法（`scripts/ilv2-impact-miss-breakdown.mjs`）

输入是 F 的 `responses.jsonl`、`rows.jsonl`（sha256 必须等于 D15-F.json `rawEvidence` 记录的值）和 dev gold。对 C0、C3 下每个未命中的 Java 目标，按下列顺序取第一个成立的原因：

| 原因 | 条件 |
|---|---|
| `NO_IMPACT_CALL` | 该题没有 impact 调用 |
| `SELECTED_RANGE_MISS` | 文件已进读取计划，行范围没覆盖 |
| `ANCHOR_CONFOUND` | 文件不在任何调用的候选池里，且该题没有一次调用锚在 exact `match` 上：不能归因于产品 |
| `RELATION_MISSING` | 文件不在候选池里，但至少一次调用锚在 exact `match` 上 |
| `CORE_CAPPED` | 在池中未选中，带受保护核心 reason，该调用有 "Protected core exceeded" 缺口 |
| `PROTECTED_UNSELECTED` | 在池中未选中，带受保护核心 reason，无核心超限 |
| `WEAK_RELATION` | 在池中未选中，没有受保护核心 reason |

"在池中"的判断沿用 F 的口径：取第一个池中有该文件的调用。受保护核心按 reasons 近似；产品还看 `plannerEvidence`（例如 CALLS 只有 `callDepth ≤ 1` 才受保护），F 没有保留这一字段，这是已知偏差。每个未命中另记"决定它的那次调用是否锚在 exact `match` 上"（池外目标看该题任一调用）。exact `match` 只说明计划词精确命中了某个声明，不保证它就是题目要问的符号。

另做角色审计：C0 所有池中文件里带受保护 reason 的文件，按输出角色计数。

## 3. 判读规则

### 3.1 写规则时已知的量

焦点未命中 = C0 下 implementations + callers 的未命中 Java 目标。D15-F.json 的 `xmlAttribution.labelsByCategory` 已公开（本节写于看过这些数之后）：

- implementations：`NO_IMPACT_CALL` 1、`SELECTED_RANGE_MISS` 1、`POOL_ABSENT` 4、`UNSELECTED` 7（其中 F 判为 coreCapped 2）。
- callers：`SELECTED_RANGE_MISS` 2、`UNSELECTED` 7，没有池外目标。

因此池外目标（`RELATION_MISSING` + `ANCHOR_CONFOUND`）最多 4 个，`SELECTED_RANGE_MISS` 为 3。这两项只报告，不设门。

本轮才知道的量：14 个 `UNSELECTED` 中受保护与弱关系的拆分，以及每个未命中的锚点是否精确。下面的门只作用于这些量，在 Mac 运行前固定。

### 3.2 规则

门槛 5 与 W3 的实现门一致。R2、R3 只数锚点精确的行，全部行的口径同时报告。

| 规则 | 条件 | 结论 |
|---|---|---|
| R2 选择候选 | 锚点精确的 `CORE_CAPPED` + `PROTECTED_UNSELECTED` ≥ 5，且其中至少一半在 C3 下仍未命中 | 选择策略是有证据的候选改动：写设计卡（不实现），先冻结评估指标与数据 |
| R3 弱关系 | 锚点精确的 `WEAK_RELATION` ≥ 锚点精确的焦点未命中的一半 | 主要是弱关系文件落选，选择策略不改，F 的 C0 结论维持 |
| 锚点 | 锚点不精确的焦点未命中 ≥ 一半 | F 的数据主要反映 driver 首候选锚点，不足以评价产品；结论只能写成"不可判定"，是否做重放交用户决定 |
| 角色审计 | `relatedWithProtectedReason` > 0 | 登记为输出角色标注不一致（只影响输出，不影响选择）；是否修复另行决定 |

多条同时成立时都报告。全部不成立时，结论是"未命中分散，没有单一可改的原因"，implementations 方向收尾。

### 3.3 重放（不在本轮，待用户决定）

`semanticPolicy: "fast"` 和首候选锚点两个混杂作用于全部焦点未命中，本拆表消除不了。可选的定向重放（无模型）：对焦点未命中所在的题，用题面 `anchors` 经 exact 查询解析出的唯一声明作锚点（解析不唯一的题记为不可判定），分别以 `fast`、`auto`、`required` 调 `java_impact`。是否做由用户决定，不由本节规则触发。用户 2026-11-13 决定暂不做，看完本拆表结果再议。

### 3.4 条件卡 Q05、Q08

- Q05（关系缺失反复影响任务）：锚点精确的 `RELATION_MISSING` 计入 Q05 触发证据；与 Q02 一致，要求至少 2 个不同任务组。由 §3.1，本轮最多 4 个目标。fast 策略下的缺失不能代表 `auto`/`required`，所以即使达到也只记为"静态路径触发"。
- Q08（重载、继承、生成代码或 classpath 绑定错误）：需要 JDT 绑定结果，F 全程 `fast`，本拆表定不了，Q08 保持 UNASSESSED，只有 §3.3 的重放能提供证据。

## 4. Mac 执行

检出包含提交 `34a51a5`（D16 规则修订）的分支：合入前是 `docs/post-ilv2-merge-record`，合入后是 `main`。`F_RUN` 指 D15-F 的运行目录 `post-ilv2-d15-f-projection.AutSUN/d15-f-dev`（在 Mac 运行根下）。若目录或文件哈希对不上，停下报告，不要重跑 F。

```bash
node --test scripts/ilv2-impact-miss-breakdown.test.mjs
node scripts/ilv2-impact-miss-breakdown.mjs --dataset "$ILV2_MAC10_DATASET" --gold "$DS/private/gold-dev.jsonl" \
  --responses "$F_RUN/responses.jsonl" --rows "$F_RUN/rows.jsonl" \
  --expect-responses-sha256 206fe3e0e403e4c586b23310793ff80d3469df29bc0e211af5324fe0afc18a5b \
  --expect-rows-sha256 37c8967368fb4414583f21229aefdb979dd929d99491e59b6c0419765f281d7a \
  --out "$RUN/d16-impact-miss-breakdown"
```

回传：新建 `results/D16-MISS.json`，包含 `summary.json` 全文和定向测试 TAP 计数；按 §3 写判读，不改 §2、§3；R2、R3 报告两种口径。

## 5. 结果与判读（2026-11-13）

Mac 在 `4eb2de33` 上定向测试 5/5 通过，拆表退出 0；输入哈希与 D15-F.json `rawEvidence` 一致。[D16-MISS.json](results/D16-MISS.json)

**对账。**C0 焦点未命中 22 个，等于 D15-F 的 (16−7)+(21−8)。implementations 的 4 个 `POOL_ABSENT` 全部是 `RELATION_MISSING`，7 个 `UNSELECTED` 拆为 `WEAK_RELATION` 5、`CORE_CAPPED` 2；callers 的 7 个 `UNSELECTED` 全部是 `WEAK_RELATION`。与 §3.1 的已知量一致。

**按 §3.2：**

| 规则 | 结果 | 结论 |
|---|---|---|
| R2 选择候选 | 锚点精确 2 个（全部口径也是 2），都在 C3 下仍未命中；门槛 5 | 未触发，不写选择策略设计卡 |
| R3 弱关系 | 锚点精确 12/21（全部口径 12/22） | 触发：选择策略不改，F 的 C0 结论维持 |
| 锚点 | 不精确 1/22（唯一一个是没有 impact 调用的题） | 未触发。只排除了 ambiguous/text 锚点：精确 `match` 不保证锚点是题目所问的声明（例如命中类型而题目问成员） |
| 角色审计 | 696 个池中文件里 166 个带受保护 reason，其中输出为 `related` 的 1 个（`typeGraph:implementation-lookup`） | 登记 1 处输出角色标注不一致。建议不单独修（只影响输出标注），由用户决定 |
| R1、R4（只报告） | 池外 4 个全部 `RELATION_MISSING`；行范围未覆盖 3 个 | — |

**角色混杂排除（事实）。**§1 第 3 点担心 `related` 掩盖了实现关系。判据是 12 行 `WEAK_RELATION` 本身：它们在 F 保留的 `reasons` 里没有任何受保护项，与输出角色无关。

**规则之外的观察（假设，未验证）。**16 个焦点未命中（`WEAK_RELATION` 12 + `RELATION_MISSING` 4）的共同点是：在 F 记录的那次调用里，产品没有给目标文件任何受保护关系 reason。一种解释是 `fast` 策略下产品没有识别出调用或实现关系。至少还有三种替代解释，本拆表区分不了：

1. 锚点粒度：精确 `match` 可能命中了类型，而题目问的是成员，关系本就不该从这个锚点出发。
2. 首调用规则：一题有多个计划词时，脚本只看第一个池中有该文件的调用。
3. 受保护判定是近似：F 没有保留 `plannerEvidence`。

还要注意：目标属于 callers/implementations 类别的题，但每个证据范围是否就是锚点的调用方或实现类，没有逐个对 gold 核实。C3 下 callers 的 `WEAK_RELATION` 从 7 降到 2、命中多 3 个，说明预算能挪动其中一部分。implementations 在 C3 下 `RELATION_MISSING` 从 4 降到 0、`WEAK_RELATION` 从 5 升到 9，只是计数吻合，没有逐目标核对是否同一批目标。

**Q05：静态路径触发。**4 个锚点精确的 `RELATION_MISSING` 来自 2 个不同任务组（任务组数由 Mac 从私有行统计，summary 未携带），达到 §3.4 的条件，记为 `STATIC_PATH_TRIGGERED`。`fast` 的结果不代表 `auto` 或 `required`。

**Q08：**保持 UNASSESSED。

**收尾。**按 R3，选择策略不改，implementations 的选择策略方向收尾。（本段的重放设想已由 §6 更正。）上面的假设与三种替代解释，只有 §3.3 的重放能同时区分：它用题面 `anchors` 解析的唯一声明定锚（排除锚点粒度和首调用），并比较 `fast`、`auto`、`required`。重放仍为 NOT_RUN，是否做由用户决定。

## 6. 更正：重放前提与替代解释（2026-11-13，用户批准重放之后）

**前提更正（事实，读代码得出）。**§1 第 2 点、§3.3 和 §5 把 `semanticPolicy: "fast"` 当作 F 的混杂，这是错的。F 的会话由 `openProductSession`（`scripts/ilv2-ranking-diagnosis.mjs`）启动：`JDTLS_BIN=/usr/bin/false`，owner 的 `projects.json` 没有 alias，仓库未启用 LSP。`src/tools/impact.ts` 在 LSP 未启用时把策略强制为 `fast`，`required` 直接报错。所以真实条件是"评测 owner 没有 JDT"，`auto` 在 D15 全程等同 `fast`；W1、W2、F、D16 都只测了静态路径。

**§3.3 的三策略重放在现有评测框架里跑不了。**要比较 `auto`/`required`，必须给每个语料注册 `lspEnabled: true` 的 alias，并从 `ILV2_TOOLCHAINS` 取 `JDTLS_BIN`、`JAVA_HOME`；三个冻结语料在冻结工具链下有没有成功的 JDT 导入，现有记录里没有找到。`auto` 只在 service 类锚点或 `precision`/`recall` 模式下才启用 JDT（`src/agent-router/semantic.ts` 的 `shouldUseSemantic`），所以有意义的对照只有 `required`。

**替代解释的重新评估：**

1. **锚点粒度：大体排除（事实）。**计划词的第一个就是题面 `anchors`（`planQueries`），`exact: "match"` 表示该词作为精确选择器只命中一个声明（`src/discovery/query.ts`）。21/22 个焦点未命中的锚点就是题面点名的那个声明。题面点名类型、而 gold 关心某个成员的情况仍可能存在，但那是题目本身的写法，不是 driver 的伪影。
2. **首调用规则：可离线回答。**脚本新增 `protectedInAnyCall` 和 `R3_weak.protectedInAnotherCall`：弱关系目标在同一题的其他调用里是否带受保护 reason。重读 F 产物即可，不调用产品。若该数 ≥ 3，R3 的 12 需要相应扣减后重报。
3. **受保护判定近似：本轮无法回答。**诊断输出不暴露 `plannerEvidence`。

**结论。**锚点重放（不带 JDT）能增加的信息只有第 2 点，而第 2 点离线就能得到，因此不再单独写锚点重放脚本。剩下真正的问题是"有 JDT 时关系能否被证明"，需要新的 JDT 评测接线和语料导入可行性探针，成本与风险都高于用户批准重放时听到的描述，交用户重新决定。

Mac 补跑（只重读 F 产物，几秒钟）：按 §4 同样的命令重跑一次，回传时在 `results/D16-MISS.json` 增补 `rules.R3_weak.protectedInAnotherCall`。

**用户决定（2026-11-13）：不做 JDT 对照。**用户日常几乎不用 JDT，实际使用的就是评测测到的静态路径。因此 D15/D16 的结论直接适用于实际使用：16 个焦点未命中是静态路径没有证明 gold 中的调用或实现关系，这本身就是实际使用中的缺口，不需要再用 JDT 去区分。Q05 的"静态路径触发"即为实际路径上的触发证据；它只是触发证据，实施仍需用户另行批准，并按维护预算附重复失败案例与可长期维护的验证。剩余待办只有 §6 的首调用补跑。

## 7. 首调用补跑结果（2026-11-13）

Mac 在 `43259475` 上定向测试 5/5 通过，重跑退出 0，其余计数与 §5 一致。`R3_weak.protectedInAnotherCall` = 0：12 个弱关系目标在同一题的任何其他调用里也没有受保护 reason。首调用规则不是解释，R3 的 12 不扣减，§5 判读不变。

D16 收尾：选择策略不改；锚点粒度大体排除、首调用规则排除，受保护判定近似（`plannerEvidence`）仍不可答。16/22 个焦点未命中是静态路径没有证明 gold 的调用或实现关系，这是实际使用路径上的缺口，作为 Q05 的触发证据登记，不自动立项。

