# D19 关系后续核查（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准。离线、无模型、不调用产品：只读 D15-F 的私有产物和冻结语料源码。判读规则在 Mac 运行前固定。

## 1. 问题

D18 之后还有两个问题，答案会改变 Q05 决策的范围（[D18 §5](d18-relation-defect-shape.md#5-结果与判读2026-11-13)）：

1. **H0**：2 个直接 `implements` 锚点接口的目标不在候选池，锚点有 3 个文本上的直接子类型，池里只有 1 个带 `typeGraph:implementation-lookup`。三种解释：
   - a `PRIMARY_FILTER`：`selectPreferredImplementers`（`candidate-helpers.ts:121`）在多个实现类里有 `@Primary` 时只留 `@Primary`。这是为注入解析设计的取舍，对"有哪些实现类"的问题会丢掉其余实现。
   - b `EDGE_MISSING`：目标确实实现锚点，但跨模块的 `IMPLEMENTS` 边或查找没有把它带回来，是缺陷候选。
   - c `SAME_NAME_OTHER_TYPE`：文本层级按简单名合并，两个目标都跨模块，实现的可能是另一个同名接口。此时 D17 的"直接关系"分类本身有误。
2. **已命中的 callers**：D15-F C0 下 callers 有已计分的目标。它们是靠什么 label 和 reason 进入读取计划的？这检验 D18 §5 的说法"方法级调用方没接线，只能靠类型级弱 reason 进池"。

## 2. 方法（`scripts/ilv2-relation-followup-check.mjs`）

**H0 目标**：复用 D17 流程（`breakdown()` → C0 implementations 的 `WEAK_RELATION`/`RELATION_MISSING` → `linkForTarget`），只取 `DIRECT`。

- 解析：目标文件写出的超类型里，与锚点简单名相同的那个，按 package、单类型 import、通配 import、全限定名解析，结果为 `anchor`、`other-same-name`、`unresolved` 之一。锚点 FQN 从锚点文件本身推出（package 加类型名），不依赖声明字段；锚点文件里找不到该类型声明就报错退出。
- 语料中与锚点同简单名的类型声明数。
- 锚点的每个文本直接子类型：是否为该目标、声明前是否带 `@Primary`、是否在该锚点那次 F C0 调用的池里、是否带 `typeGraph:implementation-lookup`、是否在 `src/test/`、是否与锚点同模块、它写出的超类型是否解析到锚点。
- 池信息取自 F 记录的 C0 调用，不重跑产品。

**已命中的 callers**：C0 下 callers 类别中已计分的 Java 目标，按 F 的 label 计数；label 为 `IMPACT_SPAN` 的，取读取计划里该文件的 reason，只保留白名单（`REASON_ALLOWLIST`，同 D18）内的种类，并记是否带受保护 reason（`PROTECTED_CORE_KINDS`）。`IMPACT_SPAN` 目标在 F 的任何 C0 读取计划里都找不到时，单独计为 `impactSpanNotInPlan`，不当成"没有 reason"。

`summary.json` 只含计数和类别值；`h0-rows.jsonl` 含路径和名称，留在 Mac 私有目录。

## 3. 判读规则（看数字之前固定）

### 3.1 H0（逐目标）

| 判定 | 条件 | 去向 |
|---|---|---|
| `SAME_NAME_OTHER_TYPE` | 目标写的超类型解析到另一个同名类型 | 不是产品缺陷。更正 D17：该目标从"直接关系"移出，记为文本核查误判 |
| `PRIMARY_FILTER` | 解析到锚点；目标不带 `@Primary`；另有带 `@Primary`、且也解析到锚点的直接子类型在池中 | 设计取舍，并入 Q05 决策：查实现类时是否绕过 `@Primary` 过滤 |
| `EDGE_MISSING` | 解析到锚点，且不符合上一条 | 缺陷候选：先写跨模块合成夹具和先失败的回归测试；测试复现才按缺陷修，修复方案和评估冻结交用户确认 |
| `UNDETERMINED` | 解析不出（同包无、无 import、非全限定） | 只报告 |

### 3.2 已命中的 callers

| 条件 | 结论 |
|---|---|
| `IMPACT_SPAN` 目标里带受保护 reason 的为 0 | D18 §5 的说法成立：命中靠类型级弱 reason 或符号窗口，方法级调用方没有接线 |
| 至少 1 个带受保护 reason | 说法需要收窄：先读出该 reason 的产生路径，再提交 Q05 决策 |

`impactSpanNotInPlan` > 0 时先报告，不下结论。reason 分布只报告，不单独触发结论。

子类型的同模块标记只报告：若池中的子类型与锚点同模块、两个目标都跨模块，`EDGE_MISSING` 的回归夹具优先按跨模块构造。

## 4. Mac 执行

检出 `feat/d17-relation-text-check`。不需要构建 `dist`、不启动产品。`F_RUN` 同 D16 §4；哈希对不上就停下报告，不要重跑 F。

```bash
node --test scripts/ilv2-relation-followup-check.test.mjs scripts/ilv2-relation-text-check.test.mjs
node scripts/ilv2-relation-followup-check.mjs --dataset "$ILV2_MAC10_DATASET" --tasks "$DS/tasks-dev.jsonl" \
  --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" \
  --responses "$F_RUN/responses.jsonl" --rows "$F_RUN/rows.jsonl" \
  --expect-responses-sha256 206fe3e0e403e4c586b23310793ff80d3469df29bc0e211af5324fe0afc18a5b \
  --expect-rows-sha256 37c8967368fb4414583f21229aefdb979dd929d99491e59b6c0419765f281d7a \
  --out "$RUN/d19-relation-followup"
```

预期 `h0.targets` = 2（D18 的 H0 数）；不符就停下报告，不判读。

回传：新建 `results/D19-FOLLOWUP.json`，包含 `summary.json` 全文、定向测试 TAP 计数、源码提交；按 §3 写判读，不改 §2、§3。

## 5. 限制

- 解析是文本启发式（package、import、写出的名称），没有编译器绑定；嵌套类型和静态导入的同名类型可能判为 `unresolved`。
- `@Primary` 只看声明前的注解，不看配置类里的 `@Bean @Primary`。
- 锚点 FQN 按顶层类型推出；锚点是嵌套类型时，按 `Outer.Inner` 写的 import 会判为 `other-same-name` 或 `unresolved`。
- 池信息是 F 的记录，F 跑在 `828f8a3`；D18 已确认当前构建上 13/13 仍复现。

## 6. 结果与判读（2026-11-13）

Mac 在 `66a5380` 上运行（[D19-FOLLOWUP](results/D19-FOLLOWUP.json)）：定向测试 13/13 通过，`h0.targets` = 2，与预期一致。

**H0：2/2 为 `PRIMARY_FILTER`。**
- 两个目标写出的超类型都解析到锚点。语料中锚点简单名只有 1 处声明，排除同名误合并。
- 池中那个子类型带 `@Primary`，同样解析到锚点，并带 `typeGraph:implementation-lookup`。
- 全部直接子类型都与锚点跨模块，包括池中那个，排除跨模块边缺失。
- 两行的子类型列表相同，证据实际是 **1 个锚点**。

**机制对上代码（读代码，未运行）。**`selectPreferredImplementers` 有两个调用点：
- `candidate-collectors.ts`：锚点即接口，列它的实现类。H0 丢在这里。
- `type-reference.ts`：从锚点引用的接口推断注入的实现，`@Primary` 语义在这里合理。

**已命中的 callers（§3.2）。**
- 7 个均为 `IMPACT_SPAN`，都在 F 的 C0 读取计划里（`impactSpanNotInPlan` = 0）。
- 带受保护 reason 的为 0/7，D18 §5.1 的说法成立：方法级调用方没有接线。
- 白名单内的 reason：`typeReference` 3 个、`PACKAGE_PROXIMITY` 2 个。另有 2 到 4 个目标的 reason 不在白名单内，未记录，所以不能说"7 个都靠类型级弱 reason"。

**诊断链收尾。**D17 到 D19 的 13 个目标中没有产品缺陷：
- H3 有 7 个，2 道题，是现有设计；
- H0 有 2 个，1 个锚点，是设计取舍；
- callers 有 4 个，约 2 个锚点，是缺少能力。

后续去向见 [D18 §5.4](d18-relation-defect-shape.md#54-d19-之后的更正与决定2026-11-13)。
