# JSB-INVENTORY-03

Corpus: inventory · authored · debug · repair

重复取消同一个预留会凭空增加库存。只修复 release 的幂等性，不改变正常 reserve。

English variant (same task group): Releasing the same reservation twice creates stock. Make release idempotent without changing reserve.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {}

Follow the structured output contract; source ranges alone are plans, not read receipts.
