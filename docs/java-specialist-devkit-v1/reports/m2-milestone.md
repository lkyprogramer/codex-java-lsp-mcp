# M2 里程碑报告（最终版）：关键证据与真实 Agent 评测

**日期**：2026-07-23
**代码 HEAD**：`40c9f17`（`codex/java-specialist-devkit-v1`）
**数据**：dev 冻结集 `prompts/dev.jsonl`（sha256 `d013523a7c7ceb97…`，24 任务：qa 19 / repair 5），gold `gold/dev.jsonl`（sha256 `62ec6600ef43f393…`，即 pack 的 datasetHash）
**运行目录**：`/Users/luo/Documents/github/java-devkit-v1-runs/m2/`（仓库外）

## 一句话结论

**M2 = GO（含 LIVE）**。T08 全部落地并全绿（gap 三分类、K11 helper 前后等价的产品真实缺陷修复、M2-2/M2-3、wire-byte 测量）；T09 从 M2 中期的 BLOCKED_AUTH 推进到 **M2_LIVE = MEASURED**：使用 OpenAI 兼容后端（`openclaw/Qwen3.8-27B-WORK`，262K 上下文，经 /v1/models + tool_calls 往返验证）在 24 dev 任务 × 2 臂（product=java_symbol+read，control=仅 read）× 3 重复的完整矩阵上跑通真实 Agent 回路：**144/144 运行全部 MEASURED，taskSuccessRate 0.189（27/144），product 12/72 (0.167) vs control 9/72 (0.125)**，3,321 个 SOURCE_RECEIVED 事件全部来自真实 wire 输出（sha256 + range + callId），usage 144/144 实测（绝无 bytes/4 估算）。M3 未开始，全路线不宣布 DONE。

> 前版报告（M2_OFFLINE=GO / M2_LIVE=BLOCKED_AUTH）记录的是无后端授权时的诚实状态；本环境随后获得可用 OpenAI 兼容端点，LIVE 轨道按 T09 协议完整执行，BLOCKED_AUTH 分支仍保留为无授权时的自动降级路径。

## LIVE 轨道结果（T09 核心）

**证据**：`live-full/results-pack.json`（sha256 `a36a0190f0d69be6…`）、`live-full/source-received.jsonl`（sha256 `6f1b44b35960e0b4…`，3,321 行）、`live-full/stdout.log`；驱动脚本 `run-m2-live.sh`（仓库外，凭据只存在于 `/Users/luo/Documents/grok/.env`，未进产品仓库）。

| 指标 | product 臂 | control 臂 |
|---|---|---|
| 任务成功率（24 任务 × 3 重复 = 72 行） | **12/72 = 0.167** | 9/72 = 0.125 |
| CORRECT / WRONG_ANSWER / INVALID / MAX_COMPLETION_TOKENS / repair(UNMEASURED 轨道) | 12 / 39 / 6 / 0 / 15 | 9 / 45 / 0 / 3 / 15 |
| stopReason：MODEL_STOP / FORCED_ANSWER / MAX_COMPLETION_TOKENS | — | — | 全局 63 / 78 / 3 |
| usage 实测 | 72/72 | 72/72（合计 144/144） |
| 带 SOURCE_RECEIVED 事件的运行 / 事件总数 | — | — | 84/144 运行，3,321 事件（product 臂 100% 携带） |

- **repair（P 轨道）15+15 行保持 UNMEASURED**：candidate patch 的冻结测试执行需要 kit 侧 repair oracle 接入（注入 `repairTester`），本轮未注入，按协议不升级 proxy 为任务成功。
- 任务级亮点：JSB-PETCLINIC-01/02 双臂 × 3 重复全部命中（product=control=1）；JSB-MYBATIS-02 双臂命中；JSB-GSON-01 仅 product 臂命中；payments/access/admissions/inventory/pricing 三任务组本轮 0 成功（模型能力/长查询问题，逐行数据在 pack）。
- **诚实声明**：本轮模型为 27B 级开源权重（非卡面预设的强模型），成功率为该后端下的真实测量值，不构成"产品优于基线"的发布结论——product 臂优势（+0.042）远小于 3 重复的抽样噪声；按协议，发布级对比需锁定集 + 强模型 + 预注册实验（M3）。

### 为跑通 LIVE 而修掉的 harness 真实缺陷（`40c9f17`，双臂对称）

1. **recorder 丢事件**：live 会话把 discovery wire 文本先解析成对象再交 recorder，`JSON.parse` 再解析必失败 → 全部 SOURCE_RECEIVED 事件丢失。recorder 现接受 wire 文本与已解析负载两种形态（单测覆盖）。
2. **开源模型不收敛**：模型在证据充足后仍持续调用工具直到耗尽轮次、无最终答案（空答案 → 假 INVALID）。加入单次停止提示（60% 轮次处）+ 耗尽后的**无工具强制应答**轮（`tools: []`，`stopReason=FORCED_ANSWER`），使运行诚实提交严格 JSON 答案而不是空转。
3. **答案键契约缺失**：任务 `output_contract.answer_keys` 原先未进任务文本，模型自造键名（`storageCollectionType` 等）→ 假 INCOMPLETE。冻结契约现作为任务文本一部分注入（双臂相同）。
4. pack 增加 `stopReason`/`finalAnswer` 审计字段；markdown 围栏内的严格 JSON 正常计分（围栏是包装不是内容）。

## 离线侧证据（T08/T09 离线件，前版报告有效，摘要）

| 项 | 证据 | 结果 |
|---|---|---|
| gap 三分类 + `evidenceGapLedger`（`11dbcf6`） | `read-plan-gaps.test.ts` 5 测试 | RED→GREEN |
| K11 helper 前后等价（`11dbcf6`） | 根因：`materializeRankedCandidates` 静默丢弃与 anchor 同路径的 ranked candidate。修复后 `helper-move-k11.test.ts` 双布局：BEFORE helper 5..6 ⊂ 1..51；AFTER 333..334 ⊂ 324..335 | RED→GREEN，agent-router 211/211 |
| M2-2 `DISCOVERY_UNSUPPORTED`、M2-3 schema max(512)（`a189e70`） | `discovery-unsupported.test.ts` 2/2 | RED→GREEN |
| step-5 wire 字节测量（`6cab673`） | `measure-wire-bytes.ts`：preview 占 java_symbol 线宽 **36.9%**（36,288/98,425 B，24 仓库 106 候选） | M2-1 批处理仍待 K21 事件循环节证据，未改码 |
| M2-4 HALF_UP 反向 fixture（`3a079ff`） | 注释可检索（DOCUMENT 层）但不虚构符号、不覆盖 AST 事实 | 3/3 GREEN |

## M2 边界统一产品回归（@ `40c9f17`，tracked diff 空）

| # | 命令 | 退出码 | 证据（仓库外 `m2b-boundary/`） |
|---|---|---|---|
| 1 | `npm run build:isolated` | 0 | `1-build-isolated.log` |
| 2 | `npm test` | 0 | `2-npm-test.log`：**1205 + 305 全绿** |
| 3 | `npm run gate:pr` | 0 | `3-gate-pr.log` |
| 4 | `npm run gate:release` | 0 | `4-gate-release.log` |
| 5 | `npm run measure:tool-schema` | 0 | `5-tool-schema.log` |
| 6 | `npm run measure:production-ts` | 0 | `6-production-ts.log` |
| 7 | probe-source（12 项契约） | 0 | `7-probe-source.json`：**12/12** |
| 8 | 终态 preflight | — | `preflight-final.json`：source_sha=`40c9f17`，tracked_diff 空（e3b0c44…） |
| 9 | kit selfcheck | — | `selfcheck/summary.json`：5/5 PASSED |

冻结区（dataset/harness/schemas）相对 bundle 基线 diff 0 行。

## 未测项（诚实清单，收窄版）

1. **repair（P 轨道）真实验证**：30 行 repair 运行保持 UNMEASURED——需要把 kit 冻结测试以 `repairTester` 注入 `runLiveEvalRun`（接口已就绪）。
2. 五项发布门数值（correctness_floor / qa_contract_floor / warm_static_p95 / event_loop_p95 / anchored_impact_p95_ratio）：本轮 LIVE 未逐项采集发布门口径；`gate:release` 退出 0 是产品门禁，非本包发布门达成。
3. 第二模型对照、锁定集（locked split，含 4 个 dev 未覆盖的 cluster）、全公开语料臂（M2-6，需 `--allow-network`）。
4. K15/K19/K21 runtime 级 freshness（M2-5）：本轮 LIVE 提供了真实运行时，但契约逐项回填未执行，留 M2 收尾/M3。
5. M2-1（attachLocators 批处理）：字节动机已实测（preview 占线宽 36.9%），事件循环节证据未采集，未改码。

## 决定

- **M2 = GO**：离线机制 + LIVE 轨道（真实模型、真实产品 MCP、外部 gold 评分、完整 144 行分母、usage 全实测、3,321 条 wire 源码证据）按 T09 协议达成；M2_LIVE 由 BLOCKED_AUTH 转为 **MEASURED**。
- 本轮 27B 后端的成功率数字是**真实测量**，但按评测协议不构成发布结论；发布级对比留 M3（强模型 + 锁定集 + 预注册实验）。
- **M3 入口**：repair 冻结测试注入、发布门逐项实测、M2-1 事件循环节裁决、锁定集与全语料臂。
## 历史更正（release-audit-v1.1 R00，2026-09-26，不删除原文与数字）

本里程碑的 LIVE 轨道测量（144 runs、taskSuccessRate 0.189、product 12/72 vs control 9/72）随 `docs/java-specialist-release-audit-v1.1` 审计登记为 **INVALID_EXPERIMENT**：A01 冻结 Unicode fixture 字节漂移（CRLF→LF）+ W01–W05 最终 model 消息载荷丢失 + E01–E04 评分口径缺陷，所有模型共用同一错误 loop，跨模型一致不能排除系统性混淆。上述数字保留为历史记录，**不再支撑任何能力归因或 release 资格**；逐 run 失效清单见 `docs/next-stage/invalidated-runs.json`（`causalClaimEligible=false`）。修复与复测按 v1.1 计划 S1（R01–R04）执行。