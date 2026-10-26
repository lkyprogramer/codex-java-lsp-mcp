# MAC-13 / G13

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。全局 guidance 只以 guidance.diff 交付（仓库内为 [guidance-diff.json](guidance-diff.json) 的 `diff` 字段），**未应用**到 `~/.codex/AGENTS.md`，应用需要另行授权。数据集、运行证据和 Tier-0 质量报告只放在本机 work root（`runs/mac-13/`、`runs/dev-mac13/`），不进仓库。

## 源码变更

| 提交 | 内容 |
|---|---|
| `477745d4` | 每个静态结果的 `indexView` 标明所用视图：新增 `contentManifestId`、`workspaceId`；`java_impact` 也带 `indexView` |
| `34fe3f6a` | 公共结果改用 mac1 `symbolId` 与 `stability`；`java_symbol` 接收 `symbolId`；`java_impact` 接收 `symbol=`（symbolId 或名称）；mac1 之前的 ID 一律 REJECTED 并给出重新定位提示 |
| `f8a7ed1c` | D08②：Spring/MapStruct/MyBatis adapter 按源码上下文解析类型名（同 module/sourceSet → test 看自身 main → 其他 module main；同级多个 → AMBIGUOUS）；三类旧式查找键与 alias map 删除 |
| `252ca5d7` | README、hook 与 tools/list 说明：去掉“先调 java_status”前置条件，教 `symbol` / `symbolId` / `indexView` 新鲜度 |
| `ce7c926c` | evidence handle 只给 SNAPSHOT（局部/匿名）声明，命名声明只带 symbolId（payload +46% → +14%） |
| `f9ef881e` | 第一轮评审修复（见下） |
| `e7d983d1` | 第二轮评审修复 |
| `c90d9204` | 第三轮评审修复 |

## 公共 schema 变化（破坏性，用户 2026-10-26 批准）

- **ID：** locator id 换成 `jsym:mac1:<workspaceId>:<base64url(declarationKey)>`。同一 workspace 内未变的命名声明跨无关发布保持同一 ID；签名或路径变化后返回 `NOT_FOUND`（`DECLARATION_CHANGED`）和重新定位提示，不重新绑定。局部/匿名声明 `stability=SNAPSHOT`，只给 `jev:mac1:` evidence handle；把 handle 当 symbolId 传入会得到专门的 REJECTED 提示。
- **名称：** 保留 `indexView` 这个名字（扩展字段，而不是改名为 `index`）：分析器与约 10 个 gate 测试依赖它。
- **歧义与缺口：** 多个声明匹配时返回 `AMBIGUOUS` 候选（最多 10 个，超出标 `truncated`），不跑分析、不猜。视图非 FRESH 或不允许否定查找时，未命中返回 `NOT_READY` 而不是 `NOT_FOUND`。
- **签名选择器 `Type#method(ParamType, ...)`：** 按解析出的参数事实比较（数组维数、varargs、类型变量 erasure、嵌套 `Outer$Inner`、注解参数），每个候选判 yes/no/maybe；只有唯一 yes 且没有 maybe 时选定，maybe 一律列为候选。只有 import、`java.lang`、外层作用域或仓库确定解析才算证明 FQN；源码部分限定（如导入 `Map` 后写 `Map.Entry`）或通配/仓库唯一简单名推断出的类型不会被判为“不存在”。

## 质量（Tier-0，无模型）

数据集 `mac10-v3`（`097e6628…`），基线 `3ffcf868`，候选 `ce7c926c`。之后的提交只改 `symbol=` / `symbolId` 路径，第 2–4 轮评审确认复用成立。

| 项 | 基线 | 候选 |
|---|---|---|
| dev product recall | 0.3929 | 0.3929 |
| holdout product recall | 0.4118 | 0.4118 |
| evidence coverage（dev / holdout） | 49/104、18/45 | 49/104、18/45 |
| wrongHash | 0 | 0 |
| 6 个 pilot | — | 6/6 通过 |
| repair oracle | — | known-bad TEST_FAILED ×3，known-good PASS ×3 |
| standard 输出 payload（dev） | 279,046 B | 317,845 B（+14%） |

read plan（F 部分）不改：重复读取来自跨调用的调用方行为，见私有 `plans/mac-13/f-read-plan-decision.md`。

## 独立评审

| 轮次 | 候选 | run root | 结论 |
|---|---|---|---|
| 1 | `ce7c926c` | `20261026T122314Z` | FAIL，4 个 P2 |
| 2 | `f9ef881e` | `20261026T131645Z` | FAIL，2 个 P2 |
| 3 | `e7d983d1` | `20261026T165742Z` | FAIL，1 个 P2 |
| 4 | `c90d9204` | `20261026T173236Z` | PASS，3 个 P3 接受 |

三个 FAIL 的 run root 中 broker 运行全部通过，各自保留 FAIL verdict 与评审。

- **第 1 轮：** `java_impact symbol` 长度上限低于实际 symbolId 长度；STALE 视图或禁止否定查找时名称未命中报 `NOT_FOUND`；`Type#method(sig)` 未被 exact 选择器使用；README 仍要求先调 `java_status`。
- **第 2 轮：** 签名比较用的是 erased key，其数组写法把源码维数重复计入，数组参数永不匹配、还可能选错重载；README/hook 声称 `repoRoot` 不会解析到其他仓库，但构建根上溯可能落到外层 Maven 聚合工程。
- **第 3 轮：** EXTERNAL/QUALIFIED 解析携带的是源码写法而非 FQN，`Map.Entry` 用全名查询时在 FRESH 视图上误报不存在（第 2 轮修复引入的回归）。

## 验证（源码 `fc7a3ccd…` = HEAD `c90d9204`）

| 项 | 结果 |
|---|---|
| env-probe | READY |
| final-g13 | 170/170：MAC-13 定向套件 + MAC-10 六题整链（native 与 product，repair oracle ×3） |
| regression-g13-dist | 1594/1594 |
| regression-g13-scripts | 638 通过，10 跳过（依赖环境），0 失败 |
| rerun-g13（全新构建） | 170/170 |
| 独立评审 | PASS（`fc7a3ccd…`） |
| 资源与归档 closeout | PASS：归档 413 个文件，sha `2881b13b…` |

validation-index 里另有 scripts 测试内部写入的嵌套 fixture 记录（另一个 sourceDigest），自 G08B 起作为 P3 接受，不是门的运行。

## 已知限制

- C 风格 `String a[]` 的维数不进索引（抽取器既有问题；erased key 也重复计入源码数组维数）。两者都涉及持久化 key，归 MAC-12；README 指引此时改用 symbolId。
- 类型参数的 bound 不解析，按更完整的 FQN 比较时判 maybe（列为候选，不选定）；静态嵌套类也会查到外层类型的类型变量。
- `repoRoot` 解析行为未改：worktree 嵌在另一个 Maven/Gradle 工程目录下时可能解析成外层工程，guidance 要求先用 `java_status` 核对；结果本身不携带解析出的根。
- 只做了无模型检索评估，没有运行 agent 或模型，benefit 仍为 UNMEASURED。
- D08① 仍由 MAC-07 + MAC-08B 负责。

## 下一步

MAC-12 最终验证（成对 Tier-0 page-size A/B + 安静主机上 3 条 Tier-1 链）完成后再进入 MAC-14；MAC-15 需要 MAC-10、MAC-13 和 MAC-14。
