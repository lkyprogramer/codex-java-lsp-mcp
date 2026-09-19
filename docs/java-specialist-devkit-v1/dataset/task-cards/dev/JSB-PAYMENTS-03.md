# JSB-PAYMENTS-03

Corpus: payments · authored · debug · repair

同租户两个不同请求被当成重复。修复去重键，保留同租户同请求被拒绝的行为。

English variant (same task group): Two different requests of the same tenant are rejected as duplicates. Fix the key, preserving tenant/request idempotency.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {}

Follow the structured output contract; source ranges alone are plans, not read receipts.
