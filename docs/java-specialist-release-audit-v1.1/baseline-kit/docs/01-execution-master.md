# 开发执行主计划

> For agentic workers: 按本计划逐卡执行；每卡 RED→GREEN→review。多 agent 仅能并行不共享实现状态的工作，不并行修改同一 schema。

**Goal:** 在不重做底座的前提下，修复声明身份/检索短路/范围交付，公开静态发现入口，并建立独立可信的效果验证。

**Architecture:** 沿用每 worktree SQLite、builder、generation、bounded JDT 和既有 impact；只增加窄 Discovery 表示/查询模块与 EvidenceDelivery 修复。独立 evaluator 不导入 SUT ranking、parser 或 gold 推断函数。

**Tech stack:** 产品保持 TypeScript/Node/SQLite/Tree-sitter/JDT；验收工具 Python 标准库 + javac/java。Node/Java 版本以 preflight 固定，非本包自检平台不得宣称已测。

**Spec:** docs/02-design-delta.md；上位依据 provenance/source-guide.md。对于本文明确细化的 name/previewKind、评分数据协议、阶段门禁，以本文集合为执行规范。

## 依赖及提交顺序

| 里程碑 | 顺序 | 阶段交付 | 阻塞条件 |
|---|---|---|---|
| M0 | T01 → T02、T03 | 可信记录、声明归属、锚点保真 | baseline 不可复现或核心数据错误 |
| M1 | T04 + T05 → T07 → T06 | 静态 query 可用，不启动 JDT | 物理 SQL 工作无界、错误 scope、partial 冒充完整 |
| M2 | T08 + T09 | 关键源码真正到达模型；QA/repair 被正确判定 | 仅路径/计划指标，实际任务未测 |
| M3 | T10 → 按需要 T11 → T12 | 向量明确结论、残余绑定修复、单主线收口 | 新增依赖没有增益或超出授权 |

T09 的事件格式在 T01 冻结，测试 recorder 可与 M1 开发并行。T11 是有条件任务，不要求为完成 checklist 引入 SCIP。T10 的 NO_GO 是合法完成状态。

## 每卡公共动作

- [ ] 从任务卡复制准确源码路径和接口；先在真实 checkout 定位函数，行号变化不盲贴。
- [ ] 执行 preflight，保存 raw 日志和 SHA，不使用安装目录。
- [ ] 运行 RED，断言应失败于目标行为，不得只是模块缺失。
- [ ] 最小实现；定向测试通过后检查相关索引/工具/范围集成。
- [ ] 用同 dataset_hash、corpus_hash、模型/预算条件配对比较；不混合 full 与 scoped。
- [ ] 独立 reviewer 检查 code diff、测试是否真能杀死旧缺陷、是否偷改 evaluator。
- [ ] commit 并写 templates/milestone-report.md 对应的证据项。

## 统一产品回归命令

在产品依赖已安装的独立 checkout：

```bash
npm run build:isolated
npm test
npm run gate:pr
npm run gate:release
npm run measure:tool-schema
npm run measure:production-ts
```

这些是产品原有命令；本包未在当前环境执行完整流水线。依赖安装前先确认 checkout 不是运行中的 release。阶段中无需每个几行修改都重跑完整发布矩阵，但合入里程碑必须跑。

## Review focus

身份字符串变化必须连同 SQL/edge/semantic cache/sibling-copy 版本检查，不能只修生成函数。范围正确必须检查最终 MCP serializer，不只测 provider。静态 handler 通过必须同时验证外层 admission 不启动 JDT。查询 early-return 修复不得使 exact 请求混入模糊候选。公开完整语料、未知中文任务和变更后查询必须分别报告，不能用 tiny fixture 平均分代替。

## Definition of Done

M0 以对应真实函数契约通过为底线；M1 以隔离 MCP static query→anchor→impact 真链路为底线；M2 以真实模型 QA/冻结 repair 为底线；M3 以预注册实验结论和清理为底线。没有实际模型授权时最多完成 M0/M1 和 M2 的离线工具，报告 M2_LIVE=BLOCKED_AUTH，不宣布全路线 DONE。
