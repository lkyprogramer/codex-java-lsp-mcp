# S1 接口锚点列出全部实现类（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准 S1 及其三项范围决定（A、1b、2a）。来源：D19 判定 H0 为 `PRIMARY_FILTER`（`feat/d17-relation-text-check` 上的 D18 §5.4、D19 §6）。本分支从 main 拉出，诊断分支可以先合入；`decisions.md` 的进度行等两个分支都合入后再补，避免冲突。

## 1. 改动

`java_impact` 的锚点是接口时，类型图原来只保留 `@Primary` 实现类（`74750ef`，V4-06）。这条规则是为注入解析设计的，但"列出接口的实现类"不是注入解析：D19 中 1 个锚点下的 2 个非 `@Primary` 实现类因此不在候选池里。

| 部位 | 行为 |
|---|---|
| 候选池（`candidate-collectors.ts`） | 接口锚点的全部主源码实现类以 `typeGraph:implementation-lookup` 进池。类锚点仍只留 `@Primary`。测试源码过滤不变 |
| 依赖展开（返回值） | 仍只用 `@Primary` 选中的实现类 |
| 备选标记（`static-provider.ts`） | 备选的 `IMPLEMENTS` 信号带内部字段 `implementationRole: "alternative"`，经 `plannerEvidence` 传到读取计划和调用延续，不进 JSON。这是备选身份的唯一载体。只标记备选，不标记首选，因为注入推断路径（`type-reference.ts`）也产生同一 reason，它不受影响 |
| 调用延续（决定 A，`relationship-provider.ts`） | 带标记的候选不做延续源：首选和回退分支都排除 |
| 读取计划（决定 1b，`read-plan.ts`） | 带标记的候选受保护核心优先级降 0.01（2.4 → 2.39，闭合被调用端口时 2.45 → 2.44）。这是绝对降级：备选不只让给 `@Primary` 兄弟，也让给所有 2.4 的文件，包括 relationship-provider 给"实现了锚点类型"的 `TYPE_RELATION`。所以 S1 之前经文本或 import 进池、原本 2.4 的非 `@Primary` 实现类，现在可能失去名额；这由 §3.2"已命中目标丢失"检验 |
| 框架种子（决定 2a） | 不改。备选可能成为 Spring/MyBatis/MapStruct 适配器的扩展种子，交评估门检验 |
| 依赖其他事实的检查 | 备选进入 `staticVerifiedCandidates`，关系检查最多多读 19 个文件，在 15 秒 deadline 内 |

最坏情况：有 `@Primary` 的接口，受保护候选从 1 个变为最多 20 个。收益未证实：H0 那次调用本已核心超限，H0 目标现在排在同级最后，"新命中 0 个"是可能的结果。另外，`rank-candidates.ts` 会让所有带实现类 reason 的文件留在输出里，compact 响应可能变大，所以 §3.2 另报调用负载字节。

## 2. 判读规则依据

D18 §3.4：缺陷修复合入前，用修复后的构建按 D15-F 的方式重放 C0，对比指标与门槛随修复提交固定。S1 不是缺陷修复（D19 判为设计取舍），沿用同一要求。数据仍是看过的 dev，只作工程门，不算封存评估。

## 3. 门槛（Mac 运行前固定，`scripts/ilv2-s1-gate.mjs`）

**3.1 机制确认（不算验收）。**在 S1 构建上重跑 D18 脚本（与 D18 同参数），预期：

- H0 的 2 个目标 `inPool` 且 `protectedReason` 为真；
- 其余 11 行的 `poolSize` 与 `poolWith` 与 D18-SHAPE（`docs/post-ilv2/results/D18-SHAPE.json`，提交 `455a049`）一致；
- H0 锚点那行的 `poolWith.CALLS` 不变（调用延续没有扩）。

不符就停下报告，不跑 3.2。

**3.2 工程门。**

第 0 步，基线核对：F 跑在 `828f8a3`，S1 从 main（`8f18ea7`）拉出，其间 main 有 read plan 的改动。先在 main 构建上按 D15-F 方式重放，预期校准 PASS；再用门脚本比较 F 与 main，预期丢失 0、新命中 0、接收字节 p50 增幅 0。成立才以 F 为 S1 的基线；不成立就停下报告，由用户重定基线（不自行改用 main 的重放）。

然后 S1 构建按 D15-F 方式重放（同脚本、同参数），只比较 C0，与 D15-F 的 C0（`rows.jsonl` sha256 `37c89673…`）对比：

| 门 | 条件 |
|---|---|
| 全量平均召回 | 不低于 D15-F（容差 1e-9） |
| 已命中目标丢失 | 0 个；丢失时逐个列出（私有文件），由用户判断 |
| 每题接收源码字节 p50 | 增幅 ≤ 20%（同 F） |

只报告不设门：分类召回（implementations、callers 等）、`partialCalls`（coverage 或 semantic 非 COMPLETE 的调用数）、`coreExceededCalls`、新命中目标、每题工具负载字节和单次 impact 调用字节。replay 产物不记录单次调用耗时，deadline 的影响通过 `partialCalls` 观察。

重放脚本的校准（C0 在 Q02 上复现 W2）在 S1 上可能失败，因为 S1 本身改变产品；失败时脚本以非 0 退出，但 `rows.jsonl` 已在校准前写出，门比较照常进行，校准结果如实记录。投影不一致（compact 与 diagnostic 选的范围不同）则停下报告。

## 4. Mac 执行

1. 检出 `feat/s1-implementation-listing`，按 D18 的方式构建：`sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile --keep --name s1-compile`。
2. 定向测试（`--profile targeted`）：`dist/agent-router/` 下 `candidate-collectors`、`candidate-helpers`、`providers/static-provider`、`providers/relationship-provider`、`read-plan`、`materialize-candidates`、`evidence-normalizer` 的测试，`dist/java-index/router-integration.test.js` 与 `router-java-index.test.js`（Linux 上因缺 `owner-lock.js` 无法运行，其中 "complete JavaIndex resolves implementation relations…" 与 "production ranking observer…" 直接经过本路径），以及 `scripts/ilv2-s1-gate.test.mjs`。期望 0 失败。
3. 机制确认：在 `feat/d17-relation-text-check` 的检出（或 worktree）里运行 D18 §4 的命令，`--server-js` 指向第 1 步的 S1 `dist/server.js`，`--out "$RUN/s1-d18"`。按 3.1 核对。
4. 基线核对（§3.2 第 0 步）：在 main（`8f18ea7`）的检出上构建，按 D15 §9.4 第 3 步的命令重放，`--out "$RUN/main-replay"`；再运行下面第 6 步的门命令，`--rows` 换成 `"$RUN/main-replay/rows.jsonl"`、`--out "$RUN/main-gate"`。不符合预期就停下报告。
5. 重放：同一命令，`--server-js` 指向 S1 构建，`--out "$RUN/s1-replay"`。
6. 门：
   ```bash
   node scripts/ilv2-s1-gate.mjs --baseline-rows "$F_RUN/rows.jsonl" \
     --expect-baseline-rows-sha256 37c8967368fb4414583f21229aefdb979dd929d99491e59b6c0419765f281d7a \
     --rows "$RUN/s1-replay/rows.jsonl" --out "$RUN/s1-gate"
   ```
7. 回传：新建 `results/S1-GATE.json`，包含构建来源提交、定向测试 TAP 计数、3.1 的逐项核对、基线核对的门 `summary.json`、两次重放的 `calibration` 块与退出码、S1 门 `summary.json` 全文。门脚本 FAIL 时也退出 0，以 `status` 为准。`target-changes.json` 和 `s1-d18/shape-rows.jsonl` 含任务 ID 或路径，留在 Mac 私有目录。

门通过后、合入前，另跑 Mac 全量 `npm test` 与 `gate:pr`（同 P6）。

## 5. 验证状态（提交时）

- Linux 定向测试：已运行并通过。用临时类型转换加载器（Node 24 `--experimental-transform-types`）直接跑 `src` 测试，不是仓库标准路径；新增用例在实现前均先失败。
- 相关测试宽集（16 个文件）：改动前后失败集合相同（18 个）。其中缺 `owner-lock.js`、缺 JDK17 编译器属环境原因；1 个 router-integration 用例是断言失败，main 上同样失败，原因未定，待 Mac 确认。
- 路由层接线（`index.ts` 经 `rankCandidatePool` 到读取计划）：无 Linux 测试覆盖，待 Mac 路由层测试。
- 类型检查：未运行（本机内存不足以跑 tsc），由第 1 步的编译覆盖。
- Mac：未运行。
