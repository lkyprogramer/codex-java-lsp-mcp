# V5R live agent-trace（2026-08-20）

对外 OpenAI-compatible `chat.completions`，模型 `openclaw/Qwen3.8-27B-WORK`，上下文 **112Ki tokens（114688）**。
入口：`scripts/run-agent-trace-matrix.mjs --authorize-external --execute-live`。
TaskSuccess = `mustHit ∪ taskBlocking ⊆` 模型调用的 `java_impact` 返回 files/readPlan 并集。**不看模型自述。**
`FAILED_CONTEXT_CAP` / `FAILED_RUNTIME` 不记成 TaskSuccess=0。λ 只报 magnitude，`scalarAllowed=false`，**不**用合成 J(π) 做 KEEP/REJECT。未合 `main`。

## 判定

| 轴 | 结果 |
|---|---|
| 测量链 | **GO**（L0 连通 + L1/L2 六条 holdout 全 `MEASURED`） |
| 112K cap | **GO**（prompt cap 100000；任务最大 `promptTokens=52449`；无 `FAILED_CONTEXT_CAP`） |
| TaskSuccess | **MEASURED** 4/6 = 0.667。不是 UNMEASURED，也不是编造的 0 |
| λ | **LIVE_TRACE_MEASURED**，n=6，`tokensPerToolRound=4612.025`，**scalarAllowed 仍 false** |
| 24-cell AB/BA | **未跑**（本轮只做真实消耗，不是 old/new 对照） |
| 合 main | **否** |

## 协议控制

- 窗口 114688，prompt cap 100000，max completion 2048，最多 8 轮 tool。
- 该 endpoint 顶层 `enable_thinking=false` **无效**；实际用 `chat_template_kwargs.enable_thinking=false`（L0 探针：关 thinking 后 completion 从 36 降到 2）。这是 112K 控制，不是隐瞒思考税。
- 工具只有公开 `java_impact`（`semanticPolicy=fast`，`verbosity=compact`，`deadlineMs=15000`）。没有 `java_file_read`，没有把 golden / mustHit 发给模型。
- MCP 子进程 `JDTLS_BIN=/usr/bin/false`，cache 在 checkout 外。eval HTTP 用 `fetch`，**不**把 `openai` SDK 加进生产依赖。
- 密钥只在进程环境；报告 / JSON / HANDOFF 只保留 host + model + 窗口。

Pass1（2s 默认 deadline）lishuedu `runtime.create` 654ms 超时、exam index worker 挂掉，**不计入**均值。正式分母是 pass2 L1 + L2。

## 身份

| 项 | 值 |
|---|---|
| HEAD（测量时） | `1fb2b9a`（campaign C 收口）+ live harness 工作区 |
| L1 executableTree | `9001ef8faeda7ce4b9926f88754b2121979eddbc` |
| L2 executableTree | `077aca81e7700d02fdd984d2a14a3d27d072785e` |
| 模型 | `openclaw/Qwen3.8-27B-WORK` |
| host | `192.168.10.29:28343` |
| 三仓 golden | lishuedu `db63b1a7e393edd90449eb013d7d1c4d65c366f2` / cipherlink `fa433982e92e52dd610650d1e79f2d041179b1d3` / exam-parent-v3 `f90a0b475f7be2ed003703feecec8195bc7eb976` |
| 主机 load | L1 7.38 / L2 6.70，均 &lt; 20，必须跑 |
| 隔离契约测试 | 15/15 fail 0（tree `077aca81…`） |

## 产物（checkout 外）

| 批次 | 目录 | `live-trace.json` SHA-256 |
|---|---|---|
| L1 每仓第一条 holdout | `…/v5r-live-trace-20260820-pass2/` | `eaaadb1ca22399cd1c201f6180b51b059eddacc0b85a5079efedbb160872cfa2` |
| L2 每仓第二条 holdout | `…/v5r-live-trace-20260820-l2/` | `d24973bbad297a8f3644e236e8f8c8e65cab5eea25181691cccf91b3db5cbe5d` |

入库摘要：`docs/phase-v5r/v5r-live-trace-20260820-summary.json`（SHA-256 `b2d4f5ca8cbfa58cfa4e15baae28d604f32a680be59057afec1b30252ab64fdb`）。原始 live-trace 不入库。

## 六条 holdout

| 任务 | stop | tools | prompt / completion / total | 覆盖 | TaskSuccess |
|---|---|---|---|---|---|
| lishuedu:exam-score-export-cross-module-holdout | MODEL_STOP | 6 | 23388 / 1166 / 24554 | 13/13 | true |
| cipherlink:client-release-storage-presign-holdout | MODEL_STOP | 6 | 22255 / 1092 / 23347 | 10/11 | false |
| exam-parent-v3:exam-room-print-download-types-persistent-bundle | MODEL_STOP | 8 | 33287 / 1433 / 34720 | 8/8 | true |
| lishuedu:paper-task-claim-iam-holdout | MODEL_STOP | 5 | 22157 / 1086 / 23243 | 10/10 | true |
| cipherlink:backend-operation-log-aspect-async-audit-holdout | MODEL_STOP | 6 | 23833 / 1566 / 25399 | 12/12 | true |
| exam-parent-v3:candidate-pay-order-cross-module-admission | MAX_ROUNDS | 9 | 52449 / 769 / 53218 | 11/12 | false |

两条 false 的缺口（模型多轮 `java_impact` 仍没带回）：

- cipherlink presign：`modules/client/.../mapper/ClientReleaseMapper.java`
- exam pay-order：`exam-data/.../entity/manage/PayAccount.java`

`paper-task` 的 `MeQueryService` 在 first-plan oracle 里是 discovery gap；本轮 5 次 tool 覆盖了全部 10 个 required 路径（含 `MeQueryService`）。这是 **n=1 的多轮导航观察**，不是 first-plan 质量变了，也不构成 KEEP 刀。

## 合计（正式分母）

| 量 | 值 |
|---|---|
| 任务 | 6 scored / 6，无 cap、无 runtime 丢弃 |
| TaskSuccess | 4/6，mean **2/3** |
| promptTokens | 177369 |
| completionTokens | 7112 |
| totalTokens | **184481** |
| tool rounds | **40** |
| λ_call | **4612.025** totalTokens / toolRound |
| 最大单任务 prompt | 52449 &lt; 100000 |

## 怎么读

1. 遗留的 live agent-trace **已经消耗真实模型 token**。Phase 7 的 `BLOCKED_EXTERNAL` 对这一格解除。
2. TaskSuccess 0.667 是路径覆盖，不是「任务做对了」。没有 old-side 对照 agent，不能说 non-inferior。
3. λ 有了数量级（约 4.6k token / `java_impact` 轮），**仍禁止**用 J(π) 标量做 KEEP/REJECT。`refuseSyntheticScalar()` 不撤。
4. 112K 够用：最大任务约 53k prompt。thinking 必须靠 `chat_template_kwargs` 关掉，否则 Qwen 会把 `max_tokens` 吃进 `reasoning_content`。
5. 未解阻合 main：第四评价仓、leave-one-repo-out 矩阵、λ 标量校准、old/new 24-cell 都还没做。
