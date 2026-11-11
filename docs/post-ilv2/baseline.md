# Post-ILV2 基线（Q00）

机器可读版本是 [baseline.json](baseline.json)，本页只给人读的摘要；两者冲突时以 json 为准。来源与判断见 [decisions.md](decisions.md) D1。

| 项 | 值 | 证据等级 |
|---|---|---|
| 源码基线 | `main@665d66e`（计划文档 `1837e22` 在其上） | 已观察（git） |
| 底座修复 `cc5db6b..665d66e` 的 Mac 验证 | 用户报告已通过 `build:isolated` 与测试 | USER_REPORTED，仓库无原始日志 |
| 部署 | 用户报告已部署；`installedDigest=null` | USER_REPORTED_DEPLOYED / NOT_INDEPENDENTLY_VERIFIED |
| JDT 导入上限 | 120 000 ms（`JDTLS_START_TIMEOUT_MS` 源码默认） | 已观察（源码）；安装覆盖未知 |
| JDT 导入后索引屏障 | 600 000 ms（`JDTLS_INDEX_TIMEOUT_MS`，`07c6ccf` 引入） | 已观察（源码）；安装覆盖未知 |
| node / jdk / native | UNKNOWN（未在用户 Mac 上读取） | — |
| JDT 版本 | jdt-1.56.0（ILV2 status.json 工具链路径） | 推断；安装版本未知 |
| 已接受例外 | G12 D1-a 查询 p95 容差；G14 绝对地板 FAIL 继续披露 | 用户已接受 |
| 授权 | 模型调用、生产安装/重启、源码外发、本轮编译测试：均未授权 | — |
