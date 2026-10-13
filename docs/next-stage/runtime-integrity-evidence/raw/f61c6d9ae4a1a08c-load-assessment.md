# K29 load failure assessment

结论：本次 K29 FAIL 是已存在的 20 并发容量边界。当前候选与同机 04058e43b8b2658864d0de09c8d6024e9928dfc5 基线均超过 150ms，未观察到本轮新增的 c20 延迟回归。机制 PASS 与性能 FAIL 应同时保留。单次配对运行不足以声明统计等价，也不能外推所有仓库或生产容量。

## Scope and identity

只读审查候选 diff、static discovery → SqlJavaIndexClient.querySearch → shared read-only worker → SqlEntitySearch，以及保留的 K29 SQL trace。未改 candidate、生产脚本、门槛、语料或 worker pool。补测仅在 base commit 的独立 git archive 源目录与私有缓存中执行，复用已安装依赖文件；未启动生产 daemon/JDT/模型，未跑全套。

Candidate sourceDigest: `2d4f09405670e73bc655173b3ffe2ec72dc5b4beafddb396ea15c3fd4c0400d1`（来自 K JSON）；candidateDrift=false。

Candidate raw: `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-KJvBwm/k-contracts/raw/load/query-load-report.json`。

Baseline raw: `load-baseline/raw/query-load-report.json`；exact command/cwd/isolation: `load-baseline/command.json`；stdout/stderr/exit: `load-baseline/{stdout.log,stderr.log,exit.json}`。

## Observed same-host comparison

两次均 darwin arm64 / 10 CPUs / Node v22.16.0；生成 1000 files、1000 types、2000 methods、0 edges；相同 queries、每档 100 requests、deadline 1000ms、steps 1,5,20、写入间隔100ms。基线与候选均每档先预热四种 query；保持原测法。

| P95 ms | baseline 04058e4 | candidate | difference |
|---|---:|---:|---:|
| c1 | 33.075 | 31.583 | -1.492 |
| c5 | 83.163 | 86.166 | +3.003 |
| c20 | 268.696 | 268.585 | -0.111 |
| c20 + updates | 276.424 | 270.906 | -5.518 |

两边 c20 queuePeak=19，threads=1，settled=true；0 queue_full、0 expiredInQueue、0 terminated。无写入时均100 READY/none。带写入时 candidate 42、baseline 47 个 changed_during_request/PARTIAL，均正常结算。Candidate event-loop P95最高1.311ms；baseline最高1.395ms，均低于20ms。候选写入P95相对无写入仅+0.86%，这份证据不支持写锁是主因。

## Attribution and confidence

**高置信：串行扫描的服务时间叠加为主导成本。** worker `pump()` 在已有 running 时不派发下一请求，只有一个共享线程；c20峰值19与之吻合。Candidate c1 common-word P50=25.472ms、broad P50=30.033ms；c20对应P95=266.330/294.572ms，而 exact P95=14.891ms、fuzzy P95=18.949ms。20并发一轮包含5个普通词和5个broad扫描，串行服务时间约278ms，与观察到的尾部范围一致（说明性估算，不是逐请求queue计量）。现有 exact 优先队列已使稀有FQN免于承担同样的尾延迟。

**高置信：失败早于本轮。** 核心 query-worker.ts、query.ts、query-budget.ts、entity-search.ts、driver.ts、measure-query-load.ts 对base无diff。同机同生成语料基线也为268.696ms。仓库历史 `docs/next-stage/r09-task-result.md` 已记录 lishuedu c20 P95=331.7ms与未签性能门；该历史不同语料、Node版本，仅用于证明该容量风险早已公开，不作本次数值基线。

本轮热路径直接新增的是 status coverage 一次meta读取及JSON解析（sql-client.ts coverageRows → readSourceRootCounts），未改搜索或排队算法。当前无证据显示它主导本次失败。Parser/local type和call-resolution变更影响冷建库，合成普通类语料的实体计数与基线相同；未把这一结论外推到含local/record/dispatch的真实库。

**已观察SQL阶段，微观归因仍有限。** Candidate `order` 单次 in-process SQL trace总38.745ms、8000 postings：document postings=11.921ms；三个rank阶段合计19.376ms；merge+locators约0.534ms。rank和document postings合计约81%，应优先调查它们，优化preview/locator的收益有限。这是一次未充分warm的阶段快照，不能当作worker warm CPU profile。基线同阶段总34.331ms、同样8000 postings。

`selectTop` 为保留 `(score desc, entityId asc)` 合同，会扩展截断分数档的全部候选、查询这些ID再排序。高度重复的合成语料可能造成很大的平分档，是下一步最小可验证假设；本轮没有采集tie档长度或CPU样本，不能把它断言成唯一根因。负载工具里的 `exact:fqn_like` EXPLAIN 是解释性旧SQL，不是当前exact实际简单名预筛查询，不能据其中SCAN宣称exact全表扫描故障。

## Minimal next step and validation boundary

保持 K29 FAIL 及原150ms/20ms门槛。若另行授权性能修复，先在同一固定库记录rank阶段的平分档长度、ID加载数量与CPU profile，定位rank/document dominant cost；优先尝试保持完整分数/ID排序合同的局部top-K或ID解析改进，再同机同缓存配对验证。不扩worker pool、不降低posting预算、不改样本结构或SLO来取得PASS。

验证应保留普通词/broad的normal路径、过期入口0postings及queue过载/取消的failure路径、generation更新后PARTIAL且settled的integration边界。本轮已读取原过期入口trace（deadline、0 postings、0 stages）及负载更新结算证据；未新跑queue_full/kill故障测试，原K矩阵/定向测试负责该证据。未验证真实生产builder写入、真实库容量、持续饱和或统计显著性。

## Commands run

- `git diff --numstat -- src/discovery/query-worker.ts src/discovery/query.ts src/discovery/query-budget.ts src/java-index/sql/entity-search.ts src/benchmark/measure-query-load.ts src/java-index/sql/driver.ts`（candidate cwd）：无输出，核心未改。
- `git archive 04058e43b8b2658864d0de09c8d6024e9928dfc5` → 独立 `load-baseline/source`（Python tarfile data filter）。
- `/Users/luo/.nvm/versions/node/v22.16.0/bin/node node_modules/typescript/bin/tsc -p tsconfig.json`（baseline source cwd）：exit0。
- `/Users/luo/.nvm/versions/node/v22.16.0/bin/node runs/load-baseline/run.mjs`：exit0；runner使用仓库原 `isolatedValidationEnvironment` 构造私有环境，实际运行 `node dist/benchmark/measure-query-load.js --files 1000 --samples 100 --steps 1,5,20 --output <runs/load-baseline/raw>`。

Priority：保留为release性能缺口；本次runtime-integrity修复没有新增c20回归证据。当前小并发路径通过150ms，20并发边界失败；是否另开性能任务由所有者决定。
