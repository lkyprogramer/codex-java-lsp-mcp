# Java Intelligence V3.2 Optimization Baseline

> 状态：`FROZEN`
> 日期：2026-08-09
> 适用范围：V3.2 Sprint 0–6 的首个 old side 和后续逐 Sprint successor 对比

## 1. 不可变源码身份

| 字段 | 值 |
|---|---|
| commit | `94c4ebfb1c174b2ac3cab615d986c3061accd2ed` |
| tree | `60ae785e8af9ac06012452ea41c6b1fe2d3606fd` |
| 来源 | V3.1 remediation source-locked candidate；提交前后 tree 完全一致 |
| 历史 old side | `7df1a0eef98d709ef4307c2f66184746c0d95720`，仅用于 V3.1 总结，不再作为逐 Sprint old side |

后续每个 Sprint 的正式 old side 必须是上一 Sprint 已提交且已通过三仓门禁的 commit；禁止把 `7df1a0e` 重复用作每个 Sprint 的 old side，从而掩盖中间回归。

## 2. Production TypeScript 固定口径

计数命令：

```bash
node scripts/count-production-ts.mjs \
  --revision 94c4ebfb1c174b2ac3cab615d986c3061accd2ed
```

固定规则：纳入 `src/**/*.ts`，排除 `src/**/*.test.ts`、`dist/**` 和生成输出；空文件为 0 行，非空文件按 LF 数加末尾未换行的最后一行计数。路径、bytes、physical LOC 和原始 bytes SHA-256 均写入机器清单。

| 指标 | baseline |
|---|---:|
| production TS files | 129 |
| production TS bytes | 1,273,211 |
| production TS physical LOC | 31,638 |
| inventory SHA-256 | `8c3feaba965ca26a9f076608ad5c4e92dc3d074b3e657afbb32316bc17a6e9ea` |
| Sprint 上限（+5%） | 33,219 LOC |
| V3.2 最终目标 | ≤31,638 LOC |

Telemetry 新增 LOC 必须写入 task-level ledger，并绑定后续删除、合并或保留依据；不能把临时观测代码永久当作免费复杂度。

## 3. 环境身份

| 字段 | 值 |
|---|---|
| Node | `v22.16.0` |
| platform / arch | `darwin / arm64` |
| TypeScript | `5.9.3` |
| tree-sitter | `0.25.0` |
| tree-sitter-java | `0.23.5` |
| cold JDT | `DISABLED_FOR_COLD`，`JDTLS_BIN=/usr/bin/false`，版本 `UNMEASURED` |

正式 matrix 还必须绑定 `package.json`、`package-lock.json`、Node executable、三仓 HEAD/tree、冻结场景 SHA/row set、candidate patch/runtime inputs、每个 cell stdout/stderr SHA。

## 4. 三仓固定身份

| 仓库 | commit | tree |
|---|---|---|
| lishuedu | `db63b1a7e393...` | `22f0ce4...` |
| cipherlink | `fa433982e92e...` | `21a1075...` |
| exam-parent-v3 | `f90a0b475f7b...` | `dcdb202...` |

完整 SHA 由每次 `optimization-manifest.json` 从干净仓库实时解析并绑定；表中短 SHA 只用于人工识别。

## 5. Runner 与复验合同

- `scripts/run-three-repo-cold-matrix.mjs` 继续拥有 AB/BA/AB、candidate patch、frozen scenario、cell provenance 和 paired gate。
- `scripts/run-v32-optimization-matrix.mjs` 是严格 sidecar runner，增加 production TS、运行环境、task ledger 和所有 cold artifact hash；不得改写已经被 cell 绑定的 core `run-manifest.json`。
- `scripts/count-production-ts.mjs --verify` 复验单个源码清单。
- `scripts/run-v32-optimization-matrix.mjs --verify` 复验 optimization manifest、old/new 源码 inventory 以及所有列入清单的 artifact。

## 6. Sprint 0 LOC ledger

正式 candidate 的精确 LOC、增量和剩余额度只由 source-locked optimization manifest、evidence receipt 与 Sprint 报告给出，本基线文档不预写运行结果。路径级机器台账位于 `docs/phase-v3/v32-sprint0-loc-ledger.json`；正式执行先把该文件原样冻结为 `task-ledger.json`，再由 optimization manifest 绑定 bytes/SHA 并校验所有内容 hash 变化路径恰好覆盖一次（包括 LOC 不变的等行替换）、总数一致且每个正增长 task 都绑定偿还门。

| Task | 生产 LOC delta | 原因 | 偿还 / 保留门 |
|---|---:|---|---|
| V3.2-01 | +34 | benchmark 内部 isolated repo guard | V3.2-35 |
| V3.2-02 | +235 | payload projection/attribution | V3.2-33 |
| V3.2-03 | +394 | JavaIndex RPC telemetry | V3.2-35 |
| V3.2-04 | +606 | JDT first-touch telemetry | V3.2-35 |
| V3.2-05 | +136 | process resource observer | V3.2-35 |
| V3.2-06 | +165 | coordinate range schema/metric | V3.2-35 |

## 7. Sprint 0 正式 successor

首次正式 successor old side 使用 `f85b9e56f640c7928c7ec99afaf2ddc6204751bd`（tree `9b6645deb7c306db2744f1268af1c64c7e567432`）；该提交只在冻结 baseline 文档、脚本和 metric vocabulary 上晚于第 1 节的 production baseline origin，production TS inventory 仍为相同的 `31,638 LOC / 129 files`。

正式 successor 的 executable tree、candidate patch、TAP 计数和 artifact hash 不在本 tracked
baseline 文档中手抄，避免“矩阵完成后为回填 tree 又改变 candidate tree”的循环。它们只由
正式 `optimization-manifest.json` 生成，再由
`docs/phase-v3/v32-sprint0-evidence-receipt.json`、
`docs/phase-v3/v32-sprint0-verification-receipt.json` 和
`docs/phase-v3/v32-sprint0-observability-report.md` 绑定。正式状态保持
`BASELINE_RECORDED_WITH_GAPS`：integrity replay 必须为 `verificationStatus=PASS`，同时质量门的
`coldGatePassed=false` 必须原样保留；该 replay 不重跑测试或矩阵。
