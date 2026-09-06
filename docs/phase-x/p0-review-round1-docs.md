# P0 0.6 round-1 Doc-Consistency Auditor

- auditor: Cursor generalPurpose subagent `46b25b14-9599-4900-b5e7-65b83dbc3066`
- SHA_PHASE reviewed: `f9cbe18`
- PHASE_BASE: `6885b17`
- dated: 2026-09-07
- implementer action this turn: evidence hygiene only; no closeout; no P1; wait for Code Reviewer before `fix(iod): P0 review fixes`

## Blocking for closeout (auditor)

P0-G4 fail (1407225856 B). No `p0-closeout.json`. git status not clean. G2/G3/G4 originally lacked dedicated raw files. G7 diffstat was `86de82e` not `f9cbe18`. Three-repo not finished.

## Disposition (implementer)

| id | auditor | action |
| --- | --- | --- |
| G4 1342 MiB | blocking | wait user: raise gate / schema / defer entity. No silent raise. |
| missing closeout JSON | process | will write only after G4 decision + review round-2 |
| G7 diffstat SHA | process | regenerated `6885b17..f9cbe18` (+3111/-133, whitelist still entity-search.ts + graph-store.ts) |
| missing G2/G3/G4 raw | process | added provenance files; G4 `stat` remeasured 1407225856 this session; G2/G3 original `time -l` not retained |
| T5 resolve loop from offset 0 | scope | defer to combined review-fix after Code Reviewer |
| cache_size=-16384 override | scope | defer; not a JAVA_LSP_* switch |
| extra fix commits vs 1-task-1-commit | process | do not rewrite history |
| zlib vs handbook jsonb | documented G4 change | do not edit handbook except Task splits |
| git dirty (worktree-family, untracked manuals) | process | leave unrelated; do not commit manuals in this turn |

G2/G3/G5/G6 numbers internally consistent. Code Reviewer findings P1-1–P1-7 are in `docs/phase-x/p0-review.md` and the `fix(iod): P0 review fixes` commit. Three-repo `--runs 5` retry on frozen golden SHAs still running at that commit.
