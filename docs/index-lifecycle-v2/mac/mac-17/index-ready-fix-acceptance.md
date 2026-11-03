# MAC-17：索引就绪修复与单次真实验收

已完成：首次引用因初始索引等待而超时的修复。17 项定向检查和唯一真实语义验收通过。

本轮将初始索引等待纳入原 120 秒启动预算。索引屏障返回后，客户端才提交 READY。首次精确定义和引用均使用原断言，没有查询预热或缓存答案。

## 改动

- `src/jdtls-session.ts`：收到 ServiceReady 后，用当前启动连接调用既有只读 `java.project.getAll`。沿用同一个启动 budget。
- 同一文件使用标准 `fileURLToPath` 解析 Java 的 `file:/` URI。返回值须包含当前仓库的有效项目。原心跳、启动尝试和停止检查继续生效。
- `src/jdtls-session.test.ts`：验证屏障未完成时不能 READY，以及无效响应、失败、启动超时、停止后的晚结果。
- `src/test-support/fake-jdtls.test.ts`：共享夹具只补充该内置命令的默认响应。其他未知命令仍失败。真实验收没有使用该夹具。

没有新增插件、状态、公开 API 或依赖。TLS、代理、证书校验和签名配置保持。首次索引等待在启动阶段结束，语义查询继续受原 10 秒预算限制。

## 实际验证

| 项目 | 本轮结果 |
|---|---|
| 定向生命周期检查 | 已验证：17/17 通过，无 skip |
| 唯一真实隔离验收 | 已验证：1/1 通过，无第二次运行 |
| 新 JDT | 已验证：PID 29078，单次启动 |
| 只读索引屏障 | 已验证：调用耗时 74.356 秒，返回 21 个有效项目 URI |
| JDT 启动至客户端 READY | 已验证：106.150 秒，原 120 秒上限保持 |
| 从发起启动至首次完整语义 | 已验证：109.092 秒，包含轮询和两个语义调用 |
| 首次精确定义 | 已验证：455.380 ms，原 hover 与精确位置断言匹配 |
| 首次引用 | 已验证：430.448 ms，返回两个预期位置 |
| gateway | 已验证：0 hit、4 miss；唯一引用走实际后端 |
| 语义时序 | 已验证：屏障返回后才发送真实语义请求；没有提前 READY |
| 新增依赖工件 | 已验证：JDT 阶段为 0，不表示网络请求为 0 |

同一 JDT 的实际时序为：

```text
01:55:18.913 UTC  ServiceReady / getAll[] sent
01:56:33.268 UTC  getAll returned
01:56:33.271 UTC  client READY
01:56:35.757 UTC  definition returned
01:56:36.188 UTC  references returned
```

这些时刻对应北京时间 2026-11-03 09:55–09:56。本轮没有 jcmd、采样或额外等待探针。

安装期必要依赖恢复耗时 113.188 秒。两个模型通过，包含 23 个项目、399 个必需二进制和 1 个处理器文件。1395 个依赖工件与原案例逐项同字节，共 324604180 bytes。该阶段从空私有 Gradle home 开始。后续 JDT 使用准备后的缓存，没有把旧的空缓存全程 120 秒 FAIL 改成 PASS。

原 `firstFailure` 仍记录较早的静态 MCP 错误。`start:true` 也仍触发原 15 秒调用超时。共享启动继续，`start:false` 轮询随后确认 READY。这些原始记录保留，没有声明所有调用都成功。

原 RED 为 5 项失败。其中 4 项暴露缺失屏障；另 1 项是单元夹具注入 150 ms 启动预算，导致 initialize 前超时。该配置失败保留。单元夹具改用注入 2 秒验证期限行为，真实验收的 120 秒、10 秒和 15 秒均未修改。

## 身份与可审查候选

- 基础提交：`ff81b8ddbcb8c508f785f035be92323e5a8b4027`。
- 本地源码摘要：`7805669821c95e8995b10adae6a005e614c0ab90dc81548f20296a359f82be0d`。
- 聚合产品补丁 SHA：`597d55ae122f4b0d95b9977dbcb8f02d8a47030e2de5345523a832abaa1e19a5`。
- build：`ff81b8ddbcb8+p597d55ae122f`。
- 当前候选：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261103T014500Z-index-ready-fix/review-candidate-7805669821c9.tar.gz`。
- 候选 SHA256：`c6fc6ab4ff760c57af65d7d03838378dba40538820868d330219c7ca12148ba3`。
- inventory SHA256：`1890fbc5466123a108efcf9cc22487d94441d18e098446bf1402b8a4cf783855`。
- 6508 个普通文件、1183 个目录、7 个相对链接；一次物理解压及全量 mode/link/hash 核对通过。
- 实际 native SHA：`7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`。同字节签名证据继续复用，没有新 native 构建。

候选按本次编译的真实代码打包。Node 依赖继续复用。没有 npm ci、完整测试、完整 installer 或独立重建。此前 b584 父包只用于必要的新消费者恢复；来源字段在封存前校正，未重复其物理解压验证。

## 独立复核与收尾

Astra xhigh 对实现、17 项检查记录和唯一真实验收完成只读复核。审查确认原精确 oracle、固定 PID、真实 gateway miss 和屏障前后顺序。审查没有重跑测试、构建、网络请求或包解压。

19 个登记 PID 和 7 个自有进程组均退出。精确运行根进程、隔离 launchd job 和两张配额表均无残留。统一 closeout 通过。到期 raw/tmp 已删除。候选、清单、原失败、验证索引和归档保留 LOCAL。

- raw 归档：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261103T014500Z-index-ready-fix/closeout/raw-evidence.tar.gz`。
- raw SHA256：`e5ff6532a59865fb968babac24596412321a29c3f4464c35a927a2a4f5158062`。
- 归档包含 52 个文件。一次物理解压及全 hash 核对通过。

[生成结果](index-ready-fix-task-result.json) 和 [完整摘要](index-ready-fix-summary.json) 记录本轮通过范围。历史失败与正式 G17 的 FAIL 保留，没有用本轮单项验收覆盖其他门。

验证范围是当前冻结工具链和业务副本的首次语义。后续文件变更继续沿用既有索引生命周期。本轮没有验证普遍查询延迟或 AI 收益。

生产固定 launcher 的 TCC、业务读回和升级后复读未运行，原因是用户排除生产。兼容与回滚按用户要求跳过。没有 push、部署或生产修改。当前工件是 LOCAL 审查候选，不表示 READY_FOR_DEPLOY 或 DEPLOYED。本轮早于北京时间 2026-11-03 18:00 截止点收尾。
