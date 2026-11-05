# JDT 初始导入就绪修复与验收

已完成修复、隔离验证和当前安装版同步，安装构建为 `83aa814049e5`。原 PARTIAL 的真实 Agent 任务本次恢复成功，取得真实 JDT 精确引用；调用轨迹中的冷态未就绪和 impact 超时仍单独保留。

本次增量以已安装 `48bad915c854` 为基线。主工作区只应用本次 9 个文件的补丁；其余 22,050 份已有文件内容保持原哈希。主工作区没有提交、推送或创建 PR。

## 结果与实现

- `initialize` 仅建立协议连接。启动事务等待当前连接的 `language/status` **ServiceReady**，再复查 lease 和启动代次，才进入 READY。初始化 Error 优先于后来到达的完成通知；stop、进程退出会终结导入等待。
- `java_status` 的 `progress.importState` 区分 NOT_STARTED / IMPORTING / READY / FAILED。冷态 position、references 不再把未完成导入表现为成功的空实现/引用结果，而给出未就绪提示和状态轮询方式。
- 保留按需启动、原语义请求预算、注解处理和 Lombok agent。只对 JDT 发起的 Gradle 导入加入 `java.import.gradle.jvmArguments=["-Dorg.gradle.parallel=false"]`；业务仓库和用户 Gradle 并行配置未修改。
- **READY 仅表示初始导入阶段结束，不保证后续全部构建、索引或 APT 生成代码语义已完成。** 之后的语义请求仍按原预算返回成功、超时或失败。

## 已执行验证

- 隔离 A/B：JDT LS 1.56.0、Gradle 9.3.1、JDK 25.0.1、真实 cipherlink 多模块源码。基线复现跨工程 processor configuration 的 unsafe lock；串行组无该错误且产生 13 份 factorypath。client 的 Lombok 1.18.46、MapStruct processor 1.6.3 路径存在且 enabled=true，APT prefs 为 aptEnabled=true。验证的是 APT 模型与配置同步，**未声明生成代码语义全面正确**。
- 保留 A/B 首次 references(10s) 超时记录。前两轮隔离验证的路径/缓存问题与下载超时也保留，未改写为 PASS。
- 修复前初始就绪回归 2 FAIL；独立评审发现的 3 个问题回归 3 FAIL；修复后 6 个 focused 用例、146 个相关模块用例 PASS，0 fail / 0 skip。
- 全新 workspace 的真实 stdio MCP：静态定位保持 JDT 为 NEW；首次默认 3000ms references 返回未就绪，导入继续。验收会话第 25.33s 观察到 READY；第 34.65s 单独的真实类型/路径索引探测完成，探测本身约 9.32s。此前包含 11.67s 静态定位，以上累计时间不是纯导入耗时。
- 索引探测后，原 references 参数、默认 3000ms 预算返回 11 条引用，用时 240ms；includeDeclaration=false 的新请求键返回 10 条，用时 225ms。均未截断、未用 completed cache 命中代替热态后端查询。独立索引探测是本次验收脚本的步骤，**不是产品默认预热路径，也不能据此保证 READY 后立即查询必定成功**。

相关回归命令（在干净隔离候选与私有测试环境内执行）：

```text
npm run build
node --test dist/jdtls-session.test.js dist/tools/status.test.js dist/tools/symbol-static.test.js dist/mcp-server-factory.test.js dist/semantic-gateway.test.js dist/repo-runtime-manager.test.js dist/generated-code.test.js
bash install-runtime.sh --port 38456 --canary-port 38457
```

首次发布检查在 `93f839b71d79` 的 1371 项测试中发现 3 项旧测试替身缺少新合同（HTTP ServiceReady 通知与两个 status()）；保留 1368 PASS / 3 FAIL 原始记录。补齐替身后，原断言未改，最窄重跑 3 PASS / 0 FAIL / 0 SKIP。生产代码哈希保持不变，独立评审已确认可重新执行发布检查。隔离冷恢复证据绑定冻结源码哈希，使用提交前候选的构建 stamp；最终安装身份另以安装版健康检查和真实 Agent 记录核实。

最终候选 `83aa814049e5` 已通过安装器发布检查：1371 个源码测试和 436 个脚本测试 PASS，0 fail / 0 skip；1781 个已安装源文件逐一哈希匹配，63 个文档日志按发布规则排除。正式 /healthz、/readyz 与 5 工具 HTTP smoke PASS。MCP URL 仍为 http://127.0.0.1:38456/mcp；原 plist 环境和 projects 配置保持原值，上一版 48bad915c854 保留在 previous-current，可回滚。

## 原 PARTIAL 真实 Agent 重跑

沿用原业务 prompt、cipherlink 根目录和当前 Codex 默认配置，未覆盖模型或指定工具顺序。实际命令为 `codex -a never exec --sandbox read-only --ephemeral --json --color never -C /Users/luo/Documents/program/cipherlink -o <evidence>/agents/semantic-primary/answer.md -`，原 prompt 由 stdin 输入。用时 132.503s，exit 0，前后业务 Git 状态均干净；没有观察到业务构建、应用启动或数据库操作。

实际调用顺序及结果：

1. `java_status(start=false)` 确认 cipherlink、安装构建 `83aa814049e5`、JDT NEW / importState NOT_STARTED；静态 query 定位接口。
2. 首次默认预算的 JDT references 返回导入未就绪提示，后台导入继续；随后 `java_impact(semanticPolicy=required)` 仍为 **PARTIAL_TIMEOUT**。
3. 后续 `java_status(start=false)` 返回 READY / importState READY，注解处理仍启用。
4. Agent 自主重试 `backend=jdt` references：接口返回 **11** 条、checkUpdate 返回 **9** 条、listDownloadLinks 返回 **4** 条，均未截断。结果覆盖 DefaultClientUpdateAppService 和两个生产 Controller；实际源码读取核实了升级策略与下载链接查询。

本次精确引用任务验收 **PASS**，不能表述为所有语义调用 PASS。原 Agent 答案末句“仅核对源码和静态引用”不够准确，完整轨迹实际包含 JDT 精确引用；原答案原样保留，以调用记录为证据。当前 Codex 配置在本轮内未变，但在本轮开始前已不同于历史运行，不声称跨版本配置字节一致。

stderr 保留 CLI 配置告警及另一 MCP 端口 14242 连接失败；本次 Java MCP 端口 38456 的调用成功，不声称日志零错误。源码结论与引用轨迹由不同代理只读核验，未重复启动 JDT 或运行测试。

机器可核对结果见 [validation-summary.json](jdt-import-readiness-evidence/validation-summary.json)、[agent-rerun.json](jdt-import-readiness-evidence/agent-rerun.json) 和 [独立核验](jdt-import-readiness-evidence/independent-review.json)。原始安装日志、失败记录、Agent events/answer/stderr 及逐文件 SHA256 清单保存于 [本次证据归档](/Users/luo/Documents/Codex/codex-java-lsp-mcp/2026-10-11/jdt-import-readiness-83aa814049e5/README.md)。

## 官方协议真源

- [InitHandler 初始化成功/错误通知](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.56.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/InitHandler.java#L247)
- [ServiceReady 与后续 build/index 顺序](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.56.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/JDTLanguageServer.java#L294)
- [Gradle import JVM 参数与注解处理配置](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.56.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/preferences/Preferences.java#L1173)
- [非空 workspace symbol 搜索的索引等待与异常处理](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.56.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/WorkspaceSymbolHandler.java#L54)

历史真实 agent 的 `48bad915c854` 结果仍为 3 PASS / 1 PARTIAL，见 [原指导验收](java-agent-guidance-review.md)；本次只重跑原 PARTIAL 用例，新结果另行记录，不覆盖旧结果。
