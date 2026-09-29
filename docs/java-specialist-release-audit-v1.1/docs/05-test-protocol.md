# 测试与验证协议

## L0：包自身与原始冻结数据

```bash
cd "$KIT"
python tools/check_bundle.py
python -m unittest discover -s tests -v
(cd baseline-kit && python -m harness.selfcheck --output "$RUNS/frozen-original")
(cd "$PROJECT/docs/java-specialist-devkit-v1" && python -m harness.selfcheck --output "$RUNS/frozen-checkout")
```

第一次b9中第二份自检失败是预期基线，原版应通过。R00恢复后两个都通过。每个output目录必须新建，原始报告只读；不要覆盖RED日志。全新git clone再做一次，防止工作区手工恢复而git再次换行。

## L1：真实导出函数反例（已提供可执行）

```bash
python "$KIT/tools/run_audit.py" --project "$PROJECT" --output "$RUNS/r01-red" --cases W01,W02,W03,W04
python "$KIT/tools/run_audit.py" --project "$PROJECT" --output "$RUNS/all-red"
```

case清单在 `contracts/audit-cases.json`，27条。每条记录观察值、结果、异常；`FAIL`表示断言检测到当前错误，`ERROR`表示测试装载/执行异常不能直接归为产品缺陷。b9：1 PASS/26 FAIL/0 ERROR。suite默认禁止fetch，SDK transport类一旦构造就报错，防止无意启动外部服务。Node/TS版本写入run日志。

这些反例手工构造Facts，不覆盖实际AST解析；部分用fake chat/fetch隔离边界，没有使用假实现替代被审计函数。不得据27条断言估计真实业务错误率。R01等可合法改变导出接口，但需迁移adapter并人工审核等价测试目标，不删除反例。

## L2：产品编译与项目单测

在可安装项目native依赖的隔离真实git checkout中：

```bash
cd "$PROJECT"
npm ci
npm run build:isolated
npm test
npm run gate:pr
npm run gate:release
npm run measure:tool-schema
npm run measure:production-ts
```

本次这些完整产品步骤未独立完成：npm registry DNS阻塞，Linux不替代macOS runtime。反例转译通过不等于tsc通过。`entity-search-bounded.test`依赖tree-sitter，缺依赖是BLOCKED_ENV而不是SQL预算测试失败。本包原始日志保留失败后单独执行纯测试子集的区别。

定向新增仓库测试采用已有隔离入口，例如：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- \
  node --test dist/discovery/query-intent.test.js dist/java-index/sql/entity-search-intent.test.js
```

当任务卡新增 test 文件后，替换为其准确dist路径。不能运行不存在文件后声称测试覆盖。

## L3：MCP/public-surface 黑盒

使用隔离stdio服务器、临时HOME/cache/ownership和临时candidate。实际SDK握手、tools/list、java_symbol static/query、position/references的LSP要求、未知工具与结构化错误都要测。不使用本包offline loader。

MCP→host adapter→最终model payload的sentinel同时存在，并验证调用toolId、源字节hash、同消息中多个结果、错误、空结果、截断、大文本、LF/CRLF、emoji、资源XML。static query设置JDT_BIN为失败程序，启动次数必须0；references单独配置真实JDT，不靠“失败程序报错”假装真实JDT行为测试。

## L4：独立数据固定预算检索 / QA

原始kit可运行命令帮助：

```bash
cd "$KIT/baseline-kit"
python -m harness --help
python -m harness score --help
python -m harness compare --help
```

发布评测adapter输出原 `java-specialist-results/v1`，完整manifest含task、variant、repeat、arm。锁定dataset/scorer/corpus/profile哈希。原scoped语料与external-full必须分别报告，不从不同语料获得两个分数相减。36任务、72中英文版本不等于72独立任务；重复运行也不增加任务多样性。

检索比较使用相同最终10个声明、160源代码行、16000源字节预算（原profile），去重后计算。discovery API默认8的产品体验另报product-default profile，不能与实验10混算。计划范围和实际dispatch源码范围分开计；path-only没有行证据分。

QA提交合法typed JSON + payload receipts；参考答案/冻结测试永不进agent索引。只有真实patch交给外部冻结judge才记repair outcome。oracle patch验证的是判定器，不是模型成功。

## L5：可解释 LIVE 与样本分组

首先执行scripted sentinel两臂（零token费用）证明tool闭环；随后经授权跑12个dev pilot，两臂各3重复。比较真实native基线与静态产品；只有这个有效后才讨论dense。统一source roots、对称工具、model/reasoning/temp/maxRounds/实际token上限与deadline。每attempt独立candidate；臂顺序按固定seed平衡，不把所有A2早上、所有A3晚上运行当对照。

每个计划行都输出一条：正常、超时、预算耗尽、transport错误、候选编译失败。无api授权的轮次整体BLOCKED_AUTH；不填失败/零usage当真实任务。已有结果0修复可如实记录，但不能未检查可见payload就解释“模型瓶颈”。

必须保存 sanitized 最终chat请求、provider原始usage（去认证头）、实际source receipts、candidate diff/hash、冻结judge stdout/stderr/退出/回执、工具schema与prompt hash。最终请求带gold属于EVAL_LEAK，不可评分。

## L6：运行态/性能/上线前

按 `docs/09-runtime-contract-matrix.md` 全32项记录目标层级，PASS需要正确层级。性能按精确/模糊/中文/宽泛query与冷建/热库/首次model加载分别测。20并发、普通词、单行大文件、查询中增删、分支切换、XML-only mutation、WAL空闲回收必须含负载样本。报告P50/P95/P99、sample n、event-loop delay、RSS（daemon/JDT/worker分开）、CPU/IO、visited rows、排队和取消后后端结算。

原门槛保留：warm static P95≤150ms、event-loop P95≤20ms、anchored-impact paired P95≤1.2×baseline。是本机profile门槛，不是任何机器保证。新代码性能真正提升需要同机同数据同缓存对照。

## 安全与归因限制

隔离目录不是安全沙箱，JVM可执行任意代码；不可信repair candidate必须用低权限容器/用户、禁网、CPU内存输出限制。模型source已dispatch不代表它注意到；token降低不等于成功质量提高；缓存命中不等于向量身份正确；0 regression只有对称固定预算和未受污染样本才有信息量。
