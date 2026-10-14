# MAC-01 — 先让错误可测

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** 新 `scripts/ilv2-mac-{driver,burst-replay,slo-report,fault-matrix}.mjs` 及平铺测试、测试 fixture、遥测类型；`run-isolated-validation.mjs`/`run-three-repo-cold-matrix.mjs`的运行根登记；参照 `scripts/run-release-contracts.mjs`、`src/benchmark/release-index-contracts.test.ts`。

**步骤：** 增加读取runtime manifest并校验实际execPath/versions/digest的公共runner入口，以及暂存内容泄漏扫描（无正文输出）和gate-closeout清单验证；将MAC-00待提交证据纳入首次扫描。broker随机根创建后立即登记/输出，验证被杀后仍可从预登记父根确定归属；fixture daemon共享同机2个槽。实现 §5 的 driver/start/attach/instance 校验、计划解析、单调时钟和原始样本记录；定义 deadline/cancel、owner/query/base lease 数、parse/write 工作量和 first-correct oracle。构造重复样本、超时、漏结果、错误 hash、错误 workspace、占用端口、attach 到错误实例的自测。故障点必须支持阻塞屏障，让外部控制器在阶段中途杀真实进程。

**验收G01：** fake driver被正确判PASS/FAIL，错误身份不能开始负载；百分位/分母自测通过；status-only不触发预热；start只管理自身生命周期，attach不停止被附加服务。另用合成负向样本证明：扫描暂存blob而非工作树、stdout/stderr不含命中正文、docs没有整体豁免；未登记路径/到期残留拒绝closeout；broker创建后输出前被杀仍归属预登记父根；第三个fixture排队，取消/退出释放配额；HEAD未变但缺文件/坏对象/输入hash变化不能开跑。新增CLI在本卡结束才允许被后续门调用。
