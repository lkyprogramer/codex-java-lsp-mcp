# Reverse-query continuation (design only, Phase 4)

V5R §7.3 / §9.5: reverse callers that never entered the first-call pool are **not** dropped top-K. They need an extra worker query (`QUERY_CALLERS` or a purpose-built reverse bundle), with budget, query type, and completion on the item.

Phase 4 does **not** open that query.

- Consumable frontier = already-materialized, unselected ReadUnits (budget-evicted / second hop / implementer / collaborator).
- `REVERSE_CALLER_QUERY` items go to `deferredQueries` with `notOpened: true`.
- No extra `QUERY_CALLERS` RPC. No `java_impact action=continue`. No session store.

Open this only after Phase 4 GO **and** a later phase that budgets the extra query. Until then, holdout files that are absent from the first-call candidate pool stay a **candidate-discovery** gap, not a continuation item.
