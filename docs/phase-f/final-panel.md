# Harvest final panel (F0)

SSOT: `docs/deep/codex-java-lsp-mcp-g2-resolution-and-main-cutover-plan-2026-08-24.md` (harvest E/C/G/O/L1 closed).
Branch: `codex/jin-main`. F2 merge is authorized after F1 GO; B3 is the only stop.

Live 29-model profile (`local-qwen`): host `47.106.205.246:1082`, model `openclaw/Qwen3.8-27B-WORK`. OpenRouter profile: `stealth/ox-alpha`.

| Card | Status | Closeout | Notes |
|---|---|---|---|
| F0 panel + model bind | COMPLETE | `docs/phase-f/f0-closeout.json` | local-qwen host bound |
| E1 paired hit-rate | COMPLETE | `docs/phase-e/e1-closeout.json` | v2 pairedHitRate; v1 fields bit-identical on N5-02 replay |
| E2 prompt symmetry | COMPLETE | `docs/phase-e/e2-closeout.json` | dropped jin navigate suppression; SHA in v2 report |
| E3 collectImpactPaths candidates | COMPLETE | `docs/phase-e/e3-closeout.json` | candidates + path-like unresolved observed |
| E4 Serena + dual profile | COMPLETE | `docs/phase-e/e4-closeout.json` | SERENA_ABANDONED; --model-profile local-qwen/openrouter |
| C1 candidates/evidence/next | COMPLETE | `docs/phase-c/c1-closeout.json` | T2 mean 0.931; in-pool 0; exam-room 8/8; MeQuery/ApplyInfo/ApplyPayTemplate on wire; 5 DISCOVERY_GAP; C2 P50 1.013 |
| C2 byte slim | COMPLETE | `docs/phase-c/c2-closeout.json` | T2 first-call P50 1.013≤1.2 |
| C3 evidence budget | COMPLETE | `docs/phase-c/c3-closeout.json` | cap 3 kept; 30% token drop vs 2000; schema 578; coverage 0.931 not reverted |
| G1 ruoyi-vue-pro golden | COMPLETE | `docs/phase-g/g1-closeout.json` | 40 scenes / 12 holdout; pin 2bbe79b3; holdout frozen |
| G2 leave-one-repo-out | OBSERVATION (user option C, 2026-08-24) | `docs/phase-g/g2-closeout.json` | three-repo folds GO; ruoyi recorded as observation (default chain is identity vs main, so no merge regression); see b3-escalation.md ruling |
| O1 child RSS ≤ 1536 | G3_MISS | `docs/phase-o/o1-closeout.json` | three knives landed; lishuedu 1851 MiB floor; gate kept; residual to F1 |
| O2 cold ≤ 60s | O2_MISS | `docs/phase-o/o2-closeout.json` | registry reuse landed; lishuedu 83.5s > 60s; shards not landed; gate kept |
| O3 G5 steady ≤ 1.10 | COMPLETE | `docs/phase-o/o3-closeout.json` | warmup 2; post-O1/O2 remeasure 0.802/0.614/0.890; G1 173/29/46 |
| L1 dual-model live | FAIL_RECORDED | `docs/phase-l/l1-closeout.json` | both models MEASURED FAIL; jin 0/6 vs old 1/6; paired delta −0.476; kill java_context from PUBLIC_JAVA_TOOLS; no fourth live |
| A1 ruoyi golden audit | GOLDEN_NOISY | `docs/phase-a/a1-closeout.json` | tuning 13/28 noisy (0.464); control 0; holdout unread; next A2a |
| A2a re-derive + LORO | GOLDEN_FIXED_CHAIN_STILL_FAILS | `docs/phase-a/a2a-closeout.json` | 238/382 pass filter; LORO ruoyi pRead/rReadMust still >15%; recall now passes; next B0 |
| A2b observation downgrade | ACTIVATED_BY_OPTION_C | | user chose C on 2026-08-24; ruoyi = observation repo, LORO gate = three-repo folds GO + ruoyi recorded |
| B0 miss-layer diagnosis | NOT_IN_POOL_STRUCTURAL | `docs/phase-b/b0-closeout.json` | diagnostic ranking pool; 76 misses; NOT_IN_POOL 40.8% > 40%; selection 59.2%; no B knives |
| B1/B2 chain knives | SKIPPED | | not entered; discovery-layer miss |
| B3 escalation | RESOLVED_OPTION_C | `docs/phase-b/b3-closeout.json` | user chose C (2026-08-24 11:53); ruling recorded in b3-escalation.md; option B filed as future project with entry condition (real-usage NOT_IN_POOL gap on non-golden repos) |
| F1 compare vs github main | FAIL_WRONG_TREE | `docs/phase-f/f1-closeout.json` | github main is pre-V4 (54 files). cipherlink numbers match V4-final new; holdout 0.55 is a V4 residual. See cipherlink-holdout-project.md |
| F1 compare vs N0 | GO | `docs/phase-f/f1-n0-closeout.json` | quality identity vs N0; token −27%; ruoyi GO; G1 57/14/21; S1 415; S2 725≤1433.6 after digest-without-unpack |
| F2 merge + attestation | COMPLETE | `docs/phase-f/f2-attestation.json` | merge `e48a253` non-squash; gate pr/nightly/release GO; 5 tools; not pushed |
| F3 soak | F3_SOAK_STARTED | `docs/phase-f/f3-soak.md` | 24–48h not elapsed; rollback = revert -m 1 e48a253 |
| R1 call telemetry | GO (branch, not installed) | `docs/phase-r/r1-closeout.json` | silent JSONL under cache/telemetry; live daemon untouched |
