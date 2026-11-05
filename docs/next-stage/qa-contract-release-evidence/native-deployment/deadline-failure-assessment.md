# Deadline failure assessment

**现有证据未证明 shared backend 被 10ms 首 caller 截断。500ms 确实包含 cold startup，但主导耗时仍待窄 instrumentation 确认。** 不应延长预算、跳过断言或靠反复全套重跑取得 PASS。

## 已观察事实

原测试 src/jdtls-session.test.ts:1382–1408 使用未启动 session；fake definition handler delay40ms。随后创建原10ms与500ms绝对 caller deadlines。attempt4 同611源码全1366 PASS，该测试完整 TAP duration479.924417ms；attempt5源码1365/1366，唯一该测试 FAIL，完整duration503.005958ms，long definitions=[]。attempt5 installer 正确拒绝切换，其 proof cleanup 为 STOPPED_JOB_ABSENT_PORTS_FREE，productionDeploymentPerformed false。旧全套失败保持失败；单失败重检通过不能覆盖它。

TAP duration 包括 harness 构造及清理，不是500ms预算内分段。因此不能据479ms直接声称已测20ms余量，也不能据503ms直接证明 ps 占了多少时间。

## 真实调用边界

harness (test:130–178) 构造 JdtlsSession。resolveProjectJdk 在 constructor:278 执行，其 JDK目录扫描、java_home与必要java-version探测均发生在caller DeadlineBudget创建前。直接把JDK探测时间计入本条500ms预算，与代码顺序不符。外部资源竞争仍可能影响后续调度，但没有现有分段证据。

预算创建后路径为 semanticLocations (jdtls-lsp-io:166)→gatewaySemanticValue→SemanticGateway.execute→backend.execute→rawDefinition→ensureSemanticStarted→ensureStarted→startAfterLease→startTransactional，完成启动后才读取文档并发送definition。DeadlineBudget 使用真实 performance.now 和 setTimeout；harness注入的now只供session/gateway状态时间，不会冻结caller预算。

传入DeadlineBudget时 semanticOperationCap 返回 DEFAULT_LSP_REQUEST_TIMEOUT_MS (jdtls-lsp-io:981)，不是首次10ms的 remaining。Gateway的backend cap独立于caller budget，short截止仅移除自身waiter；同键long仍在时不会因无waiter abort。startAfterLease也使用独立startHardCap。这条代码未显示原hard-cap回归。

FakeFactory仍分配默认pid40001 (fake-jdtls:231)。startTransactional:777 调用trackSpawnedChild→captureOwnedIdentity，后者用processCommand→listProcesses→同步 ps -axww 全进程扫描；unseen时最多3次扫描，间隔两次25ms。initialize后rememberOwnedIdentity可再次执行同样链，期间另有processStartIdentityForPid的同步ps。这些真实OS活动以及cold mkdir/document read都处于caller500ms窗口内。fake initialize本身立即返回，但“fake transport”并未隔离真实进程身份探测成本。

semanticLocations约定把caller deadline或backend失败降级为absent definitions，故[]本身不区分正确caller超时与SUT错误。既有raw未包含request起止、READY、每次ps或gateway settlement分段，无法确认准确失败stage。

## 可证伪解释与最小修法

最可能解释是fake不存在PID引起的cold身份扫描/重试，加上文件准备和调度，使long在结果完成前正确用尽自身500ms。这是代码支持的假设，尚非测量确认的根因。若instrument显示READY及definition handler完成都在500ms内，long仍得到[]，应调查gateway settlement/abort/deadline arithmetic；此时不能用测试预热掩盖SUT错误。

主代理的无语义改变窄instrument应记录harness完成、两deadlineAt、start/track每段、每次ps耗时与verdict、initialize、READY、rememberIdentity、definition send/handler start/end、两个caller settle、remainingMs与gateway sharedJoins/abortedNoWaiters。保留失败原始日志，不以新记录覆盖旧FAIL。

若确认是late cold startup，这条“共享semantic backend cap”测试的最小边界修正是先用既有ensureStarted setup建立READY，然后再创建原10/500预算，保留short=[]、long=[location]及definition count1全部断言。既有 test:710 的cold shared-start测试（10/5000、STARTING、child不kill）继续验证冷启动caller隔离。可以用deferred definition barrier在short已settle后再释放共享结果，明确验证long仍持有共享backend；不增加预算或改变产品语义。

真实冷启动身份扫描也可能影响产品延迟，但现有证据不能归因占比，不建议本轮改生产生命周期或进程安全规则。任何已授权测试边界改动都需要新source/package身份及相应installer实际验证，不能继续沿用6d/a77执行身份冒充新变更。

本次只读源码和已有raw，没有运行测试、instrument、model、benchmark或installer。报告完成；最窄下一步是主代理原用例分段记录，按上述falsifier决定测试边界修复还是SUT调查。
