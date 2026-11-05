# JSB-MYBATIS-02

Corpus: mybatis · upstream-scoped · impact · qa

追踪参数封装：单个未标注参数若为 List，会有哪些内置 map 键？若为数组是什么键？实际参数名可用时是否另加该名字？返回 listKey、collectionKey、arrayKey、addsActualName。

English variant (same task group): Trace wrapping a single unannotated List or array parameter: listKey, collectionKey, arrayKey, addsActualName.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {"listKey": "string", "collectionKey": "string", "arrayKey": "string", "addsActualName": "boolean"}

Follow the structured output contract; source ranges alone are plans, not read receipts.
