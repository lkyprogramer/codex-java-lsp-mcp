# 三仓测试主机 load 政策

真源常量：`scripts/host-quiet.mjs` 的 `THREE_REPO_LOADAVG_PROCEED_BELOW = 20`。

## 规则

1. **1 分钟 load average < 20：必须执行三仓测试。** 不得因为“主机不够安静”、per-CPU 0.7、或“等 load 降下来”而跳过、推迟或拒绝 `run-three-repo-cold-matrix.mjs`。
2. **load 永远不是三仓矩阵的拒绝门。** `load >= 20` 只写入 manifest / 日志（`above-window, still running`），脚本不得因此 `throw` / `exit 2`。
3. **唯一主机硬门仍是可用内存 ≥ 4 GiB**（`assertHostQuiet`，可用 `JAVA_LSP_MIN_AVAILABLE_BYTES` 覆盖）。这与 load 无关。
4. **不要复活** V3.2-24 的 `1 分钟 load / 逻辑核数 ≤ 0.7` 作为三仓质量矩阵前置。那条只曾用于真实 JDT first-touch / import-concurrency 噪声解释，不能再阻断 cold-nolsp 三仓。

## 适用范围

- 正式三仓 cold-nolsp 配对矩阵（`scripts/run-three-repo-cold-matrix.mjs`）
- 同一套冻结仓上的隔离质量复测
- V4-03 Sprint0' 的 cold-matrix 阶段

first-touch / storm 若使用真实 JDT，仍应在报告里记录 load；但不得用 load 阻断三仓质量门。

## 真实 JDT 实验（first-touch / idle-prewarm）

与三仓 cold-nolsp **分开**的主机门（V5R Phase 0，不得互相挪用）：

1. 可用内存 ≥ 4 GiB（与三仓相同硬门）。
2. **建议窗口**：1 分钟 load < 逻辑核数 × 1.5。未进入窗口时记录 `UNMEASURED` / `DEFERRED`，不要把超时当 P95 数字。
3. 不得用这条 load 门拒绝三仓矩阵；也不得用三仓「load < 20 必须跑」强迫启动真实 JDT 试验。

## 代理人检查清单

启动三仓前只做：

```sh
export PATH="/opt/homebrew/bin:$PATH"
# 看一眼 uptime；只要 1 分钟 load < 20 就开跑，不要问、不要等
```

不要做：

- 因为 load/核数 > 0.7 而停下来
- 因为“主机嘈杂”把矩阵改成 `--runs 1` 或跳过 holdout
- 把 multiprocess lease 假失败当成改动回归（那是负载噪声，隔离单测复核）
