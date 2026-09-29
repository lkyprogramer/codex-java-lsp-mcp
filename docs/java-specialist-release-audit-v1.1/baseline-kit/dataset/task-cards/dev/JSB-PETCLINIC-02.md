# JSB-PETCLINIC-02

Corpus: petclinic · upstream-scoped · impact · qa

类型字段检查对新宠物与已保存宠物是否不同？另外出生日期空值是否同样受 isNew 限制？返回 newOnly 和 birthDateNewOnly。

English variant (same task group): Is a missing pet type rejected only for new pets? Is birthDate validation also new-only?

Budget: {"max_regions": 8, "max_lines": 160, "max_bytes": 16000, "deadline_ms": 10000}

Answer keys/types: {"newOnly": "boolean", "birthDateNewOnly": "boolean"}

Follow the structured output contract; source ranges alone are plans, not read receipts.
