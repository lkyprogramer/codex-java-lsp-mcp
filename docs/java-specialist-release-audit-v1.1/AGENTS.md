# Java Specialist audit/remediation 约束

## 范围

Java-only；保留现有 SQLite on-disk、Tree-sitter、JDT Gateway、worktree/freshness 与五工具面。新增只限修复本包问题。严禁新建通用 Agent 框架、第二个数据库真源、默认 embedding、更多语言、UI 或新的全图预加载入口。

## 不可变内容

`baseline-kit/dataset/`、`baseline-kit/harness/`、`baseline-kit/schemas/gates.json`、本包历史 `evidence/` 不得由实现者修改。仓库 Unicode.java 恢复为原 CRLF 是唯一已确认的原样恢复，不是重标注；只恢复指定哈希，不刷新 MANIFEST 来掩盖变化。发现真实标签/scorer 缺陷，提交 label challenge，维护者裁决后发独立协议版本，两臂一起重跑。

新 `contracts/audit-cases.json` 是机制反例，不是新的统计任务。可添加覆盖，不能降低原断言。合法重构导致导出接口变化时，单独提交审计 adapter 更新，证明新旧输入/观察边界等价，禁止把真实实现替换为测试中的理想实现。

## 实施与测试

在隔离 checkout 工作；不改运行中的 installed release，不删除生产 cache、不修改全局 Codex 配置、不复制认证文件。输入仓库只读，修复任务仅写 per-task/per-repeat candidate；评测 gold/judge 位于它外面。shell 参数数组，不拼接用户 query 为 shell。

先 RED 后 GREEN。编译错误、缺依赖、超时不算“业务断言抓到缺陷”。禁止按 taskId、测试函数名、业务仓库名写生产分支。禁止用排序稳定替代歧义处理；禁止用 topK 截断冒充穷尽；禁止接入 label-driven must-hit 保留。

## 证据纪律

SOURCE_FETCHED、MODEL_PAYLOAD_ATTACHED、EXPLICIT_READ、TASK_VALIDATED 分开。接收到 chat 函数的最终消息才能支持 payload-attached 断言，仍不能证明模型注意到了它。至少检查 fake transport 与真实 SDK 往返两级。

模型 response usage 缺失保持 null/UNMEASURED，不默认为 0。所有调度行留在分母；baseline/candidate 模型、配置、预算、语料、scorer/profile/hash 不同不得混算。修复成功来自冻结 judge，不能来自 patchApplied 自报。

状态限定 PASS / FAIL / BLOCKED_ENV / BLOCKED_AUTH / NOT_RUN / INVALID_EXPERIMENT；文档依据另记 SOURCE_REPORTED。PARTIAL 仅用于描述覆盖层级，不具备 release PASS 权力。所有 NO_GO 必须有缺口清单，不能用总测试数覆盖未执行契约。

## 工作分工

实现者看 dev 标签；独立 evaluator 保管 locked/gold/judge。此包为所有者完整交付，明文目录本身不是隔离安全机制。已暴露的 locked 登记 exposure 并降为 regression；后续泛化主张需要新未参与调参样本，不重复利用其名称优化。

## 收口

任务 R00–R13 的依赖、接口和预算见主计划；接口同名多版本不允许并存。达到原 frozen gates 后才进入人工 release review。原 `permittedToDeploy=false` 是授权字段，不是产品质量通过证明。
