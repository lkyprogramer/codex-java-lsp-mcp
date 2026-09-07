# P0 blocked: G4 DB size after zlib

- dated: 2026-09-07
- branch: `codex/index-on-disk`
- sha: `f9cbe18` (HEAD / G1); G2–G4 measured on `86de82e` zlib DB still at `/tmp/iod-lishuedu.sqlite`
- phase base: `6885b17`
- repo: `/Users/luo/Documents/program/lishu/lishuedu`
- db: `/tmp/iod-lishuedu.sqlite`

## Decision

P0 stops here. Manual P0-G4 required `zlib.deflateRawSync` on `facts` and a remeasure; the remeasure is still over the 350 MB cap. No remaining in-schema compression step is specified.

**User 2026-09-07:** keep P0 at this blocked report; do not raise G4, do not change the frozen schema, do not defer entity tables in-phase, do not write `p0-closeout.json`, do not tag `iod/P0`, **do not start P1** until a later explicit instruction.

## Measured gates (lishuedu cold build, `86de82e`)

Command:

```bash
/usr/bin/time -l node --disable-warning=ExperimentalWarning \
  dist/java-index/builder/builder-main.js \
  --repo /Users/luo/Documents/program/lishu/lishuedu \
  --db /tmp/iod-lishuedu.sqlite --mode cold
stat -f %z /tmp/iod-lishuedu.sqlite
```

| id | target | measured | pass |
| --- | --- | --- | --- |
| P0-G2 | ≤ 180 s | 133.18 s wall | yes |
| P0-G3 | ≤ 600 MiB RSS | 461504512 B = 440.1 MiB (`maximum resident set size`) | yes |
| P0-G4 | ≤ 350 MB | 1407225856 B = 1342.0 MiB (`stat -f %z`); freelist 0 | **no** |
| counts | A.1 | files 6090, types 7319, methods 25077, edges 253711 | yes (exact) |

Later gates (still no P0 closeout while G4 fails):

| id | target | measured | pass |
| --- | --- | --- | --- |
| P0-G5 | four-repo counts ±1% vs live snapshot | lishuedu/cipherlink/exam-parent-v3 exact; lishu-v2 files 3036 vs 3013 (+0.763%), types +0.714%, fields +0.754%, methods +0.917%, edges +0.886% after last-write-wins upsert | yes |
| P0-G6 | kill -9 at 90s then resume ≤ 1.3× G2 (173.134 s) | resume 133.61 s; kill at `phase=resolve, done=6090/6090`; WAL 5702763952 B at kill | yes |
| P0-G7 diff | old src files vs `6885b17` only `entity-search.ts` + `graph-store.ts` | `docs/phase-x/p0-gate-raw/P0-G7-diff-stat.txt` | yes |
| P0-G1 | isolated `full` | SHA `f9cbe18`; dist 1351 pass + scripts 282 pass + stdio smoke; `FULL_EXIT=0` (~234 s) | yes |
| P0-G7 `gate:pr` | isolated compile + `dist/**/*.test.js` | `exitCode` 0; `rawSha256` `6f7af5804a57cbbb2ed3143b25283d00aaa94fea738db3dcdddbe45a2698a9d7`; 1351 pass | yes |
| three-repo cold-nolsp | `--runs 5` vs `6885b17` (load < 20, must run) | `THREE_REPO_EXIT=2`. 18 cells written on frozen clones (lishuedu `db63b1a7e`, cipherlink `fa43398`, exam-parent-v3 `f90a0b47`). Verifier: every `*.json.stderr` is the in-process-parse cap-waived line (isolated validation disables cold-build child). Quality/p95 never scored. | **no** |

0.6 code review complete at `8670700` (round-3 approved `226e8a9..8670700`, no remaining P0/P1). G4 still blocks closeout. Details: `docs/phase-x/p0-review.md`.

lishu-v2 first G5 attempt failed `UNIQUE constraint failed: type.type_id` on duplicated FQN `com.limou.answercard.AnswerCard` under two `deploy/recognition-runners/` trees. Heap `typesById.set` last-write-wins; SQL `writeBundle` now `ON CONFLICT DO UPDATE` for type/field/method/edge.

Before zlib, the same corpus was 2090668032 B (1993.4 MiB). zlib cut about 650 MiB of `facts` payload and left indexes + `entity_token` dominant.

## Why 350 MB is unreachable on the frozen schema

`dbstat` on the zlib DB (4 KiB pages):

| object | MiB |
| --- | --- |
| `entity_token` | 212.2 |
| `entity_token_lookup` | 185.8 |
| `kg_edge` (table) | 207.8 |
| `edge` (table) | 204.9 |
| `sqlite_autoindex_edge_1` | 63.4 |
| `kg_edge_from` / `kg_edge_to` / `kg_edge_owner` | 60.8 + 59.6 + 34.6 |
| `kg_node` | 53.6 |
| `edge_from_kind` / `edge_to_kind` | 41.6 + 22.3 |
| `method` | 41.3 |

`entity_token` + `entity_token_lookup` = **398.0 MiB**, already above 350 MB with every `facts` blob deleted. Those rows are `(entity_id, field, token, tf)` plus the frozen `CREATE INDEX entity_token_lookup ON entity_token(field, token)`. zlib does not apply.

Edge/kg B-tree indexes on scalar ids are similarly uncompressed.

## What was implemented

- `rows.ts` `encodeFacts` / `decodeFacts`: `zlib.deflateRawSync` / `inflateRawSync` of JSON text; SQL binds a BLOB (`?`), not `jsonb(?)`.
- Readers that used `json(facts)` / `json_extract` / `json_each` now decode in JS (`facts-store.ts`, `knowledge-graph.ts`, `entity-tokens.ts`).
- Builder pass 3 stays streaming (P0-T7 fix `0b68c28`); method/type lookups inflate JSON text only for `signatureKey` / `modifiers`, not `callSites`.

## Options that need an explicit user decision

1. Raise P0-G4 (a floor near **1400 MB** matches this schema on lishuedu).
2. Change the frozen schema (drop `entity_token_lookup`, stop storing reverse `kg_edge` rows, or drop `entity.facts` / duplicate JSON). That is outside P0 as written.
3. Defer entity token tables to P1 and rebuild G4 against facts+graph only (still ~900+ MiB of edge/kg tables+indexes after zlib).

P1–P3 are not started.
