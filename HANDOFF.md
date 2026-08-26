# HANDOFF

## daemon 生产化三轨（2026-08-25）

分支 `codex/frontier-r1`。live HTTP daemon `http://127.0.0.1:38456/mcp`，LaunchAgent `com.lky.codex-java-lsp-mcp`。当前 release `3e9ef62e405c-20260826T034749Z`（热集 `hydrate:true`）。pin：`lishuedu`、`exam-parent-v3`、`cipherlink`、`lishu-v2`。不要把 `fat-service` / `analysis-develop-analysis` / `recognition-master` 加回 `projects.json`。不要合 `main`。回滚：`"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" rollback-release`。

计划真源：`docs/deep/codex-java-lsp-mcp-daemon-stability-and-memory-plan-2026-08-25.md`。closeout：`docs/phase-d/w1-closeout.json`、`s1`–`s3`、`m1`–`m4`、`v1-acceptance.md`。探针：`scripts/probe-daemon-acceptance.mjs`。

已落地：W1 watcher/JDK/EPIPE；S1 QUERY/STATUS 超时不 retire worker；S2 `factsHydrated` 预热；S3 read-plan `DEADLINE_EXCEEDED` fail-soft；M1 热集 hydrate / 冷集 hibernate；M2 20 分钟 index idle 关 isolate；M3 daemon `--max-old-space-size=768`、worker `resourceLimits` 1536、nofile 65536；M4 sibling seed 指纹不否决、JDK pin 文件退出指纹、拒绝原因遥测、cache-meta 回填 `familyHash`。

坑：
- 所有 git / npm / 测试加 `PATH="/opt/homebrew/bin:$PATH"`。
- 内存口径用 `footprint -p <pid>` 的 `phys_footprint`，不要只用 `ps` RSS。
- chokidar `ignored` 每事件路径禁止同步 fs。
- Worker 不能用 `execArgv --max-old-space-size`（`ERR_WORKER_INVALID_EXEC_ARGV`），要用 `resourceLimits.maxOldGenerationSizeMb`。
- linked worktree 的 live git `familyHash` 在 daemon 里可能缺失；seed 必须能从该仓自己的 `repo-meta.json` 回填。
- M4c 指纹输入变化会让 own-snapshot 全部失效。部署后 pin 仓会串行冷建；host load 40–160 时 worker 会 `ERR_WORKER_OUT_OF_MEMORY`。
- sibling `findCandidate` 只能读 v4 header，禁止对每个 family mate `toFacts()`。`createEntry` 不得 await 冷建 reconcile。OPEN 花光 15s 后 freshness barrier 必须 fail-soft，`java_status` 回退 `localStatus`。
- 热集预热是 `hydrate:true`（`JAVA_LSP_PREWARM_HOT` 默认 `lishuedu,lishu-v2`）。lishuedu rest-hydrate 三次打爆 1536 isolate（`docs/phase-d/d3a-escalation.md`）。不要再重试同一条 `QUERY_REPOSITORY_FACT_MARKERS`。
- D1 数字 807/866 MiB 是 files-only `425fd96` 上测的，不是当前 hydrate live。hydrate 打开后 idle 曾到 961。
- D1 soak 不要等生产 20 分钟 index-idle。用 `scripts/d1-fast-idle-soak.sh` 临时压 TTL，测完必须去掉 LaunchAgent 里的 TTL env。`footprint -p` 只读 `phys_footprint:` 行。

V1 **NOT COMPLETE**。D7 PASS。D1 仅 files-only 口径 PASS。D2 gradle storm P99 31 ms。D3a FAIL（lishuedu hydrate OOM，首查 4975 ms worker unavailable）。D3b/D4/D6 PASS。D5 PARTIAL。Identity vs main：三仓 recall/pRead/token P50 delta 0；formal floors 两臂同失败。后续：缩热集到 `lishu-v2`，或另开流式 hydrate 卡。

## 当前任务

**main 已切换。** merge `e48a253`（`48e665b` + `db61edc`，non-squash）。F2 attestation pr/nightly/release GO。未 push。F3 soak 已开始，24–48h 未过，计划未 COMPLETE。回滚：`git revert -m 1 e48a253`。cipherlink holdout 已立项。无 live。`java_context` 不公开。

## E1（2026-08-23）

判定 **COMPLETE**。报表 schema `java-intelligence-jin-n5-three-arm-trace/v2`。`pairedHitRate` 与 miss 标签 `IN_POOL_NOT_PACKED` / `DISCOVERY_GAP` / `SINGLE_ARM_MISS` 并报；v1 `taskSuccess`/`arms`/`modelUsage` 保留。N5-02 重放：jin 6/6 更差，mean delta ≈ −0.359。candidates 仍不计入 observed（E3）。隔离 T0 26/26 fail 0。收口 `docs/phase-e/e1-closeout.json`。

## E2（2026-08-23）

判定 **COMPLETE**。old/jin 系统提示词同构：继续调用直到描述完影响面或 8 轮上限。jin 去掉 Prefer-one-search / 禁止 navigate。SHA 写入 v2 `promptFingerprints`。隔离 T0 27/27 fail 0。收口 `docs/phase-e/e2-closeout.json`。

## E4（2026-08-23）

判定 **COMPLETE**。`--model-profile local-qwen|openrouter` 接到 F0 helper（47.106.205.246:1082 / stealth/ox-alpha）。Serena 两路失败 → `SERENA_ABANDONED`，kill 改为 old/jin 配对（harvest §3.5）。隔离 T0 35/35 fail 0。收口 `docs/phase-e/e4-closeout.json`。

## C1（2026-08-23）

判定 **COMPLETE**。`java_context` 合同 v2：`candidates[]` frontier N=24，`evidence[]` 装箱 spans，`next[]` 带 file/line。`contexts` 暂作 alias。schema 578 ≤ 700。T0 30/30；T1 dist 1184 + scripts 231 fail 0。T2 钉仓 `/tmp/codex-java-v3-golden-20260809` 已无源码（lishuedu 0 .java）→ `T2_BLOCKED_GOLDEN_EMPTY`。收口 `docs/phase-c/c1-closeout.json`。

## E3（2026-08-23）

判定 **COMPLETE**。`collectImpactPaths` 计入 `candidates[]`、`evidence[]`、带路径的 `unresolved`。compact 载荷把 frontier 交给模型。隔离 T0 22/22 fail 0。收口 `docs/phase-e/e3-closeout.json`。

## C2（2026-08-23）

判定 **COMPLETE**。spans 收成 `12-48,60-75`；去掉 resolvedIntent/anchor/contexts 回显；unresolved 只留 `{path,role}`；evidence 最多 4 文件。N=24 时 P50 1.71，按失败处置降 wire candidates **12**（层保留）。六组首呼 compact P50 **1.009 ≤ 1.2**。T0 50/50；T1 dist 1185 + scripts 232 fail 0。三仓 T2 仍 `T2_BLOCKED_GOLDEN_EMPTY`。收口 `docs/phase-c/c2-closeout.json`。

## C3（2026-08-23）

判定 **COMPLETE**。只改常量：evidence 帽 **3**，`DEFAULT_TOKEN_BUDGET` **1400**（相对 C2 的 2000 −30%），文件护栏 **14**。选择算法未动。T0 75/75；T1 dist 1186 + scripts 232 fail 0。C2 字节 P50 门仍过。三仓 T2 仍空仓。收口 `docs/phase-c/c3-closeout.json`。

## G1（2026-08-23）

判定 **COMPLETE**。`YunaiV/ruoyi-vue-pro` pin `2bbe79b3` 冻结 40 场景 / 12 holdout。mustHit 来自 commit-tasks 同链路，未手挑。检出 `/tmp/codex-java-v4-golden-20260823/ruoyi-vue-pro`。质量 thin/noise 0。T0 17/17 fail 0。**冻结后不看 holdout gold、不调参。** 收口 `docs/phase-g/g1-closeout.json`。

## G2（2026-08-23）

判定 **G2_OVERFIT_FAIL**。四仓一折冷测。ruoyi 留出 recall/pRead/rReadMust 回撤 0.179/0.516/0.477 > 0.15。另外三折 GO。未调参（冻结 holdout 禁止拿来改排序）。**阻塞 F，不阻塞 L1**。收口 `docs/phase-g/g2-closeout.json`。

## O1（2026-08-23）

判定 **G3_MISS**。`resolveAll` 不再保留第二份 `resolvedByPath`。lishuedu 5312 文件 RSS **2790 MiB > 1536**。门未放宽。收口 `docs/phase-o/o1-closeout.json`。

## O2（2026-08-23）

判定 **O2_MISS**。三仓冷建复测 lishuedu **66.8s > 60s**（resolve 40.1s）。未上 worker 分片（digest / RSS 风险）。门未放宽。收口 `docs/phase-o/o2-closeout.json`。

## O3（2026-08-23）

判定 **COMPLETE**。G5 稳态预热 2 轮。三仓比值 **0.835 / 0.547 / 0.886 ≤ 1.10**。G1 **173 / 29 / 46** 未回退。未上 LRU。收口 `docs/phase-o/o3-closeout.json`。

## F2（2026-08-24）

判定 **COMPLETE**。`docs/phase-f/f2-attestation.json`。`main` merge `e48a253` non-squash。gate:pr / nightly / release 全 0。HTTP smoke 5 工具无 `java_context`。未 push。F3 `F3_SOAK_STARTED`。

## F1-N0（2026-08-24）

判定 **GO**。`docs/phase-f/f1-n0-closeout.json`。old=N0 `09772b2`。三仓质量 identity；token −27%。ruoyi GO。G1 57/14/21；S1 415；**S2 725≤1433.6**（digest 不再 unpack 整图）。F2 未启动。不合 main。

## F1 vs github main（2026-08-24）

判定 **FAIL_WRONG_TREE**。`docs/phase-f/f1-closeout.json`。github `main` 是前 V4 树。cipherlink 与 V4-final new 相同；holdout 0.55 立项。

## B3（2026-08-24）

**RESOLVED_OPTION_C。** `docs/phase-b/b3-escalation.md`。用户选 C：ruoyi 降观察仓。G2 是产品既有缺陷（默认链 vs `main` identity），不是合并回归。选项 B 入场条件 = 真实使用中出现可归因 `NOT_IN_POOL` 缺口。F1 已解锁。

## B0（2026-08-24）

判定 **NOT_IN_POOL_STRUCTURAL**。池是 diagnostic `productionRanking`（不是 compact `files[]`）。tuning 28，holdout 12 未读。76 缺失：absent 31 (40.8%)，readplan-budget 25，candidate-limit 5，range-miss 15。选择层 59.2%。**不开 B1/B2**。隔离 T0 6/6；T2 diagnostic GO。收口 `docs/phase-b/b0-closeout.json`。

## A2a（2026-08-24）

判定 **GOLDEN_FIXED_CHAIN_STILL_FAILS**。A1 规则取反过滤 eligible 382→238，写入 40 场景（28 tuning / 12 holdout）。tuning 再审计 noisyRate 0。LORO 三折 GO；ruoyi recall 回撤 0.121 过门，pRead 0.536 / rReadMust 0.416 仍 >0.15。holdout 未读。下一步 **B0**。收口 `docs/phase-a/a2a-closeout.json`。

## A1（2026-08-24）

判定 **GOLDEN_NOISY**。六条预注册规则；holdout 12 条未读。ruoyi tuning noisyRate **0.464** ≥ 0.30。三仓对照各 8 条 tuning 噪声率 0，非 `RULE_TOO_STRICT`。主因 `testInMustHit` 13 + `mustHitGt8` 3。隔离 T0 9/9 fail 0。下一步 **A2a** 按规则取反重推导。收口 `docs/phase-a/a1-closeout.json`。

## L1（2026-08-23）

判定 **FAIL** / `KILLED_AFTER_THREE_LIVES`。双模型都 MEASURED：local-qwen `openclaw/Qwen3.8-27B-WORK` 与 OpenRouter `stealth/ox-alpha` 均为 jin 0/6 vs old 1/6。合并配对均值 delta −0.476，两模型都不满足 ≥4/6 不劣。token jin/old 1.735 / 2.694 都 >1.1。presign / pay-order 仍 false。无 cap/runtime 丢弃。已从 `PUBLIC_JAVA_TOOLS` 撤下 `java_context`（handler 留分支）。隔离 T0 23/23 fail 0；smoke 5 工具无 `java_context`。没有第四次 live。收口 `docs/phase-l/l1-closeout.json`。

## N5 live 复测（2026-08-22）

判定 **FAIL**。6 holdout 全跑完，无 502/503。old 1/6（exam-score-export），jin 0/6。jin 轮次 22 vs 29，token 43543 vs 25402。presign / pay-order 仍 false。Serena UNAVAILABLE。raw SHA `51e978f5…`（scratch，不入库）。摘要 `docs/phase-jin/jin-n5-02-live-summary.json` SHA `bd5a2025…`。

## M6-5（2026-08-22）

判定 **PASS（G1）**。v4 rest 按段从磁盘再读，OPEN 不再捏着整份快照 Buffer。digest 在可选 `gc()` 后取样（unpack JSON 垃圾不算 G1）。G1 **173 / 29 / 46** 全达标。G4 1534ms GO。G5 稳态 lishuedu 1.12 略超 1.10。真实 child RSS 2311 仍超 G3。T1 dist 1181 + scripts 215 fail 0。

收口：`docs/phase-m/m6-5-baseline.json`、`docs/phase-m/m6-5-memory.json`。

## M6-4（2026-08-22）

判定 **MEASURED**。lishuedu 真实 child：discover 0.2s / parse 19.4s / resolve 46.1s / snapshotPrepare 3.4s / v4 encode 7.6s / graph encode 0.7s / **合计 77.6s**。N1 46s ≈ 今天的 resolveAll。v4 gzip 不是 3 倍主因。先前 161s 冷建是 child 因 `/tmp`→`/private/tmp` 写了空快照后父进程自己扫。真实 child RSS **2174 MiB > G3 1536**（门未放宽）。

收口：`docs/phase-m/m6-4-baseline.json`、`docs/phase-m/m6-4-cold.json`。

## M6-3（2026-08-22）

判定 **PARTIAL**。JavaFileFacts + imports 落列；OPEN 解完 files 段后丢掉 JSON 数组。G1 208→207（文件对象在 M1 intern 后只剩 ~10 MiB，不是预估的 30–50）。中小仓 37/62 ≤64 **GO**。G4 1348ms **GO**。G5 稳态 0.914/0.596/1.01 **GO**。残差是 graph intern 表 + pending v4 rest gzip Buffer。T1 dist 1180 + scripts 215 fail 0。

收口：`docs/phase-m/m6-3-baseline.json`、`docs/phase-m/m6-3-memory.json`。

## M6-2（2026-08-22）

判定 **PARTIAL**。知识图改列式（StringTable + node/edge 列 + 惰性物化）。G1 257→208（−49 MiB）；cipherlink 45 / exam 62 ≤64 **GO**；lishuedu 208>200 **MISS** 8 MiB（门未放宽，残差 files）。G4 1549ms **GO**。G5 稳态 0.929/0.618/0.881 **GO**；首 hydrate 仍 ~7.9s。S1 960 **GO**；S2 RSS 1592>1433 **MISS**（heapUsedSum 546 低于 M6-1）。T1 dist 1177 + scripts 215 fail 0。

收口：`docs/phase-m/m6-2-baseline.json`、`docs/phase-m/m6-2-memory.json`。

## M6-1（2026-08-22）

判定 **PARTIAL**。G4 lishuedu 1131ms ≤ 2000 **GO**（M5 2114 含 graph unpack；`0f414ed` 原提交同线程 rest hydrate 把 G4 推到 9243，已从 OPEN 验证路径拿掉）。G5 拆门：稳态 warm p95 69/28/34 vs M0 77.2/40.9/38.5，比值 0.898/0.679/0.895 **GO**；lishuedu 首 hydrate 7377ms **MISS**（门未放宽）。edit-to-visible P95 188ms ≤ 500 **GO**。S1 686 / S2 1207 / S4 9 MiB·107ms GO。G1 257/46/77 仍 MISS。

收口：`docs/phase-m/m6-1-baseline.json`、`docs/phase-m/m6-1-memory.json`。T1 dist 1174 + scripts 215 fail 0。

## M 轨道出口（2026-08-21）

判定 **PARTIAL**。T3 identity GO（三仓 recall/pRead/rReadMust/RangeLineRecall/holdout/tokens 逐位相同；p95 0.976/0.971/1.005 ≤ 1.10）。G1/G2/G4/G5 未达书面目标，按各卡失败处置记账，**门未放宽**。S1 733 / S2 1291 / S3=1 / S4 9 MiB·108ms GO。LOC +2118 ≤ 2500。HEAD 生产树 `70f0939`，old=`1f9eed4`。

收口：`docs/phase-m/m-track-closeout.json`、`docs/phase-m/m-track-20260821.md`。raw T3 cell 不入库。

## 已完成

N0 COMPLETE → N0.5 COMPLETE → N1 FAIL RSS（M 轨道 **RESOLVED**）→ N2a COMPLETE → N3 COMPLETE → N4 PARTIAL 3/4（`8cc1762`）→ N5-01 GO → N5-02 live MEASURED FAIL → **M0–M5 PARTIAL** → **M6-1～M6-5（G1 GO）**。

## 当前状态 / 卡点

- N5 退出卡（2026-08-22 OpenRouter）：jin 0/6 vs old 1/6；token 43543 vs 25402；presign/pay-order 未闭合。无 502/503。Serena UNAVAILABLE。
- Range 残差：lishuedu / exam 仍低于 compact；cipherlink 0.925 不回退。
- N1 RSS `0A.4(4b)` **RESOLVED** by M-track §3（G1/G2 书面目标仍 MISS，门未放宽）。
- N3 p95 −35% vs 默认 impact **UNMEASURED**。
- 第四仓 `YunaiV/ruoyi-vue-pro` pin `2bbe79b3` 已冻结；G2 leave-one-repo-out **G2_OVERFIT_FAIL**（阻塞 F）。
- 生产 MCP / `java_impact` 不读 `JAVA_LSP_ENGINE`。

## 下一步计划

1. B3 停点：用户在接受风险合并 / 图层立项 / ruoyi 降观察仓中选。
2. 没有第四次 live。不要把 `java_context` 加回公开工具面。
3. 在用户选择之前不合 `main`。
4. 冷建 RSS / 时长残差走已记账的 O1/O2，不重开 M 轨架构。

## 绝对不要再踩的坑

- 不要再用「跨模块优先」装箱：pack6 把 Agency 等无关跨模块文件挤进 paper/exam，holdout 掉到 0.517。
- 不要按方法拆 hop>0：Range 会从 0.582 掉到 0.499。
- 不要把 extraNames 灌成全局 call 名：lishuedu p95Ratio 会到 1.2–1.7。
- 不要给 hop0 挂全部 owner 字段 IMPORTS：会把每个 repo 的 `findById` IMPLEMENTS 抬到 rank 0，挤掉 School CALLS。
- 不要发明 TaskSuccess。不要提交 `docs/evals/task30-model-comparison-20260802/`。密钥不入库。
- T3 输出目录必须不存在（已存在 exit 2）。隔离测试 `PATH=/opt/homebrew/bin` 在前，`JDTLS_BIN=/usr/bin/false`。
- 本地 `node --test *.ts` 会因 unknown extension 失败；以 isolated compile+dist 为准。
- 不要把 N6 closeout 的过时「N4 2/4 / N5 NOT_STARTED」文案当现状；现状是 N4 3/4、N5 FAIL。
- 不要在 OPEN 验证 finally 里 kick 同线程 v4 rest hydrate：STATUS 被 gzip+JSON+ingest 堵住，G4 从 1131ms 变成 9243ms，S1/S2 跟着灌满。
- Darwin 上 cold-build child 必须 `realpath(repoRoot)`。`path.resolve('/tmp/...')` 对不上 `realpath(file)` 的 `/private/tmp/...`，5312 个文件全部 outside-repo，G3 会假绿成 108 MiB。

## 关键文件 / 命令 / 验证

- 15A 面板 `docs/phase-jin/jin-section15a-verification-panel.json`。N5 收口 `jin-phase-n5-closeout.json` SHA `509999fb…`。live 摘要 SHA `fec4f4a0…`。raw trace SHA `9a398537…`（scratch）。
- T0 log SHA `ee93dd54…`；T1 log SHA `fc5286cc…`；executableTree `4b212d28…`；`JDTLS_BIN=/usr/bin/false`。
- goldens `/tmp/codex-java-v3-golden-20260809/{lishuedu,cipherlink,exam-parent-v3}`。
- 计划真源 `docs/deep/codex-java-lsp-mcp-v5r-postmortem-and-java-intelligence-next-clean-slate-plan-2026-08-20.md` 15A.7–15A.8。

## 给下一会话的第一步

读 `docs/phase-jin/jin-n5-02-live-summary.json`。N5 live FAIL，不要进 N6，不要合 `main`，不要发明 TaskSuccess。

## JIN 15A 面板（N5 FAIL / 不进 N6 / 不合 main，2026-08-21）

N0 COMPLETE、N0.5 COMPLETE、N1 FAIL RSS、N2a COMPLETE、N3 COMPLETE、N4 PARTIAL 3/4、N5 FAIL、N6 NOT_STARTED。
HEAD `8ae1c1d` 隔离 T1 dist 1146 + scripts 194 fail 0。live SHA `9a398537…`。

## JIN N5 FAIL（live 三臂 MEASURED，2026-08-21）

6 holdout × old/jin/serena。localization old 1/5 与 jin 1/5 并列。jin 轮次 66 vs 26、token 197618 vs 25845 FAIL。presign/pay-order 未闭合。paper-task jin 502、presign old 503。Serena UNAVAILABLE。不合 main。
摘要 `jin-n5-02-live-summary.json`。raw SHA `9a398537…`。

## JIN N5 PARTIAL（三臂 harness GO，live BLOCKED_EXTERNAL，2026-08-21）

N5-02 harness：36 cells（old=`java_impact` / jin=`java_context` / serena 公开 MCP）。  
`--authorize-external --execute-live` exit 3。host `192.168.10.29:28343` 无 key → HTTP 401。TaskSuccess/usage **UNMEASURED**。Serena **UNAVAILABLE**。  
0A.4(a) escalate。不进 N6。不合 `main`。T1 dist 1146 + scripts 193 fail 0。  
报告：`docs/phase-jin/jin-phase-n5-20260821.md`。摘要 `jin-n5-02-blocked-external.json`。code `78e01a3`。

## JIN N5-01 COMPLETE（java_context，2026-08-21）

`PUBLIC_JAVA_TOOLS` 现为 6 工具。handler `src/tools/java-context.ts`（`tools/context.ts` 是 ToolContext，未覆盖）。intent 必填、无锚点走实体入口、mode=navigate。  
`measure:tool-schema` java_context **564** token（≤600）。T1 dist 1146 + scripts 190 fail 0。smoke GO。  
N5-02 未跑。不合 `main`。生产路径不读 `JAVA_LSP_ENGINE`。  
报告：`docs/phase-jin/jin-phase-n5-20260821.md`。收口 `jin-phase-n5-closeout.json`。code `b0c08dd`。

## JIN N4 PARTIAL 3/4（named hop-2 CALLS_VIRTUAL，2026-08-21）

15A.6 JIN-N4-04：≥ 3/4 记 PARTIAL 并进 N5。窗口从 2026-08-20 起算，未到期。  
T3 **3/4**：token **GO**（1715/2164/1842，−49.5/−32.1/−34.9%）；p95 **GO**（0.369/0.147/0.167）；holdout rReadMust 均值 **0.758**（1.00/0.775/0.50）**GO**；RangeLineRecall **FAIL** 0.733/0.925/0.653 vs compact 0.842/0.875/0.853。  
storage-signed-url **5/5**。exam-score **4/4** SchoolQueryService。paper-task **4/4** MeQueryService。  
**进 N5、不合 `main`。** 生产 MCP 不读 `JAVA_LSP_ENGINE`。不得发明 TaskSuccess。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-named-callee-summary.json`。code `8cc1762`。scratch `jin-n4-t3-named3`。

## JIN 停在 N4（holdout 装箱 2/4；时钟未到期，2026-08-21）

15A.6 JIN-N4-04：**2 周窗口到期**才做二元裁决。窗口从 2026-08-20 起算，尚未到期。  
本轮 T3 **2/4**：token **FAIL**（2673/2730/2725，−21/−14/−4%，未满 25%）；p95 **GO**（0.281/0.083/0.115）；RangeLineRecall **FAIL** vs compact 0.718/0.925/0.653；holdout rReadMust 均值 **0.633**（0.75/0.65/0.50）**FAIL**。  
storage-signed-url **5/5**（SignedUrl DTO 在）。exam-score **3/4** 缺 SchoolQueryService。paper-task **3/4** 缺 MeQueryService。ExcelGenerator 在。  
不要再用「跨模块优先」装箱：pack6 把 Agency 等无关跨模块文件挤进 paper/exam，holdout 掉到 0.517。  
**不进 N5、不合 `main`。** 生产 MCP 不读 `JAVA_LSP_ENGINE`。不得发明 TaskSuccess。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-pack-holdout-summary.json`。scratch `jin-n4-t3-pack4`。

## JIN 停在 N4（hop0 cap 2/4；时钟未到期，2026-08-21）

15A.6 JIN-N4-04：**2 周窗口到期**才做二元裁决。窗口从 2026-08-20 起算，尚未到期。  
本轮 T3 **2/4**：token **GO**（1730/1406/1782）；p95 **GO**（0.333/0.139/0.160）；RangeLineRecall **FAIL** 0.582/0.850/0.558；holdout rReadMust 均值 0.300 **FAIL**。  
exam-score hop0 1117（剩余 ~883）仍 1 文件。SignedUrl DTO / MeQueryService / SchoolQueryService / ExcelGenerator 仍缺。AliyunOssGateway + PaperAccessService 在。  
**不进 N5、不合 `main`。** 生产 MCP 不读 `JAVA_LSP_ENGINE`。不得发明 TaskSuccess。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-musthit-summary.json`。code `c7b2482`。

## JIN N4 hop0 field-callee cap 2/4（2026-08-21）

分支 `codex/jin-main`。hop0 = containing + 最多 4 个带字段调用的同文件 callee。T3 **2/4**。T1 1127+190 fail 0。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-musthit-summary.json`。

## JIN N4 hop-2 CALLS 2/4（2026-08-21）

分支 `codex/jin-main`。字段全部调用名 + 仅沿 CALLS 的 hop-2。extraNames 仍只含 containing 方法。T3 **2/4**。T1 1124+190 fail 0。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-holdout-hop2-summary.json`。

## JIN N4 holdout 字段调用名 2/4（2026-08-21）

分支 `codex/jin-main`。在 discovery 类型集合上给 hop-0 字段调用挂 member 名，extraNames 仍只含 containing 方法。T3 **2/4**。T1 1122+190 fail 0。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-holdout-summary.json`。

## JIN N4 restore 2/4（2026-08-21）

分支 `codex/jin-main`。planner/closure 收回 discovery。T3 四轴 **2/4**，与 `08965e8` discovery 对齐。T1 1118+190 fail 0。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-restore-summary.json`。

## JIN N4 FAIL neighborhood（2026-08-21）

分支 `codex/jin-main`。method-body callees + hop-2 field types，proving-path member 名写入 toId，hop-ordered extraNames。预算 2000，selected-only。  
T3 四轴 **1/4**。T1 1120+190 fail 0。`storage-signed-url` 无 AliyunOssGateway / SignedUrl DTO；`exam-score-export` 仍 1 文件；`paper-task` 无 MeQueryService。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-nb-summary.json`。

## JIN N4 FAIL discovery（2026-08-21）

分支 `codex/jin-main`。锚点 TYPE+METHOD 起步，SOURCE_ROOT 不扩展，签名类型/实现者 hop-1 attach，hop-0 同类型 sibling method，lexical hop-1 不再等 unresolved。预算 2000，selected-only。  
T3 四轴 **2/4**：token **GO**（−47.7/−47.6/−34.5%）；p95 **GO**（0.324/0.132/0.156）；RangeLineRecall 0.582/0.850/0.558 **FAIL**；holdout rReadMust 均值 0.300 **FAIL**。T1 1118+190 fail 0。未合 `main`。  
`storage-signed-url` 上 AliyunOssGateway 仍覆盖；SignedUrl DTO / MeQueryService / SchoolQueryService 仍缺。  
报告：`docs/phase-jin/jin-phase-n4-20260820.md`。摘要 `jin-n4-t3-disc-summary.json`。

## JIN N3 COMPLETE（2026-08-20）

分支 `codex/jin-main`。commit-tasks 已冻：lishuedu 753 / cipherlink 20 / exam 45。  
第四仓 **`YunaiV/ruoyi-vue-pro`** pin `2bbe79b3`（mall 仅 8 条已换）。holdout 未看。  
`QUERY_CONTEXT_GRAPH` mustHit **1.00 / 1.00 / 0.96**。查询 p95 20–37ms；相对默认链 −35% **UNMEASURED**。未合 `main`。  
报告：`docs/phase-jin/jin-phase-n3-20260820.md`。下一阶段 **N4**。

## JIN N2a COMPLETE（2026-08-20）

分支 `codex/jin-main`。调用/Spring/持久化边已进 JavaIndex worker 图。  
T2 discovery **8/8** 图可达（MeQueryService hop 2，PayAccount hop 1，ClientReleaseMapper hop 2）。  
索引期 cold/增量/digest 相对 N1 未回退。RSS **FAIL 继承 N1**（lishuedu 2319 MiB，门未放宽）。N2b 跳过。未合 `main`。  
报告：`docs/phase-jin/jin-phase-n2a-20260820.md`。下一阶段 **N3-00**。

## JIN N1 FAIL / escalate 0A.4(4b)（2026-08-20）

分支 `codex/jin-main`。知识图 schema/store/snapshot/增量 **已落地**。  
Cold/增量/digest/T1 **GO**；**RSS ≤ 512 MiB FAIL**（lishuedu 进程 RSS 2344 MiB，worker heap 838 MiB）。图本身 6.0 万节点 / gzip 1.7M，不是 RSS 主体。  
失败处置（裁 statement/parameter、增量 digest、解耦 snapshot dirty）已做，不放宽门。  
报告：`docs/phase-jin/jin-phase-n1-20260820.md`。未合 `main`。  
**停在 N1 出口等文档修订授权**（512 MiB 假设错误）。N2a 在同口径 RSS 门下也会 FAIL。

## JIN N0.5 COMPLETE（2026-08-20）

分支 `codex/jin-main`。old = N0 `09772b2`。  
T3：**质量 identity**；`estimatedTokens` P50 三仓 −27.6/−28.3/−27.3%（≥20% GO）；p95Ratio ≤ 1.10。  
实体入口 T2：**30/30** top-3 命中 anchor 文件。未合 `main`。  
报告：`docs/phase-jin/jin-phase-n05-20260820.md`。下一阶段 **N1** knowledge graph。

## JIN N0 COMPLETE（2026-08-20）

分支 `codex/jin-main`。tag `v5r-evidence-baseline` = `aa4098f`。  
N0 T3 vs tag：**质量+token identity**。生产 LOC 39466→37410。未合 `main`。  
报告：`docs/phase-jin/jin-phase-n0-20260820.md`。下一阶段 **N0.5** 紧凑合同。

## V5R live agent-trace（MEASURED，2026-08-20）

对外 OpenAI-compatible host `192.168.10.29:28343`，模型 `openclaw/Qwen3.8-27B-WORK`，窗口 112Ki（114688）。密钥不入库。

报告：`docs/phase-v5r/v5r-live-trace-20260820.md`。摘要：`docs/phase-v5r/v5r-live-trace-20260820-summary.json`。λ：`docs/phase-v5r/v5r-lambda-calibration.json` 现为 **LIVE_TRACE_MEASURED**，`scalarAllowed=false`。

- 六条冻结 holdout 全 `MEASURED`。TaskSuccess **4/6**（路径覆盖，不是模型自述）。无 `FAILED_CONTEXT_CAP`。最大 prompt 52449。
- 合计 184481 tokens / 40 次 `java_impact`，λ_call **4612.025**。n=6 仍禁止 J(π) KEEP/REJECT。
- 24-cell AB/BA 未跑。未合 `main`。第四评价仓仍 UNMEASURED。

## V5R 开关战役（Wave 0 + T + B + P + C，2026-08-20）

测量链：同树 `env-locked-same-tree` + `@2calls` benchmark。台账：`docs/phase-v5r/v5r-flag-campaign-ledger.json`。未合 `main`。

- **T** `FRONTIER_SHADOW=off`：质量 identity **GO**；+21 token 归因 **HOLD（证伪）**。报告 `docs/phase-v5r/v5r-flag-campaign-t-20260820.md`。
- **B** `RELATIONSHIP_BUNDLE=on`：**FAIL**。质量 identity 成立，但 exam p95Ratio **1.349** 超 1.25；RPC sidecar **REJECT**（10632→10662，降幅 −0.28%；P95 还变差）。保持 off。报告 `docs/phase-v5r/v5r-flag-campaign-b-20260820.md`。
- **P** `SPAN_PACKING=on`：identity **GO**，压字节 **HOLD**（readPlanBytes/ranges 不变）。保持 off。报告 `docs/phase-v5r/v5r-flag-campaign-p-20260820.md`。
- **C** `@2calls` fifo continue：**FAIL**。续读 420/450 attempt 真打了，holdout rReadMust **不变**，pRead 下降。fifo 没点到缺口 golden。不叠刀。报告 `docs/phase-v5r/v5r-flag-campaign-c-20260820.md`。
- 战役 S 跳过。所有新开关 **保持默认关**。

## V5R 三仓 cold 矩阵（2026-08-20）

正式入口：`scripts/run-three-repo-cold-matrix.mjs --runs 5`，AB/BA/AB，cold-nolsp。  
报告：`docs/phase-v5r/v5r-three-repo-cold-20260820.md`。收口：`docs/phase-v5r/v5r-three-repo-closeout.json`。摘要副本：`docs/phase-v5r/v5r-three-repo-cold-20260820-summary.json`（SHA-256 `db030687…`）。

**结论：矩阵已跑完。质量门 FAIL（`passed=false`，独立 verifier exit 1）。未合 `main`。不得声称 TaskSuccess。**

- 分母 Sprint0' `63a80a2`；候选 `bcf547c`（patch 只有白名单实验脚本，无 `src/`）。load 9.35 < 20，必须跑；18 cells 齐。
- 相对 Sprint0'：三仓 gate 全 FAIL。绝对 1.0（rReadMust / holdout rReadMust / RangeLineRecall）仍不是 1.0，与 V4-final residual 相同。
- 相对 V4-final：recall / pRead / rReadMust / range / holdout / gate **逐位相同**（first-plan identity 成立）。new token P50 三仓都 **+21**（search payload +85B，readPlanBytes 不变）。
- 18 个 raw cell 不入库。λ 现为 `LIVE_TRACE_MEASURED`（2026-08-20 live-trace），`scalarAllowed` 仍 false。

## V5R §15 验证面板（2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15。  
面板：`docs/phase-v5r/v5r-section15-verification-panel.json`。HEAD `09ed01b`。隔离定向 **53/53 fail 0**。

**结论：Phase 0–6 COMPLETE；Phase 7 live-trace 已于 2026-08-20 `MEASURED`，其余格子仍阻塞。未合 `main`。** 第四评价仓未冻结。

## V5R Phase 7（BLOCKED，live-trace 已于 2026-08-20 MEASURED）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15 Phase 7。  
收口：`docs/phase-v5r/v5r-phase7-closeout.json`。合 main 计划：`docs/phase-v5r/v5r-main-merge-plan.json`。隔离全量 1068+170 fail 0；executableTree `6427540e`。

- **live trace**：2026-08-20 已 `--authorize-external --execute-live`。六条 holdout **`MEASURED`**，TaskSuccess 4/6。无 key 时仍 exit 3 / `UNMEASURED`。
- **第四仓**：未声明评价用第四 golden。`golden/` 里的 fixture jsonl 不算第四仓。
- **leave-one-repo-out**：三折协议已落地（`scripts/leave-one-repo-out.mjs`），**不调参**；矩阵本身 `UNMEASURED`。
- **release attestation**：`mergeToMain: false`。`GATE_PROFILES` pr/nightly/release 仍不同。stdio/HTTP smoke 已有；Codex CLI/Desktop live **UNMEASURED**。
- **未合 main**。λ 为 `LIVE_TRACE_MEASURED`，`scalarAllowed=false`。

解阻合 main：冻结真正的第四评价仓；leave-one-repo-out 矩阵；标量 λ 另行裁决。

## V5R Phase 6（COMPLETE，2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15 Phase 6 / §9.2–9.3。  
收口：`docs/phase-v5r/v5r-phase6-closeout.json`。隔离全量 1068+164 fail 0；executableTree `3cf2f882`。

- **默认 `JAVA_LSP_SPAN_PACKING=off`**：first-plan 文件与 range identity 不变。
- **`on`/`shadow`**：选择完成后再 pack。重叠/相邻的 context 并进 primary；**不相邻的两个方法保持多 span**，不合成整文件。预算先丢 context、不饿死最后一段 method。extreme method 按 mode 字节帽裁切。
- **mode profiles**：minimal 4 span / 4KiB；balanced·precision 8 / 8KiB；recall 8 / 16KiB。
- packed planned-source ≤ overlap 未合并；< whole-file；tail CVaR 不恶化。λ 仍 `CALIBRATED_OFFLINE`。未烧三仓。没有 type-header +1。

下一 Phase：**Phase 7 真实 Agent 校准 / 第四仓 / release**。未获外部授权不得声称 TaskSuccess。不得合 main。

## V5R Phase 5（COMPLETE，2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15 Phase 5 / §8。  
收口：`docs/phase-v5r/v5r-phase5-closeout.json`。隔离全量 1061+164 fail 0；executableTree `7340a718`。

- **默认 `action=analyze` 仍是 V6**，first-plan identity 不变。`retrieval.enabled=true` 才建 session 并返回 **V7**（`kind` + `retrieval`）。
- **`action=continue`**：只消费 session 里已物化的 in-pool 单元（BUDGET_EVICTED / implementer / second-hop / collaborator / in-pool cross-module）。不发明 discovery-gap 文件，不开放 `QUERY_CALLERS`。
- **session**：application 持有、内存 LRU+TTL（128 / 180s）、opaque 128-bit id、complete-only 写入、generation/build stale fail-closed、同 id 幂等、并发串行。stdio 随进程灭；HTTP 随 daemon 灭。
- **rReadMust@2calls**：池内 holdout 可抬升；`MeQueryService` 仍 uncovered。λ 仍 `CALIBRATED_OFFLINE`。未烧三仓。

下一 Phase：**Phase 6 span packing**。不得合 main。

## V5R Phase 4（COMPLETE，2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15 Phase 4 / §9.5。  
收口：`docs/phase-v5r/v5r-phase4-closeout.json`。隔离全量 1052+164 fail 0；executableTree `2c35ab1c`。holdout oracle：`docs/phase-v5r/v5r-phase4-holdout-oracle.json`。

- **frontier shadow**：`buildFrontier` 在 first plan 之后从已物化、未入选的 ReadUnit 生成。默认 `JAVA_LSP_FRONTIER_SHADOW=shadow`，只挂 `metrics.readPlan.frontierShadow`（diagnostic）。不改 `version:6`，不暴露 `expectedGain` / 公开 `retrieval`。
- **多样性**：relation/file/family cap（2/1/2）+ items/bytes 双上限（8 / 8KiB）。不是 dropped top-K 复制。
- **oracle**：六条 holdout 的 first-plan mustHit 均值 **0.525 → 池内 oracle 0.825**。5/6 至少有一个已在首轮候选池、被预算挤出的 golden。`paper-task` 的 `MeQueryService` 以及 exam-data 持久化类型仍是 discovery gap。
- **continuation 决策：GO**（仅针对池内 BUDGET_EVICTED / implementer）。**本 Phase 未实施** `action=continue` / session。反向 caller 只写了设计：`docs/phase-v5r/v5r-reverse-query-design.md`，未开放 `QUERY_CALLERS`。
- λ 仍 `CALIBRATED_OFFLINE`。未烧三仓（first plan identity 未变）。

下一 Phase：**Phase 5 Continuation session**（仅因本 Phase GO）。不得把 discovery-gap 文件算成 frontier 命中。未过 Phase 5 退出条件不得合 main。

## V5R Phase 3（COMPLETE，2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15 Phase 3 / §6.2。  
收口：`docs/phase-v5r/v5r-phase3-closeout.json`。隔离全量 1047+164 fail 0；executableTree `ef2273d5`。λ：`docs/phase-v5r/v5r-lambda-calibration.json` = `CALIBRATED_OFFLINE`。

- **RetrievalCostVectorV1**：由已收敛的 `ImpactCostV6` 推导。`estimatedTokens = ceil((wireBytes + plannedSourceBytes) / 4)`，与 V6 公式同一实现（`reconstructEstimatedTokens`）。proxy 只报告、不累加进 `estimatedTokens`。向量不写入 MCP `cost` 对象（避免 JSON 自引用打乱 `resultBytes`）。
- **λ**：本会话无外部授权/key，未跑 live trace，也没有带 TaskSuccess 的录制会话。`scalarAllowed: false`，`taskSuccess: UNMEASURED`。Phase 4–6 只能逐字段比较，禁止合成 `J(π)`。
- **repair / DEFAULT vs ORACLE / scorecard**：离线字节策略与 required-groups 覆盖；tuning/holdout 分列；无公开 planner 分。
- **Golden V2**：`requiredGroups` 可选；旧 `mustHit` 仍有效。未改 jsonl，未烧三仓（排名/readPlan 未变）。未做 continuation。

下一 Phase：**Phase 4 Retrieval frontier shadow**。未过 Phase 4 oracle coverage 不得做 continuation / 合 main。

## V5R Phase 2（COMPLETE，2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15 Phase 2。  
收口：`docs/phase-v5r/v5r-phase2-closeout.json`。隔离全量 1038+164 fail 0；executableTree `3110213e`。

- **ReadUnit**：`src/agent-router/retrieval/`。CandidateWindow 经 `buildReadUnits` 再 round-trip 回 V6 selector，首呼选择 identity 保持。
- **context closure**：对已有 indexed ranges 分类（method/xml-statement = primary，type/resultMap = context），不新增 golden 特判 span。
- **统一 utility**：`selectionUtility` 同时服务 first-call 与后续 frontier；不暴露到公开 MCP。
- **hard caps**：files/bytes/spans/spansPerFile；溢出只记 gap，不另起选择刀。
- **`read-plan-budget.ts`**：仍只服务 `rank-candidates` 的 candidate-tail coverage，不是 V6 byte-aware first-call selector。
- **shadow**：`JAVA_LSP_READUNIT_PLANNER=shadow`。未做 continuation / session / V7。未烧三仓（选择 identity 未变）。

下一 Phase：**Phase 3 成本向量与离线策略模拟**。禁止跳到 continuation / 合 main。

## V5R Phase 1（COMPLETE，2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15 Phase 1。  
收口：`docs/phase-v5r/v5r-phase1-closeout.json`。隔离全量 1032+164 fail 0；executableTree `6035eda7`。

- **QUERY_RELATIONSHIP_BUNDLE**：worker command + router facade + request memo + generation stale → `DEGRADED`。默认 `JAVA_LSP_RELATIONSHIP_BUNDLE=off` 走旧 `factsForFiles` 路径；`shadow` 旁路观察文件身份；`on` 用 bundle 填充 facts 并跳过已打包的 `resolvedCallees`。旧路径保留至 release soak。
- **RPC telemetry**：`JavaIndexRpcTelemetryCollector.relationshipSummary()`；diagnostic `javaIndex.relationshipRpc`。
- **provider 拆分第一步**：`relationship-query-plan.ts` / `relationship-bundle-client.ts` / `relationship-parity.ts`。projector/closure 仍在 `relationship-provider.ts`。
- **V4-05 dual worker**：两轮 `run-storm-gate.mjs`（flag=1，`--iterations 1`）均 `FAIL`。staleCount=0，但 P95/quiet 为 29.0/5.28/7.92 与 37.5/5.92/3.94（门槛 1.10）。sweep 线程已删除。单 query worker 仍是 store 唯一写者。证据 `docs/phase-v5r/v5r-dual-worker-decision.json`。ADR-01 标 `FAILED`。

下一 Phase：**Phase 2 ReadUnit 与统一 planner**。禁止跳到 continuation / 合 main。

## V5R Phase 0（COMPLETE，2026-08-19）

真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v5r-comprehensive-assessment-refactoring-plan-2026-08-19.md` §15。  
收口：`docs/phase-v5r/v5r-phase0-closeout.json`。V4 最终矩阵 executableTree `a56af2f9`；Phase 0 工作树在 close-out 里。PR/nightly/release argv 已分层。`PUBLIC_JAVA_TOOLS` 为五工具真源。`estimatedTokens` 仍是 `ceil((resultBytes+readBytes)/4)`，另报 `wireTokensProxy` / `plannedSourceTokensProxy`。

### 遗留欠账二值决定（2026-08-19）

- **V4-09 JDT dataDir fingerprint**：`CLOSED`。实验已完成、未加失效层（`docs/phase-v4/v4-09-jdt-workspace-fingerprint.md`）。除非出现 stale-workspace 实证，不再加 fingerprint 层。
- **V4-11 idle prewarm**：`DEFERRED`。telemetry 已落地（`IdlePrewarmTracker`，`JAVA_LSP_IDLE_PREWARM` 默认关）。正式 first-touch P95/RSS 试验 `UNMEASURED`。真实 JDT 实验主机门见 `docs/phase-v4/three-repo-host-load-policy.md`「真实 JDT 实验」：可用内存 ≥ 4 GiB **且** 1 分钟 load < 逻辑核数×1.5。窗口出现时由后续会话补跑；本计划 Phase 0 不阻塞。不得默认开启。
- **V4-05 dual worker**：Phase 1 已 `FAIL`（2026-08-19）。两轮 storm flag=1 未过 P95/quiet ≤1.10；sweep 线程已删除。见 `docs/phase-v5r/v5r-dual-worker-decision.json`。

## 当前任务

**V4-01/02/03/04 已完成；V4-05 默认关已落地；V4-06 已诚实收口（2026-08-19）**：`CLOSED_WITH_RESIDUAL_STRUCTURAL_MISSES`，不是 RangeLineRecall/rReadMust=1.0。KEEP：Primary-keep、`positionsFromFacts`（paper-task 0.4→0.8）、helper continuation + called-port IMPLEMENTS 2.45（lishuedu/cipherlink file recall 升，rReadMust 未回归）。REJECT：IMPLEMENTS 2.65。禁止为三仓凑 1.0。残差见 `docs/phase-v4/v4-06-range-holdout-progress-2026-08-19.md`。真源 `docs/deep/codex-java-lsp-mcp-java-intelligence-v4-consolidation-plan-2026-08-17.md`。**三仓 load 政策**：1 分钟 load < 20 必须执行。V4-05 storm 已两轮 FAIL，sweep 线程已删。隔离约束不变。

（以下 V3.2 各 Sprint 记录保留供追溯，其结论与"不要再踩的坑"在 V4 阶段继续有效，除非 V4 计划文档显式解除——V4-05 曾以 ADR 引入第二 worker **线程**；V5R Phase 1 两轮 storm FAIL 后该线程已删除，query worker 再次独自承担后台 chunk。）

当前分支是 `codex/java-intelligence-v3`（最新 commit 见 `git log --oneline -5`）。生产 `src/`、三仓/战役/live-trace 报告均已入库。`artifacts/v3-*`、`artifacts/model-eval/`、`graphify-out/`、`.workflow/`、`.task30-debug.mjs` 是本地 dumps，已 gitignore，不入库。

用户的标准授权（持续有效，无需每次重新确认）：
- 本仓库上的 `git commit`、`git push origin codex/java-intelligence-v3` 不需要逐次请求授权。
- 设计分叉/实现取舍不需要问用户，直接调用 advisor 并按其最终建议执行；只有 destructive/不可逆操作、PR/发布/deploy 范围、或 advisor 自己标注为"需要用户判断"的事项才升级给用户。
- 外部 Agent eval 与 destructive 操作的边界写在本文件；不引用个人本机 memory 路径。

**唯一仍然需要用户明确授权、不可绕过的边界**：development-plan V3.2-07b（外部 Agent eval）——任何会产生外部模型调用成本或把代码发送给外部 provider 的操作，必须由用户显式授权；未获授权时相关任务状态必须是 `BLOCKED_EXTERNAL`，不得编造/估算数字顶替。Sprint4 的 V3.2-21 若涉及"实际 Agent quality 结论"，同样受此约束。

## Sprint3 最终状态（已关闭，供追溯）

- V3.2-16（progressive-index benchmark）：完成。
- V3.2-17（前台 anchor closure 优先级）：实现完成，且修复了一个真实的 `resourceCoverage`/snapshot-durability 竞态（`java-index-worker.ts`，三次迭代定位到正确修复：`processBackgroundChunk` 的 `finalChunk` 兜底重扫）。但其自身 `storm foreground P95/quiet ≤1.10` 验收线**未达标**（实测 7.72x-13.24x），已正式记录为 exit decision `DO_NOT_IMPLEMENT_SINGLE_WORKER_ARCHITECTURAL_CONTENTION`：拆解为一次性 ~671ms 冷启动税（次要）+ 单线程 worker 上后台 sweep 与前台请求的持续资源争用（主要、架构性，需要第二 worker 线程或 ADR 级并发模型决策才能消除，明确超出 Sprint3 范围）。**这不是待办事项，是已关闭的架构性结论**——除非有新证据或产品优先级变化，不要在 Sprint4 里顺手重新触碰 `beginBackgroundSweep`/`processBackgroundChunk` 试图修它。
- V3.2-18（后台 root 优先级）：确认已实现且有测试（`manifest.ts` 的 `prioritizeJavaFilesForBackgroundSweep`）。
- V3.2-19（snapshot/seed telemetry）：本轮补齐了此前缺失的无条件 telemetry 半边；门控式 metadata directory index 半边未触发入场条件，未实施（正确行为）。
- V3.2-20（cooperative cancel 研究门）：已用现有证据关闭，入场条件不满足，不实施。

详细报告：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-sprint3-storm-progressive-cold-matrix-report-2026-08-15.md`。
记忆索引：`v32-sprint3-status.md`。

## Sprint4 范围（development-plan 第 630-680 行）

- **V3.2-21：已用 exit decision 关闭，不实施（`DO_NOT_IMPLEMENT`）。** 写过一版 admission-gate 草稿（`session.status().started && progress.active===0 && !budget.expired()`），未落地就 revert 了——`progress.active===0` 是瞬时读数，`waitForProgressIdle()`（`jdtls-session.ts:2054`）自己已经证明瞬时 idle 不可信，需要 sustained-idle wait 才可靠，而这恰是 V3.2-21 原文明确禁止的（"修改 admission，而不是延长 timeout"）。在设计更好的信号之前，先用真实 jdtls 在当前 tree（`3030975`）上重跑了 Task35 2026-08-07/08 的 `cold-nolsp` vs `warm-auto` quality 对比（3 仓 × 5 runs × 全量 golden scenarios），**结果与 Task35 原始结论完全一致**：recall/pRead/rReadMust/rTaskBlocking 三仓全部 bit-identical，P95 却暴涨 7-15.6 倍。`auto` 现有的 live JDT 调用对当前三仓 golden 集合没有任何可测量的质量收益，只有真实延迟成本——这本身就是 line 640 验收线的完整答案（quality 非劣是平凡成立的，因为两边本来就相同；要做到 P95 不再顶 cap 又不引入质量退化，唯一路径是不打这些没有收益的调用，而不是把"何时打"变聪明）。**这不是待办事项，是已关闭的结论**，除非未来某个新场景证明 live semantic 证据真的改变了某个 golden 指标，否则不要重新设计 admission gate。详见 `docs/phase-v3/phase5-semantic-first-touch-decision.md`（2026-08-15 追加小节）+ `artifacts/v3-final/sprint4-v321-admission-recheck-20260815/`。
- **V3.2-22：已用 exit decision 关闭，不实施（`CONSERVATIVE_ALTERNATIVE_ALREADY_SATISFIED`）。** 逐路径核查了写入门（`semantic-edge-store.ts` 的 `completion`/`confidence` 硬编码字面量，仅供 `load()`/`putComplete()` 内部拒绝非完整写入用）、读取路径（`candidate-collectors.ts:186-209` 只读 `relation`/`targetFile`/`targetRanges`，从不读 `completion`/`confidence`）、证据层（`semantic-provider.ts:84-85` 的 `confidence: 0.9`/`completeness: "COMPLETE"` 是 provider 自己的固定字面量，与底层 edge 字段无关）、准入路径（`index.ts` 不读 `completeness`、不据此跳过或精简 live JDT，两阶段无条件顺序执行）——四处均确认：当前实现已经就是计划自己定义的"保守替代"（只提供正向候选和置信度，不承诺 operation completeness，也不据此跳过 live JDT）。"推荐实现"分支（新增 `SemanticOperationCoverageRecord`）的入场条件"telemetry 证明值得减少 live verify"不成立——`impact-metrics.ts` 只有逐请求 `verifyUsed`/`verifySkipped` 布尔量，没有支撑这个判断所需的聚合 telemetry。**这不是待办事项，是已关闭的结论**，不要新增 coverage-record 机制。详见 `docs/deep/codex-java-lsp-mcp-java-intelligence-v3-sprint4-jdt-semantic-value-report-2026-08-16.md` §3。遗留悬空依赖（不代为处理，留给下一步）：V3.2-22 原依赖行写的是"依赖 V3.2-08、V3.2-21"，V3.2-21 已关闭，这条依赖已悬空；V3.2-25 的 5 项默认化条件书写时假设 `auto` 仍会发起 live JDT 调用，这个前提在 V3.2-21 关闭后也不再成立，处理 V3.2-25 时需要先重新评估这些条件本身是否还有意义。
- **V3.2-23：已关闭为 `DEFERRED_PENDING_WORKLOAD_TELEMETRY`（既不是 PASS/FAIL，也不是 DO_NOT_IMPLEMENT）。** 延迟收益是真实且巨大的——直接引用 Task35 已有证据（`artifacts/v3-phase5/task35-first-touch-20260807/`）：cipherlink 上 `fresh`（全新 session）totalMs 32296-42268ms，对比"已预热完成的 session 收到第一个真实请求"的代理值（`reused` 第 2/3 次请求）177-182ms，改善 >99.5%，超过计划 30% 门槛约 300 倍，不需要新测量确认方向。受益面也不是空集：`server.ts` 的 `java_symbol`（hover/definition/implementation/references）与 `java_diagnostics` 两个工具硬编码 `semanticPolicy: "required"` + `requireLspEnabled: true`，任何 Agent 调用它们（不经过 `java_impact` 默认 `auto` 的 opt-in 参数）就无条件走 live JDT，因此 V3.2-21 关闭 `auto` 不等于 prewarm 受益面为空。**但试验门的资源安全半边（peak RSS/CPU 增幅 ≤10%，对应计划"禁止"条款——不能只把成本提前发生再包装成提速）结构性无法测量**：这条禁令保护的是"预热了但从未被查询"的浪费场景，而任何现有工具（已存在的 `scripts/sample-java-runtime-resources.mjs` V3.2-05 进程树采样器，或本轮新写但未提交的 `scripts/run-idle-prewarm-experiment.mjs`）都只能测量"确实发起了请求"路径的资源开销，回答不了"未使用的预热"这个问题——那是会话级/仓库级的预热命中率 telemetry，`impact-metrics.ts` 目前不存在这类字段，与 V3.2-22 发现的 telemetry 缺口同类。**这不是待办事项，是已关闭的结论**：在没有命中率 telemetry 之前实现并默认开启预热功能，正是计划"禁止"条款要阻止的交付方式；构建这类 telemetry 是一项独立、有实质 LOC 成本的功能决策，不应该在"只是测量"的实验步骤里顺手决定。详见 `docs/deep/codex-java-lsp-mcp-java-intelligence-v3-sprint4-jdt-semantic-value-report-2026-08-16.md` §4。`scripts/run-idle-prewarm-experiment.mjs` 保留在工作区（未提交，调试中留下 3 个与本结论无关的 harness 修复：`JDTLS_BIN` 透传缺失、嵌套 isolation broker 命令要求 `node` 起手而非 `sh`、`withFreshWorkspace` 清理阶段的 Gradle daemon 竞态），不建议继续调试或提交它——它回答的是延迟问题（已经用现有证据回答了），不是真正卡住 V3.2-23 的资源安全问题。
- **V3.2-24：已用 exit decision 关闭，不实施（`KEEP_EXPLICIT`）。** 四个变量（import concurrency / workspace reuse / project import readiness / document prepare）里三个已经是 `semantic-first-touch.ts` 现成的 CLI 开关（`--prepare none|progress-idle|document-symbol`、`--workspace-state fresh|reused`），2026-08-09 Task36 remediation 已经跑过三仓×10 runs×3 种 prepare 模式；重新按仓取每仓最快 prepare 分支的 P95（不是不加区分取 `none`——lishuedu 的 `none` 只有 8/10 完成，censored 幸存者上的数字会虚高）：cipherlink 25431ms、exam-parent-v3 48762ms、lishuedu 53549ms，三仓在当前机器默认 `importConcurrency=2` 下全部远超计划 20s 门槛（超出 27%/144%/168%）。退出条件是析取式（P95>20s 或资源恶化 → `KEEP_EXPLICIT`），举证责任在"证明能达标"一侧，现状数据已经独立满足，不需要等第四个变量测完就能关闭。**第四个变量（import concurrency，`JAVA_LSP_IMPORT_CONCURRENCY` env var，`jdtls-session.ts:1786`）本轮尝试复测但因主机噪声未能完成**：冒烟测试时 1 分钟 load average ≈30（本机 10 核，3.0x），Time Machine 正在跑全量备份，concurrency=2 与 concurrency=8 两臂都在 60s 超时后 0 结果收场——这是"主机测不出有效数据"的信号，不是"两个设置都变慢了"的信号，两次超时已丢弃、不计入任何结论。**曾经尝试过一个"`ensureStartedMs` 占比小所以 import concurrency 翻不了盘"的阶段分解论证，经复核确认是错的、已撤回**：`ensureStartedMs` 对应的是 LSP `initialize` 握手往返，不是 project import；每条样本的 `progress.projectImportMs` 都是 `UNMEASURED`，说明 project import 实际发生在 `requestMs`（唯一大头阶段）内部的按需 build 里，而这正是 `maxConcurrentBuilds`/import concurrency 影响的阶段——所以这一维度是**未测、不是已否定**，但因为退出条件已经独立满足，不构成阻塞。已给复测脚本（`scripts/run-v324-import-concurrency-experiment.mjs`，本轮新增未提交，两层 isolation chain 接线已验证——冒烟测试确实拉起了真实 jdtls 1.56.0 并透传了 concurrency env var）加了主机静默度前置检查（1 分钟 load/核数 >0.7 拒绝启动），在主机安静时重跑是一条命令的事。隔离验收三条核查（读源码+既有测试，未新增代码）：(a)(b) sibling worktree 的 `dataDir`（`repo-layout.ts:65-67`，`sha1(repoRoot)`）与 `JDT_WORKTREE` lease（`cross-process-lease.ts:334-337`，键是 `repoHash` 不是共享的 `familyHash`）按构造互相独立，已用 `worktree-identity.test.ts:28-37` 核实；(c) **版本/fingerprint 不匹配拒绝复用未实现，是一个真实存在于当前生产代码里的缺口**——`dataDir` 的 key 只含 `repoRoot`，唯一会删磁盘 workspace 的路径是需要调用方显式传参的 `restart(clearCache=true)`（`jdtls-session.ts:843-846`），私有的 `clearCache()`（`jdtls-session.ts:2000-2007`）只清内存缓存、不碰磁盘，且只在当前存活会话亲眼看到文件变更时触发，不覆盖会话停止期间的 JDTLS 升级或依赖变更。**这不在本轮修复**：修复前需要先回答一个未验证的问题——JDT 自身的 M2E/Buildship 项目导入插件是否已经对外部 `pom.xml`/`build.gradle` 变更有自己的过期检测，在不知道这一点之前写新的 fingerprint 失效层有构建冗余逻辑、白白丢弃可复用 warm workspace 的风险；验证这一点需要另一次真实 JDT 实验，跟本轮一样受当前主机状态限制。详见 `docs/deep/codex-java-lsp-mcp-java-intelligence-v3-sprint4-jdt-semantic-value-report-2026-08-16.md` §5。
- **V3.2-25：已用 exit decision 关闭，不实施（`KEEP_EXPLICIT`）。Sprint4 最后一项，收尾无需新实验。** 5 项默认化条件是合取，任何一项决定性不成立就足以关闭。Sprint4 已产生的证据里 2 项决定性不成立：(1) P95≤800ms——三仓 `warm-auto` elapsedMsP95 是 1571.0/1611.3/1571.7ms，三个数字彼此相差<40ms 且都落在 1500ms 附近不是巧合：`benchmark-agent-impact.ts:487-489` 的 `effectiveSemanticTimeoutMs()` 给 `warm-auto` 硬编码的内部超时就是 1500ms，这是**被截断的下界**，不是真实完整延迟，且这个下界本身已经近 2 倍于 800ms 门槛；`fresh` 冷启动 P95 是 25431-53549ms，是门槛 32-67 倍。(2) 0 partial/timeout——对 Task36 `first-touch-final` 全量 242 次 attempts 现场重新统计，2 次是真实 `PARTIAL_TIMEOUT`（`lishuedu-fresh-none-references`）。**条件 3（R_must=1）最初判定不成立，advisor 复核后撤回**：引用的 `rReadMust`=0.88-0.91 数字来自当前（Task32 后）golden-scenario 集合，`phase5-semantic-first-touch-decision.md` caveat #6 明确说这与 Iteration A 记录的历史 `R_read_must=1.0000`（旧 16 场景集合）不可比——用这个数字判定条件 3 不成立，会是条件 1 曾经犯过、已撤回的同一类错误（拿错误口径的指标下结论），所以条件 3 改记为"证据不可比、未独立核实"，不用作决定性证据。条件 4（Agent task success 非劣）依赖 V3.2-07b 外部 Agent 调用授权，本轮未获得，状态 `BLOCKED_EXTERNAL`，但条件 1-2 已经让合取不可能成立，不需要为了走完形式去申请外部调用授权；条件 5（资源受控）同理不再单独核查。**这基本是 V3.2-21（零质量收益+`auto` 自身 1.5s 内部超时已近 2 倍 800ms 门槛）与 V3.2-24（fresh P95 远超 20s）两项已关闭结论的直接推论，不是需要独立调查的新问题**。详见 `docs/deep/codex-java-lsp-mcp-java-intelligence-v3-sprint4-jdt-semantic-value-report-2026-08-16.md` §6。

**Sprint4 完成门**（development-plan 原文未单列一行，按 §5.2 全局硬门 + 上述 5 条默认化硬门执行）：五项全部关闭，最终策略维持 `KEEP_EXPLICIT`，`semantic` 未进入默认路径，未新增任何自动触发 live JDT 的代码。

## Sprint5 进展（development-plan 第 685-725 行）

- **V3.2-26：字节半场已关闭为 `CLOSED_VIA_V3.2-02_EXIT_CONDITION`（不是"达到 15% 目标"）。** `artifacts/v3-baseline/` 下的 Sprint0 baseline 全是 0 字节文件（`ls -la` 核实），"相对 Sprint0 baseline 降 15%" 这个数值门本身不可测。但依赖项 V3.2-02 自己的退出条件（`standardToDiagnosticBytesRatio<0.5` → 转向真实 Agent trace）早已成立：cipherlink 10 场景 P50 ratio 是 0.338（本轮改动前）/0.329（改动后），远低于 0.5。本轮顺手修了一个真实的一致性 bug——`applyVerbosity()`（`format.ts`）给 `files[]` 剥离了 `reasons`/`verifiedBy`/`scoreBreakdown` 三个诊断专用字段，却漏了 `readPlan[].ranges[].reason` 同类字段，导致它在 standard/compact 也原样出现；改成剥离后 standard bytes P50 从 11432 降到 11124（**-2.69%**，cipherlink 独测，机制仓库无关但未在另外两仓复测）。**连带修复**了 `attribution-v3.ts` 的 `candidateReadPlanFingerprint()`——它把 `payload.readPlan` 整体纳入身份哈希，剥离 `ranges[].reason` 后触发了它自己的"projection changed candidate/read-plan identity"断言（这个断言设计意图是只保护身份不保护辅助字段，`files` 侧早就手动排除了对应字段，`readPlan` 侧漏做了同样的事）——这不是我引入的新 bug，是既有断言正确抓住了一个此前从未被裁剪过的字段路径。**输出契约变化**：`readPlan[].ranges[].reason` 不再出现在默认 `standard` 响应里；已检索确认没有任何现存文档/schema/agent prompt 把这个字段列为承诺契约，不需要改文档。Agent 使用质量半场移交 V3.2-30。详见 `docs/deep/codex-java-lsp-mcp-java-intelligence-v3-sprint5-token-value-realization-progress-2026-08-16.md` §2。
- **V3.2-27：已关闭为 `MODIFY_REJECTED_STRUCTURAL`，本轮不实现代码。** 首次测得 baseline：三仓 RangeLineRecall 0.5525-0.85（目标 1.0），真实未关闭的实现缺口。15 个 miss 场景归纳出 5 类根因（top-of-file-fallback / near-miss-boundary / budget-truncation / second-position-not-queried / out-of-scope），本轮只深入分析了最大类 top-of-file-fallback（8 例，根因是 `candidateFromFacts()` 硬编码 `positions:[{line:1,column:1}]`，命中 `fallbackReadRange()` 得到 lines 1-23）。**一个"用 type 声明行代替 (1,1)"的低成本候选修法被结构性证伪**：任何因这个 bug miss 的场景，golden 起点按定义必然 >~23 行（否则早已是命中）；`typeHeaderRange()` 的落点仍在 1-40 行区间，和实际 miss 起点（50/77/102/136/162/238/961）完全不重叠——本轮从 golden 数据逐一核实：真正落在 [1,23] 内的几个 range 全部已经是命中，不在 miss 列表里，证明这条修法帮不到任何一个真实 miss。真正需要的修法是给候选线程具体方法级位置（不是类型声明行），这需要在 `collectTypeGraphCandidates`/`collectImportGraphCandidates` 两个 `hydrate:false` 调用点强制 `hydrate:true`，成本未量化，留作后续独立评估项。**不要试图用 type-header 变体去凑合**——已证明结构性帮不上忙，不是"收益不够大"。详见同上报告 §3。
- **V3.2-28：`NO_VIABLE_ZERO_COST_RULE_FOUND`，唯一测过的候选规则已回滚，未落地任何代码。** 依赖检查：`read-plan-budget.ts` 的文件级配额和 V3.2-27 的 AST range 精度是独立层，V3.2-27 零代码落地不构成硬阻塞；holdout/tuning 分离评分基础设施（`golden/*.scenarios.jsonl` 的 `evaluationSplit` + `scripts/run-three-repo-cold-matrix.mjs`/`verify-three-repo-cold-matrix.mjs` 的 `holdoutRReadMust` 等独立 gate）已经存在，验收条件可评估。唯一测过的候选规则：把 `SPRING_CALL_PATH` 从 `read-plan-budget.ts:24` 的 `FRAMEWORK_VERIFIED_REASONS`（"verified" 配额）移出降级为 "structural"——动机是 V3.2-29 测出的 Spring `NDCG_read@6` 三仓一致为负；这个改动删一个 Set 成员、同步精简一句注释，**同行数，零 LOC 成本**。用正式三仓 AB/BA/AB 矩阵（`run-three-repo-cold-matrix.mjs`，baseline=`869b353` vs candidate=改动后 worktree，`--runs 5` 强制）测量：lishuedu、exam-parent-v3 的 tuning/holdout 四项指标（recall/pRead/rReadMust/rTaskBlocking）**逐位精确相等**（零影响）；cipherlink tuning 切分 recall 从 0.8322 掉到 0.8144（**-1.7%，唯一非零的一格，且是负的**），holdout 不变。这套正式工具不采集 `NDCG_read@6`，驱动改动的原始信号在这里无法验证；净结果比"中性"更差（一处真实回归、其余全零），判定 REJECT，已 `git checkout --` 还原两个文件（`read-plan-budget.ts`、`read-plan-budget.test.ts`），LOC 不受影响。过程中第一次矩阵运行在候选测试套件阶段因主机负载（`uptime` 1 分钟 37.82，10 核）导致 `task36-multiprocess-smoke.test.mjs` 一个真实子进程 sweep-lease 超时用例假性失败（该测试与改动无代码路径关联，隔离环境单独重跑 3.7 秒内干净通过），重跑后 100/100 全绿。**顺带发现**：`gate.holdoutRReadMust` 三仓全部 `FALSE`（holdout rReadMust 0.5/0.55/0.4，远低于验收要求的 1.0）且 old/new 完全一致——不是本轮改动造成的，是当前代码树在这套正式口径下本来就没通过 holdout 绝对门槛，和 V3.2-27 已记录的 RangeLineRecall 缺口是同一类"结构性未闭合"证据的另一角度，非本轮要修的问题。**更大范围的 "anchor profile/taskBlocking/sourceSet/文件大小" budget 调整需要真正新增生产代码**，当前 LOC 已超编（33,230/33,219，V3.2-29 的一次性突破尚未偿还），不能像 V3.2-29 那样默认继续往上加，需要用户先明确是否愿意再授权一次突破。详见报告 §4.1-4.5。
- **V3.2-28 第 2 轮（2026-08-17）：用户明确"授权一次突破"后测了一条真正新增代码的规则，正式矩阵证伪，已回滚，未落地任何代码。** 先用第 1 轮已有的正式矩阵原始数据核对：三仓全部 6 个 holdout 场景在 balanced 模式下都在文件数上限（6）打满、字节预算只用 30%-69%——文件数是真正 binding 的约束，选对了杠杆。改动：把 `buildReadPlan()`（`read-plan.ts`）里既有的"anchor 数量超预算时放宽 `selectionBudget.maxFiles`"机制，扩大到"anchor ∪ `protectedPaths`"（已在流转的 JDT 精确结构证据集合），且只在调用方未显式传 `readPlanMaxItems` 时生效（显式预算是硬约束，不能被悄悄突破——第一版实现忘了这条边界，导致 3 个刻意设小预算验证约束的既有测试多选出一个文件，是真实 bug 不是过期断言，已修正）。净改动 `read-plan.ts` +10 行。正式三仓矩阵（baseline=`4eedc6b`）结果：三仓 token 成本全部上升（+181~+486 P50），`pRead` 在三仓 tuning、两仓 holdout 全部下降；唯一真实正向信号是 lishuedu holdout `rTaskBlocking` +0.154，但同仓同切分 `pRead` 同时 -0.071，cipherlink tuning recall/pRead 双双真实回归（-0.047/-0.133），exam-parent-v3 holdout pRead 回归 -0.183——净效果是多花 token 换广泛精度下降，只在一仓一项指标上换到一点收益，不划算，判定 REJECT，`git checkout --` 还原，LOC 复核精确回到 33,230。**V3.2-28 到此两轮候选规则均告负，未再尝试第三条**；计划原文更大范围没有被排除，只是这两条具体规则不成立，未来要继续需要新的、结构不同的假设。详见报告 §4.6-4.7。
- **V3.2-30：`BLOCKED_EXTERNAL`，用户已确认暂时跳过。** 见上方"当前任务"一段；核实过程详见报告 §5。
- **V3.2-29：第 1 轮 source-locked on/off ablation 已完成，三个 adapter 全部 `KEEP`，理由各不相同，没有一个进入删除候选。** 用户已明确授权"一次性小幅突破 LOC 硬上限"，实际改动 +11 行（`33,219→33,230`，`index.ts` 新增 `AgentRouter` 的 `frameworkAdapters` benchmark-only 覆盖参数 + `benchmark-agent-impact.ts` 新增 `--exclude-framework-adapter` CLI 开关；编排/diff/manifest 逻辑在新增的 `scripts/run-v329-framework-ablation.mjs` 里，不计入 ledger）。**这 11 行目前未偿还**，`scripts/run-v32-optimization-matrix.mjs:49` 的 `productionLocGatePassed` 此后会是 `false`——**这是预期状态，不要去"修"它**，它就是这次被授权的突破本身。结果：MapStruct（仅 lishuedu 有 81 处 `org.mapstruct.Mapper` 用法）`KEEP_CONFIRMED_GAIN`——五项 gain 指标全部正向（recall+5.36%），且 payload/readPlan 字节同时下降，说明是"更精准候选、用更少字节拿到更高召回"，不是加证据加字节换召回；Spring（三仓都用）`KEEP_MODIFY_SIGNAL`——三仓 gain 方向不一致（lishuedu 五项全负，cipherlink/exam-parent-v3 有正有负），唯一三仓一致的信号是 `NDCG_read@6` 全为负，指向 `read-plan-budget.ts` 里 `SPRING_CALL_PATH` 的"verified"配额可能定级过高，是配额调整的 MODIFY 信号，不是删 adapter 的信号，本轮未动 `read-plan-budget.ts`；MyBatis（三仓 gain 全部精确为 0）`KEEP_UNDERPOWERED`——三仓核实过**零个** MyBatis XML mapper 文件，`isActive()` 靠 import 前缀在 cipherlink/lishuedu 会激活、`collect()` 真的跑了（payload 字节有真实正增量），但因为当前 adapter 的证据形状是 XML statement/resultMap，没有 XML 可扫，注定拿不到东西——按计划自带的 MyBatis 专属规则（不得仅因 adapter 无收益删除底层 XML 能力），这是 golden 集合覆盖缺口，不是 adapter 无价值的证据，也不算"无真实增益"的有效一轮。"连续两轮无真实增益"门槛本轮无法触发（只有一轮，且 MyBatis 这轮不算数）。详见报告 §4，含正对照数据（排除 Spring 后 cipherlink 五项指标全部非零变化，证明 filter 真实生效）和全部 18 次运行 `executableTree` 一致性核实（`eaaf5d39b74647e62964406800333bc21099b1b2`，campaign 期间代码树无漂移）。

## 下一步

**执行 V4 计划（真源见上）。** V4-06 已收口，不要再为 holdout 1.0 发明特判。不要再抬全量 IMPLEMENTS，不要放宽 maxFiles，不要用 save 猜 Mapper，不要 type-header +1，不要发明 caller-scan。下一件独立项是 V4-05 storm（未测，未过两轮不得默认开 dual worker）或 V4-07 缓存真源；不要自动扩到 Sprint6。三仓 load < 20 必须继续跑。V4-01 daemon 合流已完成（`4323b3c`）。V4-02 LOC 基线 35,472（上限 37,245）。

V4-03 **分母已入库**：`docs/phase-v4/v4-sprint0-manifest.json` + `docs/phase-v4/v4-sprint0-summaries/`。raw 在 `/tmp/codex-java-lsp-v4-sprint0-20260818/`。主机门改为可用内存 ≥4 GiB，load 只记录。cold-matrix 质量门 FAIL 是分母（三仓 rReadMust 0.90/0.91/0.88）。first-touch：lishuedu 3/5 COMPLETE，cipherlink 与 exam-parent-v3 5/5 PARTIAL_TIMEOUT（`--prepare none` + 60s）。正式仓仍是 `/tmp/codex-java-v3-golden-20260809/{lishuedu,cipherlink,exam-parent-v3}`。

V4-05 ADR-01 **FAILED**（V5R Phase 1）：两轮 `run-storm-gate.mjs` flag=1 未过 P95/quiet ≤1.10。sweep 线程已删除；query worker 仍是 live store 唯一写者，并继续在本线程跑后台 chunk。不要复活 `JAVA_LSP_JAVA_INDEX_DUAL_WORKER`。

V4-10 harness 已存在：`scripts/run-agent-trace-matrix.mjs`。无 `--authorize-external` 或 API key 时必须报 `BLOCKED_EXTERNAL` 且 usage/TaskSuccess 为 `UNMEASURED`，不得写成 `0`。真正外发调用仍等用户提供 key 且 Sprint0' 已入库后再开。

以下为 V3.2 收尾时的历史记录（保留供追溯）：

1. **V3.2-28 已两轮都测完、都 REJECT，未落地任何代码，不是待办事项**：第 1 轮零 LOC 的 Spring 配额调整、第 2 轮用户授权 LOC 突破后的文件数上限放宽，均被正式三仓矩阵证伪并回滚（见报告 §4.1-4.7）。计划原文更大的范围（anchor profile/taskBlocking evidence/sourceSet/文件大小四维度）没有被排除，只是这两条具体规则不成立——如果未来想继续挖，需要一个结构不同的新假设，不是这两条的变体，也不要不问用户就再花一次已经授权过的 LOC 突破额度（"再授权一次"不等于"永久授权"，每次新的 LOC 突破仍需单独问）。
2. **V3.2-29 尚未偿还的 11 行债务**：如果未来某个 round 2 真的对某个 adapter 测出"连续两轮无真实增益"（MyBatis 需要先找一个有真实 XML mapper 的 golden 仓库才能算公平的一轮，不能拿同样 3 个仓库再跑一次充数），对应的删除会把 LOC 拉回到硬上限以下——这是唯一的偿还路径，不要在其他无关地方找"精简"凑数。
3. 遇到设计分叉直接问 advisor，不问用户；只有 LOC ceiling 突破、外部 Agent 调用范围明显超出已授权 scope 这类事项才升级给用户。
4. Sprint5 完成后走 Sprint3/4 同样的收尾流程：隔离回归 → LOC ledger → 报告 → commit → push（均已获用户标准授权，不需要再问）。
5. **Sprint6（development-plan 第 732 行起，V3.2-31~35：删除 evidence transitional score 路径、收敛 framework shared helper、删除未测量的 shadow planner 决策路径、CI 分层门禁、最终价值报告）尚未开始、未做任何调研**——是 Sprint5 之后的自然下一个单元，但要不要现在开始应该先跟用户确认，不要在完成 Sprint5 收尾后自动往下扩展范围。
6. 独立于 Sprint5：import concurrency / JDT fingerprint 仍是低优先级开放项。**三仓质量矩阵不要用 0.7/核 去挡**：1 分钟 load < 20 必须跑，见 `docs/phase-v4/three-repo-host-load-policy.md`。
7. **Spring 的 `read-plan-budget.ts` 配额调整仍是独立的未来项**：V3.2-29 发现 Spring `NDCG_read@6` 三仓一致为负，但 V3.2-28 测过的"整体移出 verified 配额"这一种修法已被证伪（cipherlink tuning recall 净负、其余零效果）——这不代表 Spring 配额问题不存在，只说明"整体降级"这个具体修法不对；如果未来想继续挖这个方向，需要换一个更细粒度的假设（比如只在特定证据组合下降级，而不是全局移出 Set），不要重复跑同一个已经被否定的规则。

## 绝对不要再踩的坑（跨 Sprint 持续有效）

- 不要在活动 checkout 直接执行 `npm run build`、`node dist/...`、`npx tsc`、任何 `node --test` 或三仓 benchmark。所有会启动 Node worker/JDT/JavaIndex 的命令必须包在 `sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs` 中，并保持 `JDTLS_BIN=/usr/bin/false`。
- 不要运行旧的 `benchmark:lsp-performance` 入口；它已删除。
- 不要把 close 的 grace 恢复成 deadline 触发 `terminate()`；这会在 native parser 或原子写中杀 worker。
- 不要将 watcher refresh、A2 anchor 或多文件 refresh 标为 `ACTIVE_ANCHOR`。只有 `AgentRouter` 的第一个 A1 anchor 且单 changed/no deleted 能升级 root priority。
- 不要把 `isJavaIndexQuiescent()` 当作 `T_complete`；progressive complete 必须用 `isJavaIndexCompleteAt()`。
- 不要改变、删除或暂存未跟踪的历史 artifacts（`artifacts/v3-phase3`、`artifacts/v3-phase4`、`artifacts/v3-phase5`、`artifacts/v3-final/task36-remediation-20260809`、`artifacts/model-eval`、`artifacts/v3-task22`）、`.workflow/`、`.task30-debug.mjs`、`docs/evals/task30-model-comparison-20260802`。它们是其他并行会话/任务的产物，与 V3.2 Sprint 系列不是同一所有权，截至 2026-08-15 仍是 untracked。
- 不要在没有新证据或产品优先级变更的情况下重开 V3.2-17 的 storm/quiet P95 exit decision（见上）。
- 不要在没有用户明确授权的情况下产生任何真实 Agent 模型调用成本（V3.2-07b/V3.2-21/V3.2-30 的 quality 结论）。
- 不要在没有新证据的情况下重开 V3.2-24 的 `KEEP_EXPLICIT`——退出条件已经在现有 concurrency=2 数据上独立成立，不依赖 import concurrency 那一维度的答案。
- 不要在没有先验证"JDT 自身 M2E/Buildship 是否已经覆盖"之前，直接给 `dataDir` 加版本/fingerprint 失效逻辑（V3.2-24 §5.5(c) 的开放问题）——可能是重复造轮子。
- 三仓 cold-nolsp 矩阵：1 分钟 load < 20 **必须执行**，禁止用 per-CPU 0.7 或“等主机安静”阻断。load 只记录，不是拒绝门。真源 `docs/phase-v4/three-repo-host-load-policy.md`。fresh-workspace **真实 JDT** first-touch 在 load≈30 时曾两臂 60s 超时——那是 JDT 噪声解释，不能外推成“三仓也不许跑”。
- 不要在裸 `bash -lc '...'` 里跑 `run-isolated-validation.mjs`/`run-isolated-jdt-benchmark.mjs` 而不先 `export PATH="/opt/homebrew/bin:$PATH"`——本机 `/usr/local/bin/git` 是 2015 年遗留的 git 2.3.1 符号链接，排在真正的 `/opt/homebrew/bin/git`（2.52.0）前面，会导致 worktree 相关测试假性失败、或对三仓 golden repo（本身是 git worktree）的 `--repo-root` 调用假性报 "Not a git repository"。见 [[node-and-benchmark-env-constraints]] 第 3 条。
- 不要把 V3.2-27 的 top-of-file-fallback miss 类用"type 声明行代替 (1,1)"这种低成本修法去凑合——已用 golden 数据结构性证伪（见 Sprint5 §3），会浪费 LOC 余量且拿不到任何真实收益。
- V4 起不要再用 V3.2 的 `33,230/33,219` 当 LOC 门禁。现行真源是合流提交 `4323b3c`：35,472 LOC，周期上限 37,245。V3.2-29 的 +11 行旧债已并入该基线清零。
- 不要"修复"历史 V3.2 报告里的 `productionLocGatePassed: false`——那是当时 `33,230/33,219` 的已授权突破记录，不是现在的回归。
- `scripts/run-three-repo-cold-matrix.mjs` 的候选测试套件阶段包含真实子进程多进程锁 lease 测试（`task36-multiprocess-smoke.test.mjs`），高 load 时可能假失败。这**不是**停跑三仓的理由：load < 20 必须开跑；若该单测失败，隔离环境单独重跑那一个文件，两次方向一致才能下结论。
- 不要重复尝试"把 `SPRING_CALL_PATH` 从 `read-plan-budget.ts` 的 `FRAMEWORK_VERIFIED_REASONS` 整体移出"这条规则——V3.2-28 第 1 轮已经用正式三仓 AB/BA/AB 矩阵测过（`--baseline 869b353`），cipherlink tuning recall 净负、其余两仓四项指标全零，已回滚（见 Sprint5 §4.1-4.5）。Spring 配额问题本身可能仍然存在（V3.2-29 的 `NDCG_read@6` 三仓一致为负这个信号没有被推翻，只是这一种修法不对），但下次要换更细粒度的假设，不是重跑同一条规则。
- 不要为三仓 golden 分数过拟合。用户还有很多仓库。禁止场景 id / 文件名 / taskKeywords 特判；禁止用 `save` 猜 Mapper `listTodo`；禁止 type-header +1 修 77–93 vs 77–94。三仓是验收样本，不是目标函数。
- 不要重复尝试"把 `buildReadPlan()` 里 anchor 数量超预算才放宽 `maxFiles` 的机制，扩大到 anchor∪protectedPaths"这条规则——V3.2-28 第 2 轮用正式三仓矩阵测过（`--baseline 4eedc6b`），三仓 token 成本全部上升、`pRead` 广泛下降，只在一仓一项指标上有收益，净不划算，已回滚（见 Sprint5 §4.6-4.7）。如果未来想继续挖"task-aware budget"这个方向，先重复这条规则本身发现的方法论（见下一条），不要直接重跑同一条被否定的规则。
- 涉及 `read-plan.ts`/`read-plan-budget.ts` 的任何预算类改动，落地前先核实**文件数上限（`maxFiles`）还是字节上限（`maxReadBytes`）才是真正 binding 的约束**——V3.2-28 两轮都先用已有正式矩阵原始数据核对过这一点（holdout 场景文件数打满、字节只用 30%-69%），这不是可以跳过的步骤，选错杠杆等于白跑一次正式矩阵。同时要注意 `selectTokenAwarePlan` 的 `BUCKET_RULES`（`anchor:1, core:4, framework:2, support:1, lexical:1`）是另一层独立的、按证据类别分桶的硬上限，和 `configuredBudget.maxFiles` 是两套不同机制——只调其中一个可能对另一个完全无效（本轮第 2 轮第一次单测编写时就撞上了这个坑）。任何"默认预算内自动放宽"的机制都必须显式判断调用方是否传了 `readPlanMaxItems`/`readPlanMaxBytes`——显式预算是硬约束，不能被默认值放宽逻辑覆盖（第 2 轮第一版实现漏了这条，导致 3 个既有的"constrained core"测试真实回归，不是测试断言过期）。

## 关键文件 / 命令 / 验证

- 计划真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md`。
- Sprint3 证据：`artifacts/v3-final/sprint3-{cold-matrix-20260815-v3,progressive-20260815,storm-20260815,diagnostics-20260815,followup-20260815}/`。
- 隔离验证入口：`sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted|compile|full [--keep] [--env NAME=VALUE] -- COMMAND`。
- LOC ledger 生成参考：对比固定基线 `d7f23d5`（31,638 行）与当前 worktree，用 `scripts/count-production-ts.mjs` 的 `countProductionTs`；硬上限 `Math.floor(31638*1.05)=33,219`（`scripts/run-v32-optimization-matrix.mjs:49` 用 `<=` 判定，打满不算超）；**当前候选 33,230/33,219，超编 11 行（V3.2-29 一次性突破，用户已授权，未偿还）**——`productionLocGatePassed: false` 是预期状态，不要"修复"它；新增生产代码前必须先问用户是否愿意再授权一次突破，或找到能偿还这 11 行债务的真实删除机会（V3.2-28 试过把 `SPRING_CALL_PATH` 移出 verified 配额这个零 LOC 规则，已被证伪回滚，见报告 §4，不要重复跑同一条被否定的规则）。

## 给下一会话的第一步

```sh
git log --oneline -5
git status --short
```

确认 `git log` 最新几条含 V5R Phase 7 `BLOCKED_EXTERNAL` 收口。不要合 `main`。不要把 TaskSuccess 写成 0。解阻需要用户 key + `--authorize-external`，以及声明并冻结第四评价仓。λ 仍是 `CALIBRATED_OFFLINE`。三仓 load < 20 仍必须跑。
