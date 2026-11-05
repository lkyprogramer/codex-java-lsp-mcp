# P5 independent locked 实际结果独立评审

结论：**PASS / INDEPENDENT_LOCKED**。本结论只绑定本次冻结源码和 24 个真实 slot。发现 2 个真实模型修复失败，未发现由产品检索、宿主输入或判定接口引入的新增 critical regression。失败原样保留。

| 范围 | control | product |
|---|---:|---:|
| 新 QA | 9/9 | 9/9 |
| 新 repair | 2/3 | 2/3 |
| 实际 slot | 12/12 | 12/12 |

原 QA floor 0.8 保持不变。新 3 个 repair 补充组不替代原 8 个 frozen repair groups；不增加新 repair 必须 100% 的门槛。原 8 组是否通过继续引用原 release evidence，本评审未重跑或重新认证它们。

## 发现与归因

**模型候选缺陷，置信度高：HLR-PARCEL-R1，block-19 control / block-20 product。** 两臂模型实际提交的 `src/main/java/holdout/parcelgrid/BinCounter.java:5` 都为 `(parcels + binSize - 1) / binSize`。该表达式在合法的较大 int 输入下会发生中间加法溢出，无法保证结果满足公开任务合同。缺陷位于模型生成的候选源码。

这项归因不依赖“两臂同败”：已逐项核对完整初始源码确实进入后续模型请求；product 的定位结果具有正确路径、声明位置和文件哈希；原始 `replace_file` 参数与最终候选逐字相符；模型可用的 `test` 返回 `COMPILED`，没有声称业务测试通过；私有原 judge 的实际编译 exit 0、业务运行 exit 1，失败为业务断言，非超时、输出限制或宿主异常。公开 safe receipt 的候选树、进程回执及原 artifact / verdict SHA 与私有原件一致。

最小处理：保留两条 `TEST_FAILED` 和 2/3 分母，不修补、筛除、重跑或调参本次冻结样本。后续模型能力改进应另开版本和独立评测，不回写本次结果。

**辅助指标限制，非阻断：block-20 / block-24 的 repair 检索评分 `valid=false`。** 原冻结检索 scorer 将读回执与初始 corpus 比较，模型补丁后读取会出现 stale hash / source range 错误。block-20 对应最终候选的重读；block-24 对应中间补丁版本的重读，其后还有两次修改。已按原始工具顺序在内存中比对 8 次修改与全部读取，各版本 snapshot 和最终候选都一致。这是辅助检索指标的版本边界，不是源码交付错误。scorer 的 repair_pass 固定为空，实际 repair 成败来自外部原 judge；canonical 保留该判定。不得将报告概括为“24 条检索评分全部 valid”。

另有 3 次模型 `rg` 参数指向不存在的 corpus 相对路径（block-13/23/24），均明确返回 PATH_NOT_FOUND 后恢复；block-08 有一次普通文本草稿，使用冻结合同允许的一次类型化提交恢复。这些调用及成本全部保留，没有删除失败过程或追加重跑。

## 已验证的证据链

- 24 个唯一计划 slot 与 schedule、execution、completion、attempts、canonical pack 一一对应；24/24 完成，missing 0。逐 block 的原 scorer 报告按完整 12 任务宇宙展示 11 个 MISSING，聚合只取该 block 的计划 slot，不把这些占位行混入最终分母。
- 112 组模型请求响应、95 个非提交工具结果及 24 个类型化提交逐项绑定；请求 payload SHA、工具原始 SHA、模型实际收到的内容 SHA/字节数、参数、响应接续、提交 schema/类型/键/约束和最终答案映射一致。
- 45 条 SOURCE_RECEIVED、每次 attempt 去重合计 40 个 snapshot 已校验文件 SHA 和逐字源码范围；54 个 product 声明 locator 与公开源码的位置和哈希一致。全部读取与 8 次模型修改按时间顺序核对通过。
- 18 个 QA 私下核对 50 个答案字段以及完整证据覆盖；未公开任何 gold 值或必需坐标。原冻结 QA 判定与 canonical 一致。160 行 / 16000 字节预算保留；本次最大实际接收为 34 行 / 1303 字节。
- 请求参数为 `openclaw/Qwen3.8-next`、`broad`、`max_tokens=2048`、`reasoning_effort=none`、`enable_thinking=false`；16 rounds、ordering seed 1984、单次 paired run 及默认单 worker 绑定未变。112 份 provider usage 原始记录及其 SHA、聚合字段均一致。
- control 累计 input/output/cached tokens 为 100123 / 2899 / 77923；product 为 120888 / 2676 / 85652。缓存 token 是 input 子集，不重复相加。
- 冻结源码 611 文件、public inputs / interface、launcher / executor 和 79 私有冻结文件及 seal 未漂移。6 份候选树、原 test SHA、wrapper SHA、原 artifact / verdict 与 safe receipt 全部一致。6 份编译成功；4 份原业务通过且 completion guard 为真，2 份业务失败且 guard 为假。原运行使用 6 个不同 nonce。
- 6 份私有 verdict 为 0600，所在目录为 0700；公开模型 payload 的私有判定标记扫描通过。公开报告不包含私有测试、原诊断、参数或 nonce。

QA 的 `answerStatus=NO_GOLD` 是空 gold runtime 产生并保留的 preliminary 标签；最终权威为 `frozenScore` 与更新后的 `taskSuccess`。这 18 个 QA 的真实冻结判定均通过，未将 preliminary 当成最终结果。

## 验证边界与剩余风险

本次只读审计已有证据，没有再次运行 model、score、judge、工程测试或 benchmark，没有修改 source、seal、raw 或原评分结果。临时核对脚本的初版假设曾将 preliminary、恢复请求及 repair 辅助指标当作最终字段；依据原调用链纠正后完成核对，未更改任何业务断言或真实结果。

请求日志保存工具名称；完整工具 schema 来自冻结 preregistration 与绑定的生成代码，未取得独立 provider 网络抓包。nonce 临时文件随原 judge 工作目录清理，本次校验的是原始运行参数、冻结 wrapper 逻辑及原 completion 标记，未声称重新执行 guard。人工 authored 三个 corpus、单次配对只支持该样本结论，不证明线上发生率、统计优势或生产环境安全。后续汇总需保留上述失败和辅助指标限制。

## 固定身份

- Source digest: `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`
- Results pack SHA-256: `d88449ef2e3926b300877d066d2c8f3fcf4e9da9d31300591a1407965716927e`
- Private seal: `259a0d158e1fc300f3533816769ad2e304ef98ca996a9d1d7b24b8872d9248d7`
- 原始公开证据：[preregistration](execution/preregistration.json)、[completion](execution/run/completion.json)、[canonical pack](execution/run/results-pack.json)、[attempts](execution/run/attempts.json)。逐项结构化结论见 [results-review.json](results-review.json)。
