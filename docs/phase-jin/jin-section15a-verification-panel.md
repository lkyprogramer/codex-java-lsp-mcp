# JIN 15A 验证面板（2026-08-21）

对照 `docs/deep/codex-java-lsp-mcp-v5r-postmortem-and-java-intelligence-next-clean-slate-plan-2026-08-20.md` §15 / 15A 退出卡。

## 裁决

**N5 FAIL。不进 N6。不合 `main`。**

证据树 HEAD `8ae1c1d`。live raw SHA-256 `9a398537da83054fe6beab8d6270f9389854254a72de734dbba9c2c5426d503b`。

| Phase | 退出卡 | 决策 |
|---|---|---|
| N0 | 基线可复现 + T3 identity + LOC 下降 | **COMPLETE** |
| N0.5 | identity + token P50 ≥20% + p95≤1.10 + 实体入口 ≥80% | **COMPLETE** |
| N1 | cold/增量过；RSS ≤512 MiB **FAIL** | **FAIL**（门不放宽） |
| N2a | discovery 8/8；RSS 不回退 N1 | **COMPLETE**（RSS 继承） |
| N3 | mustHit ≥0.95；p95 vs 默认 impact **UNMEASURED** | **COMPLETE** |
| N4 | 3/4（token/p95/holdout GO；Range FAIL） | **PARTIAL**（已进 N5） |
| N5 | 质量并列；轮次/token FAIL；live false 未闭合；502/503 | **FAIL** |
| N6 | 硬门未跑 | **NOT_STARTED** |

## 隔离横幅（N5 HEAD）

| 跑次 | isolation | `JDTLS_BIN` | executableTree | SHA-256 |
|---|---|---|---|---|
| T0 29/29 | detached-local-clone `XfUadH` | `/usr/bin/false` | `4b212d28…` | banner `802d16cc…` / log `ee93dd54…` |
| T1 1146+194 fail 0 | detached-local-clone `WKs1S9` | `/usr/bin/false` | `4b212d28…` | banner `0faee53a…` / log `fc5286cc…` |
| live 三臂 | detached-local-clone `EZGHoc` | `/usr/bin/false` | `20a99abc…` | banner `1cb7b24b…` / trace `9a398537…` |

T1 smoke 工具列表含 `java_context`。raw 日志不入库。

## 机器可读

`docs/phase-jin/jin-section15a-verification-panel.json`
