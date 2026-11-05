# MAC-16 / G16

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

**条件语义精度实验 NOT_RUN；现有专用 JDT 隔离验证 PASS。** 现有失败证据主要属于检索深度、预算和范围覆盖，未建立影响任务成功的编译器解析缺陷，因此保持语义架构和现有 JDT 能力。

## 复用的验证

源码提交 `e0245aac`，broker source digest `26fdb127…`；K/JDT 输入指纹为 `9a5c5397…`。两种摘要的输入集合和编码不同，身份桥已核对当前源码与两次构建候选一致。

| 项 | 已有结果 |
|---|---|
| real-jdt-g16 / rerun-real-jdt-g16 | 两次真实 owner 路径 K26/K28 PASS；各 12 轮双 worktree 交错，串扰 0 |
| k-contracts-g16 | K01–K32，32/32 PASS |
| targeted-g16 / rerun-g16 | 两次各 139/139，0 fail / skip / cancelled |
| 独立只读评审 | PASS，无未关闭发现；核对原始 JSON、TAP、身份与输出 hash |
| closeout | PASS；140 个 RAW 文件归档并物理解包校验，22 个登记 PID、1 个组及 1 个 launchd job 退出；到期 raw/tmp 已清理 |

上述测试由前一执行者于 2026-10-30 运行。本次收尾只复核、归档和生成结果，没有重新运行工作负载。私有运行根：`runs/mac-16/20261029T170720Z`。

## 验证边界

- 未运行至少 200 符号、语义关系一致率至少 98% 的条件精度实验，不宣称精度提升。
- MAC-15 模型收益未测；没有重新打开 holdout。
- 隔离测试不证明生产安装、固定路径 TCC 授权或生产业务仓读取。

下一步为 MAC-17 安装链路与隔离 canary；不继续扩展语义或性能优化。
