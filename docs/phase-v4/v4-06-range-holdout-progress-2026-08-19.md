# V4-06 range / holdout 进展（2026-08-19）

## 主机政策

用户确认：三仓测试在 1 分钟 load < 20 时必须执行，不得因 load 阻断。已固化：

- `docs/phase-v4/three-repo-host-load-policy.md`
- `scripts/host-quiet.mjs`：`THREE_REPO_LOADAVG_PROCEED_BELOW = 20`，`refuse` 恒为 false
- `.cursor/rules/three-repo-load-gate.mdc`
- `HANDOFF.md` / 三仓 runbook / V4 计划 §7.5

唯一主机硬门仍是可用内存 ≥ 4 GiB。

## 上一轮 hydrate 矩阵（已完成，勿当本轮分母）

产物：`/tmp/codex-java-lsp-v4-06-hydrate-20260818-233402/`  
baseline `df2ca1f`，candidate `f0e2ef1`，`--runs 5`。候选测试 158/158。exit 1 = 质量绝对门槛 FAIL（分母），不是 hydrate 回归。

| 仓 | RangeLineRecall old→new | holdout rReadMust | tokens P50 |
|---|---|---|---|
| lishuedu | 0.634 → **0.734** | 0.5 | 4308 → 4496（+188） |
| cipherlink | 0.85 → 0.85 | 0.55 | 3606 不变 |
| exam-parent-v3 | 0.5525 → 0.5525 | 0.40 | 3395 不变 |

lishuedu 闭合：`storage-signed-url` 0.5→1、`report-reusable-zip` 0.5→1。

## 剩余 miss 分类（r1-new vs frozen golden）

**NEAR-MISS-HEADER / (1,1)**：Assembler 1–35、AuditOrderMapper 1–29、PaperAccessService 1–23。  
**NEAR-MISS-WRONG-RANGE**：同文件第二方法或方法截断（exam-score 后续方法、apply-info 136–202 vs 136–226、rule-engine 103–130）。  
**DTO type-header**：CebOrderRequest 10–22 vs 10–61。  
**ABSENT-FROM-READPLAN / CANDIDATES**：多数 holdout，属预算/召回，不是本刀 hydrate。

## 本轮代码（相对 `f0e2ef1`）

1. `positionFromFacts` 增加 `typeName`：唯一引用该类型的方法取代 `(1,1)`；多方法同名类型保持 `(1,1)`。type/import graph 传入 `anchor.className`。目标：`benefit-product-code-dto` Assembler 50–54。
2. `QUERY_READ_RANGES`：无实例方法的类型读整型体（上限 80 行），不用 13 行 header。目标：`ceb-order-create-dto`。
3. `methodRangeEnd` 取 declaration/body 较大端。目标：差一行的 near-miss。
4. relationship CALLS：用已加载的 framework 方法行，不新开 hydrate。

隔离 targeted：67/67 绿（host-quiet、candidate-helpers、collectors、relationship-provider、java-index-client）。

## 下一测量

正式三仓矩阵 `--baseline f0e2ef1`，`--runs 5`，冻结仓 `/tmp/codex-java-v3-golden-20260809/{lishuedu,cipherlink,exam-parent-v3}`。  
验收仍是三仓 RangeLineRecall=1.0 与 holdout rReadMust=1.0；本轮预期先抬 lishuedu assembler 与 exam DTO，不承诺一次过门。
