# MAC-18 上线审查

2026-11-03。审查对象是 MAC-17 的本地候选 `review-candidate-7805669821c9.tar.gz`。候选包 SHA256 已读回一致。正式 G17 仍为 `FAIL`，G18 仍为 `PLAN`。本记录供审查使用。生产切换须满足 [MAC-18 前置门](../../../deep/ilv2-mac-manual/cards/MAC-18.md)，并获得对实际安装工件和目标的明确授权。

## 候选身份

| 项目 | 值 |
| --- | --- |
| 包 SHA256 | `c6fc6ab4ff760c57af65d7d03838378dba40538820868d330219c7ca12148ba3` |
| 源码摘要 | `7805669821c95e8995b10adae6a005e614c0ab90dc81548f20296a359f82be0d` |
| build | `ff81b8ddbcb8+p597d55ae122f` |
| inventory SHA256 | `1890fbc5466123a108efcf9cc22487d94441d18e098446bf1402b8a4cf783855` |
| native SHA256 | `7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3` |
| 签名 Team / CDHash | `2UVGT2J459` / `64c1294487a7180fe03ceb3f15b36dca6651fd74` |
| 冻结 runtime manifest SHA256 | `26112d6328ccb37718c004f6bac4f6c62fbe99d3808ff7f5870db550429de058` |
| installer SHA256 | `a775d0fe5c2b53d2df2a580e078dddb6b24d065c2bc4a0f8cf542b3440a2e854` |

本次用 `shasum -a 256` 核对候选压缩包和工作区 installer。包内文件模式、链接及逐文件哈希沿用原封存核验。签名沿用同字节 native 的严格签名记录。工件位置见 [MAC-17 封存报告](../mac-17/index-ready-fix-acceptance.md#身份与可审查候选)。

## 证据复用

| 证据 | 可覆盖的范围 | 仍缺的证据 |
| --- | --- | --- |
| 当前候选的隔离首次语义 | 17/17 定向检查。安装期恢复依赖后，真实 JDT 在 106.150 秒内就绪。精确定义和引用通过。原空缓存全程 120 秒的失败保留。 | 当前候选由正式安装入口交付后，Gradle 准备与 daemon 实际使用同一服务域的证据。[真实验收](../mac-17/index-ready-fix-acceptance.md) |
| `174227f978a0` 的完整安装 A、停服升级 B | 两次入口均通过，各有完整测试和安装读回。候选复用 A 的 native 和 Node 依赖 inventory，字节身份一致。 | 当前源码和安装入口的交付验证。A/B 的安装、升级结果仍归各自 release。[安装记录](../mac-17/current-baseline-acceptance.md) |
| `0fb81bb52c0e` 的两小时 canary | 原候选 1000 次正常请求和 20 次编辑的历史结果。可复用场景及验收口径。 | 当前交付工件的同身份 canary 和适用 SLO 证据。[历史记录](../mac-17/acceptance-summary.json) |
| 历史 G14 与隔离 TCC | G14 作为受影响范围的基线。开发路径已证明稳定签名和同一路径重签后可复用授权。 | 核对 JDT 生命周期、状态和安装改动影响的 G14 项。真实 JDT 合同证据须绑定交付候选。生产固定路径的 Documents 授权和业务读回为 `NOT_RUN`。[G14](../../../deep/ilv2-mac-manual/cards/MAC-14.md) · [TCC 决定](../status.json) |

## 切换前必须关闭的缺口

1. **确认实际安装工件。** 常规 `install-runtime.sh` 从干净源码执行 `npm ci`、构建和完整 `npm test`，再生成 release。当前审查 tar 直接安装的路径未验证。先确定拟用的安装入口和实际交付包，再把源码、runtime、native 和包 SHA 绑定到验证记录。若走常规入口，须单独确认其内置完整测试是否获准。复用身份匹配且行为未受影响的证据，只补未覆盖的门。[安装入口](../../../../install-runtime.sh#L345)
2. **确认 Gradle 准备接入。** `--prepare-gradle` 仅支持隔离安装阶段，执行后退出。常规安装入口尚未接入该阶段。必须在隔离交付验证中证明依赖恢复使用新服务实际读取的 `GRADLE_USER_HOME`，并沿用原 120 秒启动和精确定义、引用门槛。旧缓存及用户凭据不作为准备输入。[隔离入口](../../../../install-runtime.sh#L69) · [服务环境](../../../../install-runtime.sh#L712)
3. **落实失败即停。** 当前 installer 在部分更新失败分支会尝试恢复并启动前一 release。用户选择停用新服务。切换前须用拟采用的入口和布局在隔离环境证明失败后新 job 退出，且旧 job 不被自动启动。保留旧工件和数据。兼容与版本回滚测试按用户决定跳过。[故障分支](../../../../install-runtime.sh#L872) · [启动后故障分支](../../../../install-runtime.sh#L927)
4. **核对正式门。** 交付候选的受影响 G14 和 G17 必须有判定。当前候选缺同身份 canary。手册另有提前候选路线，但本次未选择该路线，相关前置门也未验收。[G17](../../../deep/ilv2-mac-manual/cards/MAC-17.md) · [提前候选条件](../../../deep/codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md#31-可选提前恢复服务默认不执行)

## 生产授权和验收范围

上线申请必须填入实际工件 SHA256、build、native SHA256 和签名身份，并核定新 ILV2 runtime 绝对路径、固定 launcher 路径、LaunchAgent label 和 plist、端口、唯一 owner、业务仓及 MCP 入口。`38456` 是安装器默认生产端口，现场归属待确认。新 cache、service-state、Gradle home 和旧 runtime/cache/state 的保留位置也须写入申请。默认 installer runtime 指向历史路径，首次 ILV2 安装必须显式指定新路径。[生产操作边界](../../../phase-f/production-operations.md)

获准后，按 MAC-18 卡读回固定 launcher 与实际运行身份。由生产 launchd job 读取获准的业务仓，执行一次真实静态查询和一次指定增量，核对 stdio/HTTP 指向同一 owner。首次 TCC 授权后的复读必须实测。若未安排升级，升级后复读仍单列 `NOT_RUN`。真实 JDT 仅在授权包含语义验收时启动。

身份不符、TCC 等待或拒绝、业务读回失败时，停止本次切换。若新 job 已启动，停止新服务并核对退出。旧工件和旧数据保留，旧服务恢复须另有授权。G18 通过后才进入 MAC-19 观察。

## 2026-11-03 安装入口确认与隔离组件验收

拟采用仓库现有的 `install-runtime.sh`。首次部署使用独立的新 ILV2 runtime 和 LaunchAgent label，保留旧 runtime。审查 tar 用于锁定证据和候选内容。现有入口从干净源码生成 release，并内置完整 `npm test`。本轮执行该入口的预检及隔离组件验收，实际交付包和完整安装仍待确认。

| 检查 | 观察结果 |
| --- | --- |
| `/bin/bash -n install-runtime.sh` 与 `install-runtime.sh --preflight-runtime` | 通过。工作区 installer SHA 与冻结记录一致。真实 Node 和 runtime manifest SHA 与候选一致。私有 runtime 目录未创建。 |
| `install-runtime.sh --prepare-gradle` 的非隔离门 | 拒绝执行，退出码 `2`，原文 `Gradle preparation requires its isolated installation phase.`。私有 runtime 目录未创建。 |
| Gradle 目录 | 用候选封存清单核对 14 个消费文件的 SHA。执行原 `write_state` 和 `write_launch_agent`，生成的 plist 通过 `plutil -lint`。daemon.env、plist、JDT `jdtGradleHome()` 均指向同一私有 `runtime/state/jdt-gradle-home`。原 `validatePreparation()` 接受相同路径并拒绝不同路径。此项覆盖配置和路径守卫。真实依赖恢复与语义沿用 MAC-17 证据。 |
| 首次安装的 smoke 失败 | 执行 installer 的原失败分支。测试控制脚本注入 smoke 错误，记录 `start → smoke → stop`。隔离子进程确实退出，installer 退出码 `1`。新 `current`、plist 和 daemon.env 撤除，候选目录和独立旧 runtime 保留。源码随后尝试启动，但控制脚本已经撤除，原文包含 `daemonctl.sh: No such file or directory`。本项使用测试控制脚本，真实 LaunchAgent 的退出仍未验证。 |

首次故障夹具用常驻函数替代控制脚本。它在配置撤除后仍接收 `start`，导致调用次数断言失败。补测仅修正夹具边界，由原 `managed_daemonctl` 调用可被原流程撤除的私有控制脚本。未修改 installer 或故障分支。

当前结论为部分完成。完整入口尚未将已验证的 Gradle 恢复阶段接到实际服务。已有 ILV2 前序版本时，installer 的自动启动旧服务路径仍存在。下一次隔离交付必须验证真实 job 的失败停用，绑定交付工件的受影响 G14 和 canary，并确认完整 installer 内置测试的执行范围。生产 TCC、业务读回、生产切换均为 `NOT_RUN`。

## 2026-11-03 隔离安装接入和真实停用验证

安装器增加 `--install-with-gradle <plan>`。该模式只接受登记的隔离运行目录、新 runtime、未使用的 LaunchAgent 和非保留端口。完整构建、测试和候选 smoke 通过后，它调用 release 自带的 Gradle 准备脚本。准备阶段、daemon.env 和 plist 共用 `runtime/state/jdt-gradle-home`。准备失败时不切换服务。切换后的启动或 smoke 失败时，执行 `daemonctl stop` 并以失败退出，保留现场供审查。旧独立准备入口 `--prepare-gradle` 继续用于既有隔离工作流。执行完整隔离入口时，外部控制器须在实际 bootstrap 前取得共享 fixture 配额，并负责退出核对。

本次实现只用于隔离交付。正式生产模式、生产 Gradle profile 和固定 launcher 的 TCC 仍待授权和验证。MAC-17 的首次真实语义证据使用隔离 JVM profile，不能据此推定正式入口已经覆盖相同的 JDT 与 Buildship 参数。

| 检查 | 观察结果 |
| --- | --- |
| 定向测试 | 6/6 通过。覆盖隔离路径、保留端口、非隔离拒绝、已有锁、共同 Gradle home、失败后 stop 且不调用恢复。使用冻结 Node 和 runtime manifest。 |
| 真实 installer CLI 拒绝保留端口 | 输入保留端口后，退出码 `1`，原文 `[gradle-prepare] reserved HTTP port rejected`。runtime、cache 和 plist 目录均未创建。未连接该端口。 |
| 真实隔离 LaunchAgent 停用 | 复用封存候选 `7805669821c9` 的运行字节。用本次 installer 的配置写入函数生成 plist，在随机端口 `50383` 启动到 ready。给原安装失败分支注入一次 smoke 失败，执行真实 `daemonctl stop`。标签 `com.lky.ilv2-mac18.dc792297-beff-4823-a684-2b86b80070f9` 卸载，PID/PGID `86614` 退出，恢复调用为 `0`。两张全局配额表均为空。本项验证真实退出，启动由隔离控制器完成，故障由夹具注入。 |

首次定向测试发现校验入口的参数计数错误和测试日志匹配错误，修正后通过。安装锁检查首次缺冻结 Node 环境，补齐环境后通过。第一次真实停用夹具在 bootstrap 前因 plist 不在登记 runtime 中被拒绝，未加载 job，配额已释放。将 plist 放入登记 runtime 后，只执行一次真实启动和停用。历史失败保留在本记录及命令结果中。

本次没有生成新的安装交付包。完整安装、从新入口实际恢复依赖并执行首次语义、受影响 G14、同交付工件 canary、生产 TCC 及生产切换均未运行。正式 G17 仍为 `FAIL`，G18 为 `PLAN`。完整入口内置 `npm test`。其运行范围必须单独确认，并从干净源码冻结实际交付工件。

## 2026-11-03 完整隔离安装结果

用户随后授权一次真实完整安装。冻结源码 `835f6a33d1e627f505f239b0b9d8fda6093efc43`，从干净隔离 checkout 执行 `install-runtime.sh --install-with-gradle`。安装在 `npm ci` 编译 `tree-sitter` 时失败。Node headers 下载返回 HTTP 200。`make` 报 `You have not agreed to the Xcode license agreements.`，退出码 `69`。安装器退出码 `1`。签名构建、完整测试、Gradle 准备、服务启动、真实语义均未执行。

按首次失败停止，无重试。实际安装命令和错误保存在本次运行根 `formal-install-sKNmrw/raw`。控制器的 `acceptance-outcome.json` 记录 `FAIL`，资源核验为 `PASS`。安装器进程组退出，没有 LaunchAgent bootstrap，两张全局配额表均为空。外层 zsh 在控制器退出后因 `status` 是只读变量而未能打印摘要，判定以原命令日志和控制器结果为准。生产及正式门状态保持原记录。

## 2026-11-03 Xcode 许可处理后复验

沿用冻结源码 `835f6a33d1e627f505f239b0b9d8fda6093efc43`。本次重新记录实际 Apple Clang `21.0.0 (clang-2100.4.1.1)` 和 macOS SDK `27.2`，并沿用完整测试所需的冻结 JDT 工具链清单。`npm ci`、原生模块加载检查和签名构建通过。安装器内置源码测试为 `1610 PASS / 1 FAIL`。安装器退出码为 `1`。

唯一失败是 `two HTTP clients reuse one live LSP root and isolate linked worktree LSP runtimes`。首次 `java_status` 的 `started` 实际为 `false`，断言要求 `true`。该测试使用独立的假 JDT 进程。它发送 `ServiceReady`，但不响应 `workspace/executeCommand`。当前启动流程在 `ServiceReady` 后等待 `java.project.getAll`，因此该夹具不能达到就绪门槛。建议只让该夹具响应指定命令，返回初始化时收到的当前仓库 URI。保留原就绪、同仓复用和 worktree 隔离断言。[HTTP 夹具](../../../../src/http-server.test.ts#L521) · [JDT 索引门槛](../../../../src/jdtls-session.ts#L893)

首次失败后停止。脚本测试阶段、候选激活、Gradle 恢复和真实语义未运行。原命令及结果保存在 `formal-install-license-AWfPjt/raw` 和该运行根的 `acceptance-outcome.json`。资源退出核验为 `PASS`，没有 LaunchAgent bootstrap，两张全局配额表均为空。正式门状态保持原记录。

## 2026-11-03 HTTP 夹具修复后的完整安装复验

隔离候选源码 `0a1df0a068cd0431688d25e66d48e525d6a53a2d`。相对上一次仅修改 `src/http-server.test.ts`，沿用冻结工具链和业务副本。`npm ci`、解析器加载和签名构建通过。源码测试 `1611/1611 PASS`，原 HTTP 会话复用用例通过。脚本测试 `667 PASS / 1 FAIL / 10 SKIP`，总数 678。

唯一失败是 `installation preparation confines inputs and preserves its bounded profile`。内层夹具启动校验进程时只覆盖了 `TMPDIR`，继承外层运行根的 `CODEX_HOME`、XDG 和项目配置。校验器拒绝越出内层运行根的路径，输出 `[gradle-prepare] path outside managed root`。此前定向测试未覆盖安装器注入的外层环境。最小修复是在夹具中显式构造子进程环境，将需要的目录放入内层运行根，保留故意传入外层路径的拒绝断言。[夹具环境](../../../../scripts/ilv2-mac-gradle-prepare.test.mjs#L35) · [隔离路径校验](../../../../scripts/ilv2-mac-gradle-prepare.mjs#L37)

安装器退出码为 `1`，未激活服务。Gradle 恢复和首次精确定义、引用未运行。记录位于 `formal-install-http-msW2tf/raw` 和该运行根的 `acceptance-outcome.json`。资源退出核验为 `PASS`，未加载 LaunchAgent，两张全局配额表均为空。正式门状态保持原记录。

## 2026-11-03 独立安装审查与修复

Astra xhigh 独立核对安装器、测试夹具、运行配置和实际日志。审查确认两个缺口。Gradle 夹具继承外层路径。此前真实语义通过使用私有观察器追加 Buildship JVM 参数，而正式隔离入口只把这些参数传给了依赖准备阶段。审查还确认私有控制器须在 stop 失败后继续配额收尾，并补登记准备阶段的进程。

在外层 broker 环境下复现 Gradle 夹具失败。修复后子进程只接收自己的目录，越界断言保留。隔离安装器从已验证计划取得代理端口，只写入本次服务的配置。JDT 启动和 Buildship 使用相同的 TLS 1.2 与本机代理。原证书校验和受管 Gradle init 保留。私有控制器核对 LaunchAgent 配置，移除外部 `JDTLS_EXTRA_ARGS` 注入，并用只读观察器记录实际 Gradle JVM 属性。定向验证 7/7 通过。

第一次审查后完整安装使用源码 `c5c204c4ca1e268e8e2a18937c1a4b1b79ebac6a`。依赖安装和签名构建通过。源码测试 `1610 PASS / 1 FAIL`，未进入脚本测试。唯一失败为资源观测测试 `eventLoopDelay.status` 实际 `UNMEASURED`。在相同冻结 Node 下，用受控延迟复现单次定时器得到 0 个样本，分三个独立 5 毫秒定时器得到 2 个样本。仅修改测试的等待方式，保留原采样间隔、名义等待时间和所有断言。资源观测测试 4/4 通过。原完整失败保留在 `formal-review-njhBXV`，其资源退出为 `PASS`，两张全局配额表均为空。

最后一次完整复验使用源码 `1238d8d359a77d9f9240a5c7fb5708eb36ca6585`。`npm ci` 和签名构建通过。原资源观测、HTTP 会话复用用例均通过。源码测试 `1611 PASS / 1 FAIL`。唯一失败是 `dist/jdtls-session.test.js` 的文件级判定。初始化硬截止用例结束后，连接关闭产生了未处理的拒绝 `The JSON-RPC connection was disposed`。原命令日志保留在 `formal-review-retry-CrwNYi/raw/phase1-install-A.stdout.log`，控制器记录为 `FAIL`。两次完整安装均未进入脚本测试、Gradle 准备或服务激活。

Astra xhigh 复核了该拒绝的调用链。到期时 `DeadlineBudget.race` 收到的是已启动的请求 Promise。到期分支在调用清理回调前没有接管该 Promise。用冻结 Node 和旧编译产物在严格拒绝模式下复现了退出。现已在到期分支先接管请求拒绝，再按原逻辑清理并返回原截止错误。TypeScript 编译通过。严格拒绝模式下的期限回归、原 JDT 硬截止和配置检查共 10/10 通过。[截止处理](../../../../src/runtime/deadline-budget.ts#L70)

本轮按有界复验停止。最后的截止修复只有定向验证。最新源码的完整安装、真实 Buildship JVM 属性、精确定义与引用均未验证。两次完整安装的资源退出均为 `PASS`，未启动 LaunchAgent，配额无残留。正式 G17 仍为 `FAIL`，同交付工件 canary、受影响 G14 与生产 TCC 沿用原待验边界。

## 2026-11-03 截止修复后的单次完整隔离安装

唯一一次执行使用冻结源码 `2f5a3363bd12e3066359ea2019554e1dc3153b63`，相对上一候选仅包含 `DeadlineBudget` 修复及其回归测试。`npm ci`、解析器加载、签名构建和源码测试均通过。源码 `1611 PASS / 0 FAIL`，原初始化硬截止用例通过。脚本 `667 PASS / 1 FAIL / 10 SKIP`，总数 678。

脚本唯一失败是 `gradle-stop-failure-static-recovers-semantic-blocks-then-recovers`。故障修复后，测试在原 30 秒内未观察到 `semanticState=READY`。原错误 `fixture observation deadline exceeded`。脚本失败使安装器退出码为 `1`。该结果属于安装器内置恢复测试。计划中的实际安装期 Gradle 准备、服务激活和真实精确定义、引用均未运行。

本次按授权只执行一次。原命令输出及恢复用例证据保留在 `formal-deadline-DPAdEb/raw`，控制器结果为 `FAIL`。资源退出核验为 `PASS`。本次安装未加载 LaunchAgent，未发现剩余私有进程，两张配额表均为空。正式门与生产范围沿用原记录。

## 2026-11-03 单次 Gradle 恢复取证

在隔离恢复用例启用阶段日志。记录分发发现、launcher 校验、客户端启动、首次输出、退出和原始异常。用例保留触发后的状态。新一轮恢复失败时直接报告服务原错。10 秒清理预算、30 秒观察窗口和进程退出断言保持。

冻结源码 `371c538892211cbcb0f70de5e117efc285232326`。broker 定向验证 `5/5 PASS`，其中一次真实 Gradle 恢复、四项相关检查。先观察到预期的签名摘要拒绝。修正夹具配置后，首次 `--status` 为 914.4 ms。launcher 校验 3.2 ms，客户端启动在该阶段开始后 9.9 ms。客户端启动至 daemon 收到 `ReportStatus` 约 890 ms，daemon 在约 1 ms 后发出响应。`--stop` 为 416.7 ms，退出确认 26.7 ms，后置 `--status` 为 492.8 ms。约 1.86 秒完成清理链，旧 daemon 退出，`READY` 及恢复后的真实定义通过。

历史 10 秒慢路径未复现。历史记录缺少客户端启动时间。保留原失败与当前通过两份证据。仅实施诊断和观测修复，未据此修改恢复策略或推定历史延迟的细分原因。完整安装未运行，正式门保持原判定。

本次运行根为 `recovery-trace-hAId9G`。原始证据归档 SHA256 为 `8984fb38425ca1f36e1793e5ceefd2eab5a9287d69d9786ffa9434026775f4ea`。34 个文件完成一次物理解压及哈希核对。13 个 PID、2 个自有组和 1 个 LaunchAgent 的退出核验通过。配额与到期临时文件均无残留。

构建、验收和安装拆分另见 [封存工件交付方案](artifact-delivery-plan.md)。
