# P4 posting row arrays / compatibility fallback microprobe

Scope: new arrays-r1 directory only.80 normal paired sets (20 alternating rotations ×4 original queries ×4arms) and17 preserved edgecases all pass full semantic parity. Trace operations/visited/remainingMs are included; only elapsed begin/end timestamps are excluded. Original fixture.sqlite SHA256 remains unchanged. No formal load, repo/candidate edits, build, model, JDT, installer, engine/default/budget/gate/scoring changes.

Arms: actual ADtF8Q patch base; previous callback-token lean; lean with optional native posting-only setReturnArrays(true) and array/record value helper; same helper forced to the pre-method statement shape via bound all/iterate wrapper, exposing no setReturnArrays. Each arm uses its own SQLite connection so the statement cache return-mode mutation cannot leak to another arm. Nonposting SQL, pageEnd point reads, entityIds and rank code are untouched.Only full posting payload SELECTs are switched: entity3 columns,document4 columns. Unscoped all256/scoped iterator2048,joins,page visits,examined/budget/deadline order remain unchanged.

Runtime evidence: actual executable Node v22.16.0; StatementSync.setReturnArrays observed as a function. Modern arm helper observed array rows,true enable,false fallback; forced fallback observed no method,record rows,true fallback,no array rows. No method call is attempted when absent. This proves the helper fallback path on current runtime; actual old Node22 was NOT run, so minimum-version runtime support remains unverified. package engines>=22 stays unchanged. Probe seam is a temporary wrapper,not production compatibility scaffolding.

Paired median deltas in milliseconds:

| query | arrays vs actual patch base | arrays vs lean | forced record fallback vs lean | arrays vs forced record fallback |
|---|---:|---:|---:|---:|
| order |-3.648375|-2.762521|-1.662667|-0.955667|
| broad |-4.938501|-3.515666|-2.105480|-1.418291|
| refundOrder |-0.007687|+0.022208|+0.024187|+0.033250|

Modern arrays faster than forced record in15/20 common and19/20 broad paired samples. Arrays-vs-base paired delta P95 common+0.346ms,broad-3.679ms;20 samples are not a performance confidence guarantee. Exact deltas are microsecond noise; full values and every raw result remain in JSON.

Attribution limit: forced record fallback also speeds lean considerably,despite no native row shape change. Thus optional array/helper COMBINATION is measured; it is incorrect to call all2.76/3.52ms gain pure native row-transfer savings. The closest paired contrast arrays-vs-forced-record gives~0.96/1.42ms additional reduction,with wrapper allocation/dispatch and JIT specialization differences still possible. This probe does not contain native profiling and cannot split SQLite VM work,property transfer and optimized JS access exactly.

Candidate recommendation: only port the bounded postingStatement/value-access helpers if independent reviewer accepts the two-caller/cache isolation boundary. Optional API use must be guarded typeof statement.setReturnArrays==='function' and return the original statement on fallback; production does not need forced-wrapper seam. Read rows via Array.isArray(row)?row[index]:row[alias]; positions fixed by these3/4-column SQL projections. Do not enable arrays on shared driver or nonposting statements; schema/public rows stay objects. Keep per-row billPosting first and TF grouping/scoring/tie logic identical. Record helper fallback may itself offer benefit; no broader abstractions required.

Expected capacity impact is still a hypothesis. Per20-request wave (5 common+5 broad),arrays vs actual patch base median estimate~42.93ms service reduction; arrays vs lean~31.39ms. These are aggregate service arithmetic,not a prediction of formalP95 or acceptance. Parent's baseline actualpatch default1 formalP95~170ms must be judged with original unchanged default1 workload/gates after source port,review and offline tests. No default2 substitution or broad narrowing.

Validation already performed here: four normal queries,expired entry,posting7/300,inside/outside scope,midbatch/scoped-midpage deadline,no indexed token rows,own copied scratch with17 removed entities and fresh generation. Full normal/edge parity includes missing-entity refill and snapshot generation. Remaining production checks: source implementation review,focused unit/integration tests including arrays native path and forced missing-method fallback,statement-cache shape isolation,then same-host unchanged formal default1 load. Do not treat this microprobe as release readiness.

Evidence: prepare-arrays.py exact local compiled transforms; variants.json compiled hashes; run-paired-arrays.mjs sequential rotation and oracle; paired-probes.json all normal/edge raw results,timings,immutable fixture hash and runtime probe state; probes-summary.json includes base/lean/fallback contrasts and faster sample counts; probe.log original execution output. Old perf-probes evidence remains untouched.
