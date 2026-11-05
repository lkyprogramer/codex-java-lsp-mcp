# JSB-HIKARI-02

Corpus: hikari · upstream-scoped · impact · qa

定位 FastList.clear：它是否仅将 size 清零？说明旧引用如何处理，以及 backing array 是否缩容。返回 clearsReferences、shrinksArray。

English variant (same task group): Trace FastList.clear: are backing references cleared and is the backing array shrunk?

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {"clearsReferences": "boolean", "shrinksArray": "boolean"}

Follow the structured output contract; source ranges alone are plans, not read receipts.
