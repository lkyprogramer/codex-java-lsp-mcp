# 原始要求 → 当前实现 → 必须补齐

依据是原版 `baseline-kit/tasks/`、`baseline-kit/schemas/gates.json` 和指南，而不是完成报告自述。采用 IMPLEMENTED / PARTIAL / INVALID_EVIDENCE / NOT_VERIFIED，不将“存在文件”视作验收通过。

| 原任务 | 当前实际进展 | 一致性判断 | 本包修复 |
|---|---|---|---|
| T01 基线、真实成功口径 | 原 scorer 保留，新 JS LIVE 判分已建 | **PARTIAL / INVALID_EVIDENCE**：弱化类型、证据要求及分母；数据换行漂移 | R00、R02 |
| T02 ID 与 scope | 路径化ID解决数据库覆盖，原探针绿 | **PARTIAL**：resolver 仍 FQN→单ID任意选，未贯通消歧 | R05、R06 |
| T03 anchor/range | 长方法单/多anchor基本修复 | **PARTIAL**：原探针绿，但最终交付、UTF16/freshness等未全测 | R01、R08、R12 |
| T04 intent | text不再类名短路，已有测试 | **PARTIAL**：exact miss走fuzzy、terms替代原句 | R07 |
| T05 来源表示 | signature/comment/framework search docs存在 | **PARTIAL**：XML证据路径/hash错误；资源独立更新未全测 | R08、R12 |
| T06 公开静态 query | 默认 static、preview、五工具面 | **IMPLEMENTED with defects**：scope组合/旧locator/preview字节上限 | R06–R09 |
| T07 SQL物理预算 | stats表、postings/deadline结构 | **PARTIAL**：过滤在cap后；exact阶段绕过deadline；运行负载证据未完整 | R06、R09、R12 |
| T08 证据交付 | product preview与范围存在 | **PARTIAL / INVALID_EVIDENCE**：模型消息被投影为空，不能凭recorder证明效果 | R01、R08 |
| T09 实际Agent评估 | LIVE入口与repair judge已写 | **INVALID_EVIDENCE**：丢返回、矛盾prompt、不公平control、判分偏离 | R01–R04 |
| T10 可结束向量实验 | provider/缓存/实验文件隔离主产品 | **边界符合，效果证据无效**：cache碰撞、不同预算、stale行 | R10、R11 |
| T11 绑定残余问题 | 选择 NOT_NEEDED，未扩平台 | **需重判**：N01已证明重复FQN绑定缺口；无需因此实现完整编译器 | R05、R12 |
| T12 收口发布 | 删除java_context面，保留单静态主线 | **PARTIAL**：冻结字节不符、K门禁豁免没有依据、raw不可交付 | R00、R12、R13 |

## 已完成部分不应再重做

不重新设计数据库存储，不删除现有 HTTP daemon，不重新实现生命周期、worktree lease 或完整 AST。复用现有索引并补正确约束；若某项修复确需 schema版本变化，则按当前可删除缓存重建模式执行，而不是增加永久双读。

## K 契约与 T11 可选性的关系

T11“在没有绑定失败时可以不增加新功能”不等于 K22/K23/K24/K28 可以不测试已有行为。NOT_NEEDED 是功能开发决策，NOT_RUN 是测试状态，两者不是同一门禁。若用户决定只发布不含相关能力的独立静态产品，必须另建经批准范围与新接口/承诺；当前仍暴露JDT position/references，不能凭静态轨道自称覆盖该能力。

## 可接受的例外

原 v1 阈值是起始提案，但被实现者作为冻结验收依据后，不允许自己降低。维护者可以批准版本化例外，必须指出哪一项、为何、有效期、受限功能、剩余风险，并在报告显示“受限试用”，不可冒充原完整上线标准。当前未检索到这种批准材料。
