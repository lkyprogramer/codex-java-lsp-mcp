# 交付验证记录与使用边界

日期：2026-09-19。版本：Java Specialist Development & Evaluation Kit 1.0。

本页记录的是**交付包本身的验证**，不是产品修改结果。产品源代码未在本包中改造；没有把修复参考答案或评分器自检当作被测 MCP 的成绩。

## 1. 已冻结的验收资产

- 36 个任务组；24 dev / 12 locked；每组中英文两种查询，共 72 query variants。
- 12 个语料 cluster：8 个原创完整小工程、4 个公开项目的固定文件种子。
- 28 个结构化 QA 任务、8 个代码修复任务；入口 / 影响 / 排查三种工作流各 12 个任务。
- 32 条产品机制契约规格、4 条具体 mutation 操作序列；32 条规格不等于已经执行 32 项产品测试。
- 8 套评测侧冻结 Java 测试与参考修改，不在 Agent 的 staged repo 中。
- 数据目录的 132 个文件被 `dataset/manifest.json` 锁定；数据内容摘要为：

```text
c34a7c7c2f261bb273bc622739eae6beff8479ca96512c48942638cd912b8c4d
```

该摘要覆盖规范化路径与内容，算法见 `harness/dataset.py`。只排除根 manifest 自身；repairs/manifest.json 等嵌套控制文件必须纳入摘要。根 manifest 自身排除，避免自引用。包根 `SHA256SUMS` 另锁定文档、评分器、规则和全部交付物；发布新评分规则必须单独版本化，不可只保留相同数据 hash。

## 2. 本次实际执行

| 检查 | 实际结果 | 证据文件 |
|---|---|---|
| 数据完整性、任务/分组、标签范围校验 | PASS：36 任务、72 变体、12 clusters，errors=[] | `reports/self-check/final/dataset-command.json` |
| Python 单元与集成自检 | PASS：56 tests，0 failures | `reports/self-check/final/unit-command.json` |
| 8 个有缺陷的 Java baseline | 全部 javac 成功，然后被冻结业务断言判为 TEST_FAILED | `reports/self-check/final/repair-oracles.json` |
| 8 个参考修复 | 全部编译、运行通过 | 同上；这是 oracle validation，不是 Agent repair rate |
| 同 FQN 的两个独立模块 fixture | 分别编译成功，均产生自己的 demo/Shared.class | `reports/self-check/module-isolation-compile.json` |
| 4 份公开原文件 | Git blob SHA-1 与来源一致，内容 SHA-256 校验通过 | `reports/self-check/final/upstream-command.json` |
| 评分器故障注入 | 故意移除 stale hash 检查、故意把计划当作读取，两种错误均被断言捕获 | `reports/self-check/final/evaluator-faultcheck.json` |
| 五段独立设计 TypeScript 核心示例 | strict/noEmit 通过；不是完整产品 typecheck | `reports/self-check/design-snippets-typecheck.json` |
| 固定 BM25 词面基线 | 72 次查询与评分完成，QA/模型 usage 未测 | `reports/self-check/bm25-results.json`、`bm25-report.json` |
| 固定 literal-term 词面基线 | 72 次查询与评分完成；它不是系统 ripgrep | `reports/self-check/grep-results.json`、`grep-report.json` |
| 两基线配对比较 | 生成 task/cluster 分层差异及 cluster bootstrap | `reports/self-check/lexical-controls-comparison.json` |
| 仅检索结果进入 QA qualification gate | 正确返回 QUALIFICATION_FAIL（不是运行崩溃）；未生成答案不能过 QA 门槛 | `reports/self-check/bm25-qualification.json` |
| 一键自检 | PASS，scope=KIT_ONLY；product_release/live_agent=NOT_RUN | `reports/self-check/final/summary.json` |

基线的 144 次查询只说明两条对照与评测链已经运行。它们是同一 36 任务组的不同版本和方法，不是 144 个独立任务，不证明当前产品或向量策略优于任何竞品。

自检目录中的早期 RED/GREEN 日志保留开发过程；最终计数以 `final/unit-command.json` 为准。初始 module-not-found 只属于脚手架准备，不计为行为性 RED；`evidence-red.log` 与故障注入记录才体现错误行为被断言捕获。

## 3. 当前产品源码基线：预期失败不得隐藏

固定源码：`d86dba38fccc9bf4b6d83703c9effacedbe9a972`。上传 archive 的 commit comment 与上一版指南相符；解包目录无 `.git`，因此 preflight 的 git SHA 为 UNAVAILABLE，不能伪造 git 命令成功。

实际运行 `adapters/probe-source.mjs` 后得到 **12 项：3 PASS / 9 FAIL**：

- 身份组：文件路径与 owner 未形成独立 ID；正反写入次序都发生同 FQN 归属合并。named identity 的空行稳定性通过。
- 查询组：精确方法、纯正文词查询通过；类名与任务词混合查询未返回目标方法。
- 范围组：LF/CRLF 下长方法单锚点与多锚点仍丢失中间位置。

证据：`reports/self-check/current-source-probes.json`。该命令退出 1，表示对期望正确行为的真实失败，不是本包自检错误。执行 AI 应修复产品并转绿，禁止修改断言来保持旧行为。

这些探针使用**真实导出的源码函数 + 构造事实和临时文件**；TypeScript 使用 transpileModule，没有完成产品全量类型检查、Tree-sitter→JDT→MCP 全链运行。不能把 12 项探针称为全部产品契约验收。

## 4. 环境

```text
OS: Linux（本次容器）
Python: 3.13.5
Node: v22.16.0
Java compiler: javac 21.0.11
Source probe transpiler: TypeScript 5.8.3
Product snapshot: d86dba38fccc9bf4b6d83703c9effacedbe9a972
```

Java fixture 用 `--release 8 -proc:none` 编译；JDK 21 关于 release 8 过时的 options warning 保留在日志中，不隐藏。Node 对 experimental SQLite 的警告也不等于业务失败。正式 macOS 测试仍需执行者运行。

## 5. 本次明确未完成、也未宣称完成的测量

| 项目 | 状态与后续入口 |
|---|---|
| 产品 npm 全量 build/test/release | NOT_RUN；T01/T12 在真实 checkout 与依赖环境执行 |
| 真实 HTTP MCP static query | NOT_RUN；当前产品尚无拟议契约。adapter 仅通过 fake HTTP transport 测试 |
| 剩余产品机制/并发/新鲜度契约 | SPECIFIED_NOT_RUN；按任务卡落实到真实产品集成测试 |
| 真实 JDT、运行中 daemon、macOS 生命周期 | NOT_RUN；不能由 Linux 函数探针替代 |
| 完整四个公开仓库的下载与检索 | NOT_RUN；网络获取命令已提供，随包只有四个原文件种子 |
| 上游 Spring/MyBatis/Gson/Hikari 的完整构建和测试 | NOT_RUN；不属于本包局部静态语料的已通过范围 |
| 真实 AI 编程/QA 轨迹与费用 | NOT_RUN；8 个参考修复并非 8 个 AI 成功任务 |
| zvec、embedding 与模型对照 | NOT_RUN；T10 要求先授权并固定独立实验配置 |
| 外部标注双审、第三方复跑 | NOT_RUN；当前是源代码核对后的单作者标签 |

`hydrate-public` 保留固定 commit 和种子内容校验，生成新的 full-corpus hash。获取失败必须退出，不能回退到种子却仍写 full。首次在你的环境使用时同时保留获取日志和 manifest。源码种子版本不是追逐 latest，而是为了长期可重复比较固定版本。

## 6. “完整”的准确含义

本包交付的是可运行的**统一验收起点**：实际源码、任务、答案、测试、评分程序、基线、任务卡和规则均存在，不依赖私有三仓。它不宣称几百行人工工程或四个原文件可以代表所有企业 Java 项目。

开发期先用它稳定复现缺陷、证明机制；发布前在完整公开语料和真正 Agent 任务上验证。locked 集明文交给所有者，因此必须由独立 evaluator 挂载；开发 AI 一旦读过就记录 EXPOSED，不能再宣传为盲测。

未测的产品、模型和完整仓库指标不填零、不填 PASS。由自己拥有的测试集证明了工程改进，也仍需公开运行协议、原始结果和局限，才能逐步提高对外说服力。

## 7. 发布前补充的 manifest 防漏检测试

最终检查发现，同名嵌套 manifest 不能与根 manifest 一并排除，否则修复任务允许修改范围的变更不会改变数据摘要。已增加两项独立测试：嵌套 manifest 改动必须改变摘要；根 manifest 不能造成自引用。记录位于 `reports/self-check/manifest-boundary-red.log` 与 `manifest-boundary-green.log`，先真实失败再修正。所有最终基线与自检均按修正后的 132 文件摘要重新运行。

## 8. 冻结测试必须正常执行完成

仅以 JVM exit=0 判修复成功不充分：候选代码提前 System.exit(0) 会跳过后续断言。已用真实候选写出失败回归，再增加 evaluator-owned FrozenJudgeRunner：只有测试 main 正常返回后才写本轮完成回执，退出码、超时、输出上限与回执共同决定成功。

证据：`reports/self-check/repair-early-exit-red.log`、`repair-early-exit-green.log`。最终 56 项自检覆盖该边界；8 份 baseline/reference 均已重新执行。此回执防止普通提前退出误报，并不构成同权限恶意 Java 代码无法伪造的安全证明；不可信候选仍必须在独立容器/低权限环境执行。
