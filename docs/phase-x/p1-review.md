# P1 0.6 review

Range: `iod/P0` (`88d5c80`) .. P1 closeout SHA.

## Round 1 (reviewer on `36e6125`)

P0=0, P1=2, P2=4.

- **P1-1** (fixed): `successors()` always `ensureAdj()` during SQL cold-build `replaceFile` → O(files×graph). Write path now keeps per-node SQL; adj cache only after `prefetch()`.
- **P1-2** (fixed): MCP `plan: true` had no SQL dual-end. `sql-queries.test.ts` now compares PaymentGateway `plan: true` (intent/coverage/unresolved/evidence paths).
- P2-1..P2-4 deferred (planner scan vs edges; cache array copy/WAL; empty-db query throw; read-ranges duplication).

Disclosed, not findings: graph-layer live-repo superset; G3 context 62ms vs 25ms cap; G5 floors fail both arms.

## Round 2

P1-1/P1-2 patched. Isolated targeted: knowledge-graph + sql-queries + cold-build 6/6 pass. P0=0 P1=0 remaining on those two. P2 items not in this phase.
