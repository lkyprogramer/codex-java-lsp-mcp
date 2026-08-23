# Harvest final panel (F0)

SSOT: `docs/deep/codex-java-lsp-mcp-jin-n5-live-postmortem-and-value-harvest-plan-2026-08-23.md`.
Branch: `codex/jin-main`. **Do not merge `main` until the user decides.**

Live 29-model profile (`local-qwen`): host `47.106.205.246:1082`, model `openclaw/Qwen3.8-27B-WORK`. OpenRouter profile: `stealth/ox-alpha`.

| Card | Status | Closeout | Notes |
|---|---|---|---|
| F0 panel + model bind | COMPLETE | `docs/phase-f/f0-closeout.json` | local-qwen host bound |
| E1 paired hit-rate | COMPLETE | `docs/phase-e/e1-closeout.json` | v2 pairedHitRate; v1 fields bit-identical on N5-02 replay |
| E2 prompt symmetry | COMPLETE | `docs/phase-e/e2-closeout.json` | dropped jin navigate suppression; SHA in v2 report |
| E3 collectImpactPaths candidates | COMPLETE | `docs/phase-e/e3-closeout.json` | candidates + path-like unresolved observed |
| E4 Serena + dual profile | COMPLETE | `docs/phase-e/e4-closeout.json` | SERENA_ABANDONED; --model-profile local-qwen/openrouter |
| C1 candidates/evidence/next | COMPLETE | `docs/phase-c/c1-closeout.json` | contract v2; schema 578≤700; T2 goldens empty |
| C2 byte slim | COMPLETE | `docs/phase-c/c2-closeout.json` | P50 1.009≤1.2; wire N=12; T2 goldens empty |
| C3 evidence budget | COMPLETE | `docs/phase-c/c3-closeout.json` | cap 3; budget 1400; T2 goldens empty |
| G1 ruoyi-vue-pro golden | COMPLETE | `docs/phase-g/g1-closeout.json` | 40 scenes / 12 holdout; pin 2bbe79b3; holdout frozen |
| G2 leave-one-repo-out | G2_OVERFIT_FAIL | `docs/phase-g/g2-closeout.json` | ruoyi held-out drop >15%; blocks F not L1; no retune |
| O1 child RSS ≤ 1536 | PENDING | | |
| O2 cold ≤ 60s | PENDING | | depends O1 |
| O3 G5 steady ≤ 1.10 | PENDING | | |
| L1 dual-model live | PENDING | | one shot; FAIL kills java_context |
| F1 compare vs main | PENDING | | no merge |
| F2 merge + attestation | BLOCKED | | user-only merge |
| F3 soak | BLOCKED | | after user merge |
