# P3 capacity raw evidence review

结论：RAW_AUDIT_PASS。六次运行的报告与原始样本一致；本次 synthetic 容量门结果为单 reader 3/3 FAIL、双 reader 3/3 PASS。单 reader 的三个并发20及三个 update20 单元均超过150ms；全部24单元的 event-loop P95 均低于20ms。双 reader 改善了此合成闭环负载的排队延迟，不能据此修改历史 FAIL 或生产默认配置。

审计范围：`capacity-r2-comparison.json` 及其六个独立 `query-load-report.json`；代码与口径依据已审阅的 r2 冻结实现。独立审计仅解析 JSON、重算统计和检查不变量，没有运行 benchmark、LLM 或额外构建。机器可读结果在 `capacity-raw-audit.json`，failures 为空。

## 证据一致性

- 六行 candidateIdentity 一致，sourceDigest 为 `a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313`，baseSha 为 `04058e43b8b2658864d0de09c8d6024e9928dfc5`，611 files；host 元数据和原始四查询 cohort 一致。
- planned 与实际行顺序均为 pair1 1/2、pair2 2/1、pair3 1/2。相邻运行的可观测请求时间窗口无重叠；串行子进程机制由已审 runner 保证。该证据不声称整台宿主没有其他负载。
- 每次1000文件；每次1/5/20/update20四单元各100请求，共2400测量请求。每单元 sample 为0..99且唯一，round/slot/sample映射成立；四类各25，worker task分布也各25。deadline1000ms、limit8、writer100ms、150/20门限未变。
- 对全部24单元及96个kind分组，独立按 nearest-rank 重算 P50/P95/P99，并按报告三位小数精度比较，全部一致。原始 stopReason/scopeState 计数一致。comparison 内嵌 steps 与六份独立报告完整相等。最终 PASS/FAIL 可由报告门限重算得到。
- 每单元100条唯一 worker request timing；144条预热timing。所有 timing 已执行且 completed、service非null，时间顺序及 queue=dispatch-enqueue、service=workerFinish-workerStart、dispatchReply=settle-dispatch、total=queue+dispatchReply 均逐条成立。同slot服务区间无重叠。原始时间支持进一步求IPC/交付间隔；不同分布的P95不可直接相加。
- 每个reader×每个query均有completed和非null service证明；预热全部settle后才开始测量。原cohort的`fuzzy`标签保持不变，但`refundOrder`的auto实际分类为exact，不能把这一行解释为真实模糊检索性能。全部单元 measuredWorkerSpawned=0、measuredWorkerCompleted=100，未用thread数替代预热成功。
- 所有测量单元settled，queuePeak≤32，零queue rejection/queue expiry/termination；最终六份shutdown均threads0/queued0/running=false。update20实测commit分别为单reader10/10/10、双reader6/7/6；warm+measured之和等于保留的总commit。非update单元commit0。update的PARTIAL均由原始changed_during_request计数支持，六单元分别29/19/49/36/52/33；该报告本身不证明所有SQL快照语义，后者由代码与前置测试提供证据。
- event-loop报告只保存直方图摘要；本次可检查门限但无法从原始delay样本独立重建P95。未把该项写成raw重算结果。

## 延迟与资源结果

以下为三对中的单reader → 双reader discovery P95，单位ms。

| pair | c1 | c5 | c20 | update20 |
| --- | --- | --- | --- | --- |
| 1 | 21.158 → 28.804 | 59.492 → 41.751 | 187.940 → 114.804 | 189.367 → 114.533 |
| 2 | 21.814 → 22.089 | 58.661 → 43.541 | 193.812 → 120.409 | 194.204 → 131.148 |
| 3 | 22.447 → 20.451 | 59.704 → 40.678 | 188.077 → 111.602 | 188.382 → 106.833 |

c20三对P95下降37.87%–40.66%；update20下降32.47%–43.29%。c1没有一致改善，pair1反而升高36.14%。全部event-loop P95范围1.396–1.882ms。

排队数据支持减轻等待这一解释：c20单reader queue P95为168.277–173.520ms，双reader为90.371–93.246ms；同一批服务P95从19.678–20.235ms升为23.309–24.495ms。因此观察到的收益来自更少的等待，未证明单条SQL更快。

资源代价须一起报告。c20每100请求累计CPU由1230.388–1286.927ms升至1412.738–1611.392ms，逐对增加14.82%–29.40%；update20增加15.16%–22.51%。c20 CPU等效核数从1.237–1.285升至2.342–2.488，计入整个进程与worker，不能解读为worker数。

CPU原始user/system单位是微秒，审计按 `(userUs+systemUs)/(wallMs*1000)` 重算等效核数，全部一致；上文累计CPU已除1000换成ms。RSS代码除1024²，虽字段命名Mb，实际单位为MiB。c20单reader采样峰297.844–302.750MiB，双reader295.984–330.859MiB，逐对变化+28.578/−6.766/+32.281MiB；不能声称每次都增加或降低内存。update20逐对增加22.922/3.078/26.969MiB。RSS是10ms采样的全进程峰值，含先前构建/GC影响，不能归因为纯reader增量，更不是精确峰。

## 结论边界

原首轮 `capacity/pair-1-workers-1` 的预热oracle FAIL_SETUP及stderr仍保留；新comparison明确记录前次失败，不将其改算为SLO样本。修复后单reader三次真实性能FAIL也保留。此次三对结果支持显式双reader在这个1000文件、固定四查询、预热后closed-wave synthetic workload下通过原门限；不等于生产吞吐、真实到达率容量、冷启动性能或真实仓库验收。100样本P99仍是稀疏顺序统计量，单kind仅25样本。

writer间隔保持100ms；双reader测量窗口更短，因此提交次数较少。这是原实验设计下的实际暴露差异，不能宣称两组遭遇了相同数量的写入，也不能把PARTIAL数量下降直接归因为一致性改善。生产默认继续为1；不在此次审计中建议额外运行或扩大范围。
