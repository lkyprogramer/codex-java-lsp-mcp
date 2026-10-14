# MAC-17 — 最终构建、canary 与可审查安装包

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** `install-runtime.sh`、`scripts/runtime-artifacts.test.mjs`、README、HANDOFF、[生产操作文档](../../../phase-f/production-operations.md)、隔离 canary。

**步骤：** 安装工件包含并校验native binary/权限/版本；移除旧stdio runtime迁移和双schema启动合同。生成release digest、唯一缓存/独立serviceStateRoot布局、§2.1完整launchd配置（RunAtLoad、KeepAlive/非零OWNER_BUSY、ThrottleInterval、AbandonProcessGroup、5 s锁等待）及停止/回退步骤，按生成plist读回核验。按§2.1的TCC决定落实launcher身份与授权方式，并在隔离launchd下用`ilv2-mac-env-probe.mjs --read <业务仓内文件>`证明READY；BLOCKED_ENV_TCC不能计入G17。canary用`:38457`独立cache和service-state，通过start启动后attach回放≥2 h、≥1000正常请求，含full/seed/编辑/重启/lease/GC；真实JDT专项另测，其余可禁用JDT。

**验收G17：** 本卡修改构建输入后先补受影响G14门；运行实例build/source/native身份与候选匹配，§6正常窗口SLO达标，输出回滚演练和安装清单。部署请求精确到SHA/digest、生产路径、唯一owner、旧缓存和service-state保留/恢复方式；披露空私有Gradle home下首次发行版/依赖下载、首次语义可用耗时和新增磁盘实测，未测明确标注，静态与语义可用时间分开。只迁入核实必需且获授权的构建配置，不整份复制用户Gradle home或凭据；不能由“当前未见配置”推定生产永久无需配置。工程候选可READY_FOR_DEPLOY，尚非DEPLOYED或AGENT_IMPROVED。
