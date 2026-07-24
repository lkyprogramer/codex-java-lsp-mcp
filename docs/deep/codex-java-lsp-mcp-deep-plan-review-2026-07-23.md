# docs/deep 两份优化方案的深度 Review 报告

> Review 日期：2026-07-23
> Review 对象：
> - `codex-java-lsp-mcp-architecture-optimization-plan.md`（下称「方案一」）
> - `codex-java-lsp-mcp-deep-optimization-plan-2026-07-23.md`（下称「方案二」）
>
> 核查基线：当前 `main` HEAD `af51bc7`（2026-07-06），领先方案二的调研基线 `03c49ba`（2026-07-02）约 29 个 commit。
> 本次 review 实际执行：全量源码静态审阅 + 关键断言逐条对照当前代码 + `npm run build`（PASS）+ 全量测试（124 tests / 120 pass / 4 skipped / 0 fail，已运行并观察）。
> 未重新运行三仓 benchmark（依赖本地业务仓库与 warm 环境）；所有性能数字引用自仓库内报告，均标注来源。
> 对比项目调研：DeusData/codebase-memory-mcp、Graphify-Labs/graphify（基于其公开 README，未阅读其源码）。

---

## 1. 结论速览

1. **方案二是高质量文档，方案一基本可以废弃。** 方案二的 P0/P1 断言我逐条对照了当前代码，绝大多数在 HEAD 上仍然成立（见第 3 节核查表）；方案一没有证据锚点、信息密度低，且多项建议（RL 反馈闭环、Context Planning Engine、LSP Pool preload、百万行项目指标）与「小而精悍的个人 Java 工具」定位直接冲突。建议将方案一标注为 superseded，只保留 2~3 个已被方案二更严谨表述覆盖的想法。
2. **方案二的基线已经过时，但核心论点反而更成立了。** 基线之后项目又推进了 phase 4~12（edge store、import graph、evidence budget、agent-router 拆分、policy 按 repo 拆分），三仓 recall 从 0.7756/0.8357/0.6300 提升到 0.8456/0.8643/0.7350——也就是说，项目实际按「先做识别效果」的顺序走了，而方案二说的「第一优先级不是继续调 ranking，而是修一致性和生命周期」的 P0 问题（初始化竞态、partial 缓存、越界泄漏、无统一 generation）**一个都没修**。继续在有竞态和陈旧缓存的地基上堆识别信号，收益会越来越难归因。
3. **方案二的工程化规模需要按个人项目大幅裁剪。** 它的评测体系（12 repo / 120~150 scenario / blind split / bootstrap CI）、9 个 feature flag、shadow mode、canary 灰度、CI matrix，是为团队维护的生产服务设计的。对单人项目，正确的替代物是：固定机器 + 现有 hard gate + 少量故障注入测试 + git revert 作为回滚。你明确说了不需要兼容性，这让方案二约 1/3 的迁移/灰度工程量直接消失。
4. **与开源对比后，本项目的护城河很清晰：不是图的广度，是 Java 的深度。** codebase-memory-mcp（158 语言、15 工具、C 实现）和 graphify（36+ 语言、图产物）都是广度玩法；两者都没有编译器级 Java 语义（JDT LS）、没有 task-oriented readPlan、没有 golden hard gate 纪律。它们共同验证了一件事：**结构抽取的行业底线是 tree-sitter AST，而本项目还在用 regex**——这是对比中暴露的唯一明显落后项，也是识别质量的最高杠杆改造点。
5. **修正后的路线**（第 6 节详述）：正确性包 → 新鲜度包 → tree-sitter 索引底座 → 证据饱和与框架边 → （数据驱动地）warm-required 首触。方案二阶段 0~2 的骨架保留，阶段 3 的调度器和阶段 5 的生产化大幅裁剪，阶段 4 与已落地的 edge store/evidence budget 合并。

---

## 2. 方案一（architecture-optimization-plan）评审

### 2.1 总体判断

方向性正确（cheap fact layer + expensive semantic layer + readPlan 压缩入口），但通篇没有一条断言带证据锚点，多处与仓库实测事实冲突，后半部分是规模幻想。它与方案二重叠的部分全部被方案二更严谨地覆盖。

### 2.2 具体问题

| 问题 | 位置 | 说明 |
|---|---|---|
| 性能基线错误 | §8「cold impact 秒级」 | 仓库实测 cold-nolsp P50 4~9ms、P95 103~198ms（phase 12 报告）。「秒级→<500ms」的目标把现状说差了一个数量级，暴露作者没有读 benchmark 报告。 |
| 增量索引方案劣于已有讨论 | §3.2 `git diff --name-only HEAD` | 漏 untracked 文件，且与 watcher 天然冲突。方案二的 change journal（watcher + generation）是正确形态。 |
| 「百万行项目 首次<3分钟」 | §8 | 个人项目场景不存在这个需求；为它设计（如强制 SQLite/DuckDB）是过度设计。 |
| Persistent LSP Pool + preload | §5.1 | 与 README 的资源保守策略、方案二的 lazy activation 直接冲突。多 repo preload 在 32GB 机器上会吃掉现有 `JAVA_LSP_MAX_ACTIVE_REPOS=3` 的安全边界。 |
| Ranking 引入 "LLM Feedback" | §4 | 无任何机制描述；方案二 §24.7 明确论证当前缺口是结构事实而非模型信号。 |
| Phase 5 "Java Code Intelligence RL" | §7 | 反馈学习需要的数据量单人使用永远达不到；且 git diff 命中判定的标签噪声极大。属于典型规模幻想。 |
| Context Engine 输出 risk/test_points/migration_hint | §6 | 没有证据基础的字段会诱导幻觉输出。readPlan + evidence gaps 已是该想法的「有据可依」子集。 |

### 2.3 值得保留的想法（均已被方案二覆盖）

- method call graph（= 方案二 L2 方法体轻量边）；
- controller→service→repository 链（= 方案二 L3 框架适配器）；
- SQLite 候选存储（= 方案二 §12.2 store spike 的方案 A，且方案二正确地把它设为待实验项而非结论）。

**裁决：标注 superseded，不再作为路线输入。**

---

## 3. 方案二（deep-optimization-plan）逐条断言核查

以下每条均已在 HEAD `af51bc7` 上重新对照源码。「确认」= 当前代码仍存在该问题；「部分过时」= 基线后的 commit 已部分解决。

### 3.1 P0 正确性断言

| ID | 核查结果 | 当前代码证据 |
|---|---|---|
| C-01 伪 started 竞态 | **确认** | `src/jdtls-session.ts:198-201` 的 `ensureStarted()` 只判断 `connection && process && !killed`；`start()` 在 `initialize`（`:459`）之前就赋值 `this.process/this.connection`（`:456-457`）。请求 B 在 A 的 initialize 完成前调用 `ensureStarted()` 会直接返回并发协议请求。`this.starting` promise 只能去重「同时进入 start」的调用，堵不住「赋值后、initialize 前」的窗口。 |
| C-02 启动失败非事务清理 | **确认** | `start()` 无 try/catch；initialize 超时（120s）或空结果抛错后，`process/connection` 仍是成员字段，下一次 `ensureStarted()` 误判已启动。`exit` handler（`:439-447`）只覆盖进程真死掉的情形，覆盖不了「进程活着但 initialize 挂起/失败」。 |
| C-03 无统一 repo generation | **确认** | watcher 只在 `start()` 内启动（`:467`）；`AgentRouter.rgSummary` 的 generation 取 `session.cacheStatus().invalidations`（`src/agent-router/index.ts:244`），fast 模式下永不启动 session → generation 恒定，5 分钟 TTL 内编辑不失效。SourceIndex 只在访问文件时比对 mtime，无 delete/rename 驱逐路径。`layoutContext` 在 AgentRouter 构造时 `probeLayout(repoRoot)` 一次性固化（`index.ts:75`）。 |
| C-04 rg timeout partial 被缓存 | **确认** | `src/agent-router/rg-execution.ts:118` 对 `ETIMEDOUT` 不抛错，partial stdout 照常 `parseRgOutput`；`index.ts:259-263` 无条件写入 5 分钟 cache。假阴性被固化整个 TTL。 |
| C-05 LSP location 无仓库边界 | **确认** | `src/agent-router/semantic.ts:168-192` 的 `locationCandidate()` 对 repo 外文件不做过滤（`classifyPath` 越界时只是不设 `relativePath`）；`src/agent-router/format.ts:91` `path: file.path \|\| file.absolutePath` 会把依赖/JDK 源码的**绝对路径**直接放进 agent 可见输出。 |
| C-06 active slot 非原子 | **确认** | `src/repo-runtime-manager.ts:144-164` 是 check-then-act：`isStarted` 基于 `status().started`（进程存在），两个未启动 repo 并发进入 `reserveLspSlot` 都会看到空位。窗口存在于「检查通过 → `start()` 内赋值 process」之间（含 async mkdir 等）。 |
| C-07 无 end-to-end deadline | **确认（一处表述需修正）** | `semanticTimeoutMs`（默认 1500ms）按请求独立消费；required 的 warm documentSymbol 默认每 anchor 45s（`src/tools/impact.ts:77`）且最多 5 anchor 串行；hierarchy 内层 `requestSettled` 未传 timeout → 落到 `DEFAULT_LSP_REQUEST_TIMEOUT_MS=120000`（`jdtls-session.ts:124`）。**需修正**：`request()` 其实已有超时取消（`CancellationTokenSource` + `withTimeout` 回调触发 `$/cancelRequest`），方案二「无 cancellation」的表述过重；缺的是统一预算，不是取消机制本身。 |

### 3.2 P1 性能断言

| ID | 核查结果 | 当前代码证据 |
|---|---|---|
| P-01 主线程同步阻塞 | **确认** | `source-index.ts`：`spawnSync("rg")` 5s 超时（`:503-516`）、每次 `persist` 两次 `appendFileSync`（`:381,394`）、`compact()` 每条 method 记录一次 `appendFileSync`（`:421-431`，大仓库一次 compact 数万次同步 syscall）、`dirtyCount()` 全量 `statSync` 扫描（`:463-472`，1s memo，但 `status()` 在每次 impact 里被调用两次）。`edge-store.ts`、`project-jdk.ts`、`generated-code.ts` 同样是同步 I/O。 |
| P-02 无 coverage 模型 | **确认** | cache 只含「被访问过的文件」；`findImplementers(scan=false)` 只查内存 cache（`:193-201`），未访问文件直接假阴性；index miss 与「仓库中不存在」不可区分，因此无法安全 negative cache。 |
| P-03 rg 全量缓冲 | **确认（严重度中）** | `runRg` 字符串拼接全量 stdout，12MB maxBuffer 有上界，ENOBUFS 走失败路径。非流式但风险可控。 |
| P-04 无 semantic singleflight | **确认** | `cached()` 只缓存**完成值**不缓存 in-flight promise（`jdtls-session.ts`），并发相同 references 会重复打到 JDT LS。另确认其 TTL 从 compute **开始前**计时（`now` 在 `await compute()` 之前取），与方案二 §13.6 的修正建议一致。 |
| P-05 openDocuments 无 LRU | **确认** | `openDocument()` 全文存 Map，仅 `stop()` 清空；无 didClose。 |
| P-06 hierarchy 无 visited | **确认** | `walkTypeHierarchy`（`:876-905`）串行递归、无 visited set、内层请求默认 120s。 |
| P-07 静态资源策略 | 未逐行验证（低优先级，个人机器场景影响有限） | — |

### 3.3 P1 识别效果断言

| ID | 核查结果 | 当前代码证据 |
|---|---|---|
| Q-01 simple name 碰撞 | **确认** | 四个 lookup index 全部以 simple name 为 key（`source-index.ts:555-568`）；仅 `findTypeDefinitions` 对显式 FQN 请求做了 package 精确匹配。 |
| Q-02 regex parser 上限 | **确认，且有比文档更具体的缺陷** | `parseJavaSource` 只取**第一个** type 声明（`:690`），nested/多 top-level type 丢失；`parseMethods` 的正则要求至少一个修饰符关键字（`:823`），**package-private 方法整体漏掉**；`braceDelta` 不感知字符串/文本块/注释中的花括号，方法边界可被污染。 |
| Q-03 lishuedu policy 默认核心 | **部分过时** | commit `3e5a20b` 已拆分：`resolveRoutingPolicy` 按 repo basename 解析，非 lishuedu 仓库默认 `generic-java`（`routing-policy.ts:94-103`）。残留问题：lishuedu 专有正则（`ExcelParserTest`、`ParentBenefit` 等）仍编译在二进制里；generic policy 的 profile 正则仍带 DDD 味；`RoutingPolicy["id"]` 联合类型里 `maven-reactor`/`ddd-gradle` 从未被构造（死变体）。 |
| Q-04 加法计分重复满额 | **确认** | `mergeCandidate` 直接 `existing.score += incoming.score`（`candidate-helpers.ts:36`），同一 collaborator 被 rg、typeReference、import graph、persisted edge 各计一次全额。 |
| Q-05 references 取 server 前 40 | **确认** | `semantic.ts:90` `references.items.slice(0, 40)`，无任何价值排序前置。另确认 `semanticVerify` 的 catch 把**所有**异常记成 `timeout`（`:126-127`），与方案二「错误分类缺失」判断一致。 |
| Q-06 readPlan 是启发式选槽 | **部分过时** | phase 5~7 已落地 evidence-class 配额分配器（`read-plan-budget.ts`：verified/structural/naming/support 配额 + protected paths + task utility tie-break），已不是纯 heuristic。仍缺 byte/token 预算与边际效用，方向上方案二 §14.4 仍适用，但起点比它描述的好。 |

### 3.4 评测与其他断言

| ID | 核查结果 | 说明 |
|---|---|---|
| M-01 3 repo / 15 scenario | **确认** | `golden/` 实测：3×5 真实场景 + 1 个 generic fixture 场景。 |
| M-03 缺并发/故障测试 | **确认** | 22 个测试文件中无并发 start、fake timeout、崩溃恢复类测试。 |
| O-01 stopped context 不删除 | **确认** | `stopEntry()` 不从 `runtimes` Map 删除；SourceIndex 内存 facts 随停止的 repo 永久驻留。 |
| O-02 config 无 last-known-good | **确认** | `alias-registry.ts` `reloadIfChanged()` 解析失败直接抛出，无回退快照。P2 合理。 |

### 3.5 方案二的过时点清单（需要读者注意的部分）

1. **§3.2 基线表全部过时。** phase 11/12 后：recall 0.8456 / 0.8643 / 0.7350，P_read 0.8667 / 0.7000 / 0.6333，payload 与 elapsed 也已变化（`docs/java-lsp-mcp-agent-router-scheduler-phase12-report-2026-07-04.md`）。
2. **§19.5「agent-router 单文件」已解决。** phase 11/12 已拆成 19 个模块，`index.ts` 收缩到 275 行，行为无漂移（benchmark 一致）。
3. **§9.3 policy 默认问题已部分解决**（见 Q-03）。
4. **测试规模过时**：77 → 124 个测试。
5. **未提及已落地的 Evidence Graph 雏形**：`edge-store.ts`（LSP verify 后持久化 reference/typeHierarchy 边、mtime 失效、fanout 有界）+ import graph recall + persisted semantic cold recall，正是其 §14 建议的前半段。方案二 §14 应理解为「在 edge store 基础上补 provenance/completeness/家族饱和」，而不是从零建图。
6. **一处技术表述过重**：见 C-07，取消机制已存在，缺的是统一 deadline 预算。

### 3.6 方案二总体裁决

- **诊断部分（§4~§10）：接受。** 22 条问题中我逐条核实的 19 条全部成立或部分成立，无一条捏造。这是我见过的对本仓库最准确的一份外部审计。
- **方案部分（§11~§16）：接受骨架，裁剪规模**（详见第 5 节）。
- **评测部分（§17）与生产化（§18 阶段 5、§21）：按个人项目重新标定**（详见第 5 节）。
- **§24「明确不建议做的事情」：全盘接受**，10 条与本 review 结论零冲突，特别是 24.5（coverage 未知不做 negative cache）、24.7（不先上 embedding）、24.8（不重写成 Java）。

---

## 4. 与同类开源项目对比

### 4.1 DeusData/codebase-memory-mcp

纯 C 单二进制，158 个 tree-sitter 语法编译进二进制，SQLite 图存储，15 个 MCP tools（Cypher-like 查询、trace_path、架构摘要、嵌入式向量检索、3D 可视化 UI、daemon 多会话共享）。声称 Linux kernel 28M LOC 3 分钟索引、结构化查询相对 grep 省 99.2% token。

**对本项目的启示：**
- 验证了「结构化查询 → token 数量级节省」的核心命题，与本项目 readPlan 的出发点一致；
- 验证了 tree-sitter AST 是结构抽取的事实标准（其 Java 支持列在 "Good" 档）；
- 后台 watcher + 增量重索引是标配能力——本项目 fast 模式连 watcher 都没有（C-03），在这一点上落后于对比项目。

**反面教材（对「小而精悍」而言）：**
- 15 个工具意味着 agent 要自己学会组合查询，round-trip 和提示词成本转嫁给了使用者；本项目「一个 `java_impact` 直接给出带证据的 readPlan」是更贴近 agent 工作流的形态，不要向 15 工具面漂移；
- 158 语言 + 嵌入 + UI + daemon 是广度产品的包袱，与你的定位相反。

### 4.2 Graphify-Labs/graphify

Python + tree-sitter（36+ 语言），产出 `graph.json`（可 git 提交、可 merge）+ 可视化 + MCP 查询工具；边显式标注 `EXTRACTED` vs `INFERRED` 与置信度；Leiden 社区检测划分子系统；LLM 只用于文档/多媒体语义抽取，代码抽取零 LLM 成本；`--update` 只重抽变更文件。

**对本项目的启示：**
- 其 edge provenance + confidence 设计与方案二 §14.1 的 EvidenceEdge 几乎同构——说明方案二的 Evidence Graph 方向是行业共识而非过度设计；
- 「Not a vector index, no embeddings」的立场与方案二 §24.7 互相印证；
- 图作为可提交产物（graph.json in git）对个人项目是个轻量思路，但本项目的 per-request 实时路由 + LSP 验证边形态更适合「改代码前问影响面」的场景，不建议转向「先建全图再查询」。

### 4.3 定位结论

| 能力 | codebase-memory-mcp | graphify | codex-java-lsp-mcp |
|---|---|---|---|
| 结构抽取 | tree-sitter AST（158 语言） | tree-sitter AST（36+ 语言） | **regex（唯一落后项）** |
| 编译器级语义 | 无（内嵌近似 "Hybrid LSP"） | 无 | **JDT LS 精确 references/hierarchy（独有）** |
| 面向 agent 的输出 | 通用图查询，agent 自己组合 | 图查询 + PR 影响 | **task-profile readPlan + evidence gaps（独有）** |
| 质量纪律 | 无公开 golden 门禁 | LOCOMO 等通用基准 | **真实仓库 golden + R_read_must 硬门禁（独有）** |
| Java 框架深度 | 通用 | 通用 | DDD layer 感知，Spring/MyBatis 适配是明确的可拓展空间 |
| 新鲜度 | watcher + 增量重索引 | `--update` | **fast 模式无 watcher（落后项）** |

护城河 = JDT LS 精确语义 × task-oriented readPlan × golden 纪律 × Java 框架深度。两个落后项 = AST 抽取、LSP 无关的新鲜度。这两个落后项恰好就是方案二阶段 1~2 的核心内容，进一步支持其优先级判断。

---

## 5. 按「小而精悍、Java-only、个人项目、无兼容性约束」重新标定

### 5.1 直接采纳（正确性，改动小、保护信任）

- C-01/C-02：显式状态机（**5 态足够**：NEW/STARTING/READY/BROKEN/STOPPED，不需要方案二的 9 态；IMPORTING/SYMBOL_READY/REFERENCE_READY 等 readiness 细分留给迭代 5 按数据决定）+ start singleflight + 成功后才 commit 成员字段 + 失败统一 dispose/kill/reset。
- C-04：`SearchCompletion` 完整度标注，partial 一律不写 cache（当前请求可降级使用并标注 incomplete）。
- C-05：`locationCandidate` 处一行 containment 过滤 + suppressed 计数。绝对路径泄漏同时是隐私问题，应最先修。
- C-06：`starting` 计入 active 名额即可修掉主要窗口；完整 lease/公平队列可以不做（个人机器并发 repo 数极小）。
- C-07：入口建一个绝对 deadline，各阶段消费剩余预算；hierarchy 内层请求显式传剩余超时。放弃全链路 AbortSignal 插管（取消机制已有）。
- 错误分类：`semanticVerify` 的 catch-all-as-timeout 改为区分 timeout/cancel/not-ready/server-error；`requestSettled` 的 `console.error` 对预期超时降噪（方案二 §24.10）。

### 5.2 采纳但简化（新鲜度）

方案二的 `RepoChangeJournal` 事件溯源模型裁剪为：

- runtime 创建即启动 repo 级 watcher（不依赖 JDT LS）；
- 一个单调 generation 计数器，rgCache、SourceIndex、edge store、LSP cache 统一订阅；
- SourceIndex 增加 delete/rename 驱逐；build 文件变化触发 layout 重探；
- watcher 出错时置 dirty 标志强制下次全查——**周期性 reconcile 先不做**，等实际观察到丢事件再加。
- 顺手修 O-01（stopEntry 后删除 context 或加个位数 LRU）和 O-02（保留 last-known-good 快照，约 10 行）。

### 5.3 采纳为主要质量投资（索引底座）

- **tree-sitter-java 替换 regex parser**：修复 Q-02 全部具体缺陷（nested types、package-private 方法、字符串中花括号），是对比调研中唯一被两个项目共同验证的行业底线。Worker 数 1~2 个足够，不需要方案二的完整 pool 治理。
- **FQN/import 解析 + coverage 状态**：simple name 碰撞（Q-01）靠 import/package 解析出带置信度的 key；每个 source root 记录 COMPLETE/PARTIAL，COMPLETE 后才允许 negative cache（方案二 §24.5 铁律保留）。
- **低优先级全仓 sweep**：填掉 P-02 的「index miss ≠ 不存在」，同时消灭「miss 就全仓 `rg -l`」的 P95 抖动。
- **存储走最简路线**：放弃双 JSONL + append + compact，改为**内存索引 + 单文件原子快照（异步、debounced 写）**。无兼容性约束意味着直接 bump schema version、老缓存丢弃自动重建即可。**SQLite 不做**——三仓规模（数千文件）内存快照完全够用，native 依赖与 worker 独占连接的复杂度对个人项目是净亏损；方案二自己也把它设为 spike 而非结论。这是与方案二唯一实质分歧点：它建议 A/B spike，我建议直接选 B（原子快照）并跳过 spike，理由是仓库规模上限已知。
- 同步热点清理：请求路径去 `spawnSync`；`persist/compact` 异步化；`status()` 不再做全量 stat（预聚合或去掉 dirtyCount 的双次调用）。

### 5.4 采纳但收窄（识别效果）

- **evidence family 饱和**（Q-04）：`mergeCandidate` 从裸加法改为按家族（semantic-exact / structural / lexical / task-context）取 max 或对数饱和。这是纯函数改造，benchmark 可直接验证。
- **references 价值排序**（Q-05）：containment → file collapse → same-module/main-source/task-keyword 排序，之后再截 40。
- **方法体调用边（L2）+ Spring/MyBatis 适配器（L3）**：既然你的真实仓库就是 Spring/DDD/MyBatis 形态，L3 的 ROI 对你个人是所有识别增强里最高的；用依赖/注解触发，保持 pack 化，不进 generic core。
- **ReadPlan**：在现有 evidence-budget 分配器上加 byte 预算即可，不建 knapsack/求解器（方案二 §14.4 自己也说初期用 greedy）。
- **Ranker 校准（§14.3）降级为可选**：离线导权重、isotonic 校准这些对 16 个 golden 场景没有统计意义，等 golden 池到 50+ 再说。

### 5.5 裁剪或推迟

| 方案二内容 | 裁决 | 理由 |
|---|---|---|
| SemanticScheduler（优先级队列/aging/防饿死/bulkhead） | **裁剪为**：same-key singleflight + 简单 FIFO + deadline admission | 单用户、同一时刻基本单 repo，饿死场景不存在 |
| Circuit breaker + backoff | 裁剪为：连续失败计数 + 指数 backoff 重启（十几行） | 保护目标相同，机制简化 |
| Partial-result token / progress router | **推迟**到迭代 5，且先做行为探测再决定 | JDT LS 大概率不发 partial（方案二自己标注风险「高」） |
| DocumentLeaseManager | 裁剪为：64 个上限的 LRU + didClose（约 30 行） | 足够封住 P-05 |
| 12 repo / 120~150 scenario / blind split / bootstrap CI | 裁剪为：3~5 repo、目标 ~30 scenario、固定机器、hard gate 不变，新增 4 类系统测试（并发 start、fake rg timeout、rename/delete 陈旧、initialize 超时清理） | blind split 防的是团队规则军备竞赛；单人项目的过拟合防线是「新仓库先跑一次再调规则」的习惯，成本为零 |
| 9 个 feature flag + shadow mode + canary 灰度 | **删除**；迁移期最多留一个 INDEX_V2 开关 | 无兼容性要求 + git revert 即回滚 + benchmark gate 即 canary |
| CI matrix（macOS+Linux） | 删除 Linux | 项目明确 macOS-only（`run.sh` 直接拒绝非 macOS） |
| trust mode / 不可信仓库策略 | 保留 README 现有警告即可 | 个人仓库全部自有 |
| resource-aware admission（cgroup/RSS 预算） | 推迟 | 静态默认值在 32GB 单机上未观察到问题 |
| L5 embedding / 学习闭环 | 不做（两份方案在此一致） | — |

### 5.6 「无兼容性约束」带来的额外机会（两份方案都没敢提的）

既然明确不需要兼容性，还有几个方案二因「public surface 保持兼容」原则而绕开的简化值得做：

1. **缓存格式一次性换代**：source-index JSONL、edge store JSONL、meta 全部换成新 schema，不写 migration，老缓存直接删除重建（`~/Library/Caches/codex-java-lsp` 本来就是可丢缓存）。
2. **输出契约允许破坏性收紧**：`agent-types.ts` 大量 `Record<string, unknown>` 可直接换强类型；`ImpactResult` 里对 agent 无行动价值的字段（部分 metrics 双份 before/after）可以砍，进一步省 payload。benchmark 的 `outputBytes` 就是验收指标。
3. **死代码清理**：`RoutingPolicy["id"]` 的 `maven-reactor`/`ddd-gradle` 死变体；`benchmark-lsp-performance.ts` 若已被 agent-impact harness 取代可评估删除。
4. **工具面允许收缩**：7 个工具保持，但 `java_symbol`/`java_references` 的默认输出可以向 readPlan 风格靠拢（repo-relative、summary-only 已做，可以更激进）。

---

## 6. 修正后的执行路线

顺序沿用方案二的依赖关系（正确性 → 新鲜度 → 底座 → 识别 → warm），规模按第 5 节裁剪。每个迭代的验收都复用现有 hard gate：三仓 `R_read_must=1.0000`、recall/P_read 不回退、`npm run build && npm test` 全绿。

```text
迭代 1  正确性包（≈方案二迭代 1 裁剪版）
        C-01/02 五态状态机 + start singleflight + 事务清理
        C-04 completeness + 禁 partial cache
        C-05 containment（含绝对路径泄漏）
        C-06 starting 计入 active
        C-07 绝对 deadline 预算 + hierarchy 显式超时
        semantic 错误分类 + stderr 降噪
        新增测试：并发 start / fake rg timeout / outside-repo / initialize 超时清理

迭代 2  新鲜度包
        LSP 无关 watcher + 单调 generation（rgCache/SourceIndex/edgeStore/LSP cache 统一订阅）
        delete/rename 驱逐 + build 文件变化重探 layout
        O-01 stopped context 清理、O-02 last-known-good
        新增测试：fast 模式编辑后 cache 失效 / rename 后旧路径消失

迭代 3  索引底座（本路线唯一 XL 项）
        tree-sitter-java worker 替换 regex facts（schema 直接换代，不迁移）
        FQN/import 解析 + per-root coverage + COMPLETE 后 negative cache
        低优先级全仓 sweep；请求路径去 spawnSync；原子快照存储
        验收：三仓 benchmark 平价或更优 + mutation stale rate = 0 + package-private/nested 用例回归

迭代 4  识别效果（与已落地 edge store / evidence budget 合并推进）
        evidence family 饱和计分（替换裸加法）
        references 价值排序后再截断
        方法体调用边 + Spring/MyBatis 适配 pack
        readPlan byte 预算
        验收：R_task_blocking 每仓不回退，exam P_read ≥ 0.6333（phase 12 gate 延续）

迭代 5  warm-required 首触（数据驱动，可不做）
        先跑方案二附录 F 的裁剪版实验矩阵（fresh/reused × query 类型即可）
        semantic singleflight + document LRU
        以实验结果决定 warm-required 是否值得默认化，不预设结论
```

**明确不做**（合并两份方案与本 review 的否决项）：SQLite/DuckDB、embedding/LLM rerank、RL 反馈闭环、Context Planning Engine、LSP pool preload、多语言扩展、per-repo rules DSL、feature flag 灰度体系、Linux CI、readPlan 默认扩容、warm-required 未经数据直接默认化。

---

## 7. 文档管理建议

1. 方案一文件头部加 `> Superseded by codex-java-lsp-mcp-deep-optimization-plan-2026-07-23.md（见同目录 review 报告 §2）`，不再维护。
2. 方案二保留为主要路线输入，但使用时以本报告 §3.5 的过时点清单和 §5 的规模裁剪为准；其 §24「不建议做的事情」可直接并入贡献规范。
3. 后续每个迭代延续现有 phase report 惯例（现有 phase 4~12 报告的「基线对照 + hard gate + 已知限制」格式很好，是这个仓库最有价值的工程资产之一，应保持）。

---

## 8. 本 review 的限制

- 三仓真实 benchmark 未重跑；引用的指标来自仓库内 phase 11/12 报告（口径：cold-nolsp、runs=5、同一台机器）。
- 对比项目基于其公开 README 的声明，未验证其实际性能数字（如 99.2% token 节省、3 分钟索引 Linux kernel）。
- P-07（资源策略）与 M-02（warm benchmark 顺序效应）未逐行复核，前者影响面小，后者需要重跑 warm 实验才能证实。
- warm 延迟历史数字（1505~1717ms 首触 P95 等）无法在本次静态审阅中复现，按方案二引用的仓库报告采信。
