# 立项：cipherlink holdout rReadMust 残差

日期：2026-08-24  
状态：**FILED，非合并阻塞**。holdout 内容未读、不用于调参。

## 为什么不是 F1 回归

计划把 `main` 写成「V4-final 旧链路」。github `main`（`48e665b`，54 个生产 TS 文件）不是那棵树。

V4-final 三仓矩阵（`docs/phase-v4/v4-final-three-repo-cold-20260819.md`）new 侧 cipherlink：

| 指标 | V4-final new | F1 HEAD new |
|---|---|---|
| recall | 0.8390 | 0.839 |
| pRead | 0.6633 | 0.6633 |
| rReadMust | 0.910 | 0.91 |
| holdout rReadMust | 0.550 | 0.55 |

HEAD 与 V4-final 逐位相同。0.55 在 V4-06 / V4-final 已记为 `CLOSED_WITH_RESIDUAL_STRUCTURAL_MISSES`，不是 jin harvest 引入的。

相对 github `main` 的 holdout 聚合下降（0.675→0.55）拆到场景 ID（只报分数，不读金标）：

| 场景 ID | old rReadMust | new rReadMust | old pRead | new pRead | old recall | new recall |
|---|---|---|---|---|---|---|
| `client-release-storage-presign-holdout` | 0.75 | 0.50 | 0.833 | 0.50 | 0.50 | 0.688 |
| `backend-operation-log-aspect-async-audit-holdout` | 0.60 | 0.60 | 0.667 | 0.833 | 0.438 | 0.812 |

rReadMust 聚合下降全部来自 presign 一条。audit 的 rReadMust 未变；recall 两条都升。

## 范围

- 允许：在 **tuning** 同类场景上改默认链（cipherlink 现有 tuning ID：`client-update-check`、`transfer-upload-init`、`transfer-upload-session-repository`、`aliyun-sms-gateway-send`、`operation-log-response-dto` 等）。改完必须再过三仓非劣门。
- 禁止：读取 holdout 金标内容、按 holdout 分数挑刀、为过 holdout 放宽 F1 门。
- 验证：holdout 只看汇总指标；逐条金标仍不入目。

## 入场条件（满足一条才开工）

1. 真实使用中出现可归因到 cipherlink 类「对象存储预签名 / 网关」路径的 must-read 缺口；或
2. 用户显式打开本项目。

没有真实疼痛、也没有显式开工令，不开刀。

## 与 F1 的关系

F1 对比基线改为 N0 `09772b2`（本分支上 V4 线在紧凑输出之前的最后质量 identity 点）。本残差不阻塞那次合并。
