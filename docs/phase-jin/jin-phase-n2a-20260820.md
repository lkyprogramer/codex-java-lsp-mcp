# JIN Phase N2a：调用 / Spring / 持久化边（2026-08-20）

## 判定

| 轴 | 结果 |
|---|---|
| CALLS_EXACT / VIRTUAL / DISPATCHES_TO + CALLED_BY | **GO** |
| SPRING_INJECTS / PUBLISHES_EVENT / CONSUMES_EVENT | **GO** |
| MyBatis bind + Template/Repository 泛型实体 | **GO** |
| T2 discovery oracle 8 文件图可达 | **GO** 全部 ≤3 跳（PayAccount 实测 1，未用满放宽到 4） |
| mutation / 无 stale 调用边 | **GO** |
| T1 | **GO** dist 1085 / scripts 185 fail 0 |
| 索引期 cold/增量/digest | **GO** 相对 N1 未回退 |
| RSS ≤ 512 MiB | **FAIL 继承 N1**（lishuedu 2319 MiB，未恶化） |
| N2b | 跳过（无 def-use 准入证据） |
| 合 main | 否 |

## 身份

| 侧 | 值 |
|---|---|
| N1 HEAD | `47fe6dc` |
| executableTree | `4619caff` |
| 隔离 | `detached-local-clone`，`JDTLS_BIN=/usr/bin/false` |
| RSS 处置 | 用户未选四选一；按 0A.4(a) **不改 512 MiB 门**，带着 FAIL 进 N2a |

## Discovery hops

| 目标 | hop |
|---|---:|
| MeQueryService | 2 |
| DefaultOperationLogAppService | 2 |
| ClientReleaseMapper | 2 |
| ExamRoomPrintBundleJob | 2 |
| ExamRoomPrintBundleJobTemplate | 2 |
| ApplyPayTemplate | 2 |
| OrderRepository | 3 |
| PayAccount | 1 |

## 索引期相对 N1

lishuedu cold 46.5s→52.0s（仍 ≤60s）；增量 43ms→14ms；RSS 2344→2319 MiB；edges 117k→230k。

## 产物

| 文件 | SHA-256 |
|---|---|
| `docs/phase-jin/jin-n2a-discovery-replay.json` | `60ef4d68453a8d9293df7d139a1fe3c3116af3a467f0445d1dbbdf0bad3bae04` |
| `docs/phase-jin/jin-n2a-index-benchmark.json` | `0b1dc5b0b5772edd026ab72537e37f9b13b5789af4ede3eb7bc7f07f7f1f2d27` |

## 怎么读

1. `src/` 无 scene-id。回放脚本只在 `scripts/` 里列 oracle 路径。遍历是无向的（含 CALLED_BY）。
2. 调用边从已有 JavaIndex `CALLS` 映射：具体类 → `CALLS_EXACT`；接口/抽象 → `CALLS_VIRTUAL` + 有限 `DISPATCHES_TO`。
3. SQL_TOUCHES_TABLE 未做：MyBatis 事实里没有 SQL 正文。MapStruct 边未做，oracle 文件不依赖。
4. 生产 LOC 39105 → 39642。未合 `main`。下一阶段 **N3-00** commit-derived 任务 + 第四仓。
