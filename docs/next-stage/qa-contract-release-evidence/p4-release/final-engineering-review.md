# 最终工程证据复核

结论：**PASS，无具体 findings。** 本结论覆盖冻结候选的工程测试、真实JDT合同、原默认单reader容量门及指定离线自检。它不代替尚未执行的后续公开模型评估、安装或daemon替换验收。

本代理只读复核已有JSON、TAP、真实运行记录、文件hash、候选identity及Git index/tree；仅写本报告。未执行benchmark、模型、JDT、fullsuite、installer，未修改源码、候选、工具或raw。

## 候选与原始运行绑定

- 冻结根：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-zlPTg7/candidate`。
- base：`04058e43b8b2658864d0de09c8d6024e9928dfc5`；sourceDigest：`6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`；可执行输入611files；lockfile `fc612ac3b894495daab26226e08ac171cab20e62f20b56da7bdc14e49245ef9c`。
- 只读运行仓库原candidateIdentity算法，冻结zlPTg7与当前工作区均得到上述同一identity。`git diff-index --cached --name-only ea20b4957c6c873d11c08ef2751708a920c54c5a --`在冻结候选无输出。
- gate-release full clone QTZqD0、HTTP clone koXbnP以及JDT clone FQkbZV在原log均声明同一executableTree `ea20b4957c6c873d11c08ef2751708a920c54c5a`。K-contract report和真实JDT evidence均记录上述sourceDigest，contracts candidateDrift=false。
- 已校核state.p4Engineering、p4Offline指定hash、capacity-array-review hash、合同全部raw evidence hash、frozen-selfcheck commands指定stdout/stderr hash。未观察到漂移或无法读取的证据。
- gate-release-summary.rawSha256绑定433259字节原始运行输出前缀：`e93a2887c30cd77298df411d2e3c8dd2a6532e6ff2e556d264193ac50885ba4f`，实际前缀hash一致。完整gate-release.log为433831字节，末572字节是附加的同一摘要JSON；完整文件hash `bb0230b75261d2e4d74ea40d8e3f349c99ded6474365fcab56a72ae99c598cd7`。这两个hash口径不同，没有把完整文件与前缀混用。

## 已观察工程门

| 层 | 原始证据观察 |
|---|---|
| TypeScript编译及源码suite | gate-release.log full步骤真实执行；1366tests/pass，fail0、skip0 |
| 脚本suite | 同log 436tests/pass，fail0、skip0 |
| HTTP五工具 | 真实loopback38491 smoke ok:true、state:ready；tools为java_diagnostics/java_impact/java_runtime/java_status/java_symbol |
| K01–K32 | k-contract-results.json真实32个唯一ID，PASS32/FAIL0/BLOCKED_ENV0/NOT_RUN0；普通合同exit0/not timedout，selected均passed且无directive，并逐项在原stdout找到相应ok TAP |
| K26 | 真实JDT同digest；关闭LSP时实际配置错误、启用后locator/引用与READY运行状态；原evidence文件及复制raw hash一致 |
| K28 | 同一次真实JDT evidence：short DEADLINE_EXCEEDED，long COMPLETE，backendCalls1，最终inflight0，保留共享caller轨迹 |

JDT证据来自真实两Java文件fixture，runtimeJavaHome21与projectJavaHome17分别记录。status同时保留较新runtime解析旧sourcelevel的degraded提示；本复核没有扩大为所有真实项目/JDK/生成代码的生产语义证明。

## K29原合同没有被替换

核对`k-contracts/raw/load/query-load-report.json`，实际workerCount=1、files1000、steps1/5/20，各100请求；withUpdates20并发100请求，writerIntervalMs100、measuredWriterCommits7。原四query（rare FQN/order/broad/refundOrder auto）仍在；默认pool读取为1，无broad范围缩减或门/预算替换。

| 本次合同run | warm latencyP95 ms | event-loopP95 ms |
|---|---:|---:|
| concurrency1 |13.907|1.638|
| concurrency5 |38.300|1.668|
| concurrency20 |125.462|1.612|
| concurrency20+updates |127.665|1.555|

K29 row明确保留warmStaticP95LimitMs150、eventLoopP95LimitMs20；mechanismPass/performancePass均true。每step有100 rawLatencies与100 workerRequests，settled=true、queuePeak≤19、无termination；shutdown queued0/runningfalse/threads0。这里记录的是k-contracts实际独立run，未用state.p4Performance较早容量run的127.636/128.668替代。

Synthetic固定负载仍仅证明该冻结门；不推算生产吞吐量或真实项目尾延迟。旧默认1失败和双reader实验不被重标为当前单readerPASS。

## 离线证明层级与包完整性

- canonical-unit：本轮frozen-selfcheck/canonical-unit.stderr.log明确Ran56tests、OK；不是引用原包旧日志。
- dataset：本轮validate exit0、errors[]，36groups/72variants原dataset hash保留。
- original-probes：本轮stdout passed12/failed0，mode=`real-source-functions-with-constructed-facts`；明确typecheck与JDT NOT_RUN。它是实际源码函数+构造facts边界，不代替live model或真实JDT。
- counterexamples：本轮counterexamples.json真实27rows PASS、failed/errors0；run.json绑定冻结候选source hashes，逐项hash一致；basis明确TypeScript transpilation NOT typecheck、unused SDK transport stub、fake chat/fetch、noNetwork/noLiveModel/noJdt。全量编译证明来自工程suite，不能归给此脚本。
- faultInjection：evaluator-faultcheck.json两mutants detected=true、passed=true，保留内部预期失败；not_product_results=true。
- repairOracles：repair-oracles.json八oracle_check_pass=true、passed=true，not_sut_results=true。它证明冻结oracle有效，不冒充产品/模型修复通过。
- 357文件包：首次bundle命令exit1、原FAIL stdout保留，错误集合精确34项unsafe/missing。restored-ignored-artifacts.json精确34同路径；各已补私有候选字节hash均等于原MANIFEST.json条目，MANIFEST357files本身与仓库权威原MANIFEST hash一致。随后bundle-r2.stdout真实PASS checked357 errors[]。这些是Git-ignored原历史日志的manifest完整性恢复，不是本轮执行结果；未据此替代上述新canonical/probe/counterexample输出。

## 评审与剩余边界

`capacity-array-review.md`独立评审PASS且state记录hash一致：它覆盖posting-only数组模式、列位、fallback、scan停止与IteratorClose、budget调用顺序、ranking/snapshot/default合同；定向20tests日志保留。该早期报告明确性能未判定，当前性能结论来自后续真正K29load。

剩余未覆盖事项：实际旧Node22运行未做，已做同运行时缺方法fallback证明；生产项目容量和所有JDK语义不由synthetic/JDTfixture外推；本代理未重跑任何suite。公开模型评估与安装激活仍须各自冻结结果与runtime验收。没有在本次指定工程证据范围发现新的gap，建议主代理采用本报告作为工程门PASS，并继续既定后续阶段。

主要真源：state.p4Candidate/p4Engineering/p4Offline；p4-release/gate-release.log及gate-release-summary.json；p4-release/jdt.log及其记录的FQkbZV/tmp/codex-java-lsp-isolated-jdt-jORO6y/jdt-evidence.json；p4-release/k-contracts/k-contract-results.json及raw；p4-release/offline-summary.json、frozen-selfcheck/commands.json及对应新raw、restored-ignored-artifacts.json、bundle-r2.stdout.log；p4-release/counterexamples/run.json/counterexamples.json；p4-release/capacity-array-review.md。
