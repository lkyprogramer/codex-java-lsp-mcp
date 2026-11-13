# D18 关系缺陷复现与形态（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准。无模型、无 JDT（与 D15-F 相同）：在当前构建上复现，并输出脱敏的代码形态，供离开 Mac 编写合成回归夹具。

## 1. 问题

D17 的 13 个可判定目标（`DIRECT` 6、`INDIRECT` 7）在源码上与锚点有关系，但 D15-F 的静态路径没有给出受保护关系 reason（[D17 §5](d17-relation-text-check.md#5-结果与判读2026-11-13)）。写回归测试之前要知道两件事：

1. 当前 main 上是否仍然复现。F 跑在 `828f8a3`，之后的改动只涉及 read plan，但仍要确认。
2. 每个目标的代码形态。路径和名称只在 Mac 私有数据里，合成夹具需要脱敏的形态特征。

## 2. 方法（`scripts/ilv2-relation-defect-shape.mjs`）

目标集合：复用 D17 的流程（`breakdown()` → C0 焦点 `WEAK_RELATION`/`RELATION_MISSING` → `linkForTarget`），只取 `DIRECT` 和 `INDIRECT`，并记下得到该分类的锚点。

**复现。**每个目标用该锚点调用一次 `java_impact`，参数与 D15-F 相同：`semanticPolicy: "fast"`、`mode: "balanced"`、`verbosity: "diagnostic"`、`deadlineMs: 15000`，会话同样不启用 JDT。记录：目标是否在池中、是否被选中、是否带受保护 reason、reason 种类（只保留白名单内的固定词汇，其余只计数）、锚点解析出的 profile（`target.profile`）、`freshness.coverage`、是否核心超限，以及池中带 `typeGraph`、`typeGraph:implementation-lookup`、`IMPLEMENTS`、`CALLS`、`METHOD_RELATION` 的文件数（看类型图或调用关系是否运行过）。`reproduced` 的含义是"关系仍未被证明"（不在池中，或在池中但没有受保护 reason），不是"仍未命中"。单次调用失败记为 `callFailed`，不进任何分母。

**形态（文本启发式，只含类别值）。**

- implementations：锚点类型的种类（interface、abstract-class、class、enum、record、unknown）；锚点在语料中的直接子类型数与 4 跳内的传递子类型数，以及直接子类型是否超过 `findImplementers` 的上限 20；目标连到锚点用的子句（`extends`/`implements`）及是否带泛型实参；`INDIRECT` 另记第一跳经过的中间类型种类，以及它是否与锚点同模块。
- callers：锚点 owner 的种类；gold 范围内第一个 `member(` 调用的接收者写法（static-owner、static-other、variable、this、super、unqualified、chained、method-ref、other）；接收者为变量时，其声明类型是 owner、owner 的超类型（附种类），还是其他或找不到。
- 共用：目标与锚点是否同模块（`src/` 之前的路径前缀），目标是否在 `src/test/`。

## 3. 判读规则（看数字之前固定）

### 3.1 已知量

13 个目标：implementations 9（`DIRECT` 2、`INDIRECT` 7），callers 4（全部 `DIRECT`）。复现结果、形态、profile 都未知。

### 3.2 写规则前读代码得到的事实

- `findImplementers` 最终调用 `facts-store.ts` 的 `implementers`：只查指向锚点类型的直接 `IMPLEMENTS`/`EXTENDS` 边，按类型排序后截取前 20 个。所以只查一跳是现有设计，不是偶然遗漏；`EXTENDS` 也在内，抽象基类的直接子类在类型图运行时能被找到。
- `collectTypeGraphCandidates` 注释里的"bounded, exact second hop"指的是实现类方法上的调用延续（`relationship-provider.ts`），不是传递子类型。
- 类型图只在 `shouldUseTypeGraph` 成立时运行：锚点是接口，或 profile 为 port/repository/service。锚点 profile 解析不出时默认是 `service`（`anchor.ts`），所以 H1 可能很少出现。
- 只有接口锚点的实现类才得到受保护的 `typeGraph:implementation-lookup`。

### 3.3 假设（仅对复现的目标判定）

| 假设 | 条件 | 去向 |
|---|---|---|
| H0_UNEXPLAINED | implementations，锚点种类已知，不符合下面任何一条 | 缺陷：写先失败的回归测试并修复 |
| H1_TYPEGRAPH_GATED | 锚点不是 interface，profile 不在 port/repository/service | 写先失败的回归测试；放宽门控会改变默认候选池，修复方案交用户确认 |
| H2_NON_INTERFACE_WEAK | 锚点不是 interface，profile 在上述集合内，目标带 `typeGraph` reason | 同 H1 |
| H3_ONE_HOP | implementations 的 `INDIRECT` | 只查一跳是现有设计（§3.2）。只报告，是否扩展为传递查找（即 Q05 的范围）交用户决定 |
| H_CAP | 锚点直接子类型数 > 20 | 只报告，交用户决定 |
| H_UNKNOWN_ANCHOR | 锚点类型在语料中找不到声明 | 只报告 |
| C_OWNER_BOUND | callers，接收者是 owner 静态调用，或声明类型为 owner 的变量 | 缺陷：写先失败的回归测试并修复 |
| C_OVERRIDE_FAMILY | callers，接收者变量声明为 owner 的超类型 | 属于 15 号文档的 override-family 区分，是设计问题，交用户决定 |
| C_OTHER:<写法> | callers 的其他写法（链式、无限定、this 等） | 逐个报告，交用户决定；单个目标也不丢 |

H_CAP、H1/H2、H3 可以同时成立。

### 3.4 规则

| 规则 | 条件 | 结论 |
|---|---|---|
| 复现门 | 复现目标为 0 | 当前 main 上已全部正常，记录后收尾 |
| 缺陷 | H0 或 C_OWNER_BOUND 至少 1 个复现目标 | 按缺陷修复，不走维护预算立项 |
| 需用户确认 | H1、H2、H3、H_CAP、C_OVERRIDE_FAMILY、C_OTHER | 报告形态和数量，由用户决定是否修改设计；Q05 的去留在 H3 的决定中一并处理 |

缺陷修复会改变候选池，可能影响其他题的召回和字节。修复合入前，用修复后的构建按 D15-F 的方式重放 C0（无模型），与 D15-F 对比召回和接收字节；对比的指标与门槛在修复提交时与回归测试一起固定。

## 4. Mac 执行

检出包含本节提交的分支（合入前 `feat/d17-relation-text-check`，合入后 `main`），按 D15-F 的方式构建 `dist`。`F_RUN` 同 D16 §4；哈希对不上就停下报告，不要重跑 F。

```bash
node --test scripts/ilv2-relation-defect-shape.test.mjs scripts/ilv2-relation-text-check.test.mjs
node scripts/ilv2-relation-defect-shape.mjs --dataset "$ILV2_MAC10_DATASET" --tasks "$DS/tasks-dev.jsonl" \
  --gold "$DS/private/gold-dev.jsonl" --inputs "$ILV2_MAC10_INPUTS" --server-js "$SERVER_JS" \
  --responses "$F_RUN/responses.jsonl" --rows "$F_RUN/rows.jsonl" \
  --expect-responses-sha256 206fe3e0e403e4c586b23310793ff80d3469df29bc0e211af5324fe0afc18a5b \
  --expect-rows-sha256 37c8967368fb4414583f21229aefdb979dd929d99491e59b6c0419765f281d7a \
  --out "$RUN/d18-relation-defect-shape"
```

`ilv2-relation-text-check.mjs` 在 D17 运行之后只新增了 `keyword`、`abstract`、`relations`、`anchorIndex` 字段，分类逻辑不变，D17 结果不受影响；两个测试文件一起跑以确认。

回传：新建 `results/D18-SHAPE.json`，包含 `summary.json` 全文（含脱敏的 `shapes`）、定向测试 TAP 计数、`dist` 的构建来源提交；按 §3 写判读，不改 §2、§3。`shape-rows.jsonl` 含路径和名称，留在 Mac 私有目录。
