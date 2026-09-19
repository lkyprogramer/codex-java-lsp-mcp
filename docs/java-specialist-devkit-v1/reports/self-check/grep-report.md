# Java Specialist Benchmark Report

- Arm: `grep`
- Dataset: `c34a7c7c2f261bb273bc622739eae6beff8479ca96512c48942638cd912b8c4d`
- Scope: `bundled-scoped`

| Metric | Value |
|---|---:|
| attempts | 72 |
| task_groups | 36 |
| status_counts | {"OK": 70, "NOT_FOUND": 2} |
| invalid | 0 |
| over_budget | 0 |
| declaration_recall_at_10 | 0.8333333333333334 |
| mrr | 0.41731150793650795 |
| ndcg_at_10 | 0.5135410650906388 |
| required_line_recall | 0.8612801293356849 |
| received_line_recall | 0.8612801293356849 |
| anchor_containment | 0.5 |
| emitted_bytes | 2033.513888888889 |
| received_bytes | 2033.513888888889 |
| qa_contract_pass_rate | null |
| provider_input_measured_attempts | 0 |
| provider_input_tokens_total | null |
| repair_success | "UNMEASURED_USE_FROZEN_REPAIR_RUNNER" |

## Case results

| Task / variant | Status | R@10 | Required lines | Received lines | QA |
|---|---|---:|---:|---:|---|
| JSB-PAYMENTS-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAYMENTS-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAYMENTS-02 / primary | NOT_FOUND | 0.0 | 0.0 | 0.0 | None |
| JSB-PAYMENTS-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAYMENTS-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAYMENTS-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-INVENTORY-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-INVENTORY-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-INVENTORY-02 / primary | OK | 0.5 | 0.6 | 0.6 | None |
| JSB-INVENTORY-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-INVENTORY-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-INVENTORY-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-ACCESS-01 / primary | OK | 1.0 | 0.5 | 0.5 | None |
| JSB-ACCESS-01 / en | OK | 0.0 | 0.5 | 0.5 | None |
| JSB-ACCESS-02 / primary | OK | 0.5 | 0.6666666666666666 | 0.6666666666666666 | None |
| JSB-ACCESS-02 / en | OK | 1.0 | 0.6666666666666666 | 0.6666666666666666 | None |
| JSB-ACCESS-03 / primary | OK | 1.0 | 0.5 | 0.5 | None |
| JSB-ACCESS-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-ADMISSIONS-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-ADMISSIONS-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-ADMISSIONS-02 / primary | OK | 0.5 | 0.5 | 0.5 | None |
| JSB-ADMISSIONS-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-ADMISSIONS-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-ADMISSIONS-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PRICING-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PRICING-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PRICING-02 / primary | OK | 0.5 | 0.6666666666666666 | 0.6666666666666666 | None |
| JSB-PRICING-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PRICING-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PRICING-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PETCLINIC-01 / primary | NOT_FOUND | 0.0 | 0.0 | 0.0 | None |
| JSB-PETCLINIC-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PETCLINIC-02 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PETCLINIC-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PETCLINIC-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PETCLINIC-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-MYBATIS-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-MYBATIS-01 / en | OK | 1.0 | 0.4074074074074074 | 0.4074074074074074 | None |
| JSB-MYBATIS-02 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-MYBATIS-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-MYBATIS-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-MYBATIS-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-GSON-01 / primary | OK | 0.0 | 1.0 | 1.0 | None |
| JSB-GSON-01 / en | OK | 0.0 | 1.0 | 1.0 | None |
| JSB-GSON-02 / primary | OK | 0.0 | 0.2857142857142857 | 0.2857142857142857 | None |
| JSB-GSON-02 / en | OK | 0.0 | 0.2857142857142857 | 0.2857142857142857 | None |
| JSB-GSON-03 / primary | OK | 0.0 | 0.05 | 0.05 | None |
| JSB-GSON-03 / en | OK | 0.0 | 0.05 | 0.05 | None |
| JSB-NOTIFICATIONS-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-NOTIFICATIONS-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-NOTIFICATIONS-02 / primary | OK | 0.5 | 0.3333333333333333 | 0.3333333333333333 | None |
| JSB-NOTIFICATIONS-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-NOTIFICATIONS-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-NOTIFICATIONS-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-LEDGER-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-LEDGER-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-LEDGER-02 / primary | OK | 0.5 | 1.0 | 1.0 | None |
| JSB-LEDGER-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-LEDGER-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-LEDGER-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAGINATION-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAGINATION-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAGINATION-02 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAGINATION-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAGINATION-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-PAGINATION-03 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-HIKARI-01 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-HIKARI-01 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-HIKARI-02 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-HIKARI-02 / en | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-HIKARI-03 / primary | OK | 1.0 | 1.0 | 1.0 | None |
| JSB-HIKARI-03 / en | OK | 1.0 | 1.0 | 1.0 | None |

## Limits
Corpus-scoped QA is not a full repository repair benchmark. Missing/unsupported attempts remain in the denominator. Repair results require separately recorded frozen-test execution. Variants and tasks in the same corpus are correlated; use cluster-aware comparison.
