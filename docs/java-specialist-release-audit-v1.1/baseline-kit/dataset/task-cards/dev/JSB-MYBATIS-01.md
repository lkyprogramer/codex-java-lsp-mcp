# JSB-MYBATIS-01

Corpus: mybatis · upstream-scoped · entry · qa

定位 Mapper 参数的命名规则：未标注 @Param 且 actual-name 开关关闭时，跳过 RowBounds 后的第二个普通参数名称是什么？返回 name、specialType1、specialType2（短类名按字母序）。

English variant (same task group): For a mapper (int a, RowBounds rb, int b) with no @Param and actual names disabled, name the second ordinary parameter and the two skipped special types.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {"name": "string", "specialType1": "string", "specialType2": "string"}

Follow the structured output contract; source ranges alone are plans, not read receipts.
