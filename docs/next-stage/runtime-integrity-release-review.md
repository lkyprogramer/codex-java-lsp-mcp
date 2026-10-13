# Runtime integrity 修复与 R12/R13 验收

日期：2026-10-11。**本地修复完成；R12 为 31 PASS / 1 FAIL，R13 发布资格为 NO_GO。** 未提交、推送、安装、部署或重建线上索引。

基线提交：`04058e43b8b2658864d0de09c8d6024e9928dfc5`。候选未提交，不能只用基线 SHA 标识补丁；最终 605 个可执行源码、测试、脚本、fixture 和依赖文件的摘要为 `2d4f09405670e73bc655173b3ffe2ec72dc5b4beafddb396ea15c3fd4c0400d1`。工作区与隔离候选逐文件一致。

## 本轮变更

- 索引重建保留 schema、identity、facts 与 encoding 元数据。完整遍历标记和实际成功／失败计数共同控制 READY；局部 refresh 不再把未完成的库提升为完整状态。中断恢复对账 Java 与 XML，先完成所有引用解析再建边。
- 合入已安装版本的 JDT 子进程回收路径，并修复存活进程的 lease、heartbeat 和机器容量提前释放。实际退出或回收完成后才释放，晚到 exit 只释放一次。
- 补齐局部／嵌套类和 compact record constructor；无 FQN 局部类保留位置身份，避免不同方法中的同名类互相覆盖。覆盖解析使用已解析参数类型，增量 override 更新同时处理父类内部自调用。
- 恢复以 declaration.selection 和原始 preview 字节验证真实 JDT 的定位探针，严格保留 LF／CRLF。新增 K01–K32 执行器，保留原层级、未运行／失败状态和 raw SHA；跳过、零匹配或候选漂移不得通过。

保持 SQLite、Tree-sitter、单个有界查询 worker、按需 JDT 和五个公开工具。没有重开 dense 或 declaration.range 实验；没有 embedding 调用。schema 仍为 v9，facts revision 升到 5；未来安装此候选后，旧静态事实需要正常重建，不能沿用旧 READY 声明。

主要路径：[`index-builder`](../../src/index-builder/)、[`SqlJavaIndexClient`](../../src/java-index/sql/sql-client.ts)、[`JdtlsSession`](../../src/jdtls-session.ts)、[`RepoRuntimeManager`](../../src/repo-runtime-manager.ts)、[`graph-builder`](../../src/java-knowledge/graph-builder.ts)、[`K runner`](../../scripts/run-release-contracts.mjs)。

## 已执行验证

| 验证 | 观察结果 |
| --- | --- |
| 隔离 release profile | 1335/1335 源码测试、368/368 脚本测试、stdio smoke 与独立 38491 端口 HTTP 五工具 smoke 通过 |
| 后续验收脚本修正 | 18/18 定向测试通过；没有生产源码变化 |
| 原始源码探针／审计反例 | 12/12、27/27 通过 |
| 冻结包及自检 | 357 文件校验通过；dataset、unit、repair-oracles、upstream、faultcheck 五层通过 |
| 真实 MCP／watcher | 7/7 通过；删除前确有 3 个声明、1 条调用边，删除后清除相关归属与端点 |
| 真实 JDT K26／K28 | 启用开关、精确声明／引用、短 caller 超时隔离通过；共享 backend 仅执行一次 |
| K01–K32 | 31 PASS；K29 性能 FAIL，所有行均已执行 |
| 独立评审 | 所有生产代码 findings 和 K05/K17 证据缺口关闭；最终评分和候选绑定另行核对 |

完整测试后改动仅限 JDT 验收脚本的错误提示匹配和换行验证；真实 JDT 及受影响脚本已重跑。真实模型运行之后仅探针及其测试变化，模型评测不加载它们；生产源码字节一致。具体差异见 [source binding](runtime-integrity-evidence/raw/2df2b4f2bdd90f36-final-source-binding.json)。较早两次 JDT 验收失败分别是提示匹配和换行判断错误，原始日志保留；成功证据明确为 [real-jdt-verified](runtime-integrity-evidence/raw/a736fd6510356418-real-jdt-verified.log.txt)。

实际命令包括：

```sh
sh scripts/run-isolated-node.sh scripts/run-v4-gates.mjs --profile release --output <runs>/final-release-gate.json
node --test scripts/jdt-locator-probe.test.mjs scripts/release-jdt-contracts.test.mjs scripts/run-release-contracts.test.mjs
python3 docs/java-specialist-release-audit-v1.1/tools/run_audit.py --project . --output <runs>/audit27
node docs/java-specialist-devkit-v1/adapters/probe-source.mjs --project .
python3 -m harness.selfcheck --output <runs>/frozen-selfcheck  # cwd: frozen baseline-kit
```

JDT 与 K runner 经 `run-isolated-validation.mjs`／`run-isolated-jdt-benchmark.mjs` 执行，使用私有 HOME、cache、fixture 和项目配置。完整参数及执行层级见清单 raw；没有连接线上 38456 端口。

## K29：机制通过，容量门失败

| P95（ms） | 同机基线 04058e4 | 本次候选 |
| --- | ---: | ---: |
| 并发 1 | 33.075 | 31.583 |
| 并发 5 | 83.163 | 86.166 |
| 并发 20 | 268.696 | 268.585 |
| 并发 20，伴随更新 | 276.424 | 270.906 |

原 150 ms 门槛未满足。候选 event-loop P95 最大 1.311 ms，小于 20 ms；queuePeak=19，所有请求结算后队列清空。相同 1000 文件、100 次样本的旧版本也失败，核心 query／worker／排序代码未改，未观察到新增 c20 回归。单次配对不证明统计等价，生成语料不能证明真实仓库容量。

只读分析指向普通词／broad 查询的串行扫描服务时间，rank 与 document postings 是下一轮 profile 的优先目标；不应通过改门槛、缩语料或增加 worker 数掩盖结果。详见 [负载分析与基线](runtime-integrity-evidence/raw/f61c6d9ae4a1a08c-load-assessment.md)。

## 真实模型结果

按用户指定使用 Pi 中的 `openclaw/Qwen3.8-next`。36 题主变体 × 两臂 × 一次，共 72 个调度行，全部完成；实际 547 次 provider 请求，沿用 `eval-protocol/v1.2`、seed 1984、maxRounds 16、原题集、预算与冻结 scorer。默认模型没有产生任务评测；早期连接探测不计入这 72 行。

| 指标 | Product：原生工具 + java_symbol | Control：原生工具 |
| --- | ---: | ---: |
| 总任务成功 | 19/36（52.78%） | 20/36（55.56%） |
| 冻结严格 QA | 12/28（42.86%） | 13/28（46.43%） |
| 实际 candidate 的冻结修复测试 | 7/8 | 7/8 |
| 输入 tokens | 798,699 | 563,402 |
| 输出 tokens | 13,742 | 17,556 |
| 总 tokens | 812,441 | 580,958 |

所有 usage 均由 provider 返回。这里没有质量提升、token 节省或费用下降的证据；一个模型、一次重复不能推导统计上的提升或退化，也不与历史其他模型数字混算。历史 locked 已暴露，本轮仅作 regression，不能充当独立泛化验证。

- 唯一成功差异是 GSON-01：Product 失败，Control 成功。
- 两臂 ACCESS-03 都没有代码修改，达到 FORCED_ANSWER 后冻结测试失败。
- Product ADMISSIONS-03 的独立 repair judge 通过，但冻结基础语料的结构化证据报告有一条 stale／absent content hash。修复结果与证据有效性是不同口径，不能宣称全部结构化证据有效。

逐题、usage、原始 model payload、candidate 源码、judge 和冻结评分包均在 [LLM raw archive](runtime-integrity-evidence/raw/08f4ad06f30c8142-live-next-raw.tar.gz)，摘要见 [逐臂与失败清单](runtime-integrity-evidence/raw/ddf73ddee7881bf0-live-next-summary.json)，最终独立复核见 [acceptance review](runtime-integrity-evidence/raw/ad81188c06204663-independent-acceptance-review.md)。

## 发布清单与未覆盖项

冻结 `verify_release.py` 实际退出 1，明确给出五项阻止发布的原因：独立 locked 未通过、full public 未通过、PERFORMANCE 未通过、K29 未通过、QA frozen floor 失败。当前 [`release-evidence.json`](release-evidence.json) 与 [verdict](runtime-integrity-evidence/release-verdict.json) 保留此结果；不是安装授权。

| Gate | 最终状态 |
| --- | --- |
| DATASET | PASS |
| ORIGINAL_PROBES | PASS |
| WIRE_SENTINEL | PASS |
| CANONICAL_SCORER | PASS |
| REPAIR_JUDGE | PASS |
| PRODUCT_COUNTEREXAMPLES | PASS |
| MACOS_BUILD | PASS |
| MACOS_FULL_TEST | PASS |
| MCP_ROUNDTRIP | PASS |
| INDEPENDENT_LOCKED | NOT_RUN |
| FULL_PUBLIC | NOT_RUN |
| LIVE_PAIRED | PASS |
| PERFORMANCE | FAIL |
| EXISTING_RELEASE_GATE | PASS |
| REVIEW | PASS |

K01–K28、K30–K32 均 PASS，K29 FAIL；32 行原始 requiredLevel、oracle、command 和 SHA 均保存在统一清单，未用单测数量替代运行时边界。

未运行：新的未揭盲独立样本、完整外部 public corpus profile、隔离安装回滚、线上升级／索引重建／生产持续负载。线上已有残缺索引没有被本地源码修复自动处理。

原冻结包的 34 份历史日志被 Git ignore 排除于克隆，验证时按原 SHA 原样补齐；[不可变历史日志归档](runtime-integrity-evidence/raw/1582086eec3f8398-frozen-ignored-logs.tar.gz) 可用于 fresh clone 复查。新 raw 日志保留原字节但以 `.log.txt` 保存，防止同类遗漏；清单的证据引用均为仓库相对路径和 SHA-256；raw 保留的原始工作目录仅用于溯源，实际复查数据已包含在归档中。

```sh
python3 docs/java-specialist-release-audit-v1.1/tools/verify_release.py docs/next-stage/release-evidence.json --evidence-root .
```

该命令当前应返回 NO_GO／exit 1。所有 raw 哈希应一致；只有上述实际门槛缺口，不应出现缺文件或 hash mismatch。
