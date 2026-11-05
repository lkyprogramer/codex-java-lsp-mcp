# JSB-PAGINATION-03

Corpus: pagination · authored · debug · repair

大页码下 long 返回值仍溢出：page=100000、size=100000 应为 9999900000。修复计算类型。

English variant (same task group): Large page offsets overflow despite returning long: page=100000 and size=100000 must yield 9999900000. Fix arithmetic promotion.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {}

Follow the structured output contract; source ranges alone are plans, not read receipts.
