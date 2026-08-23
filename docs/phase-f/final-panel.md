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
| C1 candidates/evidence/next | COMPLETE | `docs/phase-c/c1-closeout.json` | T2 mean 0.59 DISCOVERY_GAP floor; N=24 |
| C2 byte slim | COMPLETE | `docs/phase-c/c2-closeout.json` | T2 first-call P50 0.951≤1.2 |
| C3 evidence budget | COMPLETE | `docs/phase-c/c3-closeout.json` | cap 3; not reverted; T2 floor recorded |
| G1 ruoyi-vue-pro golden | COMPLETE | `docs/phase-g/g1-closeout.json` | 40 scenes / 12 holdout; pin 2bbe79b3; holdout frozen |
| G2 leave-one-repo-out | G2_OVERFIT_FAIL | `docs/phase-g/g2-closeout.json` | ruoyi held-out drop >15%; blocks F not L1; no retune |
| O1 child RSS ≤ 1536 | G3_MISS | `docs/phase-o/o1-closeout.json` | three knives landed; lishuedu 1851 MiB floor; gate kept; residual to F1 |
| O2 cold ≤ 60s | O2_MISS | `docs/phase-o/o2-closeout.json` | registry reuse landed; lishuedu 83.5s > 60s; shards not landed; gate kept |
| O3 G5 steady ≤ 1.10 | COMPLETE | `docs/phase-o/o3-closeout.json` | warmup 2; 0.835/0.547/0.886; G1 173/29/46 |
| L1 dual-model live | BLOCKED_EXTERNAL | `docs/phase-l/l1-closeout.json` | OpenRouter 429 + local-qwen 404; TaskSuccess UNMEASURED; no kill |
| F1 compare vs main | BLOCKED | | blocked by G2_OVERFIT_FAIL; no merge |
| F2 merge + attestation | BLOCKED | | user-only merge |
| F3 soak | BLOCKED | | after user merge |
