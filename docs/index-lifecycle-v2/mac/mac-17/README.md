# MAC-17 安装候选与隔离 canary 收尾

2026-10-31。本轮授权范围已完成：MAC-16 收尾、MAC-17 安装链路、签名候选、隔离 canary 与审查材料。未 push、未调用或修改生产，未追加性能或精度优化。完成时间早于 2026-11-03 18:00+08 截止。

候选可供审查。正式 **G17 = NOT_RUN，candidateStatus = NOT_READY**：完整 installer 入口、生产固定路径 TCC、首次私有 Gradle 语义等验收尚未完成。本轮的子结果 PASS 不替代这些合同。唯一门状态来自生成的 [task-result.json](task-result.json) 与 [status.json](../status.json)。

## 候选身份

| 项目 | 值 |
|---|---|
| 源码提交 | `0fb81bb52c0e57d7f092f49a172bcd079494c29e` |
| 实现提交 | `eba23e14`；签名环境修复 `0fb81bb5` |
| 全源码文件清单 digest | `0ab2046807aa708bbfcbb633206cd0cf7236a3eef790fb3410e529a42dc74fc4` |
| broker 源码 digest | `e69807ad083f97d3dc34ddeb392e23553255b4ab2ea1a39ea4f6a79f0f138fb4` |
| 工件文件 inventory | `be447474f95409e35dc5eca8ecda0312ea3fc8c78dd147cfc44c3f0cfeeb8804` |
| native binary SHA256 | `d2027502ddeb3548a703bb18b134f3f29a31a65a62a5b5f79435069ef6c443c6` |
| 签名 | 实际 certificate identity；Team `2UVGT2J459`，固定 identifier，稳定 DR；两份构建严格验证通过且 CDHash 一致 |
| 文件数量 / 逻辑字节 | 7266 / 305205216 bytes，包含物理复制的依赖 |
| 候选包 | `/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261031T021745Z/deployment-candidate-0fb81bb52c0e.tar.gz` |
| 候选包 SHA256 | `20a8d575469cf6da7d77477e21e3579dc1b065068d4e5243c93b942503a29ef1` |
| 包大小 | 30714864 bytes |

候选包已实际解压一次并逐项核对全部 7266 个文件。源码全文件 digest 与 broker 选定构建输入 digest 使用不同文件集合，不混用。该包是冻结审查工件；现有 installer 没有直接消费预构建工件的入口，安装时仍会重建和运行完整测试。

## 实现结果

- launchd Program 直接指向固定 `launcher/dist/native/ilv2-mac`；参数指向具体 immutable release entry。native owner 持有 canonical cache 的 fd4 锁，直接 exec 冻结 Node。
- 完整 launcher bundle 封装 guard 及 JS 闭包、manifest、ESM 声明和逐文件 inventory；核验文件集合、权限、hash、native/runtime 和真实稳定签名。不是单独复制 binary。
- plist 显式使用 RunAtLoad、失败重启、1 秒 throttle、`AbandonProcessGroup=false`；锁忙非零退出、最长等待 5 秒。
- 新 ILV2 cache 与独立 service-state/Gradle home 分离。升级和 rollback 成对恢复 bundle、env、plist、稳定入口、immutable release 和 predecessor pointer，保留数据目录。
- 已有 daemon.env/current 但没有 verified MAC-17 bundle 时，在停服前拒绝覆盖。首次 ILV2 安装须使用显式的新 runtime 目录，保留旧 runtime/cache/state。
- 删除无调用的旧 stdio 迁移/注册 helper 及对应废弃测试，移除无生产导入的 chokidar 依赖；stdio 保持 owner relay。
- 显式 keychain 签名时，只有 codesign 签名子进程使用账户 HOME 查找身份；编译、探针和产品仍使用隔离 HOME。不复制或导出 keychain/凭据，不增加堆/RSS 杀进程阈值。

## 实际验证

| 验证 | 结果与边界 |
|---|---|
| 正式签名构建和隔离环境探针 | READY；native/runtime/工具链身份匹配 |
| 受影响定向测试 | 65/65 PASS，0 fail/skip；安装、bundle、canary、删除清单、扫描、签名、锁和退出 |
| 不同执行者的另一次构建 | 4/4 关键锁/退出/协议边界 PASS；源码、runtime、native source/protocol、Team/DR/CDHash 一致 |
| 真实安装组合演练 | A_READY → B_READY → 真实 daemonctl rollback-release → A_ROLLBACK_READY；真实签名/helper/plist/controller，退出清理 PASS。两条 immutable 路径使用同一源码，不是完整 installer 或跨版本迁移 |
| 两小时 canary | 1000 正常请求：900 query + 100 status；20 次真实编辑另计；1020 槽位全 PASS，稳定请求错误 0 |
| 正常请求跨度 | 7204072.349 ms（约 120.07 min） |
| 20 次编辑首次正确结果 p95 | 1148.355 ms，门槛 3000 ms |
| 两窗口 status p99 | 31.287 / 53.791 ms，门槛 200 ms |
| full / seed / restart | 实际观察 full publication、seedFrom 和编辑后首次正确结果；计划重启单列故障窗口，前后 PID/PGID、endpoint、build/instance 均读回 |
| 运行身份与正确性 | 响应 workspace/snapshot、声明路径/FQN/contentHash 与计划一致；完整候选文件身份在前后匹配 |
| 主机窗口 | 126 样本均 AC；wall/monotonic 连续，起止负载 <20；未因内存/RSS 阈值杀进程 |
| 既有证据复用 | G12/G14 保留；`git diff 39a4aefe..0fb81bb5 -- src native` 无变化，runtime/运行依赖指纹与 G14 相同。新安装/签名边界已有上述定向证据 |

精确 argv、退出码、计数和证据 hash 由 task-result 生成器从原 validation-index 读取。原始所有 preflight/admission 失败均保留；签名身份不可见和仓外私有 harness 被 broker 拒绝属于环境/入口失败，没有包装成行为 RED，也没有覆盖失败记录。

独立评审只读检查原始 calls/plan/identity/source 及资源实际状态，没有重跑 canary、矩阵或再次解压候选包。真实 JDT 证据沿用此前 G14/G16；本次静态 canary 禁用 JDT。

## 归档与资源

统一清单登记 101 个 PID、29 个自有进程组、27 个 launchd job；实际退出及配额释放通过。raw/tmp 已删除，未登记路径和到期残留字节均为 0。候选 tar、清单和本地证据摘要保留。

原始证据归档：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261031T021745Z/closeout/raw-evidence.tar.gz`，SHA256 `981d03d625db8d702fc9fc480af7fa05d51a4a058c429bc785e94f480405d349`；249 文件，原始逻辑字节 16009557，一次物理解压/全 hash 验证 PASS。

首次清理已完成归档验证和 raw 删除，随后因两处 0555 snapshot 目录拒绝 unlink。资源退出后只给本次到期 tmp 中这两个自有目录增加 owner 写权限，再继续原统一清理，保留第一次失败与恢复记录。原归档复用，没有第二次归档或解压。详细记录在私有 `closeout/finish-attempt1-failure.json` 和 `closeout/closeout.json.cleanupRecovery`。

## 部署前剩余合同

| 未完成项 | 当前边界 |
|---|---|
| 完整 installer 安装/升级/回滚入口 | NOT_RUN；现有入口每次重建、npm ci 和完整测试。组合演练不替代这项验收，本轮没有新增工件输入选项 |
| 生产固定 launcher 路径 TCC、首次业务仓读取、升级复读 | NOT_RUN；用户本轮明确排除生产，因此没有触发授权探针，也没有宣称观察到 TCC 拒绝 |
| 空私有 Gradle home 的首次下载、语义可用时间、额外磁盘 | NOT_RUN；静态可用不代表语义可用，不能从既有配置推定首次下载不发生 |
| MCP canary 内部 held lease / 正向 snapshot reclamation | UNVERIFIED；246 实际 sweeps、reclaimed 列表 0、一个初始 snapshot 消失不足以证明完整回收合同。硬不变量复用 G14，不追加运行来补造 PASS |

下一步仅处理这些剩余验收；本轮到此停止。没有自动启动 MAC-18/19、生产切换、付费模型评测或后续优化。

未来生产方案供审查，均未创建或读回：

| 绑定 | 拟定绝对路径/值 |
|---|---|
| 新 runtime | `/Users/luo/Library/Application Support/codex-java-lsp-mcp-ilv2` |
| 固定 launcher | `/Users/luo/Library/Application Support/codex-java-lsp-mcp-ilv2/launcher/dist/native/ilv2-mac` |
| 独立 cache | `/Users/luo/Library/Caches/codex-java-lsp-ilv2` |
| service-state | `/Users/luo/Library/Application Support/codex-java-lsp-mcp-ilv2/state` |
| 私有 Gradle home | `/Users/luo/Library/Application Support/codex-java-lsp-mcp-ilv2/state/jdt-gradle-home` |
| label / MCP | `com.lky.codex-java-lsp-mcp` / `127.0.0.1:38456/mcp` |

生产切换须另获明确授权，并先冻结实际配置和旧 runtime/cache/state/plist 保留位置。保留旧 owner 的可恢复入口；停止新 job 后恢复旧完整配置再启动旧 owner，核验两者不会同时拥有同一 cache。首次 ILV2 安装没有 verified 前序 bundle，不能把 subsequent release rollback 当作自动旧系统迁移。当前未读取生产状态。
