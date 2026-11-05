# P4 bounded posting transfer microprobe

2026-10-12. Scope: temporary compiled copies only under this directory. The actual validated duplicate-projection/512-ID patch from candidate ADtF8Q is the paired base; source candidate co0Y6G supplies copied dependencies and immutable historical fixture.sqlite is read only. No repository, candidate or historical evidence was modified. Parent explicitly authorized this short serialized probe after its capacity run ended. No formal capacity/load run, model, build, JDT or installer was run here.

Confirmed result:80 paired normal query sets (20 rotated executions ×4 queries ×3arms) and17 edge cases have complete result parity. Trace operations, visited and remainingMs are compared; only beginMs/endMs are excluded. All hit fields, scores/order, selection flags, work.postings/examined, generation and stopReason remain compared.

| query | actual-patch base P50 ms | callback only paired median delta ms | callback + omit tokenSym paired median delta ms | combined P50 ms |
|---|---:|---:|---:|---:|
| rare FQN |0.047708|+0.004188|-0.000583|0.044438|
| order |13.179854|-0.007833|-1.028751|12.357208|
| order refund ledger payment |17.015354|-0.377063|-1.391563|15.652792|
| refundOrder auto |3.032938|+0.011250|+0.016292|3.090125|

Combined paired delta P95 is +0.607ms common, +0.549ms broad; per-sample jitter exists. Median reduction common~7.8% and broad~8.2% is a mechanism candidate, not evidence of formal P95 benefit. Callback alone gives effectively zero common gain and small broad gain, so do not justify generator replacement as independently dominant. The combined arm removes tokenSym native property transfer and per-row tokenSym conversion/map lookup by using the already-known outer token; the experiment does not isolate these contributions from each other.

Minimal implementation candidate: convert postingRows to a synchronous scan callback returning boolean to continue. On every row the consumer calls billPosting first, increments visited and updates exactly the same TF group; pass token.sym from the outer loop. SQL still selects the same entity/doc key, TF, lengths and declaration key, but omits t.token_sym AS tokenSym. The callback uses tokenBySym.get(tokenSym) rather than reading/converting the duplicate returned token field. Every SQL statement is already constrained to t.token_sym=?; this is a value available from control flow, not a new cache. Keep source.key accessor,256 bounded unscoped rows,2048 scoped keyset pages,entity JOIN,all examined accounting,all budget.take and deadline checks in the same order. Returning false on failed billPosting returns from the scanner without fetching more rows, matching the old consumer break and generator close. For scoped iterator, for-of return still closes the native iterator.

Edges: expired entry,posting7,posting300,inside/outside scope,unscoped midbatch deadline,scoped midpage deadline(each common/broad),unknown token/no rows,17 removed entity IDs with retained document facts and fresh generation in a NEW copied scratch fixture(each common/broad). Original fixture hash is verified unchanged. No actual timer deadline precision claim is made; deterministic remainingMs call counts prove control flow parity.

Residual limit: parent actual-patch formal default1 c20 remains~170ms (parent report). Five common+five broad perwave at observed combined median reductions gives~12.1ms illustrative service savings, potentially still short of~20ms gate deficit. Do not claim default1 PASS or production capacity. Root should only port this bounded candidate if worth another narrow repair, review/test exact ties, scope, cancellation and generation then run unchanged default1 acceptance. Retain FAIL if still over150ms; no scope/budget/default/gate change.

Node setReturnArrays was NOT introduced. Existing package engines>=22 includes versions whose API support was not verified; no runtime-version elevation or fallback framework is justified by this probe. No new schema/cache/result contract.

Evidence: variants.json records candidate paths and compiled SHA256; prepare-variants.py records exact transform; run-paired-probes.mjs contains execution order and oracle; paired-probes.json contains every raw result/timing and fixture hash; probes-summary.json and probe.log contain statistics/PASS. The generator normal arms rotate order each iteration, run serially after4 warm rounds of everyquery/arm. No statistical guarantee from20 per-query paired samples. Original P4 source/capacity evidence remains untouched.
