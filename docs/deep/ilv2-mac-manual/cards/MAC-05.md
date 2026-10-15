# MAC-05 — full/delta 显式流水线

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** `src/index-builder/{cold-build,incremental,builder-main,progress}.ts`、新 build-plan/capture 输入与阶段实现；不复用 recovering 选择器。

**步骤：** 构建只读捕获输入和兼容 base；分离 parse、resolve、graph/search 与 SQL 阶段；分批提交 tmp；新增/删除/rename/导出变化触发明确依赖闭包。failed/recovered 文件记录缺口并清除其旧事实，其他文件仍可更新。阶段进度从真实处理计数产生，job 完成和 coverage 完整性分开。

**验收 G05：** 一文件变化没有全量 parse；含跨模块继承、方法签名改变、调用方新增、XML 修改/删除的 delta 与独立新 full 逻辑一致；一个坏文件与正常新增调用方可同时发布有效结果；修复坏文件后缺口消失。无依赖闭包证明时明确 full，不谎报 delta。删除 D02。至少对四仓分别证明两次 full 确定性与有变化的 full/delta 等价，不以旧v9缺陷为oracle。

**同分文档evidence确定性（MAC-04残留，由MAC-05负责）：** 同一声明的多个search文档BM25分数相同时，当前按自增`doc_id`选最早插入的文档，冷构建与增量构建可能展示不同evidence，即使logicalDigest一致。本卡改用稳定的逻辑文档身份决胜，不以surrogate行号或sym行号排序。定向用例须改变文档插入/增量替换顺序，直接比较所选文档身份、来源与范围，以及实际查询evidence；逻辑摘要相等不能替代这项断言。

**真库薄切片（G05必需）：** 在隔离lishu-v2上直接驱动新full→封存测试副本→20/200差量→只读实际查询，核对hash/coverage/logicalDigest和阶段/页写入成本；另注入parse后编辑。驱动只提供测试用有界并发/临时读取，不实现正式publisher/GC，也不宣称证明它们。若成本或闭包falsifier成立，先修MAC-04/05，不等MAC-11再返工。

**MAC-00实测约束（旧实现，同一lishu-v2输入，[MAC-00结果](../../../index-lifecycle-v2/mac/mac-00/task-result.json)）：** 旧full进程墙钟约429 s，阶段墙钟graph-search 248 s（58%）、resolve 95 s（22%）、parse 76 s（18%）。旧reconcile对0变化也需约7.2 s；B20墙钟27.4 s、B200 131.2 s，分别是5 s/15 s首证据目标的约5.5倍/8.7倍，且只有20/200个文件被解析，成本主要来自affected闭包的resolve/graph-search重算和固定开销（推断：扣除约7.2 s固定开销后B20约0.19 s/affected、B200约0.14 s/affected，未单独测）。薄切片因此至少分开报告：固定开销（无变化delta）、闭包大小、resolve与graph/search各自墙钟、每阶段写入页数。下列任一成立即为falsifier，先改MAC-04/05：无变化delta固定开销≥2.5 s（5 s预算的一半）；20文件delta首个正确查询>5 s，或200文件>15 s；20/200文件逻辑页差≥全库10%/30%；graph/search仍按全仓重算。B_full=409.9 s（MAC-00卡）；full门按§6.1为≤327.9 s，旧阈值600 s比旧实现实测还宽，不再适用。
