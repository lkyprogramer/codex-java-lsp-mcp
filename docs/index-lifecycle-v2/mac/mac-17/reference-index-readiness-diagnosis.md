# MAC-17：首次引用等待搜索索引的根因与最小方案

本页保留诊断当时记录。该方案随后按用户授权实施；[修复与单次验收](index-ready-fix-acceptance.md)通过，原诊断和失败记录不变。

已确认：当前客户端在 `ServiceReady` 后提交 READY。此时 JDT 搜索索引仍有排队任务。本轮首次引用等待该队列，并在原 10 秒期限取消。

本轮只诊断并给出方案。产品代码未改。完整语义验收仍失败。历史失败保留，候选继续停用。

## 同 PID 证据

唯一隔离复现使用 JDT PID 5991。源码摘要、dist、Node 依赖和 native 均沿用原身份。1395 个第三方工件逐项同字节。399 个必需文件在标准化私有运行根后也完全一致。

| 原始观测 | 支持的结论 |
|---|---|
| JDT 启动后 33.501 秒发出 ServiceReady | 初始化导入完成 |
| 引用发送后第 4 秒 | 引用线程位于 `ReferencesHandler → BasicSearchEngine.findMatches → JobManager.performConcurrentJob → Object.wait` |
| 同一引用的第 8 秒 | 同一线程仍等待同一个 IndexManager 队列 |
| 索引线程的两次栈 | 从 `AddJarFileToIndex` 读取 JAR，推进到 `SourceIndexer.resolveDocument` 类型解析 |
| 索引线程 CPU | 从 8740.17 ms 增加至 12334.29 ms；差值 3594.12 ms |
| 原 10 秒截止 | 发出取消；JDT 返回 request id 4 的 `-32800`，没有引用结果 |

两张快照证明第 4 秒和第 8 秒的等待位置。它们不证明完整 10 秒的每一瞬间都停在同一位置。本轮证据不支持死锁。两次快照均未进入实际引用匹配。

观测器记录实际传输接口的调用与返回。观察序号不等于 JSON-RPC ID。取消响应中的 request id 来自实际 JDT 错误。

两次 `jcmd` 耗时为 261.111 ms、133.205 ms。它们不是完整 JVM 暂停成本。本次数据不用于 SLO 声明。原无栈案例此前已经在相同 10 秒期限失败；本轮只补齐定位证据。

## 代码中的原因

客户端在 `src/jdtls-session.ts:894` 等待 `ServiceReady`。它在约第 900 行提交 READY。当前路径没有等待 JDT 搜索索引排空。

冻结 JDT 的 `ReferencesHandler` 会进入 `BasicSearchEngine.findMatches`。该路径使用 `WaitUntilReady`。引用的原请求期限因此覆盖初始索引等待。客户端的 `active progress=0` 没有覆盖这条等待路径。

`ServiceReady` 只表明初始化阶段完成。它不保证搜索索引排空。原案例日志虽然已有 `build jobs finished`，仍不能据此推断搜索索引就绪。

历史 PID 没有超时现场栈。本轮根因确认限于这次同上下文复现，没有改写历史观测。

## 彻底解决方案

只修正现有启动事务。TLS、代理和依赖恢复保持原样。

1. 等待当前的 `ServiceReady`。
2. 使用当前 `attempt.connection` 调用既有只读命令。
3. 校验返回的项目 URI 数组。
4. 保留现有启动尝试及生命周期检查。
5. 通过后再提交 READY。

拟议调用为：

```ts
const projectUris = await budget.race(
  "jdtls.search.index",
  attempt.connection.sendRequest("workspace/executeCommand", {
    command: "java.project.getAll",
    arguments: []
  })
);
```

这是拟议代码，尚未写入产品。它复用同一个启动 `budget`。总启动期限仍为 120 秒。引用期限仍为 10 秒。公共请求期限仍为 15 秒。

返回值必须是文件 URI 数组。数组必须包含当前 canonical repo 下的真实导入项目。空值、格式错误和仅包含其他仓库的结果必须终止启动。既有失效尝试检查继续拒收晚结果。该调用使用当前启动连接，不经过要求 READY 的语义入口。

冻结 JDT 的 `JDTLanguageServer.executeCommand` 第 614–615 行会先执行 `IndexManager.waitForIndex(true, null)`。之后，`ProjectCommand.getAllJavaProjects` 只读取项目目录 URI。该命令不构建项目，不修改源码，也不预热查询答案。

因此方案无需新增 bundle、命令、IJob 或依赖。它不使用固定 sleep、语义查询预热、重复引用请求或部分结果。它也不使用 `workspace/symbol` 作为替代；后者会捕获取消或异常并返回已收集的集合，不能可靠证明完整索引就绪。

该同步索引等待不支持 LSP 合作式取消。120 秒超时时，必须沿用现有启动失败和自有 JDT 退出清理。不得降级为仅凭 `ServiceReady` 宣布 READY。

READY 的含义是本次启动通过当前索引队列屏障。后续文件变更仍会触发正常索引。本方案没有增加新的状态或兼容分支。

## 实施与验证边界

预计只修改 `src/jdtls-session.ts` 和对应生命周期测试。没有新公开 API，也没有 JDT 升级。

- 定向验证：ServiceReady 到达而索引命令未完成时，状态仍为 STARTING。
- 定向验证：有效结果仅提交当前启动尝试；失败、超时或停止后的晚结果不能提交 READY。
- 一次真实隔离验收：保留原 120 秒启动期限及精确定义、引用门槛。引用仍限 10 秒，公共请求仍限 15 秒。
- 复用已有安装与依赖身份，不重跑完整测试、完整 installer、兼容或回滚。

这些修复验证尚未运行。现有证据只证明缺失的索引屏障。加入屏障后是否满足 120 秒及完整引用门槛，必须由上述一次真实验收决定。

单次 `start:true` 的 15 秒调用预算行为保持。原共享启动仍可继续，并由 `start:false` 读取状态。方案不承诺所有接口都没有超时。

## 证据和收尾

本轮唯一运行用例保留 1 FAIL。另一个 1 PASS 只验证已经生成的证据文件，没有启动第二个运行。Astra xhigh 独立确认了根因、既有 API 和资源退出；审查不表示修复通过。

- 源码摘要：`48253f3cc857bb9313c883bd5857247cabdc70a2a673dbabd3e23dd0ba20035a`。
- 实际 native SHA：`7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`。
- 复用候选包 SHA：`b5849e32d5f04c94de29c97357692f8e7e313f05a370ba2663f83f85bc66d0f6`。没有重建或重复物理解压验证旧包；只恢复必要的新消费者并核对身份。
- 本轮 raw 归档：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T161200Z-reference-timeout-evidence/closeout/raw-evidence.tar.gz`。
- raw SHA256：`0a07e75e0694bb88bc7c902c9c35cbd13efd5a76114131e202ade0af14d769ed`。
- 归档包含 51 个文件。统一 closeout 完成一次物理解压及全 hash 核对。

20 个 PID 和 7 个自有进程组均退出，包含两次 `jcmd`。精确运行根进程、launchd job 和两张配额表均无残留。到期 raw/tmp 已删除。候选、历史失败、方案、清单和归档保留 LOCAL。

[诊断 workflow 结果](reference-index-task-result.json) 只表示诊断证据通过。[完整摘要](reference-index-diagnosis-summary.json) 保留身份与边界。正式 G17 和产品验收仍为历史 FAIL。生产 TCC 未运行。本轮没有产品修复、push 或生产操作。
