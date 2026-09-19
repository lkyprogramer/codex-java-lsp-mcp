# JSB-PETCLINIC-01

Corpus: petclinic · upstream-scoped · entry · qa

入口定位：宠物名称为空或超长分别会如何拒绝？给出拒绝的字段、两个错误码以及长度上限。

English variant (same task group): Locate pet-name validation: field, blankCode, longCode, maxLength.

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {"field": "string", "blankCode": "string", "longCode": "string", "maxLength": "integer"}

Follow the structured output contract; source ranges alone are plans, not read receipts.
