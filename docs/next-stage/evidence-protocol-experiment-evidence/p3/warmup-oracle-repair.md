# P3 warmup oracle repair and rerun binding

Observed first attempt: capacity/pair-1-workers-1 failed during warmup with reader0 did not complete warm query fuzzy. No100-request measured phase was entered. Status FAIL_SETUP; preserve directory/stdout/stderr without overwrite.

Root cause: runStaticDiscovery resolves requested auto refundOrder through classifyQuery to actual intent exact before querySearch. The measurement and runner wrongly required raw request mode auto. Code query.ts classification and mode:intent call provide the mechanism; adding the original fuzzy/auto query to the120-file fixture reproduces both one/two-reader failures.

Minimal repair: measurement and runner both compare worker event mode with classifyQuery(query.query,query.mode), retaining reader slot, query task, completed outcome and nonnull actual service checks. The test directly asserts refundOrder worker mode exact as well as the slot×query proof. No workload, ranking, deadline, samples, gate, writer or worker core changes.

RED log measurement-warmup-red.log: pass1 fail2 zeroSkip. GREEN log measurement-warmup-green.log records repaired fixture validation. Root will freeze integrated source and review status before rerunning all six serialized arms in the same preregistered [1,2],[2,1],[1,2] sequence. New output capacity-r2 and capacity-r2-comparison.json record priorAttempt FAIL_SETUP. Prior plan thresholds and workload stay unchanged.
