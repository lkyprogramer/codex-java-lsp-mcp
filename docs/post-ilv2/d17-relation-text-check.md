# D17 关系缺失逐目标文本核查（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准。离线、无模型、不调用产品：读 D15-F 私有产物和冻结语料源码。

## 1. 问题

D16 中 16 个焦点未命中（C0 下 implementations/callers 的 `WEAK_RELATION` 12 + `RELATION_MISSING` 4）在静态路径上没有得到受保护关系 reason（[D16 §5–§7](d16-impact-miss-breakdown.md#5-结果与判读2026-11-13)）。用户日常几乎不用 JDT，静态路径即实际路径。三种可能需要区分，处理方式不同：

- 目标源码直接写着关系（`implements X`、直接调用 `x.m(`），产品却没给出：缺陷，先写回归测试。
- 关系是间接的（经抽象类或中间类型、调用发生在 gold 范围之外）：Q05 有界关系展开的范围。
- 目标与锚点没有文本联系：gold 或题目问题，不改产品。

## 2. 方法（`scripts/ilv2-relation-text-check.mjs`）

目标集合：用 D16 的 `breakdown()` 从 F 产物（哈希绑定 D15-F.json `rawEvidence`）重算，取 C0、焦点类别、原因为 `WEAK_RELATION` 或 `RELATION_MISSING` 的行。语料按 F 的方式物化（`materializeCorpus`，含 repair 前态覆盖与隐藏测试删除）。

锚点：该题 C0 下所有 exact `match` 的 impact 调用所用的声明。方法锚点的 fqn 是 `owner#member`，取 owner 的简单名和成员名。

先判不可判定的两类，不进任何规则的分母：

- `NO_ANCHOR`：该题没有 exact 锚点。
- `TYPE_ANCHOR_ONLY`：callers 目标，但该题的 exact 锚点全是类型，没有成员可查。这一类的数量同时检验 D16 §6"锚点粒度大体排除"：若 callers 目标多数落在这里，静态路径不给 `CALLS` 就是预期行为，D16 §6 和"实际使用中的缺口"的说法都要更正。summary 的 `anchorKinds` 按类别给出方法锚点、仅类型锚点、无锚点的目标数。

其余目标：源码先去掉注释和字符串/字符字面量，对每个可用锚点（callers 只用方法锚点）分类，取最好的一类（顺序如下）：

| 类 | implementations | callers |
|---|---|---|
| `SAME_FILE` | 目标文件就是锚点声明所在文件 | 同左 |
| `DIRECT` | 目标文件中某个类型头直接 `extends`/`implements` 锚点类型 | gold 行范围内有 `member(` 调用；另记 `ownerMentioned`：文件中是否出现锚点 owner 的类型名 |
| `INDIRECT` | 经语料内类型层级 2–4 跳到达锚点类型 | 文件内有 `member(` 调用，但不在 gold 范围内 |
| `MENTION_ONLY` | 文件提到锚点类型名或成员名，但不构成上面的关系 | 同左 |
| `NO_TEXT_LINK` | 都没有 | 同左 |

限制，分方向列出：

- 偏向"判成有关系"：类型层级按简单名合并，同名类型会混在一起；callers 按成员名匹配，同名方法的声明或别的类型上的同名调用（如 MyBatis-Plus 的 `save`、`list`）会被当成调用。
- 偏向"判成没关系"：匿名类和 lambda 实现不算类型头，落到 `MENTION_ONLY`；层级超过 4 跳不算；不解析 import、重载和泛型实参。

## 3. 判读规则

### 3.1 写规则时已知的量

16 个目标：implementations 9（`RELATION_MISSING` 4、`WEAK_RELATION` 5），callers 7（全部 `WEAK_RELATION`）；`RELATION_MISSING` 的 4 个来自 2 个任务组。任何文本分类结果都未知。

### 3.2 规则（Mac 运行前固定）

分母为可判定目标数（16 减去 `NO_ANCHOR` 与 `TYPE_ANCHOR_ONLY`）。

| 规则 | 条件 | 结论 |
|---|---|---|
| R_defect | 有类型证据的 `DIRECT` ≥ 3（implementations 的 `DIRECT` 都算；callers 的 `DIRECT` 要求 `ownerMentioned`） | 按缺陷处理：取这些目标写回归测试复现，定位是索引事实还是关系提供方/候选收集漏掉；属于 bug 修复，不走维护预算立项。全部 `DIRECT` 同时报告 |
| R_q05 | `INDIRECT` 超过可判定目标的一半，且来自 ≥ 2 个任务组 | Q05 有界关系展开有证据：写设计卡（不实现），先冻结评估指标与数据 |
| R_gold | `NO_TEXT_LINK` 超过可判定目标的一半 | 主要是 gold 或题目问题：不改产品，Q05 触发撤回 |
| 锚点粒度 | callers 目标中 `TYPE_ANCHOR_ONLY` 过半 | 更正 D16 §6：callers 的未命中主要来自类型锚点，不是关系识别缺口 |
| 都不成立 | — | 原因分散，记录后收尾；Q05 保持"静态路径触发"但不立项 |

`SAME_FILE`（目标就是锚点声明所在文件却没被选中）单独报告，不计入 R_gold：它更像产品问题，数量 ≥ 2 时另行说明。多条同时成立时都报告。R_defect 优先处理，因为缺陷修复后其他类的分母会变。任务组按任务的 `taskGroup` 字段计，没有该字段时按 `taskId` 计，summary 的 `identity.taskGroupField` 写明用了哪个。

## 4. Mac 执行

检出包含本节提交的分支（合入前是 `feat/d17-relation-text-check`，合入后是 `main`）。`F_RUN` 同 D16 §4。若哈希对不上，停下报告，不要重跑 F。

```bash
node --test scripts/ilv2-relation-text-check.test.mjs
node scripts/ilv2-relation-text-check.mjs --dataset "$ILV2_MAC10_DATASET" --tasks "$DS/tasks-dev.jsonl" \
  --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" \
  --responses "$F_RUN/responses.jsonl" --rows "$F_RUN/rows.jsonl" \
  --expect-responses-sha256 206fe3e0e403e4c586b23310793ff80d3469df29bc0e211af5324fe0afc18a5b \
  --expect-rows-sha256 37c8967368fb4414583f21229aefdb979dd929d99491e59b6c0419765f281d7a \
  --out "$RUN/d17-relation-text-check"
```

回传：新建 `results/D17-LINK.json`，包含 `summary.json` 全文和定向测试 TAP 计数；按 §3 写判读，不改 §2、§3。`link-rows.jsonl` 含路径和名称，留在 Mac 私有目录。若触发 R_defect，另附这些目标的私有清单路径，供写回归测试时使用。
