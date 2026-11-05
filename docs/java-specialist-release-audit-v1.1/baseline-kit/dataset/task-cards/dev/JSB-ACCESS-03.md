# JSB-ACCESS-03

Corpus: access · authored · debug · repair

到期瞬间仍允许访问。修复边界，过期前允许、到期时和到期后拒绝。不要删除长方法其他逻辑。

English variant (same task group): An access grant still works at the exact expiry instant. Reject now >= expiresAt; preserve the rest of the long method.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {}

Follow the structured output contract; source ranges alone are plans, not read receipts.
