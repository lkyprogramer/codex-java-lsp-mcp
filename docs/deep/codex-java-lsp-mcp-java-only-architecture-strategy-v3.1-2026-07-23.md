# codex-java-lsp-mcp Java-only 极致代码智能架构与优化战略 V3.1

> **文档状态：权威架构基线（Authoritative Architecture Baseline，Claude Review Integrated）**  
> **版本：V3.1**  
> **日期：2026-07-23**  
> **适用项目：`lkyprogramer/codex-java-lsp-mcp`**  
> **产品定位：小而精悍、Java-only、面向 AI Coding Agent 的仓库与 worktree-family 级代码智能引擎**  
> **兼容性策略：允许破坏性重构；缓存、内部接口和 MCP 输出均可重新设计；不承担历史兼容成本**  
> **V3.1 修订范围：吸收 `codex-java-lsp-mcp-v3-plans-review-2026-07-23.md` 中经核实成立的 A-1～A-5、E-1～E-6 与 W-1～W-6；不引入 daemon、数据库、共享内存索引或多语言抽象。**

## 文档关系

本文件与配套实施文档共同替代以下两份旧方案：

1. `codex-java-lsp-mcp-architecture-optimization-plan.md`
2. `codex-java-lsp-mcp-deep-optimization-plan-2026-07-23.md`

配套实施文档：

- `codex-java-lsp-mcp-java-only-development-execution-plan-v3.1-2026-07-23.md`

旧方案不再作为并行路线输入。旧方案中的有效结论已吸收进本文件；与“小而精悍、Java-only、个人项目”冲突的内容已明确删除。V3.1 不是独立补丁附录：worktree 并发、跨进程资源租约、snapshot generation rebase、watcher barrier 与 JDT restart backoff 已直接并入主架构和主执行顺序。

---

# 0. 决策摘要

## 0.1 最终产品定义

`codex-java-lsp-mcp` 不应演化成通用代码知识图谱平台，也不应追赶多语言覆盖、可视化、向量搜索、自然语言图查询或企业级多租户能力。

它的唯一目标是：

> **在一个 Java Git repository 及其全部 linked worktrees 内，以尽可能低的延迟和 token 成本，向 Coding Agent 提供足够准确、足够新鲜、互不污染、可解释且可直接执行的代码影响面与阅读计划。**

该目标可进一步拆成六个不可替代的核心能力：

1. **Java 结构事实足够完整**：类型、方法、字段、导入、继承、实现、签名引用、局部类型、方法调用、构造调用和框架关系可被稳定抽取。
2. **JDT LS 精确语义按需使用**：definition、implementation、references、type hierarchy 只在能产生净收益且预算允许时调用。
3. **所有候选都带证据**：区分 AST 明确事实、静态解析结果、框架推断、文本召回和 JDT 精确语义。
4. **输出直接适配 Agent 工作流**：核心不是提供图查询工具，而是一次返回经过压缩的 `readPlan`、必要证据和剩余不确定性。
5. **质量可被持续证伪**：真实仓库 golden、任务阻塞文件、token、延迟、新鲜度和故障测试共同构成发布门禁。
6. **并发 worktree 可控且隔离**：每个 worktree 有独立 generation、索引、JDT workspace 和缓存；同一 Git family 只共享经过内容验证的 seed 与全机资源租约。

## 0.2 本轮最重要的架构决策

| 决策 | 结论 |
|---|---|
| 语言范围 | 永久 Java-only，不抽象多语言插件层 |
| 结构解析 | 用 `tree-sitter-java` 替换 regex 作为主要事实来源 |
| 精确语义 | 保留 JDT LS，定位为昂贵且有界的精确确认层 |
| 图存储 | 不引入通用图数据库；使用内存索引 + 原子单文件快照 |
| 持久化 | 新 schema 直接换代，旧缓存删除重建，不写 migration |
| 并发模型 | 每 worktree 一个 JavaIndex Worker actor；不建设通用 worker pool 平台 |
| worktree 正确性边界 | canonical worktree root 独立索引、generation、JDT workspace、query cache 和 semantic edge |
| worktree family 边界 | Git common-dir 只用于跨进程资源协调、兄弟 snapshot 发现和后台节流，不作为查询 cache identity |
| 跨进程协调 | 使用小型、可回收的文件系统 lease；不引入 daemon、IPC 服务或共享内存 |
| 兄弟 snapshot 复用 | 仅做显式 seed；先执行 manifest-only 内容校验，匹配事实才可发布，coverage 在 reconcile 完成前保持 DEGRADED |
| 新鲜度 | Repo watcher 与 JDT LS 解耦，统一单调 `generation` |
| 负缓存 | 仅在对应 source root `COMPLETE` 且 generation 一致时允许 |
| 排序 | 从裸加法改成按证据家族饱和，防止重复证据多次满额计分 |
| readPlan | 在现有证据配额基础上增加 byte/token 预算和边际效用选择 |
| 框架能力 | 只做高 ROI 的 Java pack：Spring、MyBatis、JPA；MapStruct/Lombok 次级 |
| warm-required | 不预设默认化；完成正确性和索引底座后再由实验决定 |
| MCP 工具面 | 不新增工具；是否从 7 个缩到 5 个仅由工具描述 token 与误选数据决定 |
| 向量/embedding | 不做 |
| LLM rerank / RL | 不做 |
| SQLite/DuckDB | 不做 |
| UI/通用图查询/Cypher | 不做 |
| 多语言 | 不做 |

## 0.3 正确实施顺序

```text
基线核对
  ↓
正确性封口
  ↓
统一新鲜度、generation 与跨进程 worktree 资源边界
  ↓
Java AST 索引 V2 + 兄弟 worktree snapshot seeding
  ↓
证据归一化、框架边和 token-aware readPlan
  ↓
根据数据决定是否继续优化 warm-required
```

任何跳过前两步、直接继续增加召回信号或调整权重的做法，都会让结果受竞态、陈旧缓存和不完整索引污染，使后续收益无法归因。

---

# 1. 证据口径与基线说明

## 1.1 本方案使用的输入

本方案综合以下材料：

1. 用户提供的源码压缩包。
2. 旧版架构方案和旧版深度优化方案。
3. `docs/deep 两份优化方案的深度 Review 报告`。
4. 项目仓库内已有 benchmark、readPlan、warm latency、typeReference 和 phase report。
5. `DeusData/codebase-memory-mcp` 的公开 README 与 Java resolver 源码。
6. `Graphify-Labs/graphify` 的公开 README、架构、缓存和 watcher 源码。
7. Tree-sitter 官方文档与当前 Node/Java grammar 包信息。
8. `codex-java-lsp-mcp-v3-plans-review-2026-07-23.md`：针对两份 V3 文档的全文/重点任务复核与多 worktree 并发专项。

## 1.2 当前代码基线存在来源差异

附件 Review 声明其核查基线为本地 `main` HEAD `af51bc7`，并实际执行了：

```text
npm run build              PASS
npm test                   124 tests / 120 pass / 4 skipped / 0 fail
```

同时，Review 表明该基线已包含 phase 4～12 的若干改造：edge store、import graph、evidence budget、agent-router 拆分和按 repo 拆分的 policy。

但本次会话中可直接读取的源码压缩包和公开仓库快照仍接近 2026-07-02 的较早形态：`agent-router/index.ts` 仍是大文件，尚未出现 Review 提到的全部新模块。公开仓库也无法解析 `af51bc7` 这一 ref。

因此，本方案采用以下原则：

- **关于最新 HEAD 是否仍存在某项问题**：以附件 Review 的逐条源码核查为主要依据。
- **关于具体旧代码调用链和早期实现**：以源码压缩包与公开仓库为依据。
- **关于 phase 12 后的数值**：作为 Review 转述的仓库报告数据，不冒充本次独立复跑结果。
- **真正开始开发前**：必须执行配套实施文档中的“Task 0：基线对齐”，重新生成当前 HEAD 的文件映射、测试基线与 benchmark 基线。

该差异不是文档障碍，但禁止 AI 根据旧压缩包路径盲目覆盖较新的拆分实现。

V3.1 对 Review 的核实结论如下：

- 文档内可直接确认：产品定义只覆盖“一个仓库”、`DeadlineBudget.race` 的架构/计划签名不一致、Task 10 无条件等待 watcher ready、Task 3 与 Task 33 的 restart backoff 时序冲突、Task 4 步骤编号乱序、snapshot generation rebase 缺失、worktree family 设计缺失。
- 现有源码/旧快照可直接确认：cacheRoot 与 JDT workspace 以 canonical worktree path 隔离，LSP enablement 可按 Git common-dir 继承，active repo 上限只存在于单 MCP 进程，janitor 主要依赖 `jdtlsPid`。
- 无法在本会话独立重放的部分：Review 所称本地 HEAD `af51bc7` 的全部源码和三仓 benchmark；这些仍由 Task 0 重新核验。
- Review 的方向性结论成立，但 V3.1 对其 W-1 和 W-2 实现细节作了安全强化：全局 JDT lease 使用固定编号 slot + 同 worktree 独占 lease，避免“先 count 后 create”竞态；snapshot seed 在任何事实可查询前完成 manifest-only 内容验证，避免把兄弟分支的陈旧正向事实直接送入 readPlan。

## 1.3 最新可采用的质量基线

按照附件 Review 对 phase 11/12 报告的汇总，三个真实仓库的 cold recall 已提升到：

| project | recall | P_read |
|---|---:|---:|
| lishuedu | 0.8456 | 0.8667 |
| cipherlink | 0.8643 | 0.7000 |
| exam-parent-v3 | 0.7350 | 0.6333 |

三仓硬门槛继续为：

```text
R_read_must = 1.0000
```

这些绝对值只在相同业务仓库 commit、相同 golden、相同机器和相同 benchmark 口径下可直接比较。若开发时仓库 commit 已变化，则采用“当前 HEAD 重新跑出的 baseline-relative gate”，而不是机械比较历史数字。

---

# 2. 产品边界：什么必须做到，什么永久不做

## 2.1 必须做到

### A. Java 结构解析深度

必须稳定识别：

- package、显式 import、wildcard import、static import；
- class、interface、record、enum、annotation type；
- nested/member/local/anonymous type 的必要边界；
- public、protected、private、package-private 方法；
- constructor、compact record constructor；
- 字段、参数、返回值、throws、泛型参数和 bounds；
- extends、implements、permits；
- method invocation、constructor invocation、method reference；
- local variable type、cast、field access；
- 注解及关键注解参数；
- 精确 AST range，用于 read window。

### B. Java 名称解析

必须区分：

- FQN；
- 同包类型；
- explicit import；
- wildcard import；
- `java.lang`；
- nested type；
- 同 simple name 的多候选冲突；
- 不可解析和歧义状态。

系统不得把 simple name 唯一命中当成普遍事实。

### C. Java 框架事实

优先支持当前真实仓库高频模式：

- Spring stereotype、constructor/field injection；
- Spring MVC endpoint、request/response DTO；
- Spring event publisher/listener；
- `@Transactional` 边界；
- MyBatis mapper interface ↔ XML namespace/statement；
- MyBatis parameter/result type；
- JPA entity/repository 泛型和实体关系；
- MapStruct mapper；
- Lombok/annotation processing 对语义完整性的影响。

### D. Worktree-family 并发

必须支持同一 Git repository 的多个 linked worktrees 被不同 Agent/MCP 进程同时分析：

- canonical worktree root 是正确性身份；不同 worktree 的 facts、generation、JDT workspace、query cache 和 semantic edge 不共享；
- Git common-dir 派生的 `familyHash` 只用于资源 lease、兄弟 snapshot 候选发现与后台 sweep 节流；
- 同一 worktree 同时只有一个进程可以拥有 JDT workspace lease；第二个进程的 fast/auto 仍可走本地静态路径，required/精确工具返回类型化 busy/degraded 结果；
- 全机 JDT STARTING+READY 数不能因多个 MCP stdio 进程而突破机器级上限；
- 新 worktree 可以从兄弟 worktree seed **内容完全匹配** 的静态 facts，但不得共享可变索引或未经验证的负缓存；
- branch switch/rebase 的大批量事件不能淹没 foreground anchor refresh；
- fast-only 活跃会话也必须阻止 janitor 删除其 cache。

### E. Agent 输出

默认一次调用应回答：

1. 从哪个 anchor 开始；
2. 哪些文件最可能需要读；
3. 每个文件为何被选中；
4. 推荐读取哪些精确范围；
5. 哪些结论是精确语义，哪些是静态推断或 lexical recall；
6. 还缺什么证据；
7. 本次结果是否因 timeout、partial index 或 JDT 未就绪而降级。

## 2.2 永久不做

以下内容不是“暂缓”，而是本项目的明确非目标：

- 多语言 parser abstraction；
- 通用知识图谱产品；
- Cypher/Gremlin 查询语言；
- 通用 graph visualization；
- 文档、PDF、图片、视频知识图谱；
- embedding、vector database、语义向量召回；
- LLM rerank；
- 基于用户行为的 RL 或在线学习；
- 面向团队的多租户、远程服务和权限系统；
- 复杂 canary、shadow、feature-flag 平台；
- 12+ 仓库、百级盲测场景作为近期门槛；
- 自研 Java 编译器或重写 JDT LS；
- 为百万行非目标仓库设计分布式索引。

## 2.3 “小而精悍”的量化约束

- public MCP tools 不增加；长期最多 5～7 个。
- 核心运行时依赖保持克制：Tree-sitter Node binding、Java grammar、可选纯 JS XML parser；不引入数据库服务。
- 常驻后台对象按 repo 有界；停止 repo 后可被回收。
- 单个模块只承担一个清晰职责，避免新的 1,000 行核心文件。
- 默认输出必须是 Agent 可直接消费的 compact contract，而不是内部调试 dump。

---

# 3. 同类项目对比与取舍

> 对比仅用于架构取舍。两个项目 README 中的吞吐、token 节省和质量数字均属于其公开声明，本次没有在相同硬件、相同仓库和相同 Agent 任务上独立复现；本方案不把这些绝对数字作为本项目验收门槛。

## 3.1 codebase-memory-mcp

### 可观察到的设计

该项目公开资料显示其目标是广度型代码知识平台：

- 158 个 tree-sitter language grammar；
- 15 个 MCP tools；
- 持久知识图谱、SQLite、全文和向量能力；
- watcher、daemon、跨会话共享和 UI；
- Java 侧实现了一个基于 Tree-sitter AST、scope chain、类型注册表和启发式 overload resolution 的纯 C “Hybrid LSP” resolver。

其 Java resolver 源码体现了几个值得借鉴的细节：

1. 方法调用解析不是单纯按名称匹配，而是结合 receiver type、arity、参数类型、继承链和歧义处理。
2. 输出关系有明确置信度，歧义不会强行升级成 edge。
3. 负缓存只在 registry 已经 sealed/read-only 时启用；否则 miss 可能因索引继续增长而失效。
4. 直接命中仍在负缓存检查之前执行，避免 hash collision 或陈旧 memo 抑制真实结果。

### 应借鉴

- Tree-sitter AST 作为结构事实底座；
- scope、FQN、import、receiver、arity 等 Java-specific 解析；
- `resolved / ambiguous / unresolved` 明确区分；
- edge confidence；
- 完整 coverage 后才允许 negative cache；
- watcher 与索引生命周期独立于查询工具。

### 不应借鉴

- 158 语言和通用 resolver 框架；
- 15 工具的通用图查询面；
- UI、ADR、向量、跨服务和多客户端 daemon；
- 为规避 JVM 而重写 Java 语义解析器；
- 将所有能力塞入单一平台二进制。

`codex-java-lsp-mcp` 已有真实 JDT LS，复制纯 C 近似 resolver 会同时增加代码量和语义风险。正确路线是让 Tree-sitter 承担便宜、完整、确定性的静态事实，让 JDT LS 只承担真正需要编译器语义的确认。

## 3.2 Graphify

### 可观察到的设计

Graphify 是通用知识图谱产品，其公开架构具有以下特点：

- pipeline 被拆成 `detect → extract → build_graph → cluster → analyze → report → export`；
- 每个 extractor 输出统一的 `{nodes, edges}`；
- edge 明确标记 `EXTRACTED / INFERRED / AMBIGUOUS`；
- schema 在进入 graph build 前校验；
- AST cache 按 extractor version 隔离；
- semantic cache 按 prompt fingerprint 隔离；
- stat index 采用原子写；
- watcher 在锁竞争时把变更追加到 pending queue，避免事件被静默丢弃；
- partial extraction 不应悄悄覆盖更完整的结果。

### 应借鉴

- 清晰的单向 pipeline 和纯数据契约；
- edge provenance 与 confidence；
- schema validation；
- extractor version 纳入 cache identity；
- 原子 snapshot；
- watcher pending change queue；
- partial 结果不可伪装成 complete。

### 不应借鉴

- docs/media 语义抽取；
- NetworkX 通用图分析、社区检测；
- graph.html、Obsidian、SVG 导出；
- plain-language graph query；
- 通用 40 语言 extractor；
- 把全图作为产品中心。

## 3.3 三者定位对比

| 能力 | codebase-memory-mcp | Graphify | codex-java-lsp-mcp V3 |
|---|---|---|---|
| 战略 | 极广代码智能平台 | 通用知识图谱 | 极深 Java Agent Intelligence |
| 语言 | 158 | 约 40 | 1：Java |
| 结构解析 | Tree-sitter | Tree-sitter | Tree-sitter Java |
| 编译器级 Java 语义 | 自研近似 resolver | 无 | JDT LS |
| 主要输出 | 图查询结果 | 图和报告 | task-oriented readPlan |
| MCP 工具面 | 15 | 通用图工具 | 5～7，核心为 `java_impact` |
| 持久层 | SQLite/图 | graph.json/cache | 内存索引 + 原子 snapshot |
| 质量门禁 | 项目自有 benchmark | 通用 benchmark | 真实 Java repo golden hard gate |
| 框架深度 | 通用启发式 | 通用 | Spring/MyBatis/JPA 专项 |
| token 策略 | 用结构查询替代文件读取 | 用子图替代全文 | 直接优化文件与行范围预算 |

## 3.4 本项目真正的护城河

```text
Tree-sitter Java 完整静态事实
              ×
JDT LS 精确语义确认
              ×
Spring/MyBatis/JPA 深度适配
              ×
任务导向 readPlan
              ×
真实仓库 golden 门禁
```

这五项组合比“图更大、语言更多、工具更多”更难被通用平台复制，也更符合个人项目可长期维护的边界。

---

# 4. 当前架构的优点与必须修复的缺口

## 4.1 已经做对的部分

项目已具备较强的方向基础：

- `java_impact` 是单一推荐入口；
- cold fast path 不依赖 JDT LS；
- JDT LS 是可选增强；
- repo/worktree identity 以 canonical root 为核心；
- raw `rg` 输出被内部消化，显著压缩 token；
- readPlan 有 must-hit hard gate；
- benchmark 已区分 cold/warm 和 candidate/readPlan；
- diagnostic 输出包含 phase attribution；
- 最新 Review 表明 edge store、import graph、evidence budget 和 router 模块拆分已经落地。

这些都应保留。

## 4.2 P0：结果可信度问题

以下问题在修复前会直接污染结果，不属于普通性能优化：

1. **JDT LS 伪 READY 竞态**：进程和 connection 字段已赋值但 initialize 未完成时，另一请求可能误判已启动。
2. **启动失败未事务清理**：initialize timeout/失败后成员字段可能残留。
3. **无统一 repo generation**：fast 模式 watcher 未运行，`rg` cache、SourceIndex、layout 和 semantic edge 可能观察不同版本。
4. **partial rg 被缓存**：timeout 后已有 stdout 被解析并写入长 TTL cache，形成稳定假阴性。
5. **LSP location 越界**：repo 外路径可进入候选并以绝对路径暴露。
6. **active repo slot check-then-act**：并发启动可越过上限。
7. **无请求级绝对 deadline**：每个子调用独立消费 timeout，整体耗时可远超调用方预期。
8. **错误分类混乱**：timeout、cancel、not-ready 和 server-error 被混成一个状态。

## 4.3 P1：新鲜度与性能问题

- SourceIndex 的同步读、同步 append、同步 compact、同步 `spawnSync(rg)` 会阻塞 MCP 主事件循环。
- cache 只覆盖访问过的文件，index miss 与仓库不存在无法区分。
- `rg` 仍全量拼接 stdout。
- 同 key semantic 请求没有 in-flight singleflight。
- open documents 无限增长，无 didClose/LRU。
- hierarchy 无 visited，且内层默认超时过大。
- stopped runtime context 不被回收。
- alias 配置损坏时没有 last-known-good。

## 4.4 P1：识别问题

- simple name index 无法可靠处理重名类型；
- regex parser 丢 nested type、package-private method，并会被字符串/文本块中的花括号干扰；
- 多个 provider 对同一底层事实重复满额加分；
- references 直接采用 server 顺序前 40，未先按文件价值排序；
- 静态类型边尚不足以覆盖方法体调用；
- 框架关系仍大量依赖命名和 lexical recall；
- readPlan 已有 evidence budget，但缺真正的 byte/token 预算。

---

# 5. 架构原则

## 5.1 正确性优先于 recall

- 不完整结果必须显式标注；
- partial 结果不得写入 complete cache；
- unknown coverage 不得解释为不存在；
- ambiguity 不得强行转成高置信边；
- repo 外路径不得进入 agent 输出；
- generation 不一致时宁可降级重算，不复用陈旧结果。

## 5.2 便宜事实优先，昂贵语义后置

优先级固定为：

```text
AST facts
  → resolved static relations
  → framework adapters
  → bounded lexical search
  → JDT exact semantic confirmation
```

JDT LS 不是索引完整性的前提，也不应成为默认 cold 路径。

## 5.3 所有关系必须可解释

每条证据至少包含：

- source；
- family；
- kind；
- provenance；
- confidence；
- completeness；
- source location；
- generation；
- dependency files。

## 5.4 不为未来规模预付复杂度

- 一个 worker actor，而非通用 pool；
- 一个原子 snapshot，而非数据库；
- 一个单调 generation，而非事件溯源系统；
- 简单 FIFO 与 singleflight，而非多级调度器；
- git revert 与 benchmark gate，而非发布平台。

## 5.5 Agent 行动价值优先于内部信息完整度

默认输出只保留会改变 Agent 下一步动作的信息。完整 phase metrics、score breakdown、cache 状态和 raw attribution 只在 diagnostic 模式输出。

## 5.6 Worktree 隔离优先，复用必须可证明

共享的收益不能破坏分支隔离：

- 可共享：机器级 slot、后台 sweep capacity、只读 snapshot seed 候选。
- 不共享：generation、live JavaIndex、query cache、JDT workspace、open document、semantic in-flight、可变 edge store。
- seed 事实只有在目标 worktree 的 `relativePath + contentHash` 与来源 snapshot 完全一致后才能进入可查询 store。
- coverage/negative cache 永远是目标 worktree 自己的结论；来源 worktree 的 COMPLETE 不能直接继承。
- 所有持久 ID 必须 root-independent；绝对路径只存在于 runtime 边界，不进入 file/type/method identity。

---

# 6. 目标架构总览

```text
┌───────────────────────────────────────────────────────────────┐
│                        MCP Tool Layer                         │
│ java_impact / java_symbol / java_diagnostics / status ...    │
└──────────────────────────────┬────────────────────────────────┘
                               │
                     RequestContext
 repoRoot + repoHash + familyHash + generation + budget + freshness
                               │
┌──────────────────────────────▼────────────────────────────────┐
│                         RepoRuntime                           │
│  correctness identity = canonical worktree root              │
│                                                               │
│  RepoChangeCoordinator ───► GenerationClock                  │
│          │                         │                           │
│          ├──────────────► JavaIndexWorkerClient               │
│          ├──────────────► SearchExecutor                      │
│          ├──────────────► SemanticEdge invalidation           │
│          └──────────────► Layout refresh                      │
│                                                               │
│  JdtSemanticGateway ◄──── JdtlsSession(5-state lifecycle)     │
└───────────────┬───────────────────────────────┬───────────────┘
                │                               │
                │ family coordination only      │ optional validated seed
┌───────────────▼────────────────┐   ┌──────────▼─────────────────┐
│ CrossProcessLeaseStore         │   │ WorktreeSnapshotSeeder      │
│ runtime / jdt-worktree /       │   │ schema + extractor + build  │
│ jdt-slot / sweep-slot          │   │ + relative content manifest │
└────────────────────────────────┘   └────────────────────────────┘
                               │
┌──────────────────────────────▼────────────────────────────────┐
│                        ImpactPipeline                         │
│  AnchorResolver → CandidateProviders → EvidenceNormalizer     │
│  → FamilySaturatingRanker → TokenAwareReadPlanPlanner         │
│  → CompactOutputFormatter                                    │
└───────────────────────────────────────────────────────────────┘
```

## 6.1 单向数据流

```text
Repository change
  → generation++
  → JavaIndex refresh/invalidate
  → provider query
  → EvidenceSignal[]
  → normalized CandidateEvidence
  → rank
  → readPlan
  → compact MCP result
```

禁止 provider 直接修改最终 score；provider 只能产出标准证据。排序规则集中在一个纯函数模块中，readPlan 再基于排序结果和预算独立规划。

## 6.2 RepoRuntime 是一致性边界

每个 canonical **worktree** repoRoot 对应一个 RepoRuntime；同 Git common-dir 的多个 RepoRuntime 构成一个 `WorktreeFamily`，但 family 不是查询一致性边界。RepoRuntime 包含：

- generation；
- watcher；
- layout；
- JavaIndex worker client；
- rg cache；
- JDT session；
- semantic cache/edges；
- router/pipeline；
- request reference count；
- `WorktreeIdentity { repoRoot, repoHash, gitCommonDir?, familyHash? }`；
- 本进程 runtime lease、可选 JDT worktree/global slot lease。

RepoRuntime 停止后，JDT 进程可关闭；长时间未使用的整个 context 必须从 Map 中回收，避免 SourceIndex 和 snapshot metadata 永久常驻。跨进程协调不得让两个 worktree 共享同一个 mutable context。

---

# 7. 核心运行时契约

## 7.1 RequestContext

```ts
export type RequestFreshnessMode =
  | "NORMAL"
  | "WATCHER_NOT_READY"
  | "WATCHER_DEGRADED"
  | "RECONCILING";

export type RequestContext = {
  requestId: string;
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  generation: number;
  freshnessMode: RequestFreshnessMode;
  cacheReadAllowed: boolean;
  cacheWriteAllowed: boolean;
  negativeLookupAllowed: boolean;
  mode: "minimal" | "balanced" | "precision" | "recall";
  budget: DeadlineBudget;
  startedAtMs: number;
};
```

每次 MCP 请求在进入 handler 时固定 generation snapshot。若执行过程中 generation 改变：

- 当前请求可继续使用已收集的事实；
- watcher 尚未 ready、watcher dirty 或 reconcile 中时，`cacheReadAllowed/cacheWriteAllowed/negativeLookupAllowed` 必须按 §8.2 的降级规则关闭；
- 输出必须标记 `freshness.changedDuringRequest=true`；
- 不得把基于旧 generation 的新结果写入当前 generation cache；
- 对强一致性操作可重试一次，不能无限重启流水线。

## 7.2 DeadlineBudget

```ts
export interface DeadlineBudget {
  readonly deadlineAtMs: number;
  remainingMs(capMs?: number): number;
  expired(): boolean;
  throwIfExpired(stage: string): void;
  race<T>(stage: string, operation: Promise<T>, capMs?: number, onTimeout?: () => void): Promise<T>;
}
```

公开 `java_impact` 不再接受多个彼此独立的 timeout，而使用一个 `deadlineMs`：

| mode/policy | 默认 deadline |
|---|---:|
| fast/minimal | 1,500 ms |
| fast/balanced | 2,000 ms |
| auto | 3,000 ms |
| required | 5,000 ms |
| 显式上限 | 15,000 ms |

这些值是初始配置，最终以固定机器 benchmark 校准。任何子阶段只能消费剩余预算。`onTimeout` 只负责取消该 stage 的底层工作；不得把一个短 caller 的超时错误地传播成共享 singleflight backend 的全局取消。

## 7.3 Completion

```ts
export type Completion =
  | "COMPLETE"
  | "PARTIAL_TIMEOUT"
  | "PARTIAL_LIMIT"
  | "CANCELLED"
  | "FAILED";
```

统一用于 search、index query 和 semantic request。只有 `COMPLETE` 结果可进入长期 cache；`PARTIAL_*` 可作为本次请求的低置信证据，但必须在输出中暴露 degradation。

## 7.4 Error taxonomy

```ts
export type JavaIntelligenceErrorCode =
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "JDT_NOT_READY"
  | "JDT_BROKEN"
  | "JDT_BACKOFF"
  | "JDT_BUSY_OTHER_SESSION"
  | "JDT_ORPHANED"
  | "JDT_CONFIG_ERROR"
  | "LEASE_CONFIG_ERROR"
  | "JDT_SERVER_ERROR"
  | "SEARCH_TIMEOUT"
  | "SEARCH_FAILED"
  | "INDEX_PARTIAL"
  | "INDEX_CORRUPT"
  | "OUTSIDE_REPO"
  | "INVALID_INPUT";
```

预期 timeout/cancel 不输出完整 stack 到 stderr。只有未知错误、状态机不变量破坏和启动失败输出 error 级别日志。


---

# 8. 新鲜度与统一 generation

## 8.1 现状问题

当前 watcher 与 JDT LS 生命周期绑定，导致 fast/no-LSP 路径可能没有文件变更事件。与此同时：

- Router `rg` cache 依赖 session invalidation generation；
- SourceIndex 只在访问具体文件时检查 mtime；
- delete/rename 没有可靠驱逐；
- layout 在 runtime 构造时固化；
- edge store 和 JDT cache 有各自失效逻辑。

结果是同一请求可能组合不同时间点的事实。

## 8.2 RepoChangeCoordinator

引入一个与 JDT 无关、RepoRuntime 创建时即启动的 coordinator：

```ts
export type RepoChangeKind =
  | "JAVA_ADD"
  | "JAVA_CHANGE"
  | "JAVA_DELETE"
  | "RESOURCE_CHANGE"
  | "BUILD_CHANGE"
  | "WATCHER_DEGRADED";

export type RepoChangeBatch = {
  generation: number;
  observedAt: string;
  changes: Array<{
    kind: RepoChangeKind;
    absolutePath: string;
  }>;
};
```

职责：

1. 根据 layout 监听 Java source roots、resource roots 和 build files。
2. 对 add/change/unlink 做 100～250ms debounce 和 path 去重。
3. 每个 flush 原子地 `generation++`。
4. 将同一 batch 广播给 JavaIndex、rg cache、semantic cache/edge store 和 layout manager。
5. build file 变化后重新 probe layout，再调整 watched roots。
6. watcher error 时：
   - `dirty=true`；
   - generation++；
   - 下一次请求先执行一次 manifest reconcile；
   - 不建设常驻周期 reconcile，除非真实观测证明 macOS watcher 丢事件。
7. `start()` 的 Promise 在 watcher 发出 `ready` 后完成，但请求不得无上限等待。`prepareFreshness()` 最多等待 `min(2_000ms, request budget remaining)`：
   - ready：执行两次 `flushNow()` 包围 dirty reconcile，进入 `NORMAL`；
   - timeout/error：请求以 `WATCHER_NOT_READY/WATCHER_DEGRADED` 放行，禁止 generation-scoped query cache 读写、禁止 negative lookup、禁止持久化 semantic edge；anchor 仍执行 foreground `ensureFresh`，`rg` 以 uncached 方式运行。
8. 每次请求固定 generation 前先执行 `flushNow()`，把已经到达但仍在 debounce 窗口内的事件纳入当前 generation；只有 freshness preparation 成功后才允许写 cache。
9. dirty reconcile 使用 singleflight 和 compare-and-set clear；reconcile 期间若又有事件，dirty 保持为 true，下一次请求继续 reconcile。
10. 大批量 branch switch/rebase 事件不逐文件塞入 foreground 队列；达到 storm 阈值后转换为 background reconcile，具体规则见 §8.10。

## 8.3 GenerationClock

```ts
export class GenerationClock {
  private value = 1;
  private dirty = false;

  snapshot(): { value: number; dirty: boolean };
  rebaseAtLeast(value: number): number;
  advance(reason: string): number;
  markDirty(reason: string): number;
  clearDirty(expectedGeneration: number): void;
}
```

generation 是进程内单调序号，不要求不同进程的数字可比较，但同一进程重载自己的 snapshot 时必须衔接：

- own snapshot：先 `rebaseAtLeast(snapshot.indexedGeneration)`，再做 manifest verification；无变化时 coverage 可保持 COMPLETE，发现变化则 `advance()` 后应用 change batch；
- sibling seed：忽略来源 `indexedGeneration`，使用目标 worktree 的本地 generation，coverage 一律从 DEGRADED/BUILDING 开始；
- watcher 未 ready 或 verification 未完成时，不允许通过 generation 相等关系启用 negative cache。

## 8.4 统一失效规则

| 组件 | cache identity | 变更行为 |
|---|---|---|
| rg query cache | repoHash + generation + plan fingerprint | batch 到达立即淘汰旧 generation |
| JavaIndex query cache | indexedGeneration + query | worker refresh 后自然切换 |
| static negative cache | sourceRoot coverage generation | root 非 COMPLETE 时禁用 |
| JDT response cache | request key + dependency fingerprint + generation | 依赖文件变化淘汰；build 变化清空 |
| semantic edge | edge dependencies + generation | 任一依赖变化删除 |
| layout | build-file fingerprint | build batch 后重新探测 |
| readPlan cache | 不建立跨请求长期 cache | 由低层 cache 提速 |

## 8.5 Rename/delete 语义

watcher 通常无法直接提供 rename pair。系统不需要强行推断 rename：

```text
old path unlink → 删除旧 facts/edges/cache
new path add    → 新建 facts/edges/cache
```

只要同一 batch generation 内完成，结果正确性不受影响。

## 8.6 Pending change queue

如果上一批 refresh 尚未完成，新事件不得丢弃。coordinator 使用一个按路径覆盖的 pending map：

```ts
Map<absolutePath, RepoChangeKind>
```

合并规则：

| old | new | merged |
|---|---|---|
| ADD | CHANGE | ADD |
| ADD | DELETE | 删除该 pending entry |
| CHANGE | CHANGE | CHANGE |
| CHANGE | DELETE | DELETE |
| DELETE | ADD | CHANGE |

refresh 完成后继续 drain，直到 pending 为空。该机制借鉴通用图项目的 pending queue，但保持单进程、单 repo 的最小实现。

## 8.7 Worktree identity 与 family 不变量

```ts
export type WorktreeIdentity = {
  repoRoot: string;          // canonical worktree root，正确性身份
  repoHash: string;          // hash(repoRoot)，所有 repo-scoped cache key
  gitCommonDir?: string;     // canonical git common-dir
  familyHash?: string;       // hash(gitCommonDir)，只用于协调/seed discovery
  isLinkedWorktree: boolean;
};
```

必须保持：

1. 每个 worktree 独立 generation、watcher、JavaIndex worker、JDT `-data`、query cache 和 semantic edge snapshot。
2. `familyHash` 不得进入候选事实 identity，也不得让分支 A 的 COMPLETE coverage 直接成为分支 B 的 COMPLETE。
3. stable IDs 根目录无关：
   - `fileId = file:<normalizedRelativePath>`；
   - `typeId = type:<FQN>`，无法形成稳定 FQN 时才用 `type-local:<relativePath>:<rangeStart>`；
   - `methodId = method:<declaringTypeId>#<erasedSignature>`；
   - `fieldId = field:<declaringTypeId>#<name>`；
   - `edgeId = edge:<kind>:<fromId>:<toId>:<sourceRange>`，以保留同一 caller/callee 的多个调用点；
   - 任何 ID 都不得包含 absolute repoRoot。
4. 同 worktree 多 MCP 进程可以各有内存索引，但 snapshot 发布必须 complete-only、manifest-validated、atomic；last-writer 不能把与当前文件系统不匹配的 snapshot 发布为可加载基线。

## 8.8 CrossProcessLeaseStore：无 daemon 的机器级协调

V3.1 增加一个聚焦的文件系统 lease primitive，不建设常驻 daemon：

```text
<repoCacheBase>/leases/
  capacity.json
  capacity.lock/
  runtime/<familyHash>/<repoHash>/<pid>-<ownerToken>/owner.json
  jdt-worktree/<repoHash>/owner.json
  jdt-slots/slot-0/lease.json ... slot-(N-1)/lease.json
  sweep-slots/slot-0/lease.json ...
```

租约协议：

- `ownerToken` 为进程启动时生成的 UUID；metadata 包含 owner PID、repoRoot、repoHash、familyHash、acquiredAt、heartbeatAt，并在 child spawn 后写入 `jdtlsPid`。
- runtime lease 不是同 worktree 互斥锁，路径使用 `runtime/<familyKey>/<repoHash>/<pid>-<ownerToken>`，其中 `familyKey = familyHash ?? repoHash`；它允许多个 fast-only/MCP 会话并存，只用于活性、janitor 和 family runtime 计数。
- 原子占有使用 `mkdir(slotDir)` 或 `open(..., "wx")`；禁止“先统计 lease 数、再创建 repoHash 文件”的 check-then-act 算法。
- JDT 启动按两级顺序获取：先 `jdt-worktree/<repoHash>` 独占 lease，再尝试固定编号 global slot；获取 global slot 失败必须释放 worktree lease后进入有界 FIFO 重试。该顺序同时防止同 worktree 双 JDT 和跨进程超出机器上限。
- 回收要求 owner PID 不存活且记录的 `jdtlsPid` 也不存在/不存活；活 owner 即使 heartbeat 陈旧也不强抢，owner 已死但 JDT child 仍活时进入 `ORPHAN_JDT` fail-closed 状态，不自动启动第二个 workspace。显式 restart/cleanup 可在确认后处理极端悬挂。
- child spawn 后必须先把 `jdtlsPid` 原子写入 worktree/global slot metadata，写失败则立即终止 child、释放 lease 并保持非 READY；不得运行一个 lease 无法追踪的 JDT。
- graceful stop、process exit 和 startup failure 都释放 owner 自己的 lease；下次启动负责清理死 PID 残留。
- `capacity.json` 冻结该 cacheRoot 当前使用的 `jdtSlots/sweepSlots/schemaVersion`。打开 lease store 时先以 `mkdir(capacity.lock)` 做短临界区；lock 目录携带 owner token/PID，死 owner 或超过 grace 的无 metadata lock 可回收，避免启动进程崩溃留下永久锁。有 live lease 时已有 capacity 为权威，配置不一致只报告 `capacityConflict`；没有 live lease 时允许用当前本机配置原子改写。不同 MCP 进程不能各自按不同的环境变量枚举不同数量的 slot。
- MCP server 在接受 tool call 前初始化 lease store。初始化失败不阻断 static JavaIndex/rg，但必须禁用 JDT start 并通过 typed degradation/status 暴露；绝不能在机器级协调不可用时退回进程内上限并继续启动 JVM。
- `maxActiveRepos` 成为机器级 slot 数；进程内 Task 4 FIFO reservation 仍保留，用于本进程公平性。

行为：

- `java_impact semanticPolicy=auto` 遇到 `JDT_BUSY_OTHER_SESSION`：走静态/rg 路径并在 semantic degradation 中说明。
- `java_impact semanticPolicy=required`：可返回已有静态结果，但必须携带类型化 `JDT_BUSY_OTHER_SESSION`，不得声称 exact semantic 完成。
- `java_symbol/java_references` 等纯 JDT 工具：返回类型化错误，不启动第二个 JDT。

## 8.9 兄弟 worktree snapshot seeding

只有本 worktree 没有可用 own snapshot 时才尝试 seed：

```text
resolve family siblings
→ choose newest COMPLETE candidate
→ validate schema/extractor/stableId/buildFingerprint
→ enumerate target typed manifest
→ compare kind + relativePath + contentHash (Java；schema 3 还包含 MyBatis XML)
→ publish only exact-matching facts into target in-memory store
→ mark changed/new/deleted paths dirty/missing
→ coverage DEGRADED/BUILDING
→ foreground ensureFresh(anchor) + background delta parse
→ target reconcile COMPLETE
→ write target-owned snapshot
```

关键约束：

- canonical root mismatch 在**普通 snapshot load** 时仍拒绝；只有显式 seeder 可跨 root 读取。
- seed 不直接加载来源 query cache、negative cache、open documents、JDT workspace 或 semantic edge store。
- 在任何 seeded fact 对 provider 可见之前，必须完成 manifest-only 内容校验；不能仅凭相同 buildFingerprint 假设 Java 源码相同。
- manifest pass 可以读取/哈希文件，但不做 AST parse；目标是用低成本排除分支差异。每个目标文件以 open/fstat/read-hash/fstat-or-restat 的稳定读取形成 `{relativePath,size,mtimeNs,contentHash}`；读取期间变化的文件直接进入 dirty 集合。可在 Git tracked 文件上利用 blob/index 信息优化，但最终比较语义必须等价于内容 hash。
- validation 开始时记录 target generation；在 fresh target store 原子安装前执行 `flushNow()` 并确认 generation 未变化。若有变化，只复核该 change batch 涉及的复用文件；未复核前不得把它们发布为 positive facts。
- 不匹配文件的来源 facts 不进入目标 store；因此 DEGRADED 表示“覆盖不完整”，而不是“已知声明事实来自错误分支”。
- seed 的最小复用单元区分“文件局部事实”和“跨文件解析边”：声明、range、imports、未解析 type/call-site 可在源文件内容匹配时复用；一条 repo-internal resolved edge 只有当其 source/target owner files 都在目标 manifest 中 exact-match 时才可复用，否则丢弃该边并排一个 `RELINK_ONLY` job。这样目标类型被修改/删除时，不会把兄弟分支的旧解析边暴露成正向事实。
- Snapshot schema 3 引入 MyBatis XML 后，typed manifest 同时覆盖受支持的 mapper resource；Java↔XML exact link 只有两端内容都匹配时才 seed。改变 XML 不应阻止无关 Java declarations 复用，但会让 resource/framework coverage 保持 DEGRADED 直到 relink。
- 第一版不 seed persisted JDT edges；待 Stage 5 后再按真实收益决定。

## 8.10 Branch-switch/rebase storm 与后台节流

定义 storm：

```text
changedPaths >= 100
OR changedPaths >= max(20, ceil(indexedJavaFiles * 0.10))
```

storm batch：

- generation 只推进一次；
- 受影响 roots 置 BUILDING/DEGRADED；
- 不为每个文件排 priority-0 parse；
- 提交一个 manifest reconcile/background delta parse；
- 请求 anchor 继续通过 `ensureFresh(anchor)` 抢占 background work；
- standard 输出标记 `freshness.storm=true`，但不输出路径清单。

ignore 规格必须覆盖 `.git` 文件和目录、解析出的 common git dir、`.gradle`、`build`、`target`、`out`、`bin`、`node_modules`、`dist` 与缓存目录。唯一例外是 layout/build model 明确识别并直接 watch 的 generated source root；其祖先输出目录只为到达该 allowlisted root 放行，不允许任意 build/target 内容进入索引。linked worktree 根下 `.git` 是指向 common-dir 的文件，其变化不得生成 Java change 或推进 generation。

后台 full sweep/delta reconcile 使用 machine-level `sweep-slot`，默认全机并发 1，可配置最大 2；foreground anchor refresh 不占 sweep slot。parse-tree LRU 默认 64MiB，但按全机活跃 runtime lease 数动态收缩：>=2 时降为 32MiB，>=3 时降为 24MiB；这样 unrelated repo 也不会绕过内存预算。用户显式配置优先。

## 8.11 Snapshot generation rebase 与发布安全

Own snapshot OPEN：

1. 校验 schema/extractor/stableId/buildFingerprint/canonical root。
2. `clock.rebaseAtLeast(indexedGeneration)`。
3. 在 cacheable/negative lookup 前完成 manifest verification。
4. manifest 完全相同：coverage 保持 snapshot generation 的 COMPLETE。
5. 存在差异：`generation++`，apply changes，受影响 root DEGRADED；无需全量重 parse。

Seed OPEN：忽略来源 generation，所有 target facts 写入目标当前 generation，coverage 先 DEGRADED。

Snapshot publish 在 atomic rename 前再次确认 candidate 的 `manifestFingerprint` 等于最近一次 target manifest；不满足则拒绝发布并重新排队。generation 只是进程内 consistency token，跨进程 snapshot 可信度由内容 manifest 决定。

## 8.12 Janitor 与多进程活性

保留并升级 `worktree-cache-cleanup.ts`：

- `repo-meta.json` 写 `ownerPid/ownerToken/lastRequestAt/jdtlsPid`；fast-only runtime 也持续 touch。
- janitor 在删除前检查 runtime lease、owner PID、JDT PID 和 workspace lock；任一活跃则跳过。
- lifecycle 重构后，`jdtlsPid` 只在 READY commit 后写入，BROKEN/STOPPED 清除。
- janitor 不删除 lease store 本身；死 lease 由 lease reclamation 独立处理。
- 新 snapshot 和 semantic edge snapshot 仍位于 per-worktree cacheRoot，因此 TTL 清理自然覆盖。

---

# 9. JavaIndex V2：Tree-sitter Java 静态事实底座

## 9.1 为什么必须替换 regex parser

regex 作为 fallback 可以保留，但不能继续承担主要结构事实：

- 只识别首个 type declaration；
- package-private 方法漏掉；
- nested type 不完整；
- annotation、generic、record、sealed class 处理脆弱；
- 字符串、注释和 text block 内的花括号会污染方法边界；
- 方法体调用边几乎无法可靠扩展；
- simple name 与 import 解析不足。

Tree-sitter 是增量 concrete syntax tree parser，能在语法错误存在时仍提供可用结构。`tree-sitter-java` 只提供语法事实，不替代 Java 类型系统；其职责边界必须清楚。

## 9.2 依赖决策

首选组合：

```json
{
  "tree-sitter": "0.25.0",
  "tree-sitter-java": "0.23.5"
}
```

开发第一步必须在 Node.js 22、macOS arm64/x64 和 `worker_threads` 中验证：加载、完整 parse、`Tree.edit` 增量 parse、changed ranges 和 Tree 资源释放。若 native binding 无法稳定安装或不能在 worker 加载，则使用唯一备选：

```json
{
  "web-tree-sitter": "0.26.11"
}
```

并固定 Java WASM artifact。不会长期维护 native/WASM 双实现；兼容性 spike 后二选一。

### 9.2.1 Java-only parser 备选方案为何不作为主底座

Java-only 并不意味着必须把静态索引也实现成第二个 JVM 服务。V3 对四种方案做如下取舍：

| 方案 | 优点 | 主要代价 | V3 决策 |
|---|---|---|---|
| Tree-sitter Java | 增量、容错、无需 classpath、可放 Node Worker、编辑中源码也能抽事实 | 不提供完整 Java binding，需要自建有限名称解析 | **主静态底座** |
| Eclipse JDT `ASTParser` | Java 语法模型完整，可选 binding | binding 依赖 Java model/environment，时间和空间成本高；引入第二套 JVM/生命周期，与已有 JDT LS 重叠 | 不作为常驻 cold index；JDT LS 继续负责 exact semantic |
| JavaParser + SymbolSolver | API 友好，支持 AST 与符号求解 | 完整项目求解需要 source roots、依赖 JAR 和 build model；仍需长驻 Java sidecar 或反复启动 JVM | 不引入，除非 Tree-sitter 在真实 golden 上出现无法修复的语法覆盖缺口 |
| Spoon | Java 分析/变换模型强 | 面向更重的分析与 transformation，依赖和对象模型超出只读 Agent 路由需求 | 不引入 |

仅依赖 JDT LS `documentSymbol` 也不够：它要求语义 runtime 可用，无法保证 cold/no-LSP 路径，并且不是完整 import、字段类型、局部类型和调用事实接口。

Tree-sitter 方案不是信仰式选择。出现以下任一条件时才触发 Java helper 对照 spike：

- 扩充后的真实 golden 中，AST 提取错误直接造成 `R_read_must` 或 `R_task_blocking` 回退，且无法通过 grammar query/extractor 修复；
- 目标 Java 语言版本长期超出 `tree-sitter-java` 可解析范围；
- 单 worker 的全仓 sweep 在目标最大仓库持续超过既定 SLO，而 JDT/JavaParser 批处理有可复现的明显优势。

在触发前，不为理论上的 Java 语义完整度维护第二套常驻 Java parser service。

## 9.3 单 Worker Actor，而非通用 Pool

```text
Main MCP Thread
   │ async messages
   ▼
JavaIndexWorker
   ├─ Tree-sitter Parser
   ├─ in-memory normalized indexes
   ├─ coverage state
   ├─ low-priority full sweep
   ├─ foreground refresh queue
   └─ atomic snapshot writer
```

选择一个 worker 的理由：

- 项目是单用户、本机、Java-only；
- 索引 mutation 串行化可显著降低一致性复杂度；
- Tree-sitter parse 从主事件循环移出即可解决主要阻塞；
- foreground change 可高于 background sweep；
- 不需要 pool 的任务窃取、共享连接和公平性治理。

Worker 崩溃后 client 允许重启一次并从 snapshot 重建；连续失败进入 degraded，fast path 回退到 bounded `rg`。

### 9.3.1 Incremental parse tree LRU

Tree-sitter 的增量能力只在 worker 内使用，不把 syntax tree 序列化。Worker 维护一个有界 parse-tree LRU：

```ts
export type ParseTreeCachePolicy = {
  maxEntries: 128;
  maxSourceBytes: 64 * 1024 * 1024;
  maxSingleFileBytes: 2 * 1024 * 1024;
  maxIncrementalChangeRatio: 0.25;
};
```

每项保存 `tree + previous source text + lastUsedAt`。文件刷新时：

1. 用 UTF-8 byte prefix/suffix 计算一个保守的 contiguous `InputEdit`；所有 syntax-node `startIndex/endIndex` 文本提取都通过 Buffer-backed `Utf8Source`，禁止用 byte offset 直接 `String.slice()`；
2. old tree/source 在 LRU 且变更比例不超过 25% 时，执行 `tree.edit()` 后以 old tree 增量 parse；
3. 多段或大比例重写直接 full parse；
4. 增量结果与 clean full parse 在测试中必须产出相同 facts；
5. LRU 淘汰时释放 Tree native/WASM 资源；
6. source text 和 syntax tree 永不写入 snapshot。

这样能够优化日常小改动，又不会把全仓 AST 常驻内存作为新的复杂度和内存风险。

## 9.4 Worker 协议

```ts
export type JavaIndexCommand =
  | { type: "OPEN"; repoRoot: string; cacheDir: string; generation: number }
  | { type: "REFRESH"; generation: number; changed: string[]; deleted: string[] }
  | { type: "RECONCILE"; generation: number }
  | { type: "QUERY_ANCHOR"; file: string; line: number; column: number }
  | { type: "QUERY_TYPE"; typeRef: JavaTypeRef; scopeFile?: string }
  | { type: "QUERY_IMPLEMENTERS"; typeId: string; limit: number }
  | { type: "QUERY_REFERENCERS"; typeId: string; edgeKinds: StaticEdgeKind[]; limit: number }
  | { type: "QUERY_CALLERS"; methodId: string; limit: number }
  | { type: "QUERY_CALLEES"; methodId: string; limit: number }
  | { type: "QUERY_FILES"; files: string[] }
  | { type: "STATUS" }
  | { type: "FLUSH" }
  | { type: "CLOSE" };
```

所有请求带 request id；client 提供 typed Promise API。Worker response 必须经过 zod 或手写 type guard 校验，防止协议漂移污染主进程。

## 9.5 统一 SourceRange 坐标契约

所有跨模块、snapshot、Evidence 和 readPlan range 使用：

```ts
export type SourcePosition = {
  line: number;    // 1-based
  column: number;  // 1-based UTF-16 code units
};

export type SourceRange = {
  start: SourcePosition;
  end: SourcePosition; // end exclusive
};
```

Tree-sitter 的 `startIndex/endIndex` 和 point column 是 UTF-8 byte 语义，只允许存在于 JavaIndex worker 的 parser/edit 层。`Utf8Source` 必须使用 absolute byte offset 定位行首，并把行内 byte prefix 解码为 JavaScript string，以其 UTF-16 length 计算统一 column。JDT LS 边界只执行 1-based 到 0-based 转换；禁止把 Tree-sitter byte column 直接交给 LSP。

## 9.6 标准事实模型与 root-independent stable IDs

### File facts

```ts
export type JavaFileFacts = {
  fileId: string;          // file:<normalizedRelativePath>，不得包含 repoRoot
  relativePath: string;
  sourceRoot: string;
  module: string;
  sourceSet: "main" | "test" | "generated" | "unknown";
  packageName: string;
  imports: JavaImportFact[]; // `wildcard` and `static` are explicit flags
  topLevelTypeIds: string[];
  allTypeIds: string[];
  contentHash: string;
  size: number;
  mtimeMs: number;
  parseState: "COMPLETE" | "RECOVERED" | "FAILED";
  parseErrorCount: number;
  generation: number;
};
```

### Type facts

```ts
export type JavaTypeKind =
  | "class"
  | "interface"
  | "record"
  | "enum"
  | "annotation";

export type JavaTypeFacts = {
  typeId: string;          // type:<FQN> 或 type-local:<relativePath>:<rangeStart>
  fqn?: string;
  simpleName: string;
  kind: JavaTypeKind;
  fileId: string;
  enclosingTypeId?: string;
  range: SourceRange;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  typeParameters: JavaTypeParameterFact[];
  extends: JavaTypeRef[];
  implements: JavaTypeRef[];
  permits: JavaTypeRef[];
  fieldIds: string[];
  methodIds: string[];
  confidence: number;
};
```

### Method facts

```ts
export type JavaMethodFacts = {
  methodId: string;        // method:<ownerTypeId>#<erasedSignature>
  ownerTypeId: string;
  name: string;
  constructor: boolean;
  signatureKey: string;
  range: SourceRange;
  bodyRange?: SourceRange;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  typeParameters: JavaTypeParameterFact[];
  returnType?: JavaTypeRef;
  parameters: Array<{ name: string; type: JavaTypeRef; varargs: boolean; range: SourceRange }>;
  throws: JavaTypeRef[];
  callSites: JavaCallSiteFact[];
  localTypes: JavaTypeRef[];
};
```

### Type reference

```ts
export type JavaTypeRef = {
  text: string;
  simpleName: string;
  qualifiedName?: string;
  typeArguments: JavaTypeRef[];
  arrayDepth: number;
  wildcard?: "extends" | "super" | "unbounded";
  resolution:
    | { state: "RESOLVED_REPO"; typeId: string; strategy: TypeResolutionStrategy }
    | { state: "EXTERNAL"; qualifiedName: string; strategy: "QUALIFIED" | "EXPLICIT_IMPORT" | "JAVA_LANG" }
    | { state: "TYPE_VARIABLE"; name: string }
    | { state: "AMBIGUOUS"; candidates: string[] }
    | { state: "UNRESOLVED" };
  range?: SourceRange;
};
```

## 9.7 AST 抽取范围

V2 第一版必须覆盖以下 Tree-sitter Java node：

- `package_declaration`
- `import_declaration`
- `class_declaration`
- `interface_declaration`
- `record_declaration`
- `enum_declaration`
- `annotation_type_declaration`
- `method_declaration`
- `constructor_declaration`
- `compact_constructor_declaration`
- `field_declaration`
- `formal_parameter`
- `spread_parameter`
- `type_parameters`
- `superclass`
- `super_interfaces`
- `permits`
- `throws`
- `annotation`
- `marker_annotation`
- `method_invocation`
- `object_creation_expression`
- `method_reference`
- `field_access`
- `local_variable_declaration`
- `cast_expression`

不在第一版实现完整表达式类型推断。调用 receiver 仅记录可直接解析的形式：

- `this.foo()`；
- `super.foo()`；
- `TypeName.foo()`；
- 字段或参数名 `service.foo()`，且其声明类型可解析；
- 无 receiver 的同类方法调用；
- `new TypeName(...)`；
- `TypeName::method` / `expr::method`。

复杂链式泛型和数据流交给 JDT LS 确认，不在静态层重造编译器。

## 9.8 FQN/name resolution

解析顺序固定且可测试：

1. 当前 method/type scope 中已声明的 type parameter；
2. source 中已经是 qualified name；
3. 当前文件 explicit import；
4. enclosing/nested type；
5. 当前 package；
6. `java.lang`；
7. wildcard import 中唯一 repo 候选；
8. repo 全局 simple name 唯一候选；
9. 多候选则 `AMBIGUOUS`；
10. 无候选则 `UNRESOLVED`。

解析状态必须区分：

```ts
type TypeResolution =
  | { state: "RESOLVED_REPO"; typeId: string; strategy: TypeResolutionStrategy }
  | { state: "EXTERNAL"; qualifiedName: string; strategy: "QUALIFIED" | "EXPLICIT_IMPORT" | "JAVA_LANG" }
  | { state: "TYPE_VARIABLE"; name: string }
  | { state: "AMBIGUOUS"; candidates: string[] }
  | { state: "UNRESOLVED" };
```

显式导入的 Spring/JPA/JDK 类型即使没有 repo source，也应成为 `EXTERNAL`，用于 annotation/framework metadata 和 overload hint；它们没有 repo 文件，因此永不直接成为 readPlan candidate。任何 `AMBIGUOUS` 结果不产生 exact static edge。

## 9.9 静态边

```ts
export type StaticEdgeResolutionKind =
  | "AST_EXPLICIT"
  | "TYPE_REFERENCE"
  | "SAME_OWNER_NAME_ARITY"
  | "DECLARED_RECEIVER_NAME_ARITY"
  | "SUPER_CHAIN_NAME_ARITY"
  | "CONSTRUCTOR_TYPE"
  | "METHOD_REFERENCE_OWNER";

export type StaticEdgeKind =
  | "DECLARES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "PERMITS"
  | "IMPORTS"
  | "FIELD_TYPE"
  | "PARAM_TYPE"
  | "RETURN_TYPE"
  | "THROWS_TYPE"
  | "LOCAL_TYPE"
  | "CALLS"
  | "CONSTRUCTS"
  | "METHOD_REFERENCE"
  | "ANNOTATED_WITH";

export type StaticEdge = {
  edgeId: string;
  fromId: string;
  toId: string;
  kind: StaticEdgeKind;
  confidence: number;
  range?: SourceRange;
  sourceFile: string;
  generation: number;
  resolution: {
    kind: StaticEdgeResolutionKind;
    typeStrategy?: TypeResolutionStrategy;
  };
};
```

每条 edge 都包含 source range 与 resolution strategy。`TYPE_REFERENCE` 必须保留原始 `TypeResolutionStrategy`；call edge 必须指出是 same-owner、declared receiver、super-chain、constructor 还是 method-reference 解析。静态边不会假装拥有 JDT exact 的语义级别。

## 9.10 Coverage 模型

```ts
export type SourceRootCoverage = {
  root: string;
  generation: number;
  state: "UNKNOWN" | "BUILDING" | "COMPLETE" | "DEGRADED";
  discoveredFiles: number;
  indexedFiles: number;
  failedFiles: number;
  recoveredFiles: number;
  extractorVersion: string;
  completedAt?: string;
};
```

规则：

- `COMPLETE`：该 generation 下 manifest 已完整枚举，所有文件均为无语法恢复缺口的成功 parse，且没有读取失败。
- `DEGRADED`：存在 recovered/failed parse、读取失败或 watcher dirty 未 reconcile；recovered facts 仍可用于正向证据。
- `BUILDING`：后台 sweep 尚未完成。
- `UNKNOWN`：未开始。
- negative cache 只允许 `COMPLETE` 且 coverage generation 与 query generation 相同。
- recovered syntax tree 可参与正向命中，但不能作为完整负结论依据。
- 一个健康 watcher 上的已知 add/change/delete batch，在所有增量刷新成功后可把上一代 COMPLETE root 直接推进到新 generation 的 COMPLETE；不要求每次保存都重跑 full sweep。
- build/layout 变化、watcher degraded、未知 root、读取失败或 recovered parse 会使 root 进入 DEGRADED/BUILDING，并触发 reconcile/full sweep。

## 9.11 Background sweep

RepoRuntime 创建后：

1. 立即加载 snapshot；
2. anchor 所在文件和 request 所需文件走 foreground refresh；
3. source roots 启动低优先级 sweep；
4. change batch 可抢占 background queue；
5. sweep 完成后 coverage 进入 COMPLETE；
6. 不阻塞第一次 `java_impact`。

## 9.12 Snapshot

文件：

```text
~/Library/Caches/codex-java-lsp/<repoHash>/java-index-v3.snapshot.json.gz
```

`buildFingerprint` 不是 mtime 拼接，而是稳定内容指纹：

```text
SHA-256(
  canonical relative path + content SHA-256 of every detected build/JDK marker
  + sorted source/resource roots
  + layout profile
)
```

纳入的文件至少包括 root/module `pom.xml`、`settings.gradle(.kts)`、`build.gradle(.kts)`、`gradle.properties`、`gradle/libs.versions.toml`、`.java-version`、`.sdkmanrc` 和 `.mvn/jvm.config`。缺失文件不进入列表；顺序固定。这样 checkout mtime 漂移不会无效化 snapshot，而 classpath、source root、framework dependency 或 JDK marker 变化会无效化。

最终 Envelope（MyBatis resource facts 落地后）：

```ts
export type JavaIndexSnapshotV3 = {
  schemaVersion: 3;
  extractorVersion: string;
  canonicalRepoRoot: string;
  buildFingerprint: string;
  indexedGeneration: number;
  manifestFingerprint: string;
  stableIdVersion: number;
  createdAt: string;
  coverage: SourceRootCoverage[];
  files: JavaFileFacts[];
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
  edges: StaticEdge[];
  myBatisResources: MyBatisMapperResourceFacts[];
};
```

JavaIndex snapshot 只存 AST/resource 静态事实。JDT exact edge 使用 §11.6 的独立小 snapshot，不混入该文件。开发过程中的 schema-2 snapshot 不迁移；进入 schema 3 时直接删除重建。

写入在 worker 中完成：

```text
serialize → gzip → write tmp → fsync/close → rename
```

规则：

- schema/extractor/stable-id version mismatch：直接丢弃重建；
- canonical root mismatch：普通 OPEN 拒绝加载；只有 §8.9 的显式 sibling seeder 可读取；
- build fingerprint mismatch：不作为 complete snapshot 使用；可由 seeder 提取候选，但 coverage 保持 DEGRADED；
- own snapshot generation：按 §8.11 rebase 后做 manifest verification；
- JSON/gzip corruption：删除损坏 snapshot，进入 rebuild；
- 进程在 rename 前崩溃：旧 snapshot 仍完整；
- publish：candidate manifestFingerprint 与目标最近 manifest 不一致时拒绝 rename；
- 不写旧 JSONL migration；旧 `source-index.*.jsonl` 和旧 edge snapshot 在 V2 首次启动时删除。

## 9.13 主线程同步热点处理

以下操作全部移出 MCP 主事件循环：

- Java 文件读取和 parse；
- snapshot load/parse/serialize/compress；
- full manifest walk；
- index compact；
- type lookup fallback scan。

`status()` 不再做全量 `statSync`；worker 维护预聚合状态并通过 `STATUS` 返回。

---

# 10. SearchExecutor V2

## 10.1 rg 的角色

`rg` 从“主结构召回器”降级为：

- index coverage 尚未 complete 时的 fallback；
- 字符串、配置、SQL、XML、日志 key 和动态 wiring 的证据源；
- task keyword 与未知 symbol 的 lexical recall；
- framework adapter 尚未覆盖的旁路证据。

## 10.2 流式 JSON 聚合

执行方式改为：

```bash
rg --json --line-number <pattern> <roots...>
```

使用 stdout byte stream + bounded line decoder 逐条解析 `match` event，不再拼接完整 stdout。聚合器只保存：

- raw byte count；
- total match count；
- per-file count；
- 每文件前 N 个位置；
- category/provider；
- completion。

执行器必须同时设置：单 JSON line 上限、总 raw bytes 上限、match count 上限、stderr tail 上限、SIGTERM→SIGKILL grace。stderr 必须被持续消费，避免子进程因 pipe 填满而阻塞。pattern 使用 `-e` 传入，root 前使用 `--`，避免以 `-` 开头的任务词被当成参数。timeout/limit 时当前已收集证据可作为 PARTIAL 返回，但不得写 cache；请求总超时只能额外增加固定 kill grace。所有 match path 在进入候选前再次执行 canonical repo containment。

这同时避免含冒号文件名对 `path:line:text` 正则解析的干扰，并把恶意/异常长源码行的内存风险控制在常量范围内。

## 10.3 SearchResult

```ts
export type SearchResult = {
  files: SearchFileMatch[];
  completion: Completion;
  rawBytes: number;
  totalMatches: number;
  elapsedMs: number;
  stderrTail?: string; // diagnostic only
  errorCode?: JavaIntelligenceErrorCode;
};
```

cache rule：

```ts
if (result.completion === "COMPLETE") {
  cache.set(key, result);
}
```

`PARTIAL_TIMEOUT` 可在当前请求中使用，evidence completeness 为 PARTIAL，输出必须包含 gap；绝不进入 cache。

## 10.4 Cache key

```text
repoHash
+ generation
+ provider id/version
+ normalized pattern
+ roots
+ globs
+ focus/exclude modules
```

不再以 JDT cache invalidation 作为 fast 路径 generation。

## 10.5 资源边界

- 每 repo 默认 `rg` 并发 2；全局默认 4。
- 每文件最多保存 4 个位置。
- 单行解析设置合理长度上限，超长内容只计数不进入 snippet。
- 请求 deadline 到达时发送 SIGTERM，短暂 grace 后 SIGKILL。
- spawn error 与 timeout 分开统计。

---

# 11. JDT Semantic Runtime V2

## 11.1 5 态生命周期

```ts
export type JdtlsLifecycleState =
  | "NEW"
  | "STARTING"
  | "READY"
  | "BROKEN"
  | "STOPPED";
```

允许转换：

```text
NEW     → STARTING
STOPPED → STARTING
BROKEN  → STARTING（显式重启或 backoff 到期）
STARTING → READY
STARTING → BROKEN
STARTING → STOPPED（显式 stop/restart）
READY    → STOPPED
READY    → BROKEN（unexpected exit）
BROKEN   → STOPPED
```

`status.started` 的唯一定义是 `state === READY`。进程存在不代表 READY。

不增加 `STOPPING` 公共状态：`stop()` 先把目标态置为 STOPPED，使新请求不能继续使用旧 session；内部 `stopPromise`/attempt identity 负责等待 shutdown/kill 完成，新的 `ensureStarted()` 必须先等待旧 stop cleanup 结束后才能创建 attempt。

## 11.2 Start singleflight 与事务提交

```text
ensureStarted(callerBudget)
  ├─ READY      → return
  ├─ STARTING   → caller waits on same startPromise within its own budget
  ├─ NEW/...    → create one startPromise with a repo-runtime hard cap
  │
  └─ startTransactional(startHardCap)
       ├─ create child/connection as local attempt
       ├─ register handlers
       ├─ initialize within internal start hard cap
       ├─ send initialized/configuration
       ├─ verify non-empty initialize result
       ├─ verify attempt was not stopped/superseded
       ├─ commit child/connection to session fields
       └─ state = READY
```

调用者预算与共享启动预算分离：短 deadline 的 caller 只停止等待，不得杀死另一个 caller 正在共享的 initialize。共享启动本身仍受独立、有限的 hard cap 约束；显式 stop/restart 可取消它。

任一步骤失败：

```text
cancel pending requests
→ dispose connection
→ SIGTERM/SIGKILL child
→ clear attempt/member fields
→ state = BROKEN
→ record classified failure + restart backoff
→ reject仍在等待共享 startPromise 的 caller with same classified error
```

最小 restart backoff 属于生命周期正确性，必须在 Stage 1 落地，而不是拖到 SemanticGateway：

```ts
export type JdtRestartBackoff = {
  consecutiveFailures: number;
  retryAfterMs?: number;
  blockedUntilExplicitReset: boolean;
  lastErrorCode?: string;
};
```

规则：

- retryable start/server failure：`delay = min(30_000, 500 * 2^(n-1))`；
- caller deadline/cancel 不增加失败计数；
- JDT binary missing、project JDK missing/ambiguous 等配置错误设为 `blockedUntilExplicitReset=true`，直到显式 restart 或相关配置/build generation 变化；
- READY 本身不立即清零；同一 attempt 连续 READY 30s（初始值，可由实测调整）后或显式 `java_restart` 才清零，避免“刚 READY 就崩”绕过退避；
- backoff 期间 `ensureStarted` 立即返回类型化 `JDT_BACKOFF/JDT_BROKEN`，不得每个请求 respawn。

Node `child.killed` 仅表示调用过 `kill()`，不表示进程已退出；清理必须等待 `close/exit`，grace 到期再升级 SIGKILL。

## 11.3 Readiness 与 lifecycle 分离

不建设 9 态生命周期。JDT import/readiness 作为独立观测：

```ts
export type JdtReadiness = {
  initialized: boolean;
  progressActive: number;
  idleForMs: number;
  documentSymbolReady: boolean;
  lastLanguageStatus?: string;
};
```

`READY` 只表示协议可用。某个昂贵 query 是否值得发出，由 SemanticGateway 根据 readiness、历史 latency 和 request budget 决定。

## 11.4 Active repo admission：进程内 FIFO + 跨进程 lease

STARTING 和 READY 都占用 active slot。reservation 必须在允许 session 进入 STARTING 前原子授予，不能采用“先检查、后 start”的竞态流程。

该进程内 FIFO 只解决单 MCP 进程公平性；真正启动 child 前还必须按 §8.8 获取同 worktree 独占 lease 与机器级固定编号 JDT slot。任一 lease 获取失败，进程内 reservation 必须释放或保持为有界 waiter，不能把本进程额度当成全机额度。

进程内仍采用一个 FIFO wait queue、entry reservation、最老 idle READY victim 和 deadline timeout；跨进程 lease 只是把同一机器上的多个 stdio MCP 进程纳入同一容量边界，不扩展为通用调度平台。start fail/stop 按逆序释放 global slot、worktree lease 和 process-local reservation。

## 11.5 SemanticGateway

JDT 请求只通过 gateway 发起：

```ts
export interface SemanticGateway {
  locations(anchor: Anchor, budget: DeadlineBudget, options: LocationOptions): Promise<SemanticOutcome>;
  references(anchor: Anchor, budget: DeadlineBudget, options: ReferenceOptions): Promise<SemanticOutcome>;
  typeHierarchy(anchor: Anchor, budget: DeadlineBudget, options: HierarchyOptions): Promise<SemanticOutcome>;
  documentSymbols(file: string, budget: DeadlineBudget): Promise<SemanticOutcome>;
}
```

Gateway 负责：

- lifecycle/admission；
- absolute deadline；
- same-key singleflight；
- completed-value cache；
- error classification；
- repo containment；
- result normalization；
- reference file collapse/value ordering；
- metrics。

## 11.6 PersistedSemanticEdgeStore

最新 Review 表明项目已经有持久化 semantic edge 雏形。V3 不应删除这项能力，而应把它收敛成一个很小、严格的 exact-edge store，与 JavaIndex 静态 snapshot 分离：

```ts
export type PersistedSemanticEdge = {
  edgeId: string;
  sourceSymbolId: string;
  targetSymbolId: string;
  sourceFile: string;
  targetFile: string;
  relation: "JDT_DEFINITION" | "JDT_IMPLEMENTATION" | "JDT_REFERENCE" | "JDT_TYPE_HIERARCHY";
  sourceRange?: SourceRange;
  targetRanges: SourceRange[];
  provenance: "PERSISTED_JDT";
  confidence: 1;
  completion: "COMPLETE";
  dependencies: Array<{
    file: string;
    fingerprint: string;
  }>;
  buildFingerprint: string;
  validatedGeneration: number;
  createdAt: string;
};
```

边只在以下条件全部满足时写入：

- JDT query `COMPLETE`；
- source/target 均在当前 repo；
- source/target location 都可映射到稳定 JavaIndex ID；无法映射的结果只用于当前请求，不持久化；
- 所有 dependency fingerprint 已记录；
- query 没有 timeout/cancel/server error。

Store 规则：

- repo change batch 到来时，删除任何 dependency 命中的 edge；
- build fingerprint 变化时清空；
- 未受影响 edge 在 store generation 前移后可继续使用；
- snapshot 使用独立、原子、版本化小文件；
- cold/fast provider 可读取 persisted edge，但必须保留 `PERSISTED_JDT` provenance；
- partial JDT result 永不落盘；
- 不把静态 AST edge 和 persisted JDT edge 混成一个不可区分的图。

这既保留 phase 4～12 已有收益，也避免为了 JavaIndex V2 重写时把精确语义记忆退化掉。

## 11.7 Singleflight

```ts
Map<string, InflightEntry<BackendSettled>>
```

每个 entry 维护 shared backend promise、AbortController 和 waiter count。每个调用者以自己的 `DeadlineBudget` 等待 shared result，并在返回时生成自己的 `cacheHit/shared` 字段；短 deadline 调用者退出不会取消仍有其他 waiter 的 backend work。只有所有 waiter 都退出或 backend hard cap 到期时才发送 transport cancel。JDT restart backoff 的唯一所有者是 `JdtlsSession`；SemanticGateway 只读取 lifecycle/backoff 状态并返回 typed degraded outcome，不维护第二套失败计数。

key 包含：

```text
repoHash + generation + method + file fingerprint + position + options
```

相同请求并发只向 JDT 发送一次。Promise settled 后移出 in-flight map；只有 COMPLETE value 写入 TTL cache。

TTL 从 compute 完成时开始，而不是 compute 开始前。

## 11.8 Document LRU

- 最大 open documents：64；
- 每次使用 touch；
- 淘汰发送 `textDocument/didClose`；
- 文件删除立即 close；
- stop 清空；
- pinned/in-flight document 暂不淘汰。

## 11.9 Hierarchy

- visited key 使用稳定 item identity（URI + selection range + name）；
- depth、edge count、request count 和 budget 四重限制；
- 每个内层 request 显式使用 remaining budget；
- 不使用 120s 默认 timeout；
- cycle 不重复展开。

## 11.10 References 价值排序

JDT server 返回顺序不是 Agent 价值顺序。处理步骤：

1. containment，丢弃 repo 外路径；
2. 按文件 collapse；
3. 统计每文件 reference count 与代表位置；
4. 提取 file/module/sourceSet/layer；
5. 计算静态价值：
   - anchor 同文件；
   - main source；
   - same module；
   - task keyword；
   - focus module；
   - framework role；
   - test priority；
6. 对 repo-contained raw locations 设置 5000 的资源上限；超过上限标记 `PARTIAL_LIMIT`，不得写 complete cache/edge store；
7. 排序后再取 top N 文件；
8. 每文件最多保留 3 个位置。

不再直接 `items.slice(0, 40)`。

## 11.11 First-touch 决策

完成前述基础改造后，重新测：

```text
fresh workspace / reused workspace
× definition / implementation / references / typeHierarchy
× immediately-after-initialize / progress-idle / documentSymbol-warmed
```

只有同时满足以下条件，才扩大 required/default 使用：

- recall 或 task-blocking recall 有稳定净收益；
- `R_read_must=1`；
- first-touch P95 达到门槛；
- timeout/cancel 后端请求不会长期占用 session；
- Agent 总 token/round-trip 有净下降。

---

# 12. Evidence Model 与饱和排序

## 12.1 EvidenceEdge

```ts
export type EvidenceProvenance =
  | "AST_EXACT"
  | "AST_RESOLVED"
  | "FRAMEWORK_INFERRED"
  | "LEXICAL_RG"
  | "JDT_EXACT"
  | "PERSISTED_JDT";

export type EvidenceFamily =
  | "EXACT_SEMANTIC"
  | "STATIC_STRUCTURE"
  | "FRAMEWORK"
  | "LEXICAL"
  | "TASK_CONTEXT"
  | "SUPPORT";

export type EvidenceCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type EvidenceEdge = {
  edgeId: string;
  fromId: string;
  toId: string;
  kind: string;
  family: EvidenceFamily;
  provenance: EvidenceProvenance;
  confidence: number;
  completeness: EvidenceCompleteness;
  sourceFile: string;
  sourceRange?: SourceRange;
  generation: number;
  dependencies: Array<{ file: string; contentHash: string }>;
  providerId: string;
  providerVersion: string;
};
```

## 12.2 Provider contract

```ts
export interface CandidateProvider {
  readonly id: string;
  readonly version: string;
  collect(input: ProviderInput): Promise<ProviderOutcome>;
}

export type ProviderOutcome = {
  evidence: EvidenceSignal[];
  completion: Completion;
  elapsedMs: number;
  degradation?: string;
};
```

Provider 不得直接写 candidate score、read priority 或最终 reason。

## 12.3 证据家族

| Family | 例子 | 特性 |
|---|---|---|
| EXACT_SEMANTIC | JDT definition/reference/implementation | 高成本、高置信 |
| STATIC_STRUCTURE | implements、signature type、resolved call、import | 低成本、确定性强 |
| FRAMEWORK | Spring injection、MyBatis XML、JPA repository | Java-specific 推断 |
| LEXICAL | class stem、task keyword、SQL/config match | recall 兜底 |
| TASK_CONTEXT | focus module、profile、用户关键词 | 任务条件 |
| SUPPORT | test/config/SQL/migration | 验证与旁路证据 |

## 12.4 从裸加法改为家族饱和

旧式：

```text
score += rgBase
score += typeReferenceBase
score += importGraphBase
score += persistedEdgeBase
```

如果这些 provider 证明的是同一件事，候选会被重复满额放大。

V3 采用：

```text
familyScore(f) =
  max(adjustedWeight(signal in f))
  + diversityBonus * log2(1 + independentKinds)

familyScore(f) <= familyCap(f)

total = base
      + Σ familyScore(f)
      + sourceSet/same-module priors
      - cross-module/test penalties
```

其中：

```text
adjustedWeight = configuredWeight
               × confidence
               × completenessFactor
               × freshnessFactor
```

初始系数：

| completeness | factor |
|---|---:|
| COMPLETE | 1.0 |
| PARTIAL | 0.55 |
| UNKNOWN | 0.35 |

同 provider、同 edge kind、同 source range 的证据只保留一条。不同 family 才允许独立叠加。`focusModules` 与用户 task keywords 只通过 `TASK_CONTEXT` family 计分，不再额外加一次 direct delta。

## 12.5 置信度

建议区间：

| Evidence | confidence |
|---|---:|
| JDT exact location | 1.00 |
| AST direct declaration/extends/import | 0.98 |
| AST receiver+arity resolved local call | 0.90 |
| Spring explicit injection/endpoint | 0.90～0.97 |
| MyBatis namespace+statement exact | 0.95 |
| wildcard/global unique simple name | 0.70～0.82 |
| ambiguous simple name | ≤0.45 |
| lexical naming family | 0.30～0.65 |
| partial search | 再乘 0.55 |

这些值不是统计概率，只是可解释排序系数。golden 未达到约 50 个高质量场景前，不做 isotonic calibration 或学习排序。

## 12.6 CandidateEvidence

```ts
export type CandidateEvidence = {
  file: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  signals: EvidenceSignal[];
  familyScores: Partial<Record<EvidenceFamily, number>>;
  finalScore: number;
  confidence: "high" | "medium" | "low";
  degradation: string[];
};
```

Diagnostic 模式可返回 familyScores 和前若干 signal；standard 模式只返回压缩 evidence summary。

---

# 13. Java Framework Adapter Packs

## 13.1 设计原则

- 只服务 Java；
- 由 build dependency、import 或 annotation 自动激活；
- 核心 AST index 不直接硬编码所有框架；
- adapter 输出 EvidenceEdge，不修改 score；
- 每个 adapter 有独立 fixture 和 golden attribution；
- 未识别时安静退化，不阻塞 generic Java。

```ts
export interface JavaFrameworkAdapter {
  readonly id: string;
  detect(repo: RepoFrameworkFacts): boolean;
  buildEdges(view: JavaIndexReadView): Promise<EvidenceEdge[]>;
}
```

## 13.2 Spring Pack

### 激活条件

满足任一：

- build 文件含 `org.springframework` / Spring Boot plugin；
- import 以 `org.springframework.` 开头；
- 发现 Spring stereotype annotation。

### 静态边

```text
@Controller/@RestController method
  → endpoint path + HTTP method

constructor parameter / @Autowired field
  → injected type

@Service
  → stereotype role

@EventListener parameter
  → consumes event type

ApplicationEventPublisher.publishEvent(expr)
  → publishes event type（可解析时）

@Transactional method/type
  → transaction boundary metadata

@Bean method
  → produces return type
```

### 高价值影响链

```text
Controller method
  → injected application/service method
  → repository/mapper
  → request/response DTO
  → targeted tests
```

仅当 AST 有实际字段/参数/调用证据时建立边，不因类名带 `Service` 就推断调用。

## 13.3 MyBatis Pack

引入一个纯 JS XML parser，仅处理 `src/main/resources/**/*.xml` 中的 mapper 文件。候选依赖为 `fast-xml-parser`，在实现时固定 lockfile 版本。

### 抽取

- `<mapper namespace="...">`；
- `<select|insert|update|delete id="...">`；
- `parameterType`；
- `resultType`；
- `resultMap`；
- `<resultMap type="...">`；
- `<include refid="...">`。

### 连接

```text
namespace FQN + statement id
  ↔ mapper interface method

parameterType/resultType
  → Java type

resultMap
  → entity/DTO

mapper interface
  → XML resource
```

SQL 文本仍作为 support evidence，不尝试建立完整 SQL 数据流。

## 13.4 JPA Pack

- `@Entity` / `@MappedSuperclass` / `@Embeddable`；
- `@OneToMany` / `@ManyToOne` / `@OneToOne` / `@ManyToMany`；
- `JpaRepository<Entity, Id>` / `CrudRepository` 泛型；
- derived query method 的 entity property token；
- `@Query` 字符串作为 support evidence。

## 13.5 MapStruct/Lombok

### MapStruct

- `@Mapper` type；
- method param/return types 建立 mapping edge；
- `uses` annotation 参数解析后连接辅助 mapper。

### Lombok

不尝试静态生成所有 synthetic method。索引记录：

- Lombok detected；
- relevant annotations；
- generated semantics completeness。

需要 getter/setter/builder 精确绑定时交给带 javaagent 的 JDT LS。若 agent 缺失，输出明确 evidence gap。

## 13.6 Adapter 优先级

```text
Spring → MyBatis → JPA → MapStruct → Lombok metadata
```

优先级由真实仓库命中率决定，不为框架覆盖面扩张而扩张。

---

# 14. Token-aware ReadPlan Planner

## 14.1 目标

readPlan 不是“排名前 N 个文件”，而是：

> 在有限文件数和 byte/token 预算内，选择最能覆盖当前任务关键证据、且彼此信息重复最少的文件与范围。

## 14.2 预算

初始默认值：

| mode | maxFiles | maxReadBytes | 估算 tokens |
|---|---:|---:|---:|
| minimal | 4 | 6 KiB | ~1.5K |
| balanced | 6 | 14 KiB | ~3.5K |
| precision | 8 | 20 KiB | ~5K |
| recall | 12 | 32 KiB | ~8K |

`maxReadBytes` 是硬限制；某个 anchor method 本身超过预算时允许单文件超限，并标记 `budgetExceededByAnchor=true`。

## 14.3 AST 精确 read window

优先选择：

1. anchor method/body range + 小量上下文；
2. target method range；
3. type declaration header +相关 field/method；
4. XML statement range；
5. fallback 固定 radius。

同一文件多个高价值 range 可合并；相距较远则保留多段，避免读取中间无关大段。Planner 先按 rank/evidence diversity shortlist 至多 `maxFiles × 4` 个候选，再通过一次 JavaIndex worker batch query 获取 AST ranges 和精确 UTF-8 bytes；不得为了六个 readPlan 文件同步读取全部候选。

```ts
export type ReadRange = {
  startLine: number;
  endLine: number;
  reason: string;
  estimatedBytes: number;
};
```

## 14.4 选择算法

第一版使用可解释 greedy，不引入 knapsack solver：

```text
1. 固定选择 anchor。
2. 选择 protected core：exact implementation、direct static collaborator、已验证 framework 主链。
3. 对其余候选计算：
   marginalUtility =
       taskValue
     + uncoveredEvidenceFamilyValue
     + layer/module diversity
     + verificationValue
     - overlapPenalty
     - byteCostPenalty
4. 每轮选 marginalUtility / estimatedBytes 最大者。
5. 达到 maxFiles 或 maxReadBytes 时停止。
6. test/config/SQL 根据 testReadMode 和 support quota 进入。
```

## 14.5 Evidence quota

沿用已落地 evidence budget 的思想，但调整为：

| bucket | balanced minimum/maximum |
|---|---|
| anchor | 1 / 1 |
| exact/structural core | 2 / 4 |
| framework/task path | 0 / 2 |
| verification support | 0 / 1 |
| lexical-only | 0 / 1 |

这些不是固定占位；若某 bucket 无有效候选，其预算释放给其他 bucket。

## 14.6 must-hit 保护

运行时并不知道 golden `mustHit`，因此不能直接“保护 golden”。真正可保护的是确定性高的证据类别：

- anchor；
- exact implementation/definition；
- interface direct implementer；
- signature param/return direct collaborator；
- Spring explicit injection/call；
- MyBatis exact mapper statement；
- 已有 non-LSP baseline core。

Benchmark 验证这些保护规则是否继续保持 `R_read_must=1.0`。

## 14.7 输出成本模型

```ts
estimatedTokens = Math.ceil((jsonBytes + readBytes) / 4)
```

`/4` 仅是跨版本稳定、零依赖的代理估算，不声称等于某个具体模型 tokenizer。所有硬门禁同时以 UTF-8 `resultJsonBytes/readPlanBytes` 为事实指标；若 Codex/目标客户端能暴露真实 prompt token，用独立的 `observedPromptTokens` 记录，禁止替换或回写代理历史序列。

同时记录：

- `resultJsonBytes`；
- `readPlanBytes`；
- `estimatedTokens`；
- `suppressedRawSearchBytes`；
- `evidencePerKiB`；
- `mustHitsPerKiB`（benchmark only）；
- `taskBlockingHitsPerKiB`（benchmark only）。

---

# 15. MCP 工具与输出契约 V6

## 15.1 工具面策略

近期不新增工具。现有 7 个工具可继续存在，直到完成工具 schema token 统计。最终可选收缩为：

1. `java_status`
2. `java_impact`
3. `java_symbol`（可包含 references operation）
4. `java_diagnostics`
5. `java_runtime`（restart/shutdown action）

只有在以下任一条件成立时才执行 7→5 合并：

- MCP tool schema 常驻上下文可稳定节省至少 200 tokens；
- Agent 在真实会话中经常误选 references/restart/shutdown；
- 合并后 benchmark round-trip 不增加。

否则维持 7 个工具。重点是 output contract，而不是为减少两个工具制造迁移噪声。

## 15.2 ImpactResultV6

```ts
export type ImpactResultV6 = {
  version: 6;
  target: {
    file: string;
    symbol: string;
    type?: string;
    method?: string;
    profile: string;
    range: SourceRange;
  };
  freshness: {
    requestGeneration: number;
    indexedGeneration: number;
    coverage: "COMPLETE" | "PARTIAL" | "DEGRADED";
    changedDuringRequest: boolean;
  };
  semantic: {
    policy: "fast" | "auto" | "required";
    used: boolean;
    completion: Completion;
    readiness?: string;
  };
  files: ImpactFileV6[];
  readPlan: ReadPlanItemV6[];
  evidenceGaps: string[];
  cost: {
    resultBytes: number;
    readBytes: number;
    estimatedTokens: number;
    suppressedRawBytes: number;
  };
  metrics?: ImpactDiagnosticMetrics;
};
```

## 15.3 ImpactFileV6

Standard 模式：

```ts
export type ImpactFileV6 = {
  id: string;
  path: string;
  role: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  locations: Array<{ line: number; column: number }>;
};
```

不默认返回：

- raw score；
-完整 scoreBreakdown；
- cache before/after；
-每个 rg section 的候选文件；
-绝对路径；
-raw URI/range；
-重复 provider reason。

Diagnostic 模式才增加 family score、provider attribution、phase、cache 和 completion 细节。

## 15.4 ReadPlanItemV6

```ts
export type ReadPlanItemV6 = {
  priority: "P0" | "P1" | "P2";
  fileId: string;
  ranges: ReadRange[];
  reason: string;
  expectedEvidence: string[];
  estimatedBytes: number;
};
```

多 range 让 Agent 不必为了两个相距很远的方法读取整段文件。

## 15.5 越界和外部依赖

- `java_impact` 永不返回 repo 外绝对路径。
- JDT 命中 dependency/JDK source 时，只增加：

```json
{
  "externalSemanticHits": 3
}
```

或 evidence gap，不返回本地 Maven cache/JDK 路径。
- `java_symbol` 若需要表达 external definition，只返回 `external: true` 和 display name，不返回绝对路径，除非未来增加显式 diagnostic 参数。


---

# 16. 评测体系：足以防回归，但不过度建设

## 16.1 数据集目标

近期目标不是 12 个仓库和 150 个场景，而是：

```text
3 个现有真实仓库
+ 1 个从未参与调权的 holdout Java 仓库
+ 1 个 synthetic Java fixture suite
≈ 24～36 个高质量任务场景
```

真实场景必须覆盖：

- controller；
- service；
- repository；
- port/interface；
- dto/record；
- entity/JPA；
- MyBatis mapper/XML；
- event/listener；
- package-private method；
- nested type；
- simple-name collision；
- cross-module call；
- generated-code/Lombok；
- rename/delete freshness；
- partial search degradation。

不做复杂 blind split。防止过拟合的方法是：任何新规则先在 holdout repo 上只跑不调，确认无明显退化后再接受。

## 16.2 Golden schema V3

```ts
export type GoldenScenarioV3 = {
  id: string;
  projectId: string;
  repoCommit: string;
  scenarioVersion: number;
  anchor: {
    file: string;
    line: number;
    column: number;
    profile: string;
    task: string;
    focusModules: string[];
    taskKeywords: string[];
  };
  golden: {
    mustHit: string[];
    taskBlocking: string[];
    shouldHit: string[];
    support: string[];
    mustReadRanges?: Record<string, Array<{ startLine: number; endLine: number }>>;
  };
  notes: string;
};
```

`taskBlocking` 从旧 `goldenMeta.shouldBlocksTask` 提升为一等集合，减少 attribution 逻辑的隐式判断。

## 16.3 指标

### 正确性

- `R_read_must`
- outside-repo paths count
- stale result rate
- partial-as-complete violations
- generation mismatch cache writes
- lifecycle invariant violations

### 任务效果

- candidate recall/precision
- `R_task_blocking`
- `P_read`
- `NDCG_read@6`
- first task-blocking rank
- readPlan range overlap with golden ranges

### 成本

- output bytes
- read bytes
- estimated tokens
- suppressed raw bytes
- round trips
- provider cost attribution

### 性能

- cold snapshot-hit P50/P95
- cold partial-index P50/P95
- single-file refresh P50/P95
- edit-to-visible P50/P95
- warm-auto P50/P95
- warm-required first-touch/cache-hit P50/P95
- Node event-loop delay P99
- JDT request backend settlement time after cancellation

## 16.4 硬门槛

```text
npm run build                 PASS
npm test                      PASS, 0 fail
R_read_must                   1.0000 for every real repo
outside-repo output           0
partial result cached         0
stale mutation scenario       0
concurrent start oversubscribe 0
```

质量门槛采用 baseline-relative：

```text
每仓 recall 不低于当前同 commit baseline
每仓 R_task_blocking 不回退
每仓 P_read 不低于 baseline - 0.02
estimatedTokens 不高于 baseline + 5%，除非 R_task_blocking 明显提升并记录决策
```

若仍使用 Review 中相同 repo commits，可额外采用：

```text
recall >= 0.8456 / 0.8643 / 0.7350
P_read >= 0.8667 / 0.7000 / 0.6333
```

## 16.5 必须增加的系统测试

1. 两个请求并发 `ensureStarted()`，只创建一个 child，且 initialize 前无请求发送。
2. initialize timeout 后 child 被关闭，下一次可重新启动。
3. max active=1 时两个 repo 并发，不会同时 STARTING/READY。
4. fake `rg` 输出若干 match 后 timeout：当前结果标记 partial，第二次仍重新执行。
5. LSP 返回 `/tmp`、Maven cache、JDK source：结果中无绝对路径。
6. fast 模式编辑文件后，旧 rg/index cache 不再命中。
7. rename/delete 后旧 path、旧 type、旧 edge 均消失。
8. build file 变化后 layout roots 被刷新。
9. package-private/nested/text-block fixture 的 AST range 正确。
10. two packages 同名 `User` 时不建立错误 exact edge。
11. coverage 非 COMPLETE 时 negative cache 禁用。
12. hierarchy cycle 不重复请求。
13. open document 超过 64 时发送 didClose。
14. snapshot 写入中断后旧 snapshot 仍能加载。
15. malformed snapshot 自动删除并重建。
16. 两个独立 manager/lease client 共享同一临时 lease 目录时，机器级 JDT STARTING+READY 不超过 slot 上限；死 PID lease 可回收。
17. 同一 worktree 第二个进程请求 JDT：不产生第二个 child；auto 静态降级、required/精确工具返回 `JDT_BUSY_OTHER_SESSION`。
18. worktree B 无 own snapshot 时从 A seed；B 中改动/新增/删除文件不复用 A facts，coverage 在 delta reconcile 前 DEGRADED，完成后 negative lookup 恢复。
19. 500 文件或 >=10% 文件的 change storm 进入 background reconcile；foreground anchor refresh 不被长队列阻塞。
20. linked worktree 根下 `.git` 文件、common git dir 与 build/target/cache 目录变化不生成 Java change，也不无故推进 generation。
21. own snapshot 重载后 clock 从 `indexedGeneration` 续起；无变化 manifest verification 不重 parse 即恢复 COMPLETE。

## 16.6 固定机器报告

每个 phase report 必须记录：

- macOS 版本；
- 芯片与内存；
- Node 版本；
- JDK/JDT LS 版本；
- repo commit；
- golden commit/version；
- runtime build hash；
- runs；
- warm state；
- cache/workspace 是否 fresh；
- before/after JSON 文件路径。

不依据单次 latency 下结论，正式报告至少 runs=5 并报告 P50/P95。

---

# 17. 阶段性路线

## Stage 0：基线对齐

目标：确认当前实际 HEAD、最新模块布局、测试与三仓 benchmark，解决附件 Review 与可见源码版本差异。

交付：

- current-source-map；
- build/test baseline；
- real-repo benchmark baseline；
- P0 问题最小复现测试；
- phase 4～12 已落地能力清单。

不改生产行为。

## Stage 1：正确性封口

内容：

- 5 态 JDT lifecycle；
- transactional start cleanup；
- start singleflight；
- STARTING 计入 active slots；
- absolute DeadlineBudget；
- partial search 禁 cache；
- LSP containment；
- semantic error taxonomy；
- hierarchy visited 和显式 timeout；
- JDT start/server failure 最小 restart backoff 与配置错误显式 reset。

完成条件：所有 P0 故障注入测试通过，三仓 hard gate 不回退。

## Stage 2：统一新鲜度

内容：

- JDT-independent RepoChangeCoordinator；
- monotonic generation；
- rg/index/edge/JDT/layout 统一失效；
- delete/rename；
- watcher degraded on-demand reconcile；
- stopped context 回收；
- alias last-known-good；
- worktree identity/family hash；
- 跨进程 JDT/sweep leases；
- branch-switch storm 降级；
- janitor owner/runtime 活性保护。

完成条件：mutation stale rate=0，fast 模式可实时观察编辑；多 MCP 进程的机器级 JDT 数不超限，同 worktree 不启动第二个 workspace。

## Stage 3：JavaIndex V2

内容：

- Tree-sitter compatibility spike；
- Worker actor；
- AST facts；
- FQN/import resolution；
- coverage；
- full background sweep；
- atomic snapshot；
- 主线程去同步 IO；
- own snapshot generation rebase；
- sibling worktree manifest-validated snapshot seeding；
- machine-level background sweep throttle；
- 替换旧 regex/JSONL/edge snapshot。

完成条件：结构 fixture 全绿，三仓质量不回退，steady cold 性能不回退，event-loop delay 达标。

## Stage 4：识别和 token 极致化

内容：

- EvidenceEdge 统一模型；
- evidence family saturation；
- references collapse/rerank；
- method-body bounded call edge；
- Spring/MyBatis/JPA packs；
- token-aware multi-range readPlan；
- ImpactResultV6 强类型与压缩输出；
- attribution V3。

完成条件：`R_task_blocking` 每仓不回退，至少一个当前 material gap 被结构证据解决，estimatedTokens 不升或有明确收益解释。

## Stage 5：warm-required 数据驱动治理

内容：

- semantic singleflight；
- document LRU；
- first-touch experiment；
- cancellation backend settlement；
- 根据结果选择 default policy。

首触实验、singleflight/LRU 治理和默认策略决策必须完成；允许最终结论是“不默认化”。不要求为了宣称 V3 成功而把 `warm-required` 改成默认行为。

---

# 18. 初始 SLO 与发布门槛

以下是在固定参考机器上校准的初始目标，而非跨机器承诺。

## 18.1 正确性 SLO

| 项目 | 目标 |
|---|---:|
| repo 外路径进入 standard output | 0 |
| partial 结果写入 complete cache | 0 |
| generation mismatch 写 cache | 0 |
| concurrent JDT oversubscribe（含跨进程） | 0 |
| same-worktree duplicate JDT child | 0 |
| seed mismatch facts 可查询 | 0 |
| initialize 失败后的残留 child | 0 |
| rename/delete stale result | 0 |
| `R_read_must` | 1.0000 |

## 18.2 新鲜度 SLO

| 项目 | 初始目标 |
|---|---:|
| 普通 Java 编辑到新 generation | P95 ≤ 300ms |
| 编辑到 impact 可见 | P95 ≤ 500ms |
| rename/delete 到旧 facts 消失 | P95 ≤ 500ms |
| build change 到 layout refresh | P95 ≤ 1s |
| watcher ready barrier 超时后的首请求 | ≤ request deadline，必须 DEGRADED 放行 |
| 500-file storm 到 foreground anchor 可见 | P95 ≤ 750ms（固定机器校准） |

### 18.2.1 Worktree-family SLO

| 项目 | 初始目标 |
|---|---:|
| same-worktree 第二进程启动额外 JDT | 0 |
| 全机 JDT STARTING+READY | ≤ `JAVA_LSP_MAX_ACTIVE_REPOS` |
| sibling seed mismatch facts | 0 |
| 新 worktree seed 后首请求可用结构 facts | P95 ≤ 1s（典型数千文件，manifest-only pass） |
| seed 后 delta reconcile parse 文件数 | 仅 changed/new files + failed validation files |
| 活跃 fast-only cache 被 janitor 删除 | 0 |

## 18.3 Index SLO

| 项目 | 初始目标 |
|---|---:|
| snapshot hit load（典型数千 Java 文件） | P95 ≤ 500ms |
| 单 Java 文件 refresh | P95 ≤ 50ms |
| 已 complete index type query | P95 ≤ 5ms |
| background full sweep | 不阻塞 MCP 主线程 |
| indexing 时 Node event-loop delay | P99 ≤ 20ms |

## 18.4 Routing SLO

| state | 初始目标 |
|---|---:|
| cold local steady P95 | ≤ 当前 baseline × 1.10，且目标 ≤ 200ms |
| warm-auto no-semantic P95 | ≤ 300ms |
| required cache-hit P50 | ≤ 100ms |
| required first-touch P95 default gate | ≤ 800ms |

first-touch 未达 800ms 时 required 继续显式 opt-in。

## 18.5 Token SLO

- standard `java_impact` JSON 不高于当前 baseline；
- balanced readPlan 默认目标 ≤14KiB；
- diagnostic payload 不参与 Agent 默认成本门槛；
- 相同 golden 命中下 estimatedTokens 至少不回退；
- 新框架证据若增加 read bytes，必须提升 task-blocking hit 或减少后续 round-trip。

---

# 19. 风险与控制

## 19.1 Tree-sitter native 安装风险

风险：Node 22、macOS arm64、grammar binding ABI 或 worker load 失败。

控制：

- Stage 3 第一任务只做兼容性 spike；
- pin exact package/lockfile；
- CI 只测项目支持的 macOS；
- native 失败才选择 WASM，不维护双路径。

## 19.2 大重构期间质量漂移

控制：

- 先写 characterisation tests；
- 新 JavaIndex V2 在 benchmark harness 中先作为 challenger；
- 每个任务单独 commit；
- 每个 stage 结束生成 phase report；
- 不使用 9 个 feature flags，迁移期最多一个 `JAVA_LSP_INDEX_BACKEND=v1|v2` 开关；
- V2 gate 通过后删除 V1 和开关。

## 19.3 AST 静态调用误解析

控制：

- receiver/type 不明确则保留 unresolved/ambiguous；
- confidence < threshold 的 call 不进入 protected core；
- JDT exact 可确认或覆盖静态边；
- adapter 不因类名直接推断调用。

## 19.4 Framework pack 过拟合

控制：

- 只从明确 annotation、generic、XML namespace/statement 和 AST call 建边；
- framework provider 单独 attribution；
- holdout repo 跑后再调整权重；
- 专有业务词不进入 generic pack。

## 19.5 Snapshot 体积和序列化成本

控制：

- worker 内 gzip/JSON；
- normalized facts，不存 AST tree；
- source text不进 snapshot；
- only representative locations；
- status 输出 snapshot bytes；
- 若典型仓库 snapshot 超过 100MiB 再重新评估存储，不提前引入 SQLite。

## 19.6 JDT 取消不代表后端立刻停止

控制：

- 记录 client timeout 和 backend settlement；
- timeout 后避免立即向同 session 发同类昂贵请求；
- Stage 1 的 JdtlsSession 统一拥有 restart backoff；SemanticGateway 不复制 backoff 状态；
- 配置类错误显式 reset 前不重试；
- 不建设复杂 circuit-breaker 平台。

## 19.7 Worktree seed 陈旧或 lease 泄漏

控制：

- seed 先做目标 manifest 内容校验，再发布 exact-matching facts；
- source generation 不跨 worktree继承；
- fixed numbered slots + same-worktree exclusive lease，避免 count/create race；
- lease 只回收死 PID owner，所有 metadata 带 ownerToken；
- snapshot publish 再校验 target manifestFingerprint；
- janitor 检查 runtime/JDT lease 和 owner PID。

---

# 20. 旧方案内容的最终裁决

## 20.1 从旧方案一删除

- Persistent LSP Pool preload；
- Git diff-only 增量索引；
- SQLite/DuckDB 作为既定架构；
- LLM feedback ranking；
- Java Code Intelligence RL；
- Context Planning Engine 的 risk/migration 等无证据字段；
- 百万行/三分钟类非目标指标；
- 多阶段通用知识图谱平台路线。

## 20.2 从旧方案二保留

- P0 correctness 审计；
- generation/change journal 核心思想；
- SourceIndex V2；
- absolute deadline；
- semantic singleflight；
- evidence graph/provenance；
- scoring 去重；
- token/readPlan 优化；
- fault injection；
- 明确不做 embedding、重写 Java、未知 coverage 负缓存。

## 20.3 对旧方案二裁剪

| 原内容 | V3 处理 |
|---|---|
| 9 态 semantic lifecycle | 5 态 lifecycle +独立 readiness |
| SemanticScheduler/bulkhead/aging | same-key singleflight + FIFO + deadline admission |
| DocumentLeaseManager | 64-entry LRU + didClose |
| SQLite vs snapshot spike | 直接选择 worker 内存 + 原子 snapshot |
| 12 repo / 120～150 cases | 3～5 repo / 24～36 cases |
| 9 feature flags/shadow/canary | 最多一个 V2 迁移开关 + git revert |
| macOS+Linux CI | macOS-only |
| calibrated/learned ranker | deterministic family saturation |
| 通用 resource admission | 进程内 FIFO + 固定文件 lease slots；实时 RSS/cgroup 平台延后 |
| production platform stage | 删除 |

---

# 21. 架构决策记录（ADR Summary）

## ADR-001：Java-only

**Decision**：不设计 language abstraction。  
**Reason**：Java 深度、JDT LS、Spring/MyBatis/JPA 和真实 golden 是项目护城河。  
**Consequence**：接口可直接表达 JavaTypeRef、JavaMethodFacts，不为其他语言抽象损失精度。

## ADR-002：Tree-sitter + JDT 两层

**Decision**：Tree-sitter 提供完整便宜事实，JDT 提供按需 exact semantics。  
**Rejected**：regex 主解析、自研完整 resolver、JDT-only 索引。  
**Consequence**：必须维护 provenance 和 completeness。

## ADR-003：单 Worker Actor

**Decision**：JavaIndex 由一个 worker thread 拥有。  
**Rejected**：主线程同步索引、通用 worker pool。  
**Consequence**：所有 SourceIndex API 变 async，但 mutation 一致性显著简化。

## ADR-004：原子 snapshot，不使用数据库

**Decision**：内存 normalized index + gzip JSON snapshot。  
**Rejected**：SQLite、DuckDB、Neo4j。  
**Consequence**：典型仓库性能足够；超过实际规模阈值后再重新评估。

## ADR-005：统一 generation

**Decision**：所有 repo-scoped cache 使用同一单调 generation。  
**Rejected**：以 JDT invalidation 代替 repo freshness。  
**Consequence**：watcher 必须独立于 JDT。

## ADR-006：证据家族饱和

**Decision**：provider 输出 evidence，ranker 按 family 去重和饱和。  
**Rejected**：provider 直接累加 score、学习排序。  
**Consequence**：排序可解释且可用 golden 逐条归因。

## ADR-007：token-aware readPlan

**Decision**：同时约束 max files 与 max bytes，多 range 精确读取。  
**Rejected**：单纯扩大 readPlan slots。  
**Consequence**：需要 AST range 和 byte estimate。

## ADR-008：不默认化 warm-required，除非数据通过

**Decision**：first-touch 仍是可选增强。  
**Rejected**：预热所有 repo、LSP pool preload。  
**Consequence**：cold/local 路径必须独立达到高质量。

## ADR-009：Per-worktree isolation，family 只做协调和 validated seed

**Decision**：canonical worktree root 是 facts/cache/JDT 正确性边界；Git common-dir family 只用于 lease、seed discovery 和后台节流。  
**Rejected**：跨 worktree 共享 mutable index、共享 JDT workspace、共享 generation/negative cache。  
**Consequence**：分支互不污染；稳态内存允许少量重复，以换取简单可靠。

## ADR-010：文件系统 lease，不引入 daemon

**Decision**：固定编号 global slots + same-worktree exclusive lease 管理跨 MCP 进程的 JDT/sweep capacity。  
**Rejected**：常驻协调 daemon、socket IPC、数据库锁、先 count 后 create 的 repoHash lease。  
**Consequence**：实现规模有限，但必须有死 PID 回收、ownerToken、双层获取顺序和故障注入测试。

## ADR-011：Sibling snapshot 仅作内容验证后的 seed

**Decision**：只有 relative content manifest 匹配的静态 facts 可跨 worktree seed；target coverage 从 DEGRADED 开始。  
**Rejected**：直接加载兄弟 COMPLETE coverage、仅凭 buildFingerprint 复用、seed JDT edge/workspace。  
**Consequence**：显著降低新 worktree 冷启动 parse 成本，同时不把兄弟分支陈旧正向事实带入 readPlan。

---

# 22. 完成定义

V3 架构完成不等于所有可想象能力均实现。满足以下条件即可认为核心改造闭环完成：

1. JDT lifecycle、active admission、deadline、partial cache 和 containment 的 P0 测试全绿。
2. fast 模式具备独立 watcher/generation，mutation stale rate=0。
3. Tree-sitter JavaIndex V2 完全替代 regex 主索引，coverage 可观察。
4. 旧 JSONL/compact/spawnSync fallback 从请求关键路径删除。
5. EvidenceEdge/provenance/family saturation 生效。
6. references 在 file collapse/rank 后截断。
7. Spring/MyBatis/JPA 至少解决真实 material gap，而非只增加候选。
8. readPlan 同时受文件数和 byte 预算约束，并支持多 range。
9. 三仓 `R_read_must=1.0`，recall、task-blocking recall 和 P_read 不回退。
10. standard output token 不回退，且不暴露绝对路径。
11. 每个 stage 有 before/after phase report，可复现命令和原始 JSON。
12. 跨进程机器级 JDT slot 不超限，同 worktree 不产生第二个 JDT child。
13. 新 worktree 可安全 seed exact-matching facts；差异文件不复用，coverage/negative cache 由目标 reconcile 决定。
14. branch-switch/rebase storm 不阻塞 foreground anchor refresh，janitor 不删除活跃 fast-only runtime cache。
15. own snapshot 重载可 generation rebase，并在无变化时通过 manifest verification 恢复 COMPLETE 而不全量重 parse。
16. warm-required 是否默认化由 Stage 5 数据决定；“继续不默认”是合法完成结果。

---

# 23. 外部资料

访问日期：2026-07-23。

- codex-java-lsp-mcp：`https://github.com/lkyprogramer/codex-java-lsp-mcp`
- codebase-memory-mcp：`https://github.com/DeusData/codebase-memory-mcp`
- codebase-memory Java resolver：`https://github.com/DeusData/codebase-memory-mcp/blob/main/internal/cbm/lsp/java_lsp.c`
- codebase-memory negative memo：`https://github.com/DeusData/codebase-memory-mcp/blob/main/internal/cbm/lsp/lsp_neg_memo.h`
- Graphify：`https://github.com/Graphify-Labs/graphify`
- Graphify architecture：`https://github.com/Graphify-Labs/graphify/blob/v8/ARCHITECTURE.md`
- Graphify cache：`https://github.com/Graphify-Labs/graphify/blob/v8/graphify/cache.py`
- Graphify watcher：`https://github.com/Graphify-Labs/graphify/blob/v8/graphify/watch.py`
- Tree-sitter：`https://tree-sitter.github.io/tree-sitter/`
- Node Tree-sitter：`https://www.npmjs.com/package/tree-sitter`
- Java grammar：`https://github.com/tree-sitter/tree-sitter-java`
- Web Tree-sitter：`https://www.npmjs.com/package/web-tree-sitter`
- Eclipse JDT ASTParser：`https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/reference/api/org/eclipse/jdt/core/dom/ASTParser.html`
- JavaParser：`https://github.com/javaparser/javaparser`
- Spoon：`https://spoon.gforge.inria.fr/`
- fast-xml-parser：`https://www.npmjs.com/package/fast-xml-parser`

---

# 24. 最终结论

`codex-java-lsp-mcp` 最有价值的未来不是变成“另一个代码图平台”，而是成为：

> **对 Java 最懂、对 Agent 最省、对结果最诚实的一层本地代码智能。**

真正高杠杆的改造只有六类：

1. 修正生命周期、partial cache、边界和 generation，使结果可信；
2. 用 Tree-sitter Java 建立完整、可增量、可证明 coverage 的静态事实；
3. 用 JDT LS 只确认静态层无法可靠完成的精确关系；
4. 用 Spring/MyBatis/JPA pack 把通用 AST 转成真实 Java 工程影响链；
5. 用 evidence-aware、token-aware readPlan 把这些能力压缩成 Agent 一次可执行的上下文；
6. 用 per-worktree isolation、机器级 lease 和 validated snapshot seed 支撑并发 Agent，而不引入平台化调度。

所有不直接服务这六项的扩张——多语言、图 UI、向量、RL、通用查询、企业级调度——都应拒绝。
