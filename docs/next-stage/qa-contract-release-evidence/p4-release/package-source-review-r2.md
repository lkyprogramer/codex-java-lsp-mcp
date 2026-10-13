# package-r2 源码与文档 provenance 独立复核

结论：**PASS，无具体 findings。** 通过范围是私有源码快照、安装入口字节与mode、许可、合同/协议版本及文档闭包的来源一致性。状态仍为**PREPARED_NOT_INSTALLED**；本报告不声明发布、安装、startup或rollback PASS。

本代理仅执行只读文件/源码检索、SHA/Git blob/mode计算、Git元数据查询及既有candidateIdentity读取。只写本报告。未运行suite、模型、JDT、build、HTTP smoke或installer；未操作主工作区、daemon、认证或cache。未读取任务无关home文件。

## 快照与逐文件核对

- manifest：`package-source-manifest-r2.json` SHA256 `b00582d27051446de7e6cd1e5a0d173bb0091c0365ca538be49ccffbccbda9bd`，等于派发输入。
- 私有root：`/private/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-qa-release-t14dzuaq/p4-release/package-candidate-r2`。
- HEAD `a77b6428ca432259c4008ead6c5e58cdc5e53cef`，tree `0a962ef0bf631e9bb19c849d8ee18ca938774e02`，实际commit count1。
- Git HEAD与manifest路径集合完全一致：1843files、49051801bytes。每项实际文件SHA256、bytes、filesystem mode和Git HEAD blob SHA1及mode均匹配；无缺失、额外tracked路径或hash/mode差异。
- 首版manifest hash仍 `acf21cc3151c79b708001bd59ec3d7b8753c5fea975e7998cfbf08cb93be980b`。首版1606路径的SHA/mode全部原样保留；r2新增集合精确237项，全部docs路径。每个新增条目的sourcePath均位于明确primary `/Users/luo/Documents/github/codex-java-lsp-mcp`，实际primary字节SHA等于该条目及r2文件。
- 实际candidateIdentity：sourceDigest `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`、611files、dirty=false；lockfile `fc612ac3b894495daab26226e08ac171cab20e62f20b56da7bdc14e49245ef9c`。全部611可执行源码输入逐项等于冻结zlPTg7对应文件。这保持既有QA/scoring源码identity；私有commit作为包HEAD真实变化，不伪造原base SHA。

## 安装入口与许可

install-runtime.sh、daemonctl.sh、run-daemon.sh、run.sh的实际SHA256及0755mode均等于manifest和首版。LICENSE的SHA256 `c1b9df1275e769f3dbab000d1e457a2d4b0f28eb5da6c77e48dc37eeba202ed7`及0644mode匹配。其他所有入口也已纳入上述1843逐项HEAD/blob/mode核对。

只读追踪install-runtime.sh：source清洁验证仍在构建/复制前；BUILD_SHA由当前包真实Git HEAD产生，未人工写死旧值；release copy与npm/build、候选smoke、stable entrypoint、daemon restart/rollback仍走原实现。r2没有更改这些入口。既有rsync排除.git/node_modules/dist/artifacts/认证env和*.log的行为保留；源包含历史logs不等于安装后release必含logs，installer明确相关测试从sourcecheckout运行。本复核没有尝试安装，也没有把入口静态完整性当作daemon/runtime成功证明。

## 合同、协议与文档闭包

- p0 public-answer-contract-v1.0.json：包与ROOT/p0-contract原权威文件SHA均为 `2debcf5ef20d58e6e994025f4d5a69861d3e869e0f67b8a2780ee59b6592f1d3`。
- immutable v1.4：包SHA `a2f06a1cfa3ce2c9457495d49d0dc7e5a7fdc5ba66fd9696a14a8ed66e71f5c5`，等于p0 coverage-check.originalV14Hash；未用active版本覆盖原冻结版本。
- active v1.5：包SHA `c9c6682b434793707e7538b449a5fb78900e3c95c8f77bda63e6c02e138833c6`，等于真实冻结candidate的evaluation-protocol.json；包自身evaluation-protocol.json也与v1.5同字节。
- 独立解析README Markdown本地链接：17项本地目标全部存在，包括必要目录目标。manifest声明的263条本地文档/证据引用边目标全部存在。237项新增文件的来源与SHA已逐项验证，不以存在性代替来源校核。
- 新闭包限定primary明确文档及引用/证据manifest对象；没有从raw历史绝对执行路径自动追入用户home或旧runtime/cache。报告没有推断历史绝对运行路径在当前机器仍可复现。

## 原包与历史证据边界

原java-specialist-release-audit-v1.1 MANIFEST SHA `b69d945ad00af0ac4f72c3642a13f569a6563e131411ba852bdf1a72cc4ca502`与manifest记录一致；其357条实际文件SHA全部匹配。之前恢复的34个Gitignored历史log在r2仍保留原SHA。由357完整性校核覆盖原tasks/scorer/gold字节，未把其历史输出当作本轮执行结果。

runtime-integrity-evidence/release-verdict.json实际仍eligibility=NO_GO、原SHA `be6077d5c41a3ea82dd2e571a3a953f3b2787e32df17dc33f7f9019bb9f6c346`，并与primary同字节。release-evidence.json亦与primary同字节。新包准备状态不重标这些旧结论，也不借旧logs宣称本轮模型、工程、发布执行通过。

## 剩余范围与停止点

工程/QA/scoring执行证明继续使用既有冻结源6d的独立报告；本报告只证明r2保留对应源码及文档权威输入。独立locked输入缺失仍为BLOCKED_MISSING_INDEPENDENT_INPUT。r2 manifest中的build/tests/models/JDT/startup/installation/rollback均NOT_RUN；后续主代理计划的私有包编译/buildstamp与HTTP smoke尚不作为本报告输入。后续生成未tracked产物不改变本次HEAD/blob绑定，但其执行结果须另行记录。

没有发现当前包来源、611源码、安装入口/许可、版本合同或README/文档闭包的具体gap。可将本报告作为源码包准备PASS，继续既定私有包验证；不得据此跳过发布/安装条件。
