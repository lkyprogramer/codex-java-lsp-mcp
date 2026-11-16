# S1 接口锚点列出全部实现类（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准 S1 及其三项范围决定（A、1b、2a）。来源：D19 判定 H0 为 `PRIMARY_FILTER`（`feat/d17-relation-text-check` 上的 D18 §5.4、D19 §6）。本分支从 main 拉出；诊断分支（PR #6）合入后已把 main 合入本分支，进度见 `decisions.md` P11。

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

第 0 步，基线核对：F 跑在 `828f8a3`，S1 从 main（`8f18ea7`）拉出，其间 main 的 `src` 有两个提交改了 impact 与 symbol 输出（`504a5d6`、`bb34f73`）。先在 main 构建上按 D15-F 方式重放，预期校准 PASS；再用门脚本比较 F 与 main，预期丢失 0、新命中 0、接收字节 p50 增幅 0。成立才以 F 为 S1 的基线。

不成立时**不停止**（2026-11-13 Mac 运行前修订：原规则"停下报告"在单次后台运行中会让 S1 一个数都没测）：S1 照常重放并与 F 比较，另加只报告的"S1 对 main"比较（同一门脚本，基线为 main 的重放，哈希运行时计算）。此时终态为 FAIL、`baselineMatchesF` 为 false，以哪个基线判门由用户决定。

然后 S1 构建按 D15-F 方式重放（同脚本、同参数），只比较 C0，与 D15-F 的 C0（`rows.jsonl` sha256 `37c89673…`）对比：

| 门 | 条件 |
|---|---|
| 全量平均召回 | 不低于 D15-F（容差 1e-9） |
| 已命中目标丢失 | 0 个；丢失时逐个列出（私有文件），由用户判断 |
| 每题接收源码字节 p50 | 增幅 ≤ 20%（同 F） |

只报告不设门：分类召回（implementations、callers 等）、`partialCalls`（coverage 或 semantic 非 COMPLETE 的调用数）、`coreExceededCalls`、新命中目标、每题工具负载字节和单次 impact 调用字节。replay 产物不记录单次调用耗时，deadline 的影响通过 `partialCalls` 观察。

重放脚本的校准（C0 在 Q02 上复现 W2）在 S1 上可能失败，因为 S1 本身改变产品；失败时脚本以非 0 退出，但 `rows.jsonl` 已在校准前写出，门比较照常进行，校准结果如实记录。投影不一致（compact 与 diagnostic 选的范围不同）则停下报告。

## 4. Mac 执行（单分支、一次后台运行）

全部在 `feat/s1-implementation-listing` 上完成：本分支已合入 main（含 D18 脚本、D15-F 重放脚本、门脚本），不需要切换分支。基线构建也在本分支上做：`scripts/ilv2-s1-mac-run.mjs` 在工作区临时把 `src` 反向打成 main（`3d9a8d6`）的样子，构建后立即恢复。

`scripts/ilv2-s1-mac-run.mjs` 按[长时间验证规范](../deep/ilv2-mac-manual/long-running-validation.md)运行：每阶段独立日志、退出码、超时和检查；`status.json` 每 30 秒心跳；终态写 `result.json`。

| 阶段 | 内容 | 超时 | 失败后 |
|---|---|---|---|
| `preflight` | 工作区干净；HEAD 含 `63a2257` 与 `3d9a8d6`；F 产物哈希 | 2 分 | 停止 |
| `baseline-build` | 工作区 `src` 临时改为 main 后 compile（`--keep`），然后恢复 | 40 分 | 停止 |
| `s1-build-targeted` | S1 构建（`--keep`）并跑脚本中 `TARGETED_TESTS` 的 13 个 dist 测试文件（含 Linux 跑不了的 router-integration、router-java-index） | 60 分 | 继续；构建不在时依赖它的阶段记为不可运行 |
| `script-tests` | 5 个脚本测试文件 | 10 分 | 继续 |
| `mechanism` | S1 构建上重跑 D18，按 §3.1 逐行比对 `results/D18-SHAPE.json` | 45 分 | 停止 |
| `main-replay` | main 构建按 D15-F 重放，须完成评分且校准 PASS | 240 分 | 继续 |
| `main-gate` | 门脚本比较 F 与 main：丢失 0、新命中 0、字节增幅 0（§3.2 第 0 步） | 5 分 | 继续 |
| `s1-replay` | S1 构建重放；校准失败（非 0 退出）属预期，但须完成评分 | 240 分 | 停止 |
| `s1-gate` | 门脚本比较 F 与 S1（§3.2） | 5 分 | 继续 |
| `s1-vs-main` | 只报告：门脚本比较 main 与 S1 | 5 分 | — |

终态 `PASS` 要求每个阶段都通过且 S1 门 `status` 为 PASS。任何异常、超时（先 SIGTERM，10 秒后 SIGKILL 整个进程组）或收到 SIGTERM/SIGINT 都会恢复 `src` 并写出 `result.json`（终态分别为 FAIL、TIMEOUT、INTERRUPTED），后续阶段记入 `notRun`。

**步骤：**

1. 准备：
   ```bash
   cd <Mac 上的仓库>
   git fetch origin && git checkout feat/s1-implementation-listing && git pull --ff-only
   git status --porcelain            # 必须为空
   # 下面 7 个变量沿用 D15/D16 的取值，但必须 export（运行器从环境读取，未 export 的 shell 变量读不到）
   export ILV2_NODE_BIN=... ILV2_RUNTIME_MANIFEST=... ILV2_MAC10_DATASET=... ILV2_MAC10_INPUTS=...
   export DS=...        # 数据集目录，含 tasks-dev.jsonl 与 private/gold-dev.jsonl
   export F_RUN=...     # D15-F 运行目录（post-ilv2-d15-f-projection.AutSUN/d15-f-dev）
   export Q02_IDS=...   # Q02 schedule 的 20 个 taskId，逗号分隔
   RUN=<Mac 运行根>/post-ilv2-s1-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M)
   mkdir -p "$RUN"                   # 必须在仓库外
   ```
2. 后台启动（运行期间不要在这个仓库里切分支或改文件）：
   ```bash
   nohup "$ILV2_NODE_BIN" scripts/ilv2-s1-mac-run.mjs --run-dir "$RUN" > "$RUN/runner.log" 2>&1 < /dev/null &
   sleep 5 && cat "$RUN/status.json"  # 确认首条状态已落盘；pid 记在 status.json 里
   # 不要往 $RUN 里写别的文件：运行器要求启动时目录里只有 runner.log
   ```
3. 查看进度：`cat "$RUN/status.json"`（当前阶段、阶段起点、心跳；心跳超过 2 分钟没更新说明运行器已退出）；`tail "$RUN/<阶段>.log"`；`cat "$RUN/events.jsonl"`。`result.json` 出现即结束。需要中止时 `kill <status.json 里的 pid>`，运行器会恢复 `src` 并写 INTERRUPTED 终态。
4. 生成回传文件并提交：
   ```bash
   "$ILV2_NODE_BIN" scripts/ilv2-s1-mac-run.mjs --report "$RUN" > docs/post-ilv2/results/S1-GATE.json
   git add docs/post-ilv2/results/S1-GATE.json && git commit -m "docs(eval): record S1 gate results" && git push
   ```
   `S1-GATE.json` 只含计数、状态和哈希。`$RUN` 下的 `s1-d18/shape-rows.jsonl`、`*-gate/target-changes.json`、各重放目录含路径或任务 ID，留在 Mac。

中断恢复：如果运行器被 `kill -9` 或机器重启，`src` 可能停在 main 的样子，先执行 `git checkout HEAD -- src`、确认 `git status --porcelain` 为空，再换一个新的 `$RUN` 重跑。

门通过后、合入前，另跑 Mac 全量 `npm test` 与 `gate:pr`（同 P6）。

## 5. 验证状态（提交时）

- Linux 定向测试：已运行并通过。用临时类型转换加载器（Node 24 `--experimental-transform-types`）直接跑 `src` 测试，不是仓库标准路径；新增用例在实现前均先失败。
- 相关测试宽集（16 个文件）：改动前后失败集合相同（18 个）。其中缺 `owner-lock.js`、缺 JDK17 编译器属环境原因；1 个 router-integration 用例是断言失败，main 上同样失败，原因未定，待 Mac 确认。
- 路由层（`rankCandidatePool` 到读取计划）：无 Linux 测试覆盖，待 Mac。§3 点名的两个用例（"complete JavaIndex resolves implementation relations…"、"production ranking observer…"）都在 `router-integration.test.js` 里。
- 运行器（`scripts/ilv2-s1-mac-run.mjs`）：纯函数与引擎测试已运行并通过（prepare 失败、超时、后代进程占管道、不可运行阶段、报告脱敏）；按 §4 第 2 步原样在 Linux 冒烟运行（`F_RUN` 不存在），得到 preflight FAIL、其余 9 个阶段 notRun、`--report` 正常输出。基线补丁的应用与恢复在临时 worktree 中演练通过。真实构建与重放阶段未在 Linux 执行。
- 类型检查：未运行（本机内存不足以跑 tsc），由第 1 步的编译覆盖。
- Mac：提交时未运行，结果见 §6。上面"待 Mac"的两项（router-integration 断言失败、路由层用例）已由 Mac 结果关闭。

## 6. Mac 结果与判读（2026-11-16）

S1 门在 `d5843ae` 上运行（[S1-GATE](results/S1-GATE.json)），10 个阶段全部 PASS，`baselineMatchesF` 为 true。全量工程门在 `7f27667` 上运行（[S1-MAC-GATES](results/S1-MAC-GATES.json)），两者之间 `src` 只改了 `http-server.test.ts`（`43e1c5c`，按别名固定 fixture JDK，断言不变）。分支（头 `7f27667`）以快进方式进入 main，没有 merge commit；之后 main 上另有两个只改文档的提交（`1400341` 记录本表的全量门结果，`785ea4e`）。

| 项 | 结果 |
|---|---|
| §3.1 机制 | PASS：H0 的 2 个目标带受保护 reason 进池，其余 11 行不变，H0 锚点的 `CALLS` 未扩 |
| 第 0 步基线 | main 复现 F：丢失 0、新命中 0、接收字节 p50 增幅 0；main 与 S1 的 Q02 校准都复现 W2（0.38917，全召回 3 题）。main 的 compact 负载比 F 合计多约 145 字节，不在门内 |
| §3.2 门（F 对 S1） | PASS。平均召回 0.4242 → 0.4444，全召回题 5 → 6，已命中目标 52 → 54（新增 2 个都在 implementations），丢失 0，接收字节 p50 15154 不变 |
| 只报告项 | `coreExceededCalls` 11 → 11，`partialCalls` 0 → 0。相对 main，33 题接收源码合计多约 1.1KB，56 次 impact 调用的 compact 响应合计多约 140 字节 |
| Mac `npm test` | PASS：2471 个，通过 2461，失败 0，跳过 10（与 P6 白名单一致） |
| Mac `gate:pr` | PASS：1665 个，通过 1664，失败 0，跳过 1（既有的 48 小时 GC 用例） |

判读：

- §1 预判的"新命中 0 个"和 §3.2 担心的"main 对不上 F"都没有发生；§3.2 的修订规则未触发。
- (推断) 新命中的 2 个就是 D18 的两个 H0 目标：召回和增加 2/3、全召回多 1 题，符合同一道 3 目标题从 1/3 到 3/3，且机制检查已证明 H0 目标进池。目标身份只在 Mac 私有的 `target-changes.json` 里，这里未核对。
- PASS 的含义是"已知缺口补上，其他行为没变"。新命中的正是促成本改动的那批 dev 目标，不能当作召回收益；§1 的最坏情况（有 `@Primary`、实现类很多的接口）dev 没有覆盖，这次的成本数据不能外推到那种情况。
- §5 里 Linux 上失败的 router-integration 用例在 Mac 上通过（dist 0 失败、唯一跳过是 48 小时 GC 用例），(推断) 属本机环境原因（缺 JDK17 等），Linux 上未进一步定位。
