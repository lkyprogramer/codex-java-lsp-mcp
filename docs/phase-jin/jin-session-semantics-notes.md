# JIN session semantics notes (inherited from V5R campaign C)

Campaign C proved the **session protocol** is usable (450 consumes, no consistency accidents). FIFO selection failed; the session mechanism did not. N3 expansion must inherit these rules, not reinvent them.

## Tuple

A session is keyed by:

```text
sessionId + generation + repoHash + plannerVersion
```

Optional extra: `worktreeFamilyHash`, `runtimeBuildSha`. Any mismatch is stale.

## Fail-closed

- Stale / expired / wrong generation → explicit error (`SESSION_EXPIRED` / `CONTINUATION_STALE` / `CONTINUATION_MISMATCH`), never silent recompute.
- Complete-only writes: a session is stored only after a COMPLETE first plan with at least one consumable in-pool frontier item.
- Concurrent continues on the same `sessionId` are serialized (per-store lock). Same ids are idempotent.
- TTL + LRU (V5R: 180s / 128). stdio dies with the process; HTTP dies with the daemon. No cross-process resume.

## What is in-pool vs discovery-gap

Consumable relations (V5R): `BUDGET_EVICTED`, `CLOSED_PORT_IMPLEMENTATION`, `SECOND_HOP_EXACT`, `SIGNATURE_COLLABORATOR`, `CROSS_MODULE_ALTERNATIVE`.

Continue must not invent files that were never in the first-plan candidate pool. FIFO over those relations did **not** hit holdout golden; N3 must pick by obligation/gap, not insertion order.

## Public surface after N0-02

`java_impact action=continue` and `retrieval.enabled` are removed from the production path. The notes above are for N3 `java_context` expansion only.
