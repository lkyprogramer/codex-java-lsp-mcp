# Java Specialist Development & Evaluation Kit 1.0

**目标：让 AI 按明确任务改造 codex-java-lsp-mcp，并用不依赖私有三仓的固定语料、外部评分器和冻结 Java 测试判断收益。**

这不是已改造完成的产品，也不是第三方认证 benchmark。包内提供真实可运行的独立验收工具；产品修改仍由执行 AI 在你的源码 checkout 完成。

## 先运行

一键运行本包离线自检：`python -m harness.selfcheck --output /tmp/java-kit-selfcheck`。

依赖：Python 3.10+（标准库）、JDK 17+（本包验证环境为 JDK 21）；产品探针另外需要 Node 22+ 和 TypeScript。核心自检不安装 Python 包、不调用 LLM、不访问网络。

```bash
python -m harness validate --output /tmp/java-dataset-validation.json
python -m unittest discover -s harness/tests -v
python -m harness check-repairs --output /tmp/java-repair-oracles.json
python -m harness.verify_upstream
```

修复自检预期：8 个 baseline 都在成功编译后因业务断言失败；8 个 reference 都通过。这里的 PASS 只证明冻结测试能区分这些缺陷与参考修复，不证明目标 MCP 已改好。

## 给开发 AI 的入口

先读 [AGENTS.md](AGENTS.md)，再读 [开发主计划](docs/01-execution-master.md)、[架构增量设计](docs/02-design-delta.md)、[评测协议](docs/05-evaluation-protocol.md)。按 `tasks/T01` 至 `T12` 的依赖推进；不要读取全部历史 V3/V4/V5 重新调和已经失效的约束。

在独立的产品 git worktree 中执行改造，不向线上安装目录运行 npm ci，不连接生产端口 38456。先保存真实基线：

```bash
python -m harness.preflight --project /absolute/product-checkout --output /tmp/source-preflight.json
node adapters/probe-source.mjs --project /absolute/product-checkout > /tmp/source-probes.json
```

探针需要产品 checkout 内已经安装 TypeScript；也可传 `--typescript /absolute/typescript/lib/typescript.js`。本包核查的旧源码基线是 `d86dba38fccc9bf4b6d83703c9effacedbe9a972`。旧源码探针退出 1、12 项中 9 项失败是预期发现，不是要更改断言的理由。

## 数据集到底包含什么

| 层 | 已随包提供 | 证明范围 |
|---|---|---|
| 独立任务集 | 36 个任务组，24 dev / 12 locked；中英文共 72 个 query 版本 | 发现、声明定位、范围交付、结构化 QA；同一语料任务按 cluster 处理 |
| 原创完整小工程 | 8 个，无第三方 Java 运行依赖；24 任务 | 可控机制、多文件/资源关系、真实可执行修复 |
| 公开源码种子 | 4 项目各一个未改动源文件，12 任务，固定 commit + Git blob hash | 真实库代码的局部行为与方法定位；**不是完整四仓** |
| 完整公开语料扩展 | 固定 SHA 的联网获取与校验命令 | 下载后才能进行 whole-repo discovery；本次未下载/测试完整四仓 |
| 机制契约 | 32 条规格、4 条 mutation action 序列、实际边界源文件 | 12 项源码函数探针可直接跑；其余需执行对应产品集成测试 |
| 修复结果 | 8 套 evaluator-owned Java main 断言、参考修复 | 不是历史开源 issue；为本包设计的缺陷任务 |
| 负对照 | 源码-only BM25 / literal-term control；严格评分器与自检 | 校验评测链可运行；不是优化后的 SUT，也不是最强检索基线 |

36 个任务不是 36 个独立抽样单位：任务来自 12 个语料 cluster；中英文、重复执行也不增加独立任务数。locked 明文随包交给所有者，不是密码学隐藏集。执行者看过其标签后必须登记 EXPOSED，不能再称盲测。

## 跑第一份独立结果

```bash
python -m harness baseline --split all --variants all --method bm25 --output /tmp/bm25-results.json
python -m harness score --split all --input /tmp/bm25-results.json --output /tmp/bm25-report.json
python -m harness baseline --split all --variants all --method grep --output /tmp/grep-results.json
python -m harness score --split all --input /tmp/grep-results.json --output /tmp/grep-report.json
python -m harness compare --baseline /tmp/grep-report.json --candidate /tmp/bm25-report.json --output /tmp/comparison.json
```

`grep` 是本包固定词面匹配对照，不是调用系统 ripgrep；正式工具对比需另外保留宿主原生 rg/read。检索对照不生成答案，因此 QA 和真实 Agent 成功率为 UNMEASURED，而不是推断成功。

## 完整公开仓库模式

只在允许网络时执行，单独建目录，不改变随包种子文件或标签：

```bash
python -m harness hydrate-public --allow-network --output /tmp/java-full-corpora
python -m harness --corpora-root /tmp/java-full-corpora baseline --split all --variants all --output /tmp/full-bm25.json
python -m harness --corpora-root /tmp/java-full-corpora score --split all --input /tmp/full-bm25.json --output /tmp/full-report.json
```

full 与 bundled-scoped 的 corpus_hash 不同，评分器拒绝直接配对。下载完整源码不等于运行了上游 Maven/Gradle 构建；这里只提供静态检索语料扩展。

## 目录

`docs/` 为设计、数据规范、执行/评分/资源/安全/报告准则；`tasks/` 为 12 张实现任务卡；`dataset/` 为源码、公开任务与 gold、冻结测试及契约；`harness/` 为独立标准库评测程序；`adapters/` 为真实源码探针与目标 MCP 静态检索适配器；`reports/self-check/` 为本次实际验证结果；`provenance/` 为固定来源和依据。

最终先检查 [交付验证说明](docs/15-delivery-verification.md)。其中区分实际通过、预期产品失败、未运行的生产/模型/完整四仓测试，不能拿一个自检 PASS 替代产品验收。

## 验证交付文件未被改动

在包根执行 `shasum -a 256 -c SHA256SUMS`（macOS），或 `sha256sum -c SHA256SUMS`（Linux）。校验后再复制 dev 任务到开发环境；保留 evaluator-owned 数据与规则只读。运行日志输出到包外目录，避免把运行产物混入冻结数据。
