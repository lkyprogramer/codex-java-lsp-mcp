# M0 里程碑报告 —— Java Specialist Devkit v1

## 身份与范围

- **source SHA（本里程碑终点）**：`be83f5191d8c75723f7e05811cbc3cadf1eb7105`（`be83f51`，branch `codex/java-specialist-devkit-v1`）
- **基线 bundle 提交**：`81151e6`（docs bundle，230 文件）
- **dirty tree**：tracked diff 为空（`tracked_diff_sha256 = e3b0c44…` = 空串哈希）；未跟踪 `.commandcode/` 仅被 git status 列出，不进入哈希
- **installed runtime SHA**：UNMEASURED（本里程碑无 JDT/LSP 运行时启用；静态索引与函数契约轨道）
- **host**：node v22.19.0，javac 25.0.1，python 3.12.12
- **dataset_hash**：`c34a7c7c2f261bb273bc622739eae6beff8479ca96512c48942638cd912b8c4d`
- **corpus_hash**：`2c6021e29ef78cae1aec4865343ef47d8802c40a4449599a00126a9984882d42`（corpus_mode=bundled-scoped，split=dev）
- **scorer/profile**：source 自带 `harness/cli.py baseline`（BM25 词法控制臂，32 行窗口 stride 16），profile = bundled-scoped dev split
- **模型 / 付费 API**：无（本里程碑不调用任何模型；token 结论全部 UNMEASURED）
- **轨道**：FUNCTION_PROBE（probe-source 12 项契约）+ SCOPED（bundled-scoped baseline 词法控制）；LIVE / FULL / RELEASE 均未运行

## 假设与改动

| Task | 机制假设 | 改动 | 为何不是 task/gold 特判 |
|---|---|---|---|
| T01 冻结基线与测量语义 | 旧代码把 `taskSuccessFromCoverage` 当作任务成功，且 source 报告可覆盖安装运行时/任务结果等权威字段 | `scripts/run-agent-trace-live.mjs`：更名 `coverageProxy`，新增 `unmeasuredTaskOutcome()`、`SOURCE_REPORT_PROTECTED_FIELDS`（freeze）、`mergeSourceReport()`；结果构造器与 summary 增加 `taskOutcome`/`scopes`；新脚本 `scripts/record-independent-benchmark.mjs`（`independent-benchmark-record/v1`，写入前校验）+ 测试 | 改动只改测量元数据语义；不读取任何 task ID / gold 字段，无新路由分支；`LIVE_TRACE_V1_FIELD_NAMES` 未扩展（v1 anchor 冻结契约保持） |
| T02 声明身份与跨文件归属 | 旧 `type:<fqn>` 主键让同 FQN 跨文件/跨模块声明互相覆盖；方法 ID 非 owner 作用域；SQL 写包 AB/BA 顺序产生不同归属 | `stable-id.ts`：`scopedNamedTypeId`（`type:v2:<enc(path)>#<enc(fqn)>`）、`splitOwnerMemberKey`、`STABLE_ID_VERSION=2`；`schema.ts` `SCHEMA_VERSION=4`；`sql-client.ts` sibling-seed 副本 schema/identity 不一致即丢弃重建；`facts-store`/`registry-view`/`name-resolver`/`framework-index-view`/框架适配器全部改为 v2 感知；`v1AliasIds` 保持旧 `type:<fqn>` 请求可解析；FQN 保留为多值检索属性（`entity-tokens`） | 身份改为（path, FQN）纯函数；AB/BA 写包在两侧都得到相同 2 行 type / 2 行 file 归属，与写入顺序无关；FQN 匹配无 taskId 分支 |
| T03 长方法锚点窗口 | 旧 `emitMethod` 对 >300 行方法只保留首/尾 40 行，方法中部所有锚点（如 201/100/350）全部丢失 | 新 `src/discovery/anchor-windows.ts`（`anchorWindows(start, end, anchors, radius=16)` 纯函数，clamp+merge，非法输入 throw）；`sql-read-ranges.ts`：按方法聚合全部请求锚点，极端方法 = 头窗(40) + 每锚点居中窗(±16, clamp 到方法) + 尾窗(有锚点 5 行 / 无锚点保持旧 40 行)；`IndexedReadRangeResult.uncoveredAnchorLines` 显式报告预算裁剪后未覆盖锚点；`read-plan.ts` 序列化器对未覆盖锚点注入 `evidenceGaps`（不再声称完整）；LF/CRLF 均经真实 UTF-8 行偏移计算 | 锚点窗口只由请求位置驱动；短方法（≤300 行）range 行为不变；无 task ID、无 gold、无按查询文本特判 |

新增依赖：无。删除的旧分支：`emitMethod` 极端方法的"无锚点尾 40 行"逻辑仅保留在无锚点路径（行为不变）。

## 执行证据

原始日志全部位于仓库外 `RUN=/Users/luo/Documents/github/java-devkit-v1-runs/m0/`。

| Command | Exit | Raw log（$RUN/…） | SHA-256（前 12 位） | Meaning |
|---|---:|---|---|---|
| `python3 -m harness.selfcheck --project …`（kit 自检 5 项） | 0 | selfcheck/summary.json | 5f6f4cb14125 | dataset/unit/repair-oracles/upstream/faultcheck 5/5 exit 0 |
| `python3 -m harness.preflight --project … --output …`（初） | 0 | preflight.json | 8e61a2d83ef9 | 基线 preflight：source_sha=81151e6，环境齐备 |
| `node adapters/probe-source.mjs`（基线，全部 12 项） | 1 | probe-baseline.json | b37c7595971e | 3 pass / 9 fail —— 与 T01 预期一致（C1×5、C2×3、C3×4 中 C2-FQN 通过） |
| T01 RED：`run-agent-trace-live.test.mjs` | 非0 | t01-red.log | 91af11201462 | 3/27 新测试按真实断言失败（非模块缺失） |
| T01 GREEN：同文件 | 0 | t01-green.log | 5111476592ea | 31/31 |
| T01 下游消费者 + N5 重放 | 0 | t01-green-consumers.log / t01-green-n5.log | cb355d299a59 / 9a6160ed7181 | 19/19、N5 重放通过 |
| T01 commit | — | — | `b512e95` | 4 files, 357+/8- |
| `harness baseline --split dev --variants primary --repeats 1`（BM25 词法控制） | 0 | baseline-bm25-report.json / -results.json / -report.md | c79205669906 / ed7e7d1df7ec6 / 2a5f14866030 | 24 attempts（22 OK / 2 NOT_FOUND）；recall@10=0.7083，mrr=0.372，ndcg@10=0.446，required_line_recall=0.7737，anchor_containment=0.0（词法 32 行窗口下符合预期） |
| `python3 -m harness.preflight`（T02 前） | 0 | preflight-t02.json | 95221342fb24 | source_sha 与 basis 一致后开工 |
| T02 GREEN 核心探针组 | 0 | probe-t02.json（全组）/ probe-c1-t02.json（C1） | aaf81c7119f3 / 4b6dece208c2 | C1 5/5 PASS（ID-PATH、ID-LINE-STABLE、METHOD-OWNER、SQL-WRITE-AB、SQL-WRITE-BA） |
| T02 全量产品测试 | 0 | t02-full-6.log | 39dc756f6b1e | 1146 + 295 全绿 |
| T02 commit | — | — | `bb849ca` | 21 files |
| T03 RED 记录 | — | probe-baseline.json（C3 四行 FAIL，`[[1,41],[382,421]]`） | b37c7595971e | 中部锚点 201/100/350 全部丢失（首/尾 40 行坍塌） |
| T03 GREEN 定向 | 0 | t03-green.log | 1b4856089685 | anchor-windows 7 + read-ranges 3 + sql-queries + read-plan = 60/60 |
| T03 probe C3 | 0 | probe-c3-t03.json | 9ed487184aa3 | 4/4 PASS：LF/CRLF ×（201；100+350）→ `[[1,41],[185,217],[417,421]]`、`[[1,41],[84,116],[334,366],[417,421]]` |
| T03 全量产品测试 | 0 | t03-full.log | b3113c7885d3 | 1155 + 295 全绿 |
| T03 commit | — | — | `be83f51` | 6 files, 235+/14- |
| 边界：`npm run build:isolated` | 0 | boundary-build.log | e8547fb6ef3c | 隔离编译通过 |
| 边界：`npm test` | 0 | boundary-test.log | 4239337bd924 | 1155 + 295 pass，0 fail |
| 边界：`npm run gate:pr` | 0 | boundary-gate-pr.log | 6bb8633927d8 | PR-fast 门（isolated compile + dist unit）exit 0，rawSha256=3935673cc2e8… |
| 终态 preflight | 0 | preflight-final.json | 718d26f1fb68 | source_sha=be83f51…，tracked diff 空，环境齐备 |
| 终态全组 probe（12 项） | 1 | probe-final.json | 9e3830b3ee46 | 11 pass / 1 fail；唯一失败 C2 多词查询（见下） |

未运行的轨道：`npm run gate:release`、真实 MCP server、真实 Agent 任务、全语料（full-corpus）基线/对比 —— 均不在 M0 定义内，如实记 UNMEASURED / NOT_RUN，不填 0。

## 逐任务差异

| Task | Baseline（M0 前） | Candidate（M0 后） | First causal break | Closed / new / known |
|---|---|---|---|---|
| T01 测量语义 | probe 3/12；live trace 把路径覆盖率代理当任务成功；source 报告可覆盖权威字段 | live trace 31/31；`taskOutcome=UNMEASURED` 为默认真值；保护字段 freeze；独立基准记录器带写入前校验 | 任务成功判定与运行时证据解耦（`unmeasuredTaskOutcome` + 保护字段 merge） | closed；known：真实 Agent / 全语料 UNMEASURED（M0 不要求） |
| T02 声明身份 | C1 5/5 FAIL：同 FQN 跨文件同 ID、方法 ID 非 owner 作用域、SQL AB/BA 归属不同 | C1 5/5 PASS：`type:v2:path#fqn` 区分同 FQN；方法/字段 ID owner 作用域；AB/BA 写包同构（2 type 行 / 2 file 行） | 主键从 FQN 换成 (repo-relative path, FQN)，schema v4 + identity v2 使旧派生库丢弃重建 | closed；known：C2 多词文本查询仍 FAIL（M1 范围，见下） |
| T03 锚点窗口 | C3 4/4 FAIL：长方法坍塌为 `[[1,41],[382,421]]`，锚点 201/100/350 全部丢失 | C3 4/4 PASS：LF/CRLF 下锚点居中窗（±16, clamp+merge）保留；短方法行为不变；预算裁剪显式 `uncoveredAnchorLines` + readPlan `evidenceGaps` | `emitMethod` 按方法聚合全部请求锚点并调用 `anchorWindows` | closed；known：warm_static_p95 / event_loop_p95 未测（需真实 MCP 轨道，M0 不要求） |
| C2 多词查询（非 M0 任务） | `OrderService rollback refund` 返回 SIMPLE_NAME 层 OrderService 而非方法 | 未变（M0 不触及多词融合策略） | — | **known**：属 M1（T04+）范围；精确 FQN 查询与双词 CHUNK 融合已 PASS |

## 成本与统计

- 模型 / provider usage：无调用（0 tokens，无付费 API、无 embedding 下载）→ 所有 token/冷暖/建库计时指标 **UNMEASURED**，不得据此下"省 token"结论
- 词法控制臂（BM25，scoped，1 repeat）：24 attempts，22 OK / 2 NOT_FOUND；decl_recall@10 = 0.7083，mrr = 0.3720，ndcg@10 = 0.4460，required_line_recall = 0.7737，anchor_containment = 0.0000（32 行词法窗口不含锚点语义，预期值）；emitted/received bytes 均值 1931.6
- `repair_success = UNMEASURED_USE_FROZEN_REPAIR_RUNNER`（修复成功率属冻结修复运行器，非本里程碑）
- 本里程碑成本仅为本机计算：probe 12 项 + 词法基线 + 4 次全量产品测试 + 3 个门

## 限制与决定

**限制**：
1. 真实 Agent 任务、真实 MCP 服务、全语料（FULL）对比、`gate:release` 均未运行 → 相关 gate（correctness_floor / qa_contract_floor / warm_static_p95 / event_loop_p95 / anchored_impact_p95_ratio）在本里程碑全部 UNMEASURED，**不能用探针或自检替代**（探针只是函数契约底线）
2. C2 多词查询（`OrderService rollback refund`）仍失败，属 M1 范围，M0 不关闭
3. `anchor_containment=0.0` 是词法控制臂的结构性结果，T03 的收益需在真实 MCP/Agent 轨道才能体现（A1 臂对比留待 M1+）
4. `installed_runtime_sha=null`：JDT/LSP 未启用，静态轨道结论不外推到动态语义

**决定**：**GO**（M0 完成度）—— 三张任务卡的真实函数契约全部转绿（C1 5/5、C3 4/4、T01 测量语义 31/31 + 记录器），边界门 `build:isolated` / `npm test` / `gate:pr` 全过，产品回归 1155+295 无失败；M1 入口条件：先关闭 C2 多词查询（T04）再开真实 MCP 轨道。
