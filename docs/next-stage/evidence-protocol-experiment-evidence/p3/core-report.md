# P3 query-worker core frozen implementation

Production default remains one read-only reader; explicit experimental workerCount is 1 or 2. One global FIFO-with-exact-priority waiting queue has maximum 32; queueMax may reduce but never exceed it. Each slot retains its worker until terminate and exit both settle. Worker error preserves slot ownership until exit. close is a shared barrier over all slot termination and request settlement. release covers every currently alive reader, including terminating slots.

Shared experimental configureSharedQueryWorker rejects configuration while the old pool is active or closing. SQL ranking, budgets, per-query read transaction and generation code were not modified. DB inode identity reopening applies independently to both readers. Pool options are copied on construction.

Optional onTiming observes one event per settled accepted/immediately expired/queue-full request; search after close rejects without creating a new request. Queue duration, dispatch-to-settlement and actual worker service intervals are independent. Startup and termination are in dispatchReplyMs; cancellation lacking a completed worker reply has null actualServiceMs. Observer exceptions cannot change query settlement. First two synchronous calls in a Promise.all warm batch dispatch to separate slots; successful replies prove both cached DB/statement execution paths warmed.

## Verification

Command: sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted --keep -- node --test --test-concurrency=1 dist/discovery/query-worker.test.js

Latest log: core-validation-reviewed.log. Isolated TypeScript compilation PASS; query-worker tests 18/18 PASS, zero failed/cancelled/skipped. Candidate: /var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-b8DTNO/candidate. git diff --check for both owned files PASS.

Tests retain original default-one result/queue/deadline/event-loop/release/priority coverage and add single/dual global queue priority + service timing, delayed termination release/close settlement, dual connection release/inode replacement, exact result/generation parity while metadata commits, shared configuration refusal, two-thread peak during kill/respawn, error-to-exit slot ownership, and throwing observer isolation.

Native SQLite interruption mid-step remains unavailable in Node 22; tests simulate delayed termination and exercise real reader handles, WAL checkpoint and actual SQL. Capacity benchmarks, LLM requests, production runtime/index/cache builds, full-suite checks, commits and pushes were not run by this owner. Independent review remains the parent stage gate.

Hashes are frozen in core-files-sha256.json.
