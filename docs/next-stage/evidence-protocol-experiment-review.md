# 共享提交协议、证据单元与容量实验

2026-10-11。四阶段实施与实验完成，相关测试和独立数据审计通过。原 QA 80% 门槛仍为 FAIL；公共广域搜索暂不收缩，生产仍默认一个 worker。

## 范围与候选

按[实验计划](evidence-protocol-experiment-plan.md)分阶段实施。每阶段完成独立评审、修复和相关测试后推进；不修改原始任务、gold、评分器或门槛，不回填历史结果。

- Git 基线：`04058e43b8b2658864d0de09c8d6024e9928dfc5`；保留开始前已有的工作区变更。
- 实验前可执行源码摘要：`594c65b1cd6b16db0a5bfb2c79c22df2841f0be558e40efba174de31612cd137`。
- 当前已验证候选：`a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313`，611 个可执行源码文件。
- 原始记录目录：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-evidence-experiment-xsnbz3zg`。
- 未提交、推送、安装或部署；生产查询仍默认一个 worker。

## P1：共享提交协议

评测协议升级为 `eval-protocol/v1.4`。两臂使用同一公开键和类型生成的 `submit_answer`；助手正文保留为草稿。有效提交必须独占该响应的工具动作，只能引用此前实际派发的源码回执。最多允许一次公开格式修复，不提供 gold 反馈或答案值归一化。

源码预算在 read、preview 和后续 evidence 工具之间共享；耗尽状态和实际剩余额度显式返回。wire 裁剪后按真正保留的文本结算，重复序列化不会重复退款。独立评审修复了裁剪后的剩余预算、length 主停止原因被覆盖、审计回调失败丢失已测 usage 三项问题。

最终集成检查中 138 项通过，一项旧 e2e 请求遗漏显式 preview；仅修复该 fixture 后，整个 e2e 文件 3/3 通过。后续 P2 的累计相关验证覆盖了这些路径。

## P2：最小证据单元

增加显式实验 `java_symbol(operation=evidence)`，评测侧名称为 `java_evidence`。它从已定位的 Java TYPE 或 METHOD 返回现有 MyBatis 索引事实对应的 XML 源码单元。TYPE 的 resultMap 链路不依赖 Java Mapper 方法；METHOD 保留多个 XML 来源。普通 query 排名及公共默认预览不变。

每次最多 8 个单元、80 行、16000 源码字节；范围、整文件哈希和来源关系随结果返回。单元 `complete` 不代表任务证据完整。过期、解析失败、关联不确定、扫描或预算截断均保留明确缺口，不伪装 READY 空结果。独立评审发现并修复 METHOD 遗漏损坏 XML 的问题，实际损坏文件用例先 RED 再 GREEN。

隔离编译及 169/169 项相关测试通过，零跳过。验证包含真实 MCP、冻结评分器、TYPE/resultMap 交付、SQL 快照、源码回执、预算和 typed submission；该脚本化验证不代表模型使用效果。

## P3：双 worker 容量

显式实验配置可使用两个共享只读 worker，生产默认一个。两种配置共用最多 32 个等待请求的队列；等待中的 exact 优先。终止中的线程继续占用 slot，release/close 等待相关线程和请求结算。记录逐请求排队、实际服务、dispatch 至结算时间及进程 CPU/RSS。

独立评审和隔离集成 118/118 通过。首次实际容量运行在预热判据处失败：外层 `auto` 已解析为 worker 的 `exact`，旧判据却比较原模式。补入原始 fuzzy 查询后复现失败，再修复判据；隔离编译和 3/3 定向测试通过。原 `FAIL_SETUP` 日志保留。

修复后按单/双、双/单、单/双顺序运行三对。每次仍为 1000 个 Java 文件、每档 100 请求、并发 1/5/20，以及并发 20 下每 100ms 更新索引代数。门槛仍为查询 P95 ≤150ms、event-loop P95 ≤20ms。下表是三次运行 P95 的中位数，并非合并所有样本重新计算的 P95。

| 配置 | 并发 1 | 并发 5 | 并发 20 | 并发 20 + 代数更新 | 原门槛 |
| --- | ---: | ---: | ---: | ---: | --- |
| 单 worker | 21.814ms | 59.492ms | 188.077ms | 189.367ms | 3/3 FAIL |
| 双 worker | 22.089ms | 41.751ms | 114.804ms | 114.533ms | 3/3 PASS |

并发 20 下，平均排队时间的运行间中位数从 52.846ms 降到 30.296ms；平均实际服务时间从 9.752ms 增至 11.552ms。每 100 请求 CPU 用量中位数从 1245.304ms 增至 1518.435ms，采样 RSS 峰值中位数从 298.578MiB 增至 326.422MiB。低并发没有稳定收益。结论支持增加 reader 缓解这批请求的排队，不能解释为 SQL 每次执行变快。

独立审计核对了 2400 个测量请求、144 个预热请求、原始延迟和分位数、每类 25 请求、timing 分解、预热和最终线程关闭。event-loop 只有记录的 histogram 汇总，未保存原始 histogram。该实验使用合成 closed-wave 负载和代数更新，不是生产吞吐或真实源码增量构建验收；单 worker 的历史 FAIL 保持原结论。

## P4：模型对照

已完成原 36 题 × 两臂共 72 次，product 使用 broad；四个 smoke slot 包含在 72 次内。另完成 PAYMENTS-02、HIKARI-01、NOTIFICATIONS-01、MYBATIS-02 四题 × broad/evidence/exact-evidence × 两次，共 24 次诊断。所有题均已暴露，不据此宣称泛化。

模型为配置的 `openclaw/Qwen3.8-next`；completion cap 2048、reasoning none、thinking false、maxRounds 16。1984 仅为执行顺序 seed，provider sampling seed 未发送。模型运行使用生产默认单 worker，与容量实验分开。

| 完整对照 | native control | product broad |
| --- | ---: | ---: |
| QA 严格通过 | 12/28（42.86%） | 12/28（42.86%） |
| 修复题外部 judge 通过 | 8/8 | 8/8 |
| QA 提交格式合规 | 28/28 | 28/28 |
| QA 值符合冻结 gold | 19/28 | 16/28 |
| QA 必需证据完整 | 20/28 | 24/28 |
| QA 原源码预算通过 | 28/28 | 28/28 |
| provider prompt tokens，全部36题 | 280894 | 305678 |
| provider completion tokens | 8925 | 7804 |
| provider cached input tokens | 209868 | 212322 |
| 实测 uncached input tokens | 71026 | 93356 |
| provider 请求次数 | 178 | 145 |
| 实际工具调用，不含 submit | 164 | 139 |
| 累计工具消息字节，包含历史重传 | 214132 | 310655 |
| 完整尝试 wall 合计，包含 close | 244499.193ms | 300355.555ms |

36 个配对任务中，双方成功 17 个、仅 control 成功 3 个、仅 product 成功 3 个、双方失败 13 个。产品侧增加了必需证据覆盖，但值符合冻结 gold 的数量减少，本轮严格成功率没有提高。工具调用较少并未降低输入 token、uncached token 或工具消息重传成本。QA 失败可重叠分解为：control 仅缺证据 7、仅值不符 8、两者均不符 1；product 仅缺证据 4、仅值不符 12。

| 四题诊断，每 profile 8 次 | broad | evidence | exact-evidence |
| --- | ---: | ---: | ---: |
| 严格通过 | 1/8 | 3/8 | 2/8 |
| 必需证据完整 | 5/8 | 7/8 | 6/8 |
| 提交格式 / 预算合规 | 8/8 / 8/8 | 8/8 / 8/8 | 8/8 / 8/8 |
| prompt tokens | 57169 | 87303 | 79895 |
| completion tokens | 1556 | 2006 | 1914 |
| uncached input tokens | 19962 | 25662 | 19364 |
| java_evidence 调用 / 结果送达 / 源码单元 | 0 / 0 / 0 | 5 / 5 / 1 | 3 / 3 / 2 |
| 收到 XML 的尝试 | 0 | 2 | 2 |

PAYMENTS-02 中，evidence 第一轮通过、第二轮仍缺 Java 证据；exact-evidence 两轮均未严格通过。evidence 的两次 XML 送达只有一次来自新证据单元，另一次来自 native read；exact-evidence 两次均有新证据单元。空结果和无法解析 anchor 的工具响应没有记为源码。这个结果证明新路径实际交付过 XML，但不能声称它已稳定解决整题。

MYBATIS-02 第一轮三种 profile 均成功，第二轮 evidence 和 exact-evidence 成功而 broad 失败；HIKARI-01、NOTIFICATIONS-01 两轮三种 profile 均失败。移除 broad 的 exact-evidence 没有形成稳定的成功优势，因此保留为实验 profile，不替换公共 query，也不继续扩充 XML 语义。

96 次尝试共有 420 个 provider 请求和响应、486 个请求工具动作（含 96 个 submit）、390 次实际工具调用。96 次均有效提交，4 条正文草稿、0 次拒绝、0 次格式恢复。审计核对了计划键、实际顺序、usage、源码回执、整文件快照、真实范围和冻结评分；没有丢弃失败或补入重试。prompt/completion/cached usage 全覆盖，reasoning usage 未提供，保留 null。

模型启动器的原始 14 项离线检查通过；实际 CLI 的路径别名问题另经 RED→GREEN 修复，定向测试 1/1 通过。最初静默退出没有发出模型请求，空日志保留为未执行记录。所有模型尝试都发生在修复复审及预注册冻结之后。

## 决策与证据

保留共享提交协议和显式证据实验；保持公共广域搜索及生产单 worker 默认。双 worker 在本次合成高并发负载下有效，但额外 CPU、RSS 和低并发结果不支持直接改变生产默认。四题两轮不足以支持公共能力删除；本轮停止进一步搜索重构和证据语义扩张。

原始数据和审计交付见[证据清单](evidence-protocol-experiment-evidence/manifest.json)、[模型审计](evidence-protocol-experiment-evidence/p4/model-audit.md)、[模型独立复核](evidence-protocol-experiment-evidence/p4/final-independent-review.md)、[容量独立复核](evidence-protocol-experiment-evidence/p3/capacity-review.md)。分阶段状态记录和具体命令随证据保存。

## 验证边界

原 QA 80% 门槛、160 行/16000 字节源码预算、冻结评分及历史结果保持。旧 v1.3 和本轮 v1.4 同时存在协议与执行时点差异，不把历史分数差异归因于某一改动。未运行新盲测、完整 JDT 能力对照、生产负载、发布或部署。METHOD→XML 目前仅有离线真实 parser/SQL 验证，原 36 题没有对应模型任务。独立建索引时长没有可恢复时钟，模型实验只记录连接、首次产品查询混合耗时及完整 wall，不将其称为纯建索引时间。实际消息字节不包含工具 schema，完整 HTTP wire 未记录；token 是 provider 使用量，不是货币费用。
