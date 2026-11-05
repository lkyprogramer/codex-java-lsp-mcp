# MAC-10 / G10

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。数据集、gold、oracle 和运行证据只放在本机 work root（`datasets/mac10-v3/`、`runs/mac-10/`），不进仓库。

## 源码变更

| 提交 | 内容 |
|---|---|
| `3564ad0e` | **转换：** `ilv2-mac-eval-dataset.mjs` 把 `jin-commit-tasks/v1` 候选经人工核验后转换成冻结数据集：agent 可见的 tasks 与 answer contract；私有的 gold、repair oracle、corpus manifest；按仓库×类别分层的 holdout；内容 digest。<br>**检索：** 无模型 retrieval runner（`ilv2-mac-retrieval-eval.mjs`）只按 agent 可见的标识符规划查询，按实际收到的范围、hash 和字节计分，每个计划内 slot 都留在分母里。<br>**oracle 与比较：** JDK-only repair oracle（`ilv2-mac-repair-oracle.mjs`）；成对比较器（`ilv2-mac-paired-compare.mjs`）。<br>**身份：** `evaluate-java-task` 与 `eval-pilot-compare` 显式接收 dataset/gold/schedule 身份；缺 backend 或 dry-run 时保持 UNMEASURED，并以非 0 退出 |
| `11fcb672` | 修第一轮独立评审的 3 个 P2（见下） |
| `4592e286` | 修第二轮独立评审的 1 个 P2：隐藏测试跟随后续改名 |

## 数据集 `mac10-v3`

数据集 digest 为 `097e6628…`，共 50 题。

- **QA，45 题：** implementations、callers、spring、dto-impact、xml 五类，每类 9 题。
- **repair，5 题。**
- **分布：** 每仓 16–17 题。
- **split：** dev 33 / holdout 17，约 34%。
  - 除 exam 的 repair 层只有 1 题（固定在 dev）外，每个仓库×类别层各有 1 题进 holdout。
  - 大小为 2 的层取整后占比偏高，所以总体比例不是精确的 30%。
- **固定 dev 题：** 6 题，每仓 QA、repair 各 1。

**核验方式：**

- 每条证据范围都按冻结 HEAD 上的预期文本核对。
- 被 repair 改写的那个文件，按错误前态核对。

**repair oracle：**

- 已知错误前态必须因断言失败（TEST_FAILED），已知正确修复必须 PASS。
- 每个 oracle 重复 3 次，结果一致。
- 编译约 0.5 s，运行约 45 ms。

**隐藏测试：**

- **隐藏范围：** 每题 repair 的语料会隐藏两类测试源文件。
  - 修复 commit 自己改过的测试。用 `-M30% -l0` 一直追到 HEAD；被改名的按新名隐藏；被移出测试源集的拒绝转换。
  - 在 HEAD 上提到被修类名的测试。
- **数量：** 共 11 个，lishu-v2 6 个、lishuedu 5 个、exam 0 个。
- **原因：** 这些测试断言的正是 oracle 要判的修复后行为。

**旧版本：** `mac10-v1`（`96dfbc7c…`）和 `mac10-v2`（`87db40ec…`）都保留，各有一份 `*.superseded.json`。三个版本的 tasks、gold、oracle 和 split 逐字节相同，差别只在 answer contract 的 datasetId 和 corpus manifest。

## 独立评审

### 第一轮：`3564ad0e` FAIL

run root `20261019T092051Z` 的 broker 运行全部通过，但独立评审判 FAIL。该 root 留有 `not-composed.json` 和 FAIL 评审。

| 级别 | 问题 | 修复（`11fcb672`） |
|---|---|---|
| P2 | `evaluate-java-task --dataset` 只检查 tasks/gold 是不是数据集的某个 part，没有绑定 split 和角色：dev tasks 配 holdout gold，或者把 gold 当 tasks 传入，都能 dry-run 成功 | split 只从 tasks-* part 确定，gold 必须是同一 split 的 gold；pack identity 扁平化为 datasetId/datasetDigest/split |
| P2 | `pairedCompare` 拒绝 evaluator 真实产出的每一个 pack：identity 形状不同，schedule 行是 `{taskId, arm, repeat}`，没有 slotId/driverId。原测试用的是检索报告的结构，所以没发现 | comparator 把 evaluator 的 schedule 行归一成同一 slot id，corpusId 取自 gold；测试直接用 evaluator 的 dry-run pack：dry-run 得 UNMEASURED，measured 得 COMPARED，截断 schedule 得 REFUSED |
| P2 | repair 语料里还留着修复 commit 自带、断言修复后行为的测试 | 数据集记录每题 repair 要隐藏的测试，物化语料时先核对 hash 再删除；生成 `mac10-v2` |

### 第二轮：`11fcb672` FAIL

run root `20261019T120112Z` 同样全部通过，独立评审仍判 FAIL，剩 1 个 P2。

- **问题：** 修复 commit 改过的测试按旧路径去 HEAD 查找，后来被改名的文件会被静默漏掉。lishu-v2 有 2 个这样的文件。
- **修复（`4592e286`）：** 在整棵树上做穷尽改名检测，一直追到 HEAD；生成 `mac10-v3`。

### 第三轮：`4592e286` PASS

0 个未关闭项，4 个 P2 全部关闭。评审独立重算了 5 题 repair 的隐藏清单，与 v3 逐路径一致；149 条 gold 证据 hash 全部复核一致。11 个 P3 记为可接受限制，写入 notClaimed。

## 验证（源码 `87f98971…` = HEAD `4592e286`）

| 项 | 结果 |
|---|---|
| env-probe | READY |
| final-g10 | 57/57，含六题整链：<br>- 12/12 slot COMPLETE，MEASURED；<br>- native→product COMPARED；<br>- schedule 不匹配时 REFUSED；<br>- 5 个 oracle × 3 次都稳定；<br>- gold 泄漏检查和隐藏测试缺席检查通过 |
| regression-g10-dist | 1530/1530 |
| regression-g10-scripts | 600/601。跳过的 1 个是整链测试：没有数据集环境变量时跳过，它已在 final-g10 里运行 |
| mutation 矩阵（dev 档） | 40 个变异体，37 个被杀；3 个第一轮存活者在补测试后由对应的 b 版本取代，b 版本均被杀 |
| 独立评审 | PASS（`87f98971…`），openFindings 为空 |
| 资源与归档 closeout | PASS（另有独立复核）：<br>- 163 个登记 pid、35 个 launchd 任务全部退出；<br>- 归档 392 个文件，逐个校验 hash |

validation-index 里另有 4 行无名记录，来自 scripts 测试内部转发 `ILV2_RUN_ROOT`。这是自 G08B 起已接受的 P3，这些行不是门的运行。

## 检索结果怎么读

六题整链上，native-rg/v1 的平均 recall 为 0，product-mcp/v1 为 0.178：2 胜 0 负 4 平，delta 的 95% CI 为 [0, 0.4]。

- **三题 repair 拉低均值：** 这三题是纯症状描述。planner（`anchor-identifier/v2`）只用 anchors 和反引号片段，对它们规划不出任何查询，所以 recall 为 0、记作平局，把两边的均值都拉低了一半。
- **native 基线很弱：** native-rg/v1 只做一次单词精确搜索。
- **用途：** 这组数字说明整链能执行、计分正确，不代表 product 的检索收益。

## 未声明（摘要，完整列表见 task-result.json 的 notClaimed）

- **没有运行 agent 或模型，也没有付费调用。** evaluate-java-task 会绑定 MAC-10 数据集身份、冻结 schedule，但 MAC-10 行的 live 路径还没接通（失败即关闭）。接通 live 路径属于 MAC-15。
- **策展与核验由 AI 会话完成，不是仓库所有者。** 策展人看过 holdout 标签。建议在 MAC-15 之前由所有者抽查。
- **oracle 判定可被伪造：** 被修代码能伪造 `ORACLE PASS` 加 exit 0，子进程也没有沙箱。MAC-15 需要隔离和 nonce。
- **隐藏规则的已知漏网：** 只通过调用方间接测到被修方法、又不提类名的测试不会被隐藏。改名时被重写到相似度低于 30% 的测试会被当作已删除。

## 下一步

MAC-11（依赖 MAC-09）。MAC-13 需要 MAC-10 和 MAC-11；MAC-15 需要 MAC-10、MAC-13 和 MAC-14。
