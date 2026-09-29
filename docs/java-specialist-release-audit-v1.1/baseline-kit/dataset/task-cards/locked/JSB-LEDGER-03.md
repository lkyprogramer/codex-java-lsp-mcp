# JSB-LEDGER-03

Corpus: ledger · authored · debug · repair

负数划转导致借方余额增加。修复校验，非法金额应抛异常且两边余额不变。

English variant (same task group): A negative transfer increases the debit balance. Reject it before mutating either balance.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {}

Follow the structured output contract; source ranges alone are plans, not read receipts.
