# Adapter boundary

`probe-source.mjs` 现在可对源码直接执行 C1/C2/C3 的 12 个真实函数契约探针，不依赖生产安装目录。构造 FactsReader 与实体记录只隔离目标函数，不证明 Tree-sitter、JDT 或完整 MCP 路径通过。

`mcp_static.py` 对接 **M1 目标契约**。当前旧版本未提供此契约时必须返回 `UNSUPPORTED`，不能将旧 JDT query 结果伪装为 static。为消除名称猜测，M1 的 declaration 比前一版指南额外明确 `name` 字段，preview 额外明确 `previewKind: source|summary`；源文本才能计入 read receipt。该协议适配器本包用 fake server 及字段映射测试验证，实际工程连通性由 T06 执行。

通用 adapter：从 stdin 读取一个 `java-specialist-request/v1` JSON，对 `repo_root` 进行分析，向 stdout 输出单个 result JSON；日志仅 stderr；不得读 gold、patch、evaluation tests。`harness run-adapter` 负责逐任务隔离目录、超时、输出上限、缺失结果。路径与模型 usage 不能猜测。

这三个角色不同：source probe 是产品函数回归；MCP adapter 是检索结果采集；Agent adapter 是真实模型任务执行。不能用任一前两项宣称 Agent repair 成功。
