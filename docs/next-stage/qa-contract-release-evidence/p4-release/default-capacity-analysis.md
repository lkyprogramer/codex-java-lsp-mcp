# 默认单 reader 容量分析

结论：默认单 reader 的 K29 FAIL 是 common/broad 服务工作被串行队列放大；主线程 event loop 和 worker IPC 不是当前主要瓶颈。建议先实施两个有既有微实验支持的局部改动：删除重复 posting 键投影；仅在 entityIds 把 cutoff-tie ID 的逐行 iterate 改成有界 512-ID all。现有证据支持缩短服务时间，但不足以保证默认1的150ms门通过。若该最小补丁仍 FAIL，应保留 FAIL；本报告没有证据支持用额外缓存、减少 broad 路线或预算、修改调度/默认 reader 数继续救门。

范围：读取现有 P3 capacity-r2 六轮 JSON 真轨迹，以及当前 runStaticDiscovery → SqlJavaIndexClient.querySearch → QueryWorkerPool → SqlEntitySearch.searchDetailed 路径。另读取先前保留的 profiling 与成对微实验。只分析已有数据，未运行新 benchmark、模型、build、JDT 或 installer，未修改源码或旧证据。

## 已观察的容量边界

P3 容量候选 sourceDigest：a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313；base04058e43b8b2658864d0de09c8d6024e9928dfc5。当前 entity-search.ts SHA256：ea771f2d1f1c30c0556a88e2d3b1e81a63cf8e61479f5920bd4c823be25d7cc3。旧报告是该候选的实测，不自动等同未来发布候选。

| 单reader轮次 | c20 P95 ms | c20+update P95 ms | c20 event-loop P95 ms |
|---|---:|---:|---:|
| pair1 |187.940|189.367|1.440|
| pair2 |193.812|194.204|1.486|
| pair3 |188.077|188.382|1.449|

每个 c20 步骤100请求，四种 query 各25个，五个20请求封闭波。pair1 c20：

| query | queue P50/P95 ms | actual service P50/P95 ms | cohort service总和 ms |
|---|---|---|---:|
| rare FQN |7.075 /14.772|0.121 /0.228|3.443|
| refundOrder auto→exact |7.244 /14.912|3.189 /3.592|81.546|
| order |93.385 /165.251|15.355 /17.858|391.108|
| broad |108.911 /180.694|19.219 /26.071|499.068|

common+broad 仅占50%请求，却占91.285%的 actual service 总和。100请求 actual service合计975.166ms，步骤wall1001.278ms；只有约2.61%的wall不在worker服务区间内。这是串行默认1的轨迹，不应把不同query的P95相加。queueP95与serviceP95来自不同样本，也不能相加声称同一请求分解。

pair1 c20 dispatch→reply P95：order17.995ms vs service17.858ms，broad26.335ms vs service26.071ms。这些相近的分布及上述wall覆盖说明IPC/调度不是首要成本中心。c20 event loop离20ms门有明显余量。update三轮实测各10次提交，c20 P95仅比无update高约0.305–1.427ms；当前没有证据说明writer contention主导失败。

双reader c20 P95为114.804/120.409/111.602ms，服务本身并未稳定变快（pair1 common service P50变19.029ms，broad22.652ms），改善主要来自queue减少，且whole-process CPU等价core由约1.24–1.29升至约2.34–2.49。它验证队列放大假设，不能用来满足本次默认1要求。

## 有证据支持的最小改动

历史 clean CPU profile（旧源594c65…，非本次新profile）named inclusive归因：postingRows38.97%，entityIds17.33%，exactHits7.54%，selectTop排除entityIds4.19%，GC3.47%，prepareCached0.01%。Native all self29.42%、next11.62%；采样不能区分SQLite VM执行与行传输，因此不能把all全部称为marshalling。该历史profile的函数热点仍在当前代码中，但百分比不可作为当前候选新测量。

1. 当前 entity-search.ts:455和:535同时投影 entity_sym/doc_sym 为 postingKey 与 entitySym/docSym；:148仅用postingKey推进游标。移除重复投影并从已返回实体/文档键取得相同游标，保持每页256行、SQL JOIN、keyset顺序、scope和physical examined billing完全一致。优先用现有 PostingSource 增加明确 key accessor，避免把 entitySym/docSym 的宽松 fallback 拓展为公共合同。先前 projection 单独微实验：order paired median -0.313ms、broad -0.889ms。收益小，但目标是被重复传输的真实字段。

2. 当前 entityIds :277–289对完整截止同分层，使用 bindChunks(missing) 与 iterate；driver.ts:22默认chunk上限32766，synthetic query需解析2000–3000个ID。只在这一个ID查找函数按512分块执行同一实体存在性JOIN的all，把已materialized bounded rows放入同一snapshot-local cache。不得把unbounded postings改为all，不移除entity存在性JOIN，不新增跨请求/跨generation缓存，不改变missing IDs的undefined语义与localeCompare tie order。既有 projection+IDs组合微实验 order15.870→13.422ms，paired delta -2.415ms；broad19.575→18.016ms，paired delta -1.580ms。组合收益不能全部归因ID改动。exact同路结果稳定；fuzzy未改路但paired delta +0.140ms，提示保留回归检查。

既有微实验160成对query样本全部完整结果语义一致（仅trace时间排除），12项expired/posting7/posting300/inside-scope/outside-scope/midbatch-deadline边界也一致。历史临时编译变体从未进入当前源码。上述最小补丁不要求改schema、索引、业务合同、排队优先级或生产默认。

## 收益限度与下一步证明

按每波5 common+5 broad，历史组合paired delta给约19.98ms波服务节省；这是估算，不是尾延迟预测。当前单reader总体P95距150ms约37.94–43.81ms，组合收益很可能仍不足。主要postingRows读取/分组工作仍然存在，完整同分tier仍须比较每个ID。没有新证据支持宣称该补丁能完成release性能验收，或推荐更多没有实测收益的改写。

主代理若实施：正常路径比较原/新完整hits顺序、score、work.postings/examined、selectionLimited、generation、stopReason；失败路径覆盖deadline与posting cap；integration edge覆盖scoped filtered页、document→declaration winner/refill、缺失entity和generation update。现有 entity-search-bounded.test.ts:528 tie跨页/fresh generation及:577 missing-entity refill可复用；针对512边界、多个ID批次、相同locale排序增加最小覆盖。原rank/BM25/route round-robin不改。

然后冻结新源、独立review及定向隔离测试，通过后由主代理在同host串行重跑默认1 unchanged1000files/100samples/1,5,20/update@100ms；记录raw queue/service/latency、CPU/RSS，warm150ms/eventloop20ms不变。短微实验只证明服务缩减，不替代正式门。若正常结果parity失败立即停止；若正式门仍FAIL，残余风险如实记录，不能从broad、预算、门或默认并发寻找绕过。

优先级：这两个局部改动是P4最小候选；完整默认1门仍为发布阻塞。预期降低服务时间及queue放大，量级有限；rollback为恢复这几个局部SQL读取实现，不涉及数据迁移。

## 精确真源

- P3候选/计划与各轮门：/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-evidence-experiment-xsnbz3zg/p3/capacity-r2-comparison.json。
- 每轮raw：同目录capacity-r2/pair-{1,2,3}-workers-{1,2}/query-load-report.json，steps[2]和withUpdates；workerRequests.queuedMs/actualServiceMs/dispatchReplyMs，byKind，resources。统计采用排序ceil(N*p)-1，与原helper口径一致。
- 当前源码：src/discovery/query.ts:255、511（实际intent）；src/java-index/sql/sql-client.ts:276（worker边界）；src/discovery/query-worker.ts:145、168、400（默认1及timing）；src/java-index/sql/entity-search.ts:128、148、225、277、455、535；src/java-index/sql/driver.ts:22。
- 历史hotspot：/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-k29-round2-analysis-agnt6_vn/perf/cpu-clean-summary.json及cpu-clean.cpuprofile。
- 历史成对真结果：同perf/paired-probes.json（rows160,edges12,全部parity true）、probes-summary.json、paired-probes.mjs；精确变体diff来自dist/java-index/sql/entity-search-clean.js对entity-search-projection-ids.js。只读取既有记录，没有执行该probe。
