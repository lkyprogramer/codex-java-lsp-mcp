# K29 与 next 两臂评测修复结果

2026-10-11。**本地修复及本轮验证已完成；K29 仍为 FAIL，严格 QA 仍未达到原 80% 门槛。** 原始评分、任务、gold、scorer 和门槛均保留。没有提交、推送、安装、部署或重建线上索引。

## 候选与比较口径

- 基线提交：`04058e43b8b2658864d0de09c8d6024e9928dfc5`。
- 修复前可执行源码摘要：`2d4f09405670e73bc655173b3ffe2ec72dc5b4beafddb396ea15c3fd4c0400d1`。
- 修复后可执行源码摘要：`594c65b1cd6b16db0a5bfb2c79c22df2841f0be558e40efba174de31612cd137`。
- 两个摘要均绑定 605 个源码、测试、脚本、fixture 与依赖描述文件。本轮改变其中 12 个文件；前轮修复没有被覆盖。
- 冻结 dataset/harness 共 149 个文件，在工作区、修复前候选和修复后候选中逐字节一致。原证据的 109 个哈希引用验证通过。
- 模型仍是 Pi 配置的 `openclaw/Qwen3.8-next`。两臂均使用 seed 1984、maxRounds 16、max completion tokens 2048、一次重复、原源码预算与完整计划分母。
- 新执行协议为 `eval-protocol/v1.3`，两臂共用修改后的原生工具、公开提示和预算处理。显式发送配置中的 `off -> none` reasoning-effort 映射，继续发送 `enable_thinking=false`；日志只证明请求设置，不证明服务端执行方式。历史运行没有显式 reasoning-effort 字段。

因此，历史 v1.2 与本轮 v1.3 的前后变化衡量整组干预，不能拆解为某一个修复的因果效果。新协议内的 product/control 比较单独报告。36 道题已经暴露，属于回归验证，不能充当独立泛化验证。

旧结果见 [原始验收报告](runtime-integrity-release-review.md)。协议的 [v1.2 原文](evaluation-protocol-v1.2.json) 与 [v1.3 原文](evaluation-protocol.json) 分别保留。

## 已完成的修改

1. 查询路径在同一 SQLite 读快照中复用 ID 解析；以有界 heap 选择 top-K，保留完整同分档、`localeCompare` 排序和缺失实体补档；非 scope postings 按主键分批读取，每批最多 256 行并受剩余 posting 预算约束。`examined` 计入完整已物化批次，`postings` 继续逐行计费。legacy 查询入口也进入读快照。
2. 修复 `preview` 转发、`anchor.path -> file` 和原生参数校验。`preview=none` 不再被适配器变成默认源码预览，错误的 `path_start` 不再被静默忽略。
3. 两臂 repair 共用 `replace_file` 精确单次替换；保留无关字节和既有写后 session rebind。编译工具按公开 POM 的生产源码根和 Java release 工作；独立模块分别处理，复杂构建明确返回 UNSUPPORTED。
4. 评测侧压缩重复 discovery 元数据，发送前按完整行执行原 QA line/byte 预算，重复源码仍计费。原始工具结果、实际模型投影和源码快照分别保留；receipt 来自实际发送内容。
5. 记录请求配置、原始响应中的必要字段、finish reason、usage、`primaryStopReason` 和 `finalAnswerMode`。强制回答不再掩盖循环终止原因。修复后的源码回执按实际候选版本独立验证，原冻结评分不改写。

独立评审中发现并修正了三处集成问题：replace_file 返回消息未被序列化器识别、批内过期少计已物化行、standalone src 符号链接越界。最终无剩余阻断 finding。

主要源码：[SQL 查询](../../src/java-index/sql/entity-search.ts)、[评测适配](../../scripts/evaluate-java-task.mjs)、[原生工具](../../scripts/eval-native-tools.mjs)、[消息序列化](../../scripts/eval-tool-wire.mjs)、[模型循环](../../scripts/run-agent-trace-live.mjs)、[请求与响应记录](../../scripts/openai-compatible-chat.mjs)。

## 离线验证

组合验证 **199/199 PASS，0 失败、0 跳过**，包含 SQL、discovery、query worker、负载执行器、评测适配、原生编辑/编译、消息与源码回执、模型循环及请求配置。

实际命令：

```sh
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --keep --profile targeted -- node --test --test-concurrency=1 'dist/java-index/sql/entity-search*.test.js' 'dist/discovery/*.test.js' dist/benchmark/measure-query-load.test.js 'scripts/eval*.test.mjs' scripts/run-agent-trace-live.test.mjs scripts/openai-compatible-chat.test.mjs
```

测试在独立候选和私有依赖、缓存中执行。另将历史 71 次 java_symbol 响应进行固定响应投影回放：229,218 -> 165,264 字节，减少 27.9%，所有源码切片完全一致。该回放不重算历史模型答案或成功率。

## 完整 next 两臂结果

28 QA + 8 repair × 两臂，共 **72 个计划尝试全部完成并评分**。实际 458 次 provider 请求，458 条对应响应记录；无 `length` 截断。一条 control 尝试达到 MAX_ROUNDS 后强制回答，该原始原因保留。预先执行的 8 题 smoke 有独立目录，不混入下表。

| 指标 | 工具臂修复前 | 工具臂修复后 | 对照臂修复前 | 对照臂修复后 |
| --- | ---: | ---: | ---: | ---: |
| 总成功 | 19/36（52.78%） | 25/36（69.44%） | 20/36（55.56%） | 27/36（75.00%） |
| 冻结严格 QA | 12/28 | 17/28 | 13/28 | 19/28 |
| 实际候选冻结修复测试 | 7/8 | 8/8 | 7/8 | 8/8 |
| 输入 tokens | 798,699 | 499,237 | 563,402 | 490,615 |
| 输出 tokens | 13,742 | 9,100 | 17,556 | 12,160 |
| 总 tokens | 812,441 | 508,337 | 580,958 | 502,775 |
| 输入减去 provider cached tokens | 154,809 | 107,989 | 86,808 | 81,359 |
| 工具调用 | 232 | 181 | 317 | 248 |
| 累计重传工具消息字节 | 1,436,099 | 716,981 | 649,486 | 529,911 |

工具臂比自身历史结果多通过 6 题，总 tokens 减少 37.4%；对照臂多通过 7 题。新协议中工具臂仍少通过 2 题，总 tokens 仍比对照臂多约 1.1%，未缓存输入也更多。不能宣称 java_symbol 提高了整体成功率或节省了费用。

56 次 QA 的实际收到源码均在原预算内；两臂 16 个 repair 的候选版本 receipt 均 VALID。原冻结 repair 诊断仍按原始不可变语料工作：product ACCESS-03 记录 390 行、budget_pass=false；control PAYMENTS-03、ACCESS-03、NOTIFICATIONS-03、LEDGER-03 保留修改后 hash 对基础语料的 stale 诊断。实际 repair 成功仍只由独立冻结修复测试决定，不能表述为所有原冻结报告均无错误。

残余失败保留原判定：

| 用例 | 本轮原始记录 |
| --- | --- |
| ACCESS-03 | 两臂实际修改并通过冻结测试，前轮未写入问题消除。 |
| GSON-01 product | 正确计算出 `a_U_R_L`，但在 JSON 前输出推演文字，严格解析失败。smoke 曾通过，正式结果仍记失败。 |
| GSON-02 | 两臂源码证据完整且预算通过，但仍返回 `Locale.ENGLISH`，未满足冻结值。 |
| PAYMENTS-02 product | 答案正确，但只使用 discovery/rg，没有读取所需 XML 源码。control 则因 JSON 后出现额外标记而失败。 |
| MYBATIS-02 control | 历史通过、本轮失败；用满 160 行仍未覆盖所需证据，保留该回归。 |

其余失败及逐题前后答案见原始对比 JSON。没有删除额外标记、剥离解释或根据 gold 修正答案。QA 分别为 60.71% 和 67.86%，仍低于原 80% 门槛。

`schedule.jsonl` 是计划行枚举；实际执行按 seeded armOrder 排序。各运行的 `actual-execution-order.json` 从首次模型请求派生，不把枚举顺序冒充实际顺序。

## K29：有收益，原门槛仍未通过

使用同机、独立修复前后候选，按 before1 -> after1 -> after2 -> before2 -> before3 -> after3 串行测量。每次保留原 1000 文件、100 样本、并发 1/5/20 与伴随更新场景；测量期间本任务没有模型运行或编译。原执行器的更新场景只定时递增 `indexedGeneration`，不改写源码或 postings，不等于真实增量建索引负载。

下表是**三次运行各自 P95 的中位数**，不是合并请求后的总体 P95。

| 场景 | 修复前（ms） | 修复后（ms） | 降幅 |
| --- | ---: | ---: | ---: |
| 并发 1 | 32.689 | 27.590 | 15.6% |
| 并发 5 | 89.111 | 58.920 | 33.9% |
| 并发 20 | 273.604 | 184.273 | 32.6% |
| 并发 20，伴随更新 | 286.798 | 188.468 | 34.3% |

| 配对 | 前：并发20 | 后：并发20 | 前：伴随更新 | 后：伴随更新 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 286.347 | 184.273 | 274.394 | 188.468 |
| 2 | 266.422 | 207.798 | 319.585 | 197.466 |
| 3 | 273.604 | 182.617 | 286.798 | 186.281 |

全部请求结算，queuePeak 最大 19；全部 event-loop P95 最大 2.271 ms，小于原 20 ms 门槛。修复后每次并发 20 的 P95 仍高于原 150 ms，三次 K29 均为 **FAIL**。并发 1 的第三对出现波动（32.453 -> 39.739 ms），因此不宣称每次单查询测量都改善。生成语料结果不代表真实生产仓库容量。

每次实际负载命令均为：

```sh
node dist/benchmark/measure-query-load.js --files 1000 --samples 100 --steps 1,5,20 --output <该次独立目录>
```

具体 argv、cwd、候选摘要、原始 JSON 和 stdout/stderr 均保存在证据包内，未调整门槛、缩小语料或增加 worker。原执行器保存分位数而未保存逐请求延迟数组；独立评审核对了未改动的分位数计算公式、报告映射和三次 P95 的中位数，不能据持久化样本独立重算每次 P95。

## 证据与未覆盖项

- [证据清单与 SHA256](k29-remediation-evidence/manifest.json)
- [完整模型前后对比](k29-remediation-evidence/raw/live-full-comparison.json)
- [K29 六次原始对比](k29-remediation-evidence/raw/k29-comparison.json)
- [完整模型请求、响应、工具结果、候选与冻结评分归档](k29-remediation-evidence/raw/live-full-raw.tar.gz)
- [离线验证原始日志](k29-remediation-evidence/raw/offline-integrated.log.txt)
- [独立证据复核](k29-remediation-evidence/raw/final-evidence-review.md)

本轮没有重跑所有发布层级，没有新增独立未揭盲样本、完整外部 public corpus 或真实生产负载验证；没有安装、部署和线上索引重建。当前数据不支持发布通过或工具臂质量优势的结论。
