# P3 capacity experiment v1

Frozen sequence: pair1 workers1 then workers2; pair2 workers2 then workers1; pair3 workers1 then workers2. Each run is an independent process, same frozen integrated candidate and host, serialized without overlapping CPU benchmarks. Do not edit historical evidence or reinterpret historical single-reader FAIL.

Workload: unchanged synthetic generator, 1000 Java files, 100 samples per step, concurrency 1/5/20, four original query kinds, deadline1000ms, meta generation update every100ms at concurrency20. Thresholds remain warm P95<=150ms and event-loop P95<=20ms. CPU/RSS are observations, with no invented post-hoc acceptance threshold.

Before execution: core and measurement independent reviews PASS, focused offline/lifecycle tests PASS, source digest and built candidate frozen. Root writes capacity-run-approved.json with status PASS and sourceDigest only after these checks. Measurement owner does not run capacity.

Measurements: raw discovery latency per sample/round/slot/query/outcome; independent raw SQL-worker request timings with request id/task/slot, enqueue/dispatch/reply and actual worker start/end. These are distinct boundaries; discovery latency includes pre/post SQL work. Measure process CPU delta and wall time across measured requests; whole-process RSS start/end and10ms sampled peak. Sampling misses sub10ms peaks. Preserve writerCommits and old worker counters including warmup, report separate measured deltas. Warm both configured reader slots via synchronous concurrent dispatch and record observed slots. Record post-client-release settled state and final all-worker shutdown.

Interpretation: compare all three matched pairs, each step and query kind, generation outcomes, queue/service/IPC decomposition, CPU and RSS; retain failed runs. One passing run does not establish stable benefit. This closed-wave synthetic experiment tests queue amplification and reader headroom; it does not establish production throughput or realistic arrival capacity.100-sample P99 is a sparse order statistic. No default change is authorized by this experiment alone.
