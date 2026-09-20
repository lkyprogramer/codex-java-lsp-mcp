# M2 里程碑报告：关键证据与真实 Agent 评测轨道

**日期**：2026-07-23
**代码 HEAD**：`6cab673`（`codex/java-specialist-devkit-v1`）
**数据**：dev 冻结集 `prompts/dev.jsonl`（sha256 `d013523a7c7ceb97…`，24 任务：qa 19 / repair 5），gold `gold/dev.jsonl`（sha256 `62ec6600ef43f393…`）
**运行目录**：`/Users/luo/Documents/github/java-devkit-v1-runs/m2/`（仓库外）

## 一句话结论

**M2_OFFLINE = GO，M2_LIVE = BLOCKED_AUTH**。T08（关键证据与最终读计划）全部落地并全绿（含 K11 helper 前后等价的产品真实缺陷修复与 wire-byte 测量动机）；T09 离线侧（host recorder 适配器、SOURCE_RECEIVED 记录语义、Q/P 轨道外部评分、BLOCKED_AUTH 报告链路、HALF_UP 反向 fixture）全部落地并全绿。真实 Agent（LIVE 轨道）因本环境**无任何可用模型授权**（仅存在与 OpenAI 兼容链路无关的 `MXBAI_API_KEY`，无 codex CLI）按 DoD 明确报告 **M2_LIVE=BLOCKED_AUTH**：144 条任务运行（24 dev × 2 臂 × 3 重复）全部 `taskOutcome=UNMEASURED`、`taskSuccess=null`，未以检索 proxy 冒充任务成功。全路线不得宣布 DONE。

## 环境事实（授权判定证据）

- `env`：`MXBAI_API_KEY` 存在；`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 均未设置；`which codex` 无结果 → `detectBackend()` 返回 `null`
- BLOCKED_AUTH pack 实测（`eval-blocked-auth/results-pack.json`，sha256 `9416ab207e494e48`）：`status=BLOCKED_AUTH`、`denominator=144`（24×2×3）、`taskSuccessRate=null`、blockedReasons 列出 `OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL / codex CLI`

## 逐范围证据

### T08 关键证据与最终读计划（commit `11dbcf6`、`a189e70`、`6cab673`）

| 项 | 证据 | 结果 |
|---|---|---|
| 证据缺口三分类（ENTRY_ABSENT / EVICTED / RANGE_MISS） | `read-plan.ts` 全部 gap 生成点接入 `gapLedger`，`evidenceGapLedger` 与 `evidenceGaps` 镜像；`read-plan-gaps.test.ts` 5 测试 | RED（4 断言失败 @ HEAD）→ GREEN（`11dbcf6` 后 5/5；agent-router 211 测试全绿） |
| **K11：helper 移到 caller 之前/之后，必需证据等价（产品真实缺陷修复）** | 根因：`materializeRankedCandidates` 把与 anchor 同路径的 ranked candidate 直接丢弃 → 同文件 helper（CALLS 边，depth=1 受保护）的读窗口静默消失。修复：同路径 candidate 的 positions/reasons 并入 anchor 文件，range 请求携带并集，字节预算仍由计划选择器裁决（被挤掉则 EVICTED 显式点名）。`helper-move-k11.test.ts`：同一 fixture 双布局（320 行长方法使调用方走 extreme-method 窗口，helper 分居两端），真实 SQL 冷构建 → 真实 `java_impact` 静态读计划，断言 helper 方法区间在两布局都被选区覆盖（或显式点名） | RED（两布局 helper 均未覆盖、gaps 未点名）→ GREEN（BEFORE：helper 5..6 ⊂ 选区 1..51；AFTER：helper 333..334 ⊂ 选区 324..335，tail 窗口随 helper 位置对称延伸）；agent-router 211/211 绿，无回归 |
| M2-2：exact + 泛型的结构化错误 | `DiscoveryUnsupportedError`（code `DISCOVERY_UNSUPPORTED`）在 `validateArgs` 于任何检索执行前抛出，提示 raw-name 重试；auto 模式保持 text 路由不变 | RED（导出缺失 + 行为缺失 @ HEAD）→ GREEN（`discovery-unsupported.test.ts` 2/2）；discovery+symbol 24/24 绿 |
| M2-3：外层 schema 512 上限 | `symbolSchema.query: z.string().min(1).max(512).optional()` 与 worker 层 `DISCOVERY_QUERY_MAX_UNITS=512` 对齐 | 随 `a189e70` 落地；全量绿 |
| step-5 测量：signature vs preview wire 字节（M2-1 动机） | 新测量工具 `src/benchmark/measure-wire-bytes.ts`（canary 式隔离 streamable-HTTP server × 24 个 M1 staged 仓库，JDT_BIN=/usr/bin/false）。结果（`wire-bytes.json`，sha256 `2f2c5e78978248ec`）：24/24 READY、106 候选全部带 preview；**preview 占 java_symbol 线宽 36.9%**（36,288 / 98,425 B；去 preview 后 62,137 B），最重任务 JSB-MYBATIS-01 preview 3,917 B / 全 payload 8,556 B | 实测结论：preview 的字节代价中等（~1/3 线宽），不是"必须砍掉"的量级；M2-1（attachLocators 批处理）的裁决仍缺 K21 事件循环节证据，**按纪律不改码**，测量数据已入档作为 M2 测量轨道输入 |

### T09 真实 Agent 读取、QA 与 repair 评测（commit `3a079ff`）

| 项 | 证据 | 结果 |
|---|---|---|
| host recorder 适配器 `scripts/evaluate-java-task.mjs` | 后端探测 + `backendDeficit`；BLOCKED_AUTH 结果 pack（denominator 含全部 臂×重复，`taskOutcome=UNMEASURED`、`taskSuccess=null`、usage 恒 null——绝不 bytes/4 估算）；`SOURCE_RECEIVED` 事件从**真实工具/模型输出**构建（java_symbol preview → `tool_response`，host read → `explicit_read`，纯摘要不产生事件；sha256 + range + callId 齐全）；Q 轨道严格 JSON 对冻结 gold 逐键精确评分（INVALID/INCOMPLETE/WRONG/CORRECT，无部分分）；P 轨道仅接受注入的冻结测试 runner；失败/超时留在分母内 `taskSuccess=null` | `evaluate-java-task.test.mjs` 9/9 GREEN（含 replay 不变量测试：混合 measured/failed 运行包的重放核对） |
| 真实 CLI 的 BLOCKED_AUTH 运行 | `env -u OPENAI_* node scripts/evaluate-java-task.mjs --tasks <冻结dev集> --gold <冻结gold> --arms product,control --repeats 3` → exit 0，`status=BLOCKED_AUTH`、denominator=144、`taskSuccessRate=null` | 与卡面验收"没有模型授权则明确 M2_LIVE_BLOCKED_AUTH"逐字对应 |
| live 执行回路（授权后才可运行） | `runLiveEvalRun`：复用 `run-agent-trace-live.mjs` 的 MCP stdio 会话（新增 `session.symbol` 携带线级 wireText 回调）+ OpenAI 兼容 chat + `java_symbol`/`read` 自由使用（不强制先 MCP，卡 step 3）；`runLiveAgentTask` 新增 `finalContent` 输出供外部评分器取严格 JSON 答案 | 代码落地并编译；**本环境无授权未执行**（执行需要 `--repo-roots`、`--gold` 与 OPENAI 三元组；无授权时 main() 只会走 BLOCKED_AUTH 分支，路径不可达但完整） |
| M2-4：HALF_UP/DOWN 反向 fixture | `half-up-fixture.test.ts`：注释声称 HALF_UP、代码按 HALF_DOWN 实现的真实 SQL 冷构建 fixture——(1) AST 不存在 HALF_UP 符号，exact 查询不虚构；(2) 注释经 search-document 路由可检索（DOCUMENT 层命中 roundTies/Rounding）；(3) 代码自身声明保留 AST 身份 | 3/3 GREEN（首个 RED 版本暴露 auto 模式对纯标识符判 exact 不走 doc 路由的行为，按 T04 意图路由语义改用显式 `mode:"text"` 复测） |
| K07/K08/K25 绑定契约 | recorder 语义（source vs 摘要）、冻结 gold 不复制入 Agent 工作树（gold 仅评测器侧读取）、LIVE 未执行项逐条列于本报告"未测项" | 见下表 |

## M2 边界统一产品回归（@ `6cab673`，tracked diff 空）

| # | 命令 | 退出码 | 证据（仓库外） |
|---|---|---|---|
| 1 | `npm run build:isolated` | 0 | `m2-boundary/1-build-isolated.log` |
| 2 | `npm test`（独立 checkout 全量） | 0 | `m2-boundary/2-npm-test.log`：**1205 + 304 全绿**（M1 终点 1194+295，+11 产品测试 / +9 harness 无变化） |
| 3 | `npm run gate:pr` | 0 | `m2-boundary/3-gate-pr.log` |
| 4 | `npm run gate:release` | 0 | `m2-boundary/4-gate-release.log` |
| 5 | `npm run measure:tool-schema` | 0 | `m2-boundary/5-tool-schema.log` |
| 6 | `npm run measure:production-ts` | 0 | `m2-boundary/6-production-ts.log` |
| 7 | probe-source（12 项契约） | 0 | `m2-boundary/7-probe-source.json`：**12/12 PASS** |
| 8 | 终态 preflight | — | `m2-boundary/preflight-final.json`（sha256 `b7f1652452d85f3b`）：source_sha=`6cab673`，tracked_diff 空（e3b0c44…） |
| 9 | kit selfcheck | — | `m2-boundary/selfcheck/`：5/5 PASSED（dataset/unit/repair-oracles/upstream/faultcheck） |

## M1 交接项处置

| 交接项 | 处置 |
|---|---|
| M2-1 attachLocators 主键批处理 | **不改码**——字节动机已实测（preview 占线宽 36.9%，候选定位块仅 ~200B/条），事件循环节（K21）证据需 LIVE 轨道，留 M2 测量阶段 |
| M2-2 exact+泛型结构化错误 | **已完成**（`a189e70`，`DISCOVERY_UNSUPPORTED`） |
| M2-3 外层 schema max(512) | **已完成**（`a189e70`） |
| M2-4 HALF_UP 反向 fixture | **已完成**（`3a079ff`，注释可检索但不覆盖 AST 程序事实） |
| M2-5 K15/K19/K21 runtime 级 freshness | **未测**——依赖真实运行时/LIVE 轨道，M2_LIVE=BLOCKED_AUTH 期间无法逐项执行 |
| M2-6 全公开语料 static-m1 臂 | **未测**——需要 `--allow-network` 语料下载，本环境不执行 |
| M2-7 框架配置键覆盖 | 不变——M3 条件项，失败驱动 |

## 未测项（诚实清单）

1. **LIVE 轨道整体**：12+ devpilot × 2 臂 × 3 重复的真实模型执行、provider raw usage 采集、外部 repair artifact（8 repair 的冻结测试对真实 candidate worktree 执行）——全部 `UNMEASURED`，`taskSuccessRate=null`。
2. 五项发布门数值（correctness_floor / qa_contract_floor / warm_static_p95 / event_loop_p95 / anchored_impact_p95_ratio）在本里程碑仍无 LIVE 实测值；`gate:release` 退出码 0 是产品自身门禁，不是本包发布门的数值达成声明。
3. 第二模型对照臂、锁定集（locked split）执行。
4. K15/K19/K21 的 runtime 级 freshness 契约（M1 仅函数/fixture 级）。

## 决定

- **M2_OFFLINE = GO**：T08 四张机制（gap 分类、K11 位置无关性、M2-2、M2-3 + 测量）与 T09 离线侧（recorder/评分/BLOCKED_AUTH 链路/fixture）全部落地、RED→GREEN 留痕、边界 6/6 + probe 12/12 + preflight 干净 + selfcheck 5/5。
- **M2_LIVE = BLOCKED_AUTH**：授权补齐后（OPENAI 三元组或 codex CLI），以 `scripts/evaluate-java-task.mjs --tasks … --gold … --repo-roots …` 直接开跑 LIVE 轨道，无需新增代码即可产出可被 kit harness 评分的 results pack。
- **全路线**：M3 未开始；按 01-execution-master DoD，不宣布 DONE。

## 附录 A：审查发现与修复（本轮）

1. **K11 静默丢窗（产品真实缺陷，`11dbcf6` 修复）**：`materializeRankedCandidates` 按"anchor 路径已选"丢弃同路径 ranked candidate，helper 与调用方同文件时 CALLS 边的读窗口不进入 range 查询，且无任何 gap 点名——正是 K11 警告的"只看调用点之后"类位置偏置。修复后双布局等价且 helper 区间被覆盖（见 T08 表）。
2. **COMPACT wire 与 V6 双形态**（T09 适配器契约处理）：默认 wire 是 CompactImpact（`contexts[].spans` s/e/b），诊断模式才是 V6 `readPlan[]`；K11 测试与 recorder 均按"取任一形态"读取，避免把线格式当断言前提。
3. **usage 语义**：`runLiveAgentTask` 的 usage 为 `{status:"UNMEASURED"}` 占位对象，pack 组装时 `usageOrZero` 只在 MEASURED/PARTIAL 时透出数值，其余恒 null——K 契约"usage 缺失 null，不能 bytes/4 充 actual"在 pack 层强制。