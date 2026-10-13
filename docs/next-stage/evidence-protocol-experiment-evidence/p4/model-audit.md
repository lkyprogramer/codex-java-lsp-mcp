# P4 原始结果审计 (FINAL)

检查 11026 项；错误 0 项。full 72/72，diagnostic 24/24。

数据完整性结论基于保存的原始请求/响应、实际工具调用、messages 投影、整文件快照、冻结评分与外部 repair judge。局部输出仅作 PARTIAL 校核；FINAL 必须通过 96 个计划键和两组 COMPLETE。

| full arm / kind | strict | format | value | required evidence | budget | prompt | completion | cached | uncached |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| control / qa | 12/28 | 28/28 | 19/28 | 20/28 | 28/28 | 203936 | 6370 | 148191 | 55745 |
| control / repair | 8/8 | 8/8 | external judge | 7/8 | 8/8 | 76958 | 2555 | 61677 | 15281 |
| product / qa | 12/28 | 28/28 | 16/28 | 24/28 | 28/28 | 219716 | 5167 | 144012 | 75704 |
| product / repair | 8/8 | 8/8 | external judge | 7/8 | 8/8 | 85962 | 2637 | 68310 | 17652 |

已配对 36 任务：双方成功 17；仅 control 3；仅 product 3；双方失败 13。

| task | control strict | product strict | control format/value/evidence/budget | product format/value/evidence/budget |
|---|---|---|---|---|
| JSB-GSON-01 | true | false | true/true/true/true | true/false/true/true |
| JSB-PAYMENTS-02 | false | false | true/true/false/true | true/true/false/true |
| JSB-PAYMENTS-01 | true | true | true/true/true/true | true/true/true/true |
| JSB-PAYMENTS-03 | true | true | true/N/A/true/true | true/N/A/true/true |
| JSB-INVENTORY-01 | true | true | true/true/true/true | true/true/true/true |
| JSB-INVENTORY-02 | true | true | true/true/true/true | true/true/true/true |
| JSB-INVENTORY-03 | true | true | true/N/A/true/true | true/N/A/true/true |
| JSB-ACCESS-01 | false | false | true/true/false/true | true/true/false/true |
| JSB-ACCESS-02 | false | false | true/true/false/true | true/true/false/true |
| JSB-ACCESS-03 | true | true | true/N/A/false/true | true/N/A/false/true |
| JSB-ADMISSIONS-01 | true | false | true/true/true/true | true/false/true/true |
| JSB-ADMISSIONS-02 | false | false | true/false/true/true | true/false/true/true |
| JSB-ADMISSIONS-03 | true | true | true/N/A/true/true | true/N/A/true/true |
| JSB-PRICING-01 | false | false | true/false/true/true | true/false/true/true |
| JSB-PRICING-02 | false | true | true/true/false/true | true/true/true/true |
| JSB-PRICING-03 | true | true | true/N/A/true/true | true/N/A/true/true |
| JSB-PETCLINIC-01 | true | true | true/true/true/true | true/true/true/true |
| JSB-PETCLINIC-02 | true | true | true/true/true/true | true/true/true/true |
| JSB-PETCLINIC-03 | false | false | true/false/true/true | true/false/true/true |
| JSB-MYBATIS-01 | true | false | true/true/true/true | true/false/true/true |
| JSB-MYBATIS-02 | false | true | true/true/false/true | true/true/true/true |
| JSB-MYBATIS-03 | false | false | true/false/true/true | true/false/true/true |
| JSB-GSON-02 | false | false | true/false/false/true | true/false/true/true |
| JSB-GSON-03 | true | true | true/true/true/true | true/true/true/true |
| JSB-NOTIFICATIONS-01 | false | false | true/false/true/true | true/false/true/true |
| JSB-NOTIFICATIONS-02 | false | true | true/true/false/true | true/true/true/true |
| JSB-NOTIFICATIONS-03 | true | true | true/N/A/true/true | true/N/A/true/true |
| JSB-LEDGER-01 | true | true | true/true/true/true | true/true/true/true |
| JSB-LEDGER-02 | false | false | true/true/false/true | true/true/false/true |
| JSB-LEDGER-03 | true | true | true/N/A/true/true | true/N/A/true/true |
| JSB-PAGINATION-01 | true | true | true/true/true/true | true/true/true/true |
| JSB-PAGINATION-02 | false | false | true/false/true/true | true/false/true/true |
| JSB-PAGINATION-03 | true | true | true/N/A/true/true | true/N/A/true/true |
| JSB-HIKARI-01 | false | false | true/false/true/true | true/false/true/true |
| JSB-HIKARI-02 | true | true | true/true/true/true | true/true/true/true |
| JSB-HIKARI-03 | false | false | true/false/true/true | true/false/true/true |

| diagnostic profile | strict | prompt | completion | cached | uncached | evidence invoke/delivered/sourceUnits | XML received attempts |
|---|---:|---:|---:|---:|---:|---:|---:|
| broad | 1/8 | 57169 | 1556 | 37207 | 19962 | 0/0/0 | 0 |
| evidence | 3/8 | 87303 | 2006 | 61641 | 25662 | 5/5/1 | 2 |
| exact-evidence | 2/8 | 79895 | 1914 | 60531 | 19364 | 3/3/2 | 2 |

| diagnostic task / blockRepeat | broad | evidence | exact-evidence |
|---|---|---|---|
| JSB-PAYMENTS-02 / 1 | false | true | false |
| JSB-HIKARI-01 / 1 | false | false | false |
| JSB-NOTIFICATIONS-01 / 1 | false | false | false |
| JSB-MYBATIS-02 / 1 | true | true | true |
| JSB-MYBATIS-02 / 2 | false | true | true |
| JSB-NOTIFICATIONS-01 / 2 | false | false | false |
| JSB-HIKARI-01 / 2 | false | false | false |
| JSB-PAYMENTS-02 / 2 | false | false | false |

| full arm | cumulative messages bytes | tool bytes unique/repeated/total | block wall ms | scoring ms |
|---|---:|---:|---:|---:|
| control | 757595 | 94934/119198/214132 | 244499.19299999982 | 14203.075043999817 |
| product | 728761 | 136126/174529/310655 | 300355.5548359999 | 13955.444292000013 |

broad: provider responses 27; actual invocations {"java_symbol":8,"rg":6,"read":13}; java_evidence outcomes {}; 实际收到源码units 0。

evidence: provider responses 33; actual invocations {"java_symbol":10,"read":11,"java_evidence":5,"rg":1}; java_evidence outcomes {"NONEMPTY_SOURCE_UNITS":1,"READY_EMPTY":2,"ANCHOR_UNRESOLVED":2}; 实际收到源码units 1。

exact-evidence: provider responses 37; actual invocations {"java_symbol":13,"rg":5,"read":12,"java_evidence":3}; java_evidence outcomes {"NONEMPTY_SOURCE_UNITS":2,"ANCHOR_UNRESOLVED":1}; 实际收到源码units 2。

control: typed {"accepted":36,"rejected":0,"drafts":2,"recoveries":0}; provider actions {"rg":49,"read":66,"submit_answer":36,"list":33,"replace_file":8,"test":8}; actual invokes {"rg":49,"read":66,"list":33,"replace_file":8,"test":8}; delivered {"rg":49,"read":66,"list":33,"replace_file":8,"test":8}。prompt/completion/cached provider usage coverage=178/178；reasoning coverage=0/178，值为null。

product: typed {"accepted":36,"rejected":0,"drafts":1,"recoveries":0}; provider actions {"java_symbol":34,"read":58,"submit_answer":36,"rg":19,"list":12,"replace_file":8,"test":8}; actual invokes {"java_symbol":34,"read":58,"rg":19,"list":12,"replace_file":8,"test":8}; delivered {"java_symbol":34,"read":58,"rg":19,"list":12,"replace_file":8,"test":8}。prompt/completion/cached provider usage coverage=145/145；reasoning coverage=0/145，值为null。

messages bytes 是各请求 JSON.stringify(messages) 的 UTF-8 字节之和，不含 tool schema。工具 unique/repeated 以每个 attempt 的 provider callId + contentHash 初次出现划分。完整 HTTP wire 未记录，不推测补值。tokens 是 provider 成本代理，不是货币费用。

SOURCE_RECEIVED 是实际请求 messages 已送达的源码。其 slice hash、整文件 snapshot hash 和真实行范围均独立校核。来源包括 read/preview/java_evidence；导航 rg 文本不冒充源码。

blockWallMs 包含 workspace/session/model/judge/close，不含 scoringMs；overallMs 包含评分和编排。首个 product query 含冷准备，不称纯 index build。

配置：max_tokens=2048；reasoning_effort=none；enable_thinking=false；orderingSeed=1984；providerSamplingSeed=null。QA 原预算 160 行 / 16000 字节。

解释边界：原任务已暴露，单次 full、四题 diagnostic 两轮不可泛化，也不足独立支持删除公共 broad；历史 v1.3 与当前 v1.4 存在协议差异，不能把跨协议差值全归因到工具或模型。

