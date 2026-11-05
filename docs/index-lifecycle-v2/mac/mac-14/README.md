# MAC-14 / G14

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。运行证据只放在本机 work root（`runs/mac-14/`），不进仓库。产品源码自 G12（`7e561484`）起未改；本卡只改合同驱动、测试和三仓 runner/verifier。

## 源码变更

| 提交 | 内容 |
|---|---|
| `9954d9ff` | K 合同按 §6.2 迁到 owner 路径；真实 JDT 经唯一 owner 运行（`release-jdt-contracts.mjs` 重写，`run-isolated-jdt-benchmark.mjs --export`）；K runner 校验 JDT 证据的 source/native/fixture 身份；新增合同说明 overlay 与旧路径删除清单 |
| `42fe0c30` | removed-paths 把 overlay 的说明文字记为 comment |
| `40936328` | 三仓候选测试套件：带理由的 skip 计入通过，未说明的 skip、fail、cancelled、todo 仍失败；manifest 记录 skip 列表，verifier 从 hash 绑定的 TAP 复核 |

## 合同

- **contractVersion：** `ilv2-k-contracts/mac14-v1`。冻结的 v1.1 `runtime-matrix.json` 未改（kit SHA256SUMS 固定）；当前搭建与 oracle 说明写在 `scripts/release-k-contract-matrix.json`，它以 `baseMatrix.sha256` 绑定冻结矩阵，runner 遇到不一致即拒绝。overlay 位于 `scripts/`，计入 sourceDigest。
- **K 映射：** 每个 K 对应一组测试，全部通过才算 PASS。K03/K05/K06/K11/K15/K19 在真实 owner 上验证捕获（同一 workspace、FRESH、新 snapshot 与 contentManifest）；K06 为 6 个 linked worktree 并发、同路径不同内容；K21 为 seed 后 XML 改/删；K24 为 FAILED/RECOVERED 文件与正常更新同批发布；K20/K30 为 lease 与 GC；`release-index-contracts` 只保留 K23。
- **真实 JDT（K26/K28）：** jdtls 1.56.0、openjdk 25.0.2，证据 schema `release-real-jdt-evidence/v2`。K28 的短截止依次尝试 30–700 ms，取第一次与长请求 join 成功的尝试；两次运行都在 30 ms 首次成功。
- **旧路径删除清单：** D01–D13（CODE 10、PLAN 3），从生产入口遍历 214 个文件，0 生产调用者、0 未解释项。

## 验证（源码 `bfdb7fca…` = HEAD `40936328`）

| 项 | 结果 |
|---|---|
| env-probe | READY |
| real-jdt-g14 | PASS |
| k-contracts-g14 | **FAIL**（31/32，K29 更新期 serviceMs p95 231 ms > 150，起跑 load1 9.57），保留 |
| k-contracts-g14-retry1（同一构建，单次重试） | 32/32 |
| removed-paths-g14 | PASS |
| regression-g14-dist | 1601/1601 |
| regression-g14-scripts | 658 通过，10 跳过（依赖环境的测量驱动），0 失败 |
| multiworktree-g14（G11 系统环） | 1/1：正确性、隔离、截止、资源、无饥饿硬门通过；其性能分析仍为 DIAGNOSTIC_ONLY，不声称 performanceReady |
| three-repo-g14 | 质量无回退、p95 比 ≤ 1.25；绝对 1.0 地板 FAIL（见下） |
| rerun-real-jdt-g14（全新构建） | PASS |
| rerun-g14 | 185/185 |
| rerun-k-contracts-g14 | 32/32 |
| 独立评审 | PASS（`bfdb7fca…`），9 个 P3 |
| 资源与归档 closeout | PASS：归档 1133 个文件，sha `67bbdab0…` |

PR 门（dist 单测）是 regression-g14-dist 的子集，未单独运行。K 合同与 multiworktree 均在 load1 < 10 起跑门后启动。

### 三仓矩阵（基线 `9b3a1104`，5 轮，strict p95）

| 仓库 | recall 旧/新 | pRead 旧/新 | rReadMust 旧/新 | p95 比 |
|---|---|---|---|---|
| lishuedu | 0.7986 / 0.7986 | 0.7383 / 0.7383 | 0.9250 / 0.9250 | 1.082 |
| cipherlink | 0.8390 / 0.8390 | 0.6433 / 0.6433 | 0.8850 / 0.8850 | 0.934 |
| exam-parent-v3 | 0.6970 / 0.6970 | 0.6167 / 0.6167 | 0.8800 / 0.8800 | 1.059 |

所有新旧指标逐位相同。rReadMust、holdoutRReadMust、RangeLine/CoordinateRecall 的绝对 1.0 地板在三个仓库上 FAIL，基线同样 FAIL，runner 与 verifier 退出码为 1。**用户决定（lky，2026-10-30）：** G14 按卡片条文（质量无回退、p95 比 ≤ 1.25）判定此项通过，修订 MAC-08C README 中“G14 及以后不豁免这些地板”的承诺；地板 FAIL 原样记录，作为既有产品质量限制进入发布说明和上线后的检索质量任务，不算已通过。

## 失败与重试

- **`20261029T094510Z`（候选 `9954d9ff`）：** removed-paths FAIL（overlay 文字中 3 处未解释），由 `42fe0c30` 修复。不组合。
- **`20261029T094755Z`（候选 `42fe0c30`）：**
  - multiworktree-g14 FAIL：合盖睡眠（18:05→19:06）期间 full build 截止被杀，判定与 pmset 摘录见该 run root 的 `host-sleep-adjudication.json`；同一构建重试 PASS。
  - three-repo 在矩阵开始前 FAIL：runner 要求 pass = tests，把 10 个依赖环境的 skip 当作不通过，由 `40936328` 修复。
  - rerun-k-contracts K29 FAIL：c=20 静态 p95 172 ms，起跑 load1 17.6（当时 K 合同还没有起跑门）。
  - 整个 run root 不组合。
- **本次 K29 首次 FAIL：** 同一产品代码的其余 K29 测量为 74–84 ms（主跑 c=20 静态 p95 69–72 ms）。主机负载是可能原因，但证据较弱：进程快照在运行后才采集，且不含 CPU 值。重试规则在重试前写入 `k29-host-load-adjudication.json`，限一次。

## 已知限制（评审 P3）

- 三仓 green 定义放宽为“带理由的 skip 可接受”，没有允许 skip 的白名单。
- removed-paths 的生产可达遍历不跟 `export … from` 重导出，漏掉两个入口；评审重新遍历，仍为 0 调用者。
- K28 不记录未成功的尝试与短调用实际耗时；K26 静默重试 deadline exceeded；K06 不证明 6 个 worktree 真正并发构建，也不要求必须观察到 NOT_READY。
- K/JDT 记录使用的 digest `7287f50e…` 与 sourceDigest `bfdb7fca…` 之间没有记录内关联，需要重算两者才能对上。
- validation-index 里有 scripts 测试内部写入的嵌套 fixture 记录（另一个 sourceDigest），不是门的运行。
- D05 安装器迁移（`install-runtime.sh` 的旧辅助脚本）与未使用的 chokidar 依赖留给 MAC-17。

## 下一步

MAC-16（语义精度；无语义失败证据时可有依据地 NOT_RUN），然后 MAC-17。MAC-15 需要付费调用授权。
