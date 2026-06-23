# Java LSP MCP 架构级效果提升方案

生成时间：2026-06-21
修订时间：2026-06-22
适用对象：`/Users/luo/Documents/github/codex-java-lsp-mcp`（通用 Java LSP MCP）
输入依据：
- `java-lsp-mcp-lishuedu-generic-vs-dedicated-comparison-2026-06-21.md`（通用 vs 专用对比）
- 本地源码真源（`agent-router/index.ts`、`source-index.ts`、`repo-layout.ts`、`jdtls-session.ts`、`tools/*` 等）
- 前序文档 `java-lsp-mcp-performance-optimization-plan-2026-06-21.md`（性能维度，互补不重复）

> 本文回答的问题：**这个“通用” Java LSP，从底层设计与架构层面，还有没有可以提升效果的地方。** 焦点是“效果质量 + 真通用性 + 可演进性”，不是冷启动延迟（那是前序性能 plan 的范畴）。
>
> 2026-06-22 修订口径：本版吸收三轮架构 review 结论，把路线从“先大规则包通用化”调整为“先度量证伪 → 证据引擎 / routing policy 分层 → 按证据决定是否外置规则”。本版同时拍板战略定位：目标是**面向任意 Java 项目的真通用 LSP**，而不是 lishuedu 同构项目的维护性替代底座。不扩 7 个 public MCP tools，不把 `projectId` 升级为 runtime/cache 身份，不提前公开 per-repo `rules.json`。

---

## 0. 结论（先读这一段）

对比报告的结论是「通用版在 lishuedu 上不弱于、局部强于旧专用版」。这个结论**成立但具有误导性**：读完 router 真源后可以确认——

> **当前的“通用 LSP”，在召回与评分引擎层面，本质是把 lishuedu 专用 router 重构成了多 repo 外壳；它的 precision/recall 之所以在 lishuedu 上达标，是因为评分规则就是按 lishuedu 的命名约定、DDD 分层和业务名词调出来的。**

证据（§1 详列）：三个核心文件头注释直接写 “for lishuedu”；`scoreBase()` 内嵌 `ParentBenefitQueryAppServiceTest`、`ExcelParserTest|DiffBuilderTest`、`StudentDraft|TeacherDraft|GradeDraft`、`SignedUrl|Report` 等 lishuedu 专有标识符；`classifyPath()`/`rootsFor()` 只把 `modules/`+`apps/` 这种 Gradle 多模块布局当一等公民。

因此，“还能不能提升效果”的答案不是继续扩工具面，也不是先做公开配置 DSL，而是分五层推进。第三轮 review 进一步确认：作为架构方案与测试标准，本文已成熟；作为开发任务说明书，还必须先冻结 confidence、routing rule、semantic stage 三个横切契约，避免 P1/P3/E2/G1 各自发明互相冲突的接口。

1. **先把效果变得可证伪（M 类）—— 决定后续重构是不是值得做。** 现有 benchmark 基本是 lishuedu 5 场景；非 lishuedu 测试更多证明“能返回结果”，不足以证明 precision/recall。没有多项目 golden set，G/P 类改造都只能凭直觉排优先级。
2. **证据引擎 / routing policy 分层（A 类）—— 决定它能不能长期演进。** 保留 7 个 public tools、`repoRoot/repoHash` 身份边界和 `java_impact` 输出骨架，把 anchor 解析、SourceIndex、rg、references/typeHierarchy/callHierarchy 等证据能力与 layout/profile/score/readPlan 策略拆开。
3. **真通用化（G 类）—— 决定它在第二、第三个项目上还成不成立。** 把领域知识（命名约定、目录布局、profile 信号、专有正则）从核心代码里移出，但第一阶段只做内部 policy / 内置包，不公开 per-repo `rules.json`，避免把调权问题过早固化成外部契约。
4. **precision 提升（P 类）—— 决定单项目内的输出质量天花板。** 当前 `precision=0.41` 的根因是**召回主力是 rg 正则“猜”语义**（按类名前缀拼 `Stem(Controller|Service|...)`），而真正的语义边（references / typeHierarchy / callHierarchy）没有进入 `java_impact` 主路径。引入「语义验证重排 + 轻量类型关系图」可在不掉 recall 的前提下提 precision。
5. **可演进 / 可运维（E 类）—— 决定它能不能被持续优化和安全发布。** 构建漂移（installed runtime 落后于本地构建，报告 P1 已实测）、评分不可解释（全是魔数）、token 成本不可分级、root 来源不可观测。

下面是全部可提升点的索引矩阵，详述见 §3。

### 0.1 提升点矩阵

| 编号 | 方案 | 类别 | 预期收益 | 改造范围 | 风险 | 优先级 |
|---|---|---|---|---|---|---|
| **M0** | 多项目 golden set + benchmark 指标前置 | 度量 | 最高（决定后续改造是否成立） | 中偏上（golden 外部化 + warm/cold harness + readPlan 评分） | 低（标注与环境成本） | P0 |
| **E1** | 构建漂移防护：version stamp + `java_status` 暴露 + 启动校验 | 工程化 | 高（杜绝“以为用新版其实是旧 runtime”） | 小（install 脚本 + status） | 低 | P0 |
| **A1** | `java_impact` 证据引擎 / routing policy 分层 | 架构 | 高（把可复用证据能力与项目策略拆开） | 中大（router 内部结构） | 中（行为回归） | P0 |
| **G1** | 评分规则与专有正则迁入内部 routing policy（暂不公开 `rules.json`） | 通用性 | 高（决定跨项目效果可移植） | 中大（router 评分核心重构） | 中（回归风险，需基线锁定） | P0（等价迁移）/ P1（中性化） |
| **G2** | 布局/module/layer 自适应探测与 `layoutProfile` 真正生效 | 通用性 | 高（非 `modules/` 项目 recall 不塌） | 中（`classifyPath`/`rootsFor`/`persistenceRoots`/status） | 中 | P0 |
| **G3** | profile 推断从“类名正则”转“注解 + 类型 + 路径”多信号 | 通用性 | 中高（profile 错判直接带偏整张图） | 中（`inferProfile` + facts 扩展） | 低中 | P1 |
| **P1** | 语义验证重排：用 `references`/`typeHierarchy` 确认候选、裁文本噪声 | 精度 | 高（precision 直接受益，recall 不降） | 中（`impact()` 消费现有语义封装） | 中（延迟/冷启动敏感，须 policy 化） | P0 |
| **P2** | 轻量类型关系图：`implements/extends` 离线组图，替代部分 rg 猜测 | 精度 | 中高（port/repository/service 找实现更准更快） | 中（`source-index` 增图层） | 中（regex 解析不可靠，须标注置信度） | P1 |
| **P3** | 召回引擎：符号锚定优先、命名正则降级为兜底 | 精度 | 中高（减少同前缀误召回） | 大（`buildRgPlan` 体系） | 中高（牵动既有基线） | P1 |
| **P4** | `auto` 语义触发策略：warm 命中后扩大语义启用面 | 精度 | 中（auto 路径白拿语义精度） | 小（`shouldUseSemantic`） | 低 | P1 |
| **E2** | 评分可解释：候选返回 score breakdown | 工程化 | 中（调优闭环、agent 可理解排序） | 中（五记账点：anchor/semantic/rg/merge/finalize + `formatCandidate`） | 低 | P1 |
| **E3** | token 分级 verbosity：metrics/rgSummary/evidenceGaps 可裁 | 工程化 | 中（payload 降 10–25%） | 小（payload 组装） | 低 | P1 |
| **E4** | root 来源可观测：回显 `rootSource` + 启动校验 build 文件 | 工程化 | 中（防 root 漂移类故障） | 小（`repo-resolver`/`status`） | 低 | P2 |
| **X1** | 反馈驱动的轻量权重学习（agent 实际读取 → 调权重） | 展望 | 中长期高 | 大 | 高 | P3 |
| **X2** | 多语言/多 LS 抽象（router 与 JDT LS 解耦） | 展望 | 战略 | 很大 | 高 | P3 |

P0=本轮最该做；P1=紧随；P2=有余力；P3=战略储备。

---

## 1. 现状的架构定位与证据

要谈“还能不能提升”，先必须诚实地给现状定性。下面是从真源得到的结构性事实，而不是从报告转述的结论。

### 1.1 它是什么：一个被多 repo 化的 lishuedu 专用 router

三个最核心的文件，头注释（`// pos:`）自陈身份：

- `src/agent-router/index.ts:3` — `Single agent-grade semantic router for lishuedu Java navigation.`
- `src/agent-types.ts:3` — `Type contracts for the lishuedu JDT LS MCP v5 router.`
- `src/repo-layout.ts:3` — `Shared path helper for the lishuedu JDT LS MCP bridge.`

这不是注释没更新的小事，而是设计来源的如实记录：评分函数里嵌着 lishuedu 的业务词汇。

### 1.2 评分引擎里的 lishuedu 专有知识（precision 假象的来源）

`scoreBase()`（`agent-router/index.ts:580-643`）是决定排序、进而决定 precision/recall 的核心。它内部含大量**针对 lishuedu 的硬编码正则加分**：

- `:621` port profile：`/Gateway|Config|SignedUrl|AppService|Report/` → +30
- `:624` dto profile：`/Assembler|Controller|QueryAppService|ProductView|ParentBenefit|ItemView/` → +32
- `:630` dto 测试：`/ParentBenefitQueryAppServiceTest|BenefitEntitlementAssemblerTest/` → +90
- `:618` parser 测试：`/ExcelParserTest|DiffBuilderTest/` → +90
- `:612` parser：`/Parser|ParsedTemplate|DiffBuilder|Draft|PreviewItem/` → +38

以及检索词构造里更直接的业务名词，`parserTerms()`（`:734-742`）：
`StudentDraft|TeacherDraft|GradeDraft|ClassDraft|PreviewItem|BindingDraft|BindingPreviewItem`。

含义：报告里 lishuedu 5 场景 top5 与专用版“完全一致”，**部分是因为评分规则直接为这些类名/测试名加了 +30~+90 的定向分**。但这类专有分不是唯一排序因素：anchor 自身、同文件、同模块等结构分更大，通常锁定 top1/top2；lishuedu 专有正则主要扭曲中段排序与测试候选排名。把同一套规则原样搬到另一个项目，这些加分项全部失效，排序质量回落到“纯命名前缀正则 + 通用结构分”的水平——而那部分的 precision 没有被任何报告量化过。

补充口径：本文引用的 `precision=0.41` 是 benchmark 的**候选集 precision**，不是 readPlan precision。P 类收益更准确的定位是：减少候选噪声挤占 `candidateLimit`、净化 `rgSummary`、提高 readPlan 的候选池质量，而不是断言 agent 实际阅读的一半都是错误文件。

### 1.3 布局假设：`modules/` + `apps/` 是一等公民

- `classifyPath()`（`repo-layout.ts:107-119`）：`parts[0]==="modules"` 或 `"apps"` 时才直接得到 `module`；否则只能靠 `src` 的父路径兜底，且兜底会把 `com/lishu/edu` 这类包路径当成 module 名。
- `rootsFor()`（`agent-router/index.ts:694-703`）：检索根硬编码 `modules/{m}/src/{set}/java`、`apps/{m}/...`、`{m}/src/{set}/java`。
- `broadSearchRoots()`（`:705-708`）：只认 `["modules","apps"]`，否则退化为全仓 `["."]`。
- 修订说明：早期前序 plan 曾记录 `file-watcher` Maven source root 缺口；后续真源已支持 plain Maven 与一级模块 source root，因此本方案不再把 watcher 作为 G2 主改造范围。

含义：对一个标准 Maven 单体（`/src/main/java/com/x/{controller,service,dao}`）或 Spring Boot 三层项目，module 维度仍可能坍缩，`crossModulePolicy`、`focusModules`、跨模块降权这些机制失去支点，`rootsFor` 容易落到 `["."]` 全仓扫描——recall 也许还在，precision 会更差，rg 也更慢。

### 1.4 DDD 分层词典是固定枚举

`classifyPath()`（`repo-layout.ts:126`）的 layer 取自固定数组 `["interfaces","application","domain","infrastructure","controller","service","repository","mapper","entity","dto","vo"]`，命中即停。这套词典是 DDD + 部分 MVC 的混合，对 hexagonal/clean architecture（`adapter`/`usecase`/`boundary`）、或中文/团队自定义分层目录无能为力。

### 1.5 已经具备、但没用满的语义能力（precision 的真正杠杆）

`jdtls-session` 已封装并被低层工具使用的语义能力：

- `references(file,line,column,includeDeclaration)` —— 被 `java_references` 用（`tools/references.ts:26`），但 **`impact()` 从不调用**。
- `workspaceSymbols(query,limit)`、`symbolContext(...)` —— 被 `java_symbol` 用。
- `semanticLocations(...)` —— 被 `impact()` 用，但只取 `definitions + implementations`（`agent-router/index.ts:107-114`），**不取 references**。

而 `impact()` 的语义启用本身就很克制：`shouldUseSemantic()`（`:239-247`）完整条件是 `semanticPolicy==="required"`、`mode==="precision"`、`mode==="recall"` 或默认 `auto` 下命中 `profile==="service"`。也就是说 precision/recall mode 已有全量语义入口；真正缺口是 agent 默认最常走的 `mode=balanced + semanticPolicy=auto`，controller/repository/dto/parser 在这条路径下仍主要靠 rg 正则。

含义：影响面分析（“我改这个符号，谁会被波及”）的本质是**反向引用图**（incoming references / incoming calls），而这恰恰是当前 `impact()` 最不用的能力。precision=0.41 与此直接相关：召回靠正则猜，没有一道语义闸门把“文本撞名”从“真实符号关联”里筛出来。

### 1.6 source-index 是 per-file facts，不是引用图

`SourceIndex`（`source-index.ts`）缓存的是**单文件**事实：`typeName/kind/methods/implementsTypes/extendsType/annotations/packageName`，带 regex/documentSymbol 双来源与 JSONL 持久化。它**采集了 `implementsTypes`/`extendsType`（`:336-340`），却没有把它们组装成跨文件的类型关系图**。也就是说“谁实现了这个 port”这种查询，目前只能退回 rg 命名猜测，而事实层其实已经攒下了组图所需的原料。

### 1.7 一个需要修正的前序判断：rg 已是异步并发

前序性能 plan 若记述 “executeRgPlan 为同步 `spawnSync` 串行、阻塞 event loop”，**以本轮真源为准修正**：`executeRgPlan()`（`agent-router/index.ts:335`）用 `mapConcurrent(plan, RG_CONCURRENCY, ...)` 并发，`RG_CONCURRENCY=min(4, availableParallelism())`（`:53`）；`runRg()`（`:1060`）用异步 `spawn` + 流式 maxBuffer + 超时取消，**不阻塞 event loop**。因此“rg 串行化”不再是性能提升点；rg 层真正的提升点转移到**召回质量**（§4.3）与缓存命中（已有 TTL 300s generation 失效缓存）。同步 IO 的问题仍存在，但在 `source-index` 持久化（`appendFileSync`/`writeFileSync`，`:230/243/257`），归前序 plan 的稳态 IO 项。

---

## 2. 总体设计取向（约束所有方案的四条原则）

下面所有方案都遵守同四条原则；它们本身就是对“为什么现在不够通用/不够准”的回应。

1. **度量先于重构（measure-first）。** 任何触碰评分/召回核心的改造，第一步不是写新抽象，而是扩出多项目 golden set，能同时看 precision/recall@K、readPlan 命中率、payload bytes、warm/cold latency。没有证伪闭环，不排大重构。
2. **证据引擎与 routing policy 分层。** `SourceIndex`、rg、references、typeHierarchy、callHierarchy、definition/implementation 是证据能力；layout/profile/score/readPlan 是项目策略。前者应尽量通用，后者可以按 `layoutProfile`/探测结果选择，但不要扩 public tool surface。
3. **语义为闸、命名为网（semantic-gate, naming-net）。** 命名正则负责广撒网、保 recall；语义（`references`/`typeHierarchy`/`callHierarchy`）负责收口、提 precision。二者分工而非互相替代——这是把 `precision=0.41` 往上抬而不牺牲 `recall=1.00` 的关键结构。
4. **等价迁移再演进（equivalence-first）。** 任何触碰评分核心的改造，第一步必须让 lishuedu 现有输出在**排序与候选集上 byte/快照级不变**，再在该基线上做中性化/泛化。杜绝“重构即回归”，让每一步都有可回滚的黄金基线。

### 2.1 A1 证据引擎 / routing policy 分层（P0）

**问题。** 当前 `AgentRouter` 把两类职责混在一个文件里：一类是可复用证据 primitive（anchor 解析、SourceIndex facts、rg 命中、JDT LS definition/implementation/references/typeHierarchy/callHierarchy），另一类是项目 routing policy（layout/profile/score/readPlan/候选裁剪）。G1 只解决评分和专有正则，覆盖不了 A1 的整体边界。

**方案。** 先在内部明确两层接口，不改变 public MCP tools：

- evidence engine：负责产出标准化证据，如 `anchorFacts`、`rgCandidates`、`semanticEdges`、`typeGraphEdges`、`sourceFacts`。
- routing policy：消费证据，决定 module/layer/profile、score/confidence、readPlan priority、测试/跨模块策略。
- G1/G2/G3 都是 routing policy 的填充项；P1/P2/P3 是 evidence engine 与 policy 的联动项。

**改造范围。** 仍可先落在 `src/agent-router/index.ts` 内部拆函数/类型，不需要一上来拆多文件；当 `RoutingPolicy` 类型稳定后，再新增 `src/routing-policy.ts`。`java_impact` schema 和输出骨架保持不变。

**预期收益。** 执行边界清楚：后续不会把 A1 误做成“只抽评分”，也不会把 source-index/JDT LS/cache 身份这些稳定边界误纳入策略重构。

**风险与验证。** 风险是内部重排触动排序。验证方式是 lishuedu 快照零差异 + 多项目 benchmark baseline 不变；只有在 A1 等价成立后，才进入 G1/G2/P1 的行为改造。

### 2.2 开发前置契约（开工前冻结）

第三轮 review 的关键反馈成立：P1/P3/E2/G1 不是不能开工，而是缺三个横切契约。它们必须先在 Batch 1 冻结，否则实现会在评分、排序、解释和语义阶段上各写各的。

#### C1. confidence 数据模型与排序合成函数

**契约。** `CandidateFile` 保留现有 public 字段，内部扩展为 `RoutedCandidate`；A1/G1 等价迁移阶段先写字段但不改变排序，P1/P3 再由 policy 打开 confidence 调分：

```ts
type Confidence = "high" | "medium" | "low";

type ScoreBreakdownItem = {
  id: string;
  source: "anchor" | "semantic-seed" | "rg" | "merge" | "policy" | "finalize";
  delta: number;
  reason: string;
};

type RoutedCandidate = CandidateFile & {
  confidence: Confidence;       // default: "medium"
  verifiedBy: string[];         // e.g. ["anchor", "reference", "typeHierarchy"]
  scoreBreakdown?: ScoreBreakdownItem[];
};
```

**默认值。**

- anchor 自身：`confidence=high`、`verifiedBy=["anchor"]`。
- LSP definition/implementation/reference/typeHierarchy/callHierarchy 命中：`high`。
- SourceIndex facts 或 rg 命中：`medium`。
- 仅命名正则命中、且 semantic verify 明确未确认的候选：`low`。

**排序合成。** 不引入一级 `(confidenceRank, score)` 排序键，避免低分高置信候选越过高分结构候选；统一在 `finalizeScore` 末尾做加性调分：

```text
confidenceDelta = policy.confidenceDeltas[confidence]
finalScore = max(1, baseScore + finalizeDeltas + confidenceDelta)
sortKey = (finalScore desc, path asc)
readPlanSortKey = (priority asc, finalScore desc)
```

`lishuedu-legacy` 在 A1/G1 等价迁移阶段使用 `{ high: 0, medium: 0, low: 0 }`，保证快照不因字段引入而变化；P1/P3 的 generic/warm 策略再启用推荐值 `{ high: +40, medium: 0, low: -40 }`。E2 的 `scoreBreakdown` 必须包含 confidence delta，且 `sum(delta) == finalScore`；当前代码有 `scoreBase` 与 `finalizeScore` 两处 `Math.max(1, ...)`，若保留双 clamp，必须分别记录 `scoreBase.clamp` / `finalize.clamp`。不得只记 `finalize.clamp`，否则 rg 初始分被 `scoreBase` clamp 时求和会失败。

#### C2. RoutingPolicy 规则结构必须能表达现有 `scoreBase()`

**契约。** `profileSignals: { pathRegex, boost }` 不能表达真源中的多条件、多加减分规则；G1 必须采用规则数组，让现有 `scoreBase()` 的每个 `if` 都能一对一迁移。

```ts
type ScoreRule = {
  id: string;
  when: {
    category?: "java" | "protocol" | "persistence" | "config" | "tests" | "semantic" | "nonJava";
    profile?: ResolvedImpactProfile;
    sourceSet?: "main" | "test";
    layer?: string | string[];
    pathRegex?: RegExp;
    sameFile?: boolean;
    sameModule?: boolean;
    moduleEquals?: string;
    focusModule?: boolean;
    taskKeyword?: boolean;
    factSource?: "documentSymbol" | "regex" | "unknown";
  };
  delta: number;
  reason: string;
};

type RoutingPolicy = {
  id: "generic-java" | "maven-reactor" | "ddd-gradle" | "lishuedu-legacy";
  scoreRules: ScoreRule[];
  confidenceDeltas: Record<Confidence, number>;
  namingTemplates: Partial<Record<ResolvedImpactProfile, NamingTemplate[]>>;
  termProviders: Partial<Record<ResolvedImpactProfile, (ctx: TermContext) => string[]>>;
  profileSignals: ProfileSignalRule[];
  layout: LayoutContext;
};
```

`namingTemplates` 只承接纯数据化命名模板；`dtoUpstream(anchor, symbol, repoRoot)`、`testTerms(anchor, ...)` 这类依赖 anchor/repoRoot/sourceSet 的特殊逻辑进入 `termProviders`，不能伪装成 `(base, stem, symbol) => terms[]` 的 JSON 模板。

**等价要求。** `lishuedu-legacy.scoreRules` 第一版直接搬运现有 `scoreBase()` 的结构项、profile 项、惩罚项、测试项和 task/focus 项；每条规则保留可追踪 `id`，用于 E2 breakdown 与快照差异定位。

#### C3. `java_impact` 阶段结构与 warmState 绑定

**契约。** P1 新增的是 rg 之后的语义验证阶段，不替换当前 rg 之前的 `semanticLocations(definition + implementation)` 候选生成阶段。

```text
S0 resolve-anchor
  -> candidateFromAnchor
S1 semantic-seed
  -> existing semanticLocations(definition + implementation), produces candidates
S2 naming-recall
  -> SourceIndex + optional P2 typeGraph + rg plan, produces candidates
S3 semantic-verify
  -> references/typeHierarchy/callHierarchy, updates confidence/verifiedBy/scoreBreakdown
S4 finalize-rank-readPlan
  -> finalizeScore, sort, candidateLimit, readPlan
```

阶段开关：

- `cold-nolsp`：只跑 S0/S2/S4；用于 A1/G1/P3 等价快照，P1 不触发。
- `cold-nolsp` 等价快照默认 `graphMode=off`；P2 类型图若开启，会在 LSP 未就绪时新增候选，不能用于零差异快照。
- `cold-lsp`：Batch 0 只允许 S1 超时降级，不等待 import idle；P4 落地后才允许按 warm policy 跳过。
- `warm-auto`：只允许 references 轻验证，用于验证 P4 默认路径收益。
- `warm-required`：允许预算内完整 S3，用于验证 P1 权威语义路径。

因此，lishuedu 黄金快照的“零差异”默认绑定 `warmState=cold-nolsp`；P1/P4 的精度提升只在 `warm-auto` / `warm-required` 基线上验收，避免“语义调分必然改变排序”与“快照零差异”互相矛盾。

---

## 3. 通用性方案（G 类）：决定它在第二、第三个项目上还成不成立

### 3.1 G1 评分规则与专有正则迁入 routing policy（P0/P1）

**问题。** `scoreBase()`（`agent-router/index.ts:580-643`）与各 `*Terms()`（`:722-865`）把权重魔数、profile 加分正则、lishuedu 业务名词全部写死在评分核心里（证据见 §1.2）。换项目即失效，且没有任何旋钮可调。

**修订判断。** G1 方向成立，但不应作为第一刀公开 per-repo `rules.json`。现在已经有公开持久化入口 `layoutProfile`，但它尚未真正参与 routing；此时再引入 `layoutProfile` + layout probe + `rules.json` 三套并行概念，会把内部调权问题过早固化成外部契约。

**方案。** 先抽出内部 `RoutingPolicy`，把“通用证据引擎”和“项目 routing policy”解耦；第一阶段只提供内置 policy，不暴露 repo-local DSL：

```text
RoutingPolicy = {
  id:             "generic-java" | "maven-reactor" | "ddd-gradle" | "lishuedu-legacy"
  scoreRules:     ScoreRule[]                // 一条 if/加减分对应一条规则，支持负分与 sourceSet/test 条件
  confidenceDeltas:{ high, medium, low }      // C1 统一调分入口
  profileSignals: ProfileSignalRule[]        // G3 多信号投票
  namingTemplates:{ [profile]: NamingTemplate[] }
  termProviders:  { [profile]?: TermProvider } // dtoUpstream/testTerms 等上下文相关 terms
  layout:         LayoutContext
}
```

- `generic-java`：中性 policy，只含与具体业务无关的结构信号（同文件 / 同模块 / sourceSet / 常见 MVC/DDD 词典 / 标准排除）。
- `ddd-gradle` / `maven-reactor`：由现有 `layoutProfile` 或探测结果选择，用于布局与 layer/profile 的粗粒度差异。
- `lishuedu-legacy`：承接现有全部硬编码，**保证 lishuedu 等价**，但作为内部兼容 policy，不作为新公共配置格式。
- `scoreRules` 必须能一对一表达现有 `scoreBase()`：例如 parser 的 `+38 pathRegex`、`-70 persistenceRegex`、`+90 testRegex` 是三条规则，而不是一个 profile boost。
- 暂不公开 `<repoRoot>/.codex-java-lsp/rules.json`。只有当多项目 golden set 证明内置 policy 不足以覆盖真实项目差异时，再设计外部 override。
- `namingTemplates` 第一阶段只收纯命名模板；`testTerms`、`dtoUpstream` 等需要 anchor/repoRoot 的逻辑保留为 `termProviders` policy 方法。若未来开放 JSON override，必须把可数据化部分与代码 provider 明确拆开，不能把函数形态误当成可序列化契约。

**改造范围。** 新增 `src/routing-policy.ts`（类型 + 内置 policy 选择）；`scoreBase`/`finalizeScore`/`inferProfile`/全部 `*Terms` 改为从注入的 `RoutingPolicy` 取值；`RepoRuntimeManager` 创建 `AgentRouter` 时把 `layoutProfile`/探测结果传入 policy 选择器。

**影响面。** router 排序核心、所有 `java_impact` 输出。是本文最大的一处重构。

**预期收益。** 高且是战略性的：通用效果第一次变得**可移植、可度量、可调**；lishuedu 通过 legacy policy 等价保持；新项目优先通过 `layoutProfile`/探测选择内置 policy，而不是立即新增外部配置。

**风险与代价。** 重构面大、排序回归风险高。缓解 = 原则 4：先做纯等价迁移（现有魔数原样进 `lishuedu-legacy` policy），用 lishuedu 5 场景**输出快照测试**锁死 byte/排序不变，再逐步中性化 default。

**验证。** 黄金快照：lishuedu 5 场景 top5/readPlan 不变；新增 1–2 个异构项目做 A/B（见 §9）。若异构项目 current baseline 已接近 lishuedu，G1 仍完成内部等价迁移与中性 policy 清理，但不继续外置 `rules.json`。

### 3.2 G2 布局 / module / layer 自适应探测（P0）

**问题。** `classifyPath()`（`repo-layout.ts:107-119`）与 `rootsFor()`/`broadSearchRoots()`（`agent-router/index.ts:694-708`）只把 `modules/`+`apps/` 当一等公民。标准 Maven 单体或 Spring 三层项目的 module 维度直接坍缩，`crossModulePolicy`/`focusModules`/跨模块降权全部失去支点，rg 退化为全仓 `["."]`（证据 §1.3）。

**修订判断。** `file-watcher` 的 Maven 单模块 / 一级模块 source root 支持已经存在；G2 不再把 watcher 当主改造范围。真正缺口是 `classifyPath`、`rootsFor`、`persistenceRoots` 与 `layoutProfile` 没形成统一 routing 输入。这里应复用/抽取 watcher 已有探测逻辑，而不是从零再写一套。

**方案。** 启动时做一次**布局探测**，并和现有 `layoutProfile` 合并成 routing policy 输入，产出 `{ moduleRoots, sourceRoots, layers, layout: gradle-multi | maven-multi | single | flat-layers }`：

- 已有 `findBuildRoot()`（`repo-layout.ts:39-63`）能区分 gradle/maven，复用之。
- 抽取 `file-watcher.sourceRoots()` 的三段式探测思路：repo root 自身、一级子目录、`modules/apps` 子目录，形成共享 `layout-probe`。
- Gradle：解析 `settings.gradle(.kts)` 的 `include(...)`；Maven：解析根 `pom.xml` 的 `<modules>`。
- 单模块：直接用 `src/main/java`；三层：识别 `controller/service/dao|mapper` 包作为伪 layer。
- 探测结果喂给 `classifyPath`（消费 module 表而非写死 `modules/apps`）、`rootsFor`（按探测 root 生成检索根）、`persistenceRoots`（按 module/resource root 生成 SQL/XML 搜索范围）。
- `buildRgPlan` 内联的 config section 与 `dtoUpstream` fallback 不能再写死 `["modules", "apps"]`，必须改为消费 `layoutContext.broadRoots`，否则 Maven/generic 项目的 YAML/properties/dto 上游证据会被静默丢弃。
- `layoutProfile` 保留为用户可见 coarse hint；探测结果负责补齐未注册或配置不精确的项目。

**注入方式。** 不引入全局 singleton。`RepoRuntimeManager` 在创建 `AgentRouter` 时运行 `probeLayout(repoRoot, layoutProfile)`，`AgentRouter` 持有只读 `LayoutContext`，并通过入参传给纯函数：

```ts
classifyPath(repoRoot, absolutePath, layoutContext?)
rootsFor(repoRoot, anchor, sourceSet, options, layoutContext?)
persistenceRoots(anchor, layoutContext?)
```

这能保持现有 helper 的默认行为：没有 `layoutContext` 时仍走当前 `modules/apps` + 全仓 fallback；有探测结果时才启用自适应布局。这样 G2 的改动面是显式签名扩展，而不是隐式全局状态。

**改造范围。** 新增 `src/layout-probe.ts`（从 watcher 现有 source root 探测抽取，而非另起一套）；改 `classifyPath`、`rootsFor`/`broadSearchRoots`/`persistenceRoots`、`buildRgPlan` 内联 config roots、`dtoUpstream` fallback、`java_status` 布局回显；探测结果并入 G1/A1 的 `RoutingPolicy.layout`。

**影响面。** 全部依赖 module/sourceRoot 的逻辑：检索根、跨模块策略、评分中的 sameModule。

**预期收益。** 高：非 `modules/` 项目 recall 不再依赖全仓兜底，rg 范围收紧 → 更快更准；module 语义恢复，跨模块降权等机制重新生效。

**风险与代价。** 探测错误可能引发检索根错误。缓解：探测失败**回退当前全仓行为**（不劣于现状），并把 `layout`/`moduleRoots` 回显到 `java_status` 供排障。

**验证。** Maven 单模块 + Maven 多模块 + Gradle 多模块三类 fixture，断言 module/sourceRoot/检索根正确；不把 watcher 作为本项验收门槛。

### 3.3 G3 profile 推断转“注解 + 类型 + 路径”多信号（P1）

**问题。** `inferProfile()`（`agent-router/index.ts:645-678`）几乎只靠 path/typeName 的字符串正则（`controller\b`、`/repository\b/` 等），且 `facts.kind` 来自 regex。profile 一旦错判，`buildRgPlan` 的整张检索策略和 `scoreBase` 的整组加分都跟着偏。

**方案。** 把 profile 推断改成多信号加权投票，**注解优先、类名兜底**：

- 注解信号（`facts.annotations` 已采集，`source-index.ts:330-333`）：`@RestController/@Controller`→controller、`@Service`→service、`@Repository`→repository、`@Entity/@Table`→entity、`@Mapper`→mapper、`@Component/@Configuration` 辅助。
- 类型信号：`implementsTypes`/`extendsType`（已采集）命中 `*Repository<>`/`JpaRepository`/`Mapper<>`→repository/mapper。
- 路径信号：现有 path 正则降权为兜底。
- 注解→profile 映射也放进 `RoutingPolicy`（与 G1 协同，吸收 JPA / MyBatis / MyBatis-Plus 等流派差异）。

**投票权重。** 第一版不做复杂学习，固定权重并进入 `RoutingPolicy.profileSignals`：

| 信号 | 示例 | 权重 |
|---|---|---:|
| 显式 profile | `options.profile !== "auto"` | 绝对短路，不进投票 |
| anchor role | 调用方指定 `role` | +120 |
| 框架注解 | `@RestController`、`@Service`、`@Repository`、`@Mapper`、`@Entity` | +100 |
| 类型关系 | `extends JpaRepository`、`implements FooMapper`、interface + `Gateway/Client` | +80 |
| 路径 layer | `/controller/`、`/service/`、`/repository/`、`/mapper/`、`/entity/` | +50 |
| 类型名后缀 | `*Controller`、`*Service`、`*Repository`、`*DTO`、`*Entity` | +35 |
| 任务 / 文件上下文 | `testReadMode`、`sourceSet=test`、task keyword | +20 |

冲突裁决：`options.profile !== "auto"` 直接沿用当前 `resolveAnchor` 绝对覆盖语义；只有 `auto` 才进入投票。投票总分最高者胜出；平票按 `role > annotation > type > path > suffix > default service` 的最强信号优先级裁决；仍平票时保留当前短路顺序作为兼容兜底。这样 `@Service` 放在 `/controller/` 目录时不会被单一路径误判。当前 `role` 只是混在 `hint` 字符串里，G3 实现时要拆成独立信号。

**注解采集边界。** 当前 `source-index` 只采集行首注解，且可能得到 FQN（如 `@org.springframework.stereotype.Service`）；G3 映射前必须做 `@` 前缀与 FQN 简名归一化，同行注解（如 `@Service public class Foo`）在现状采集下可能漏掉，不能作为硬依赖。

**改造范围。** `inferProfile`（agent-router）；可能给 `JavaSourceFacts` 增派生字段。注解原料已存在，改动集中。

**影响面。** 单点函数，但下游放大（profile 决定整张图）。

**预期收益。** 中高：注解是比类名更稳的语义信号，profile 错判显著下降，连带提升 recall 命中正确性与 precision。

**风险与代价。** 注解流派多样。缓解：映射表进入内部 policy，未知注解回退类名正则；不要为了少数项目先公开配置 DSL。

**验证。** 对若干 `(annotations, implements, path)` 组合断言 profile 期望值（单测）。

---

## 4. 精度方案（P 类）：决定单项目内的输出质量天花板

四个方案是一个有机整体，分工如下：**P2 提供离线、便宜、冷启动可用、置信中等的类型关系图；P1 提供 LSP 权威、准确、但 warm 敏感的语义验证；P3 把两者整合进召回主干并引入 confidence 降权；P4 给 P1 的 S3 references 轻验证加 warm gate。** 它们共同把召回从“文本撞名”升级为“符号关联”。

### 4.1 P1 语义验证重排：用 references / typeHierarchy 给候选盖章（P0）

**问题。** 召回主力是 rg 命名正则，没有任何语义闸门把“撞名文件”从“真实符号关联文件”里筛出来；`impact()` 甚至从不调用已封装的 `references`（§1.5）。这是 `precision=0.41` 的结构性根因。

**修订判断。** `jdtls-session` 已经有 `references`、`callHierarchy`、`typeHierarchy` 封装，P1 的工作不是新增底层语义能力，而是让 `java_impact` 在合适的 policy 下消费这些现有原语。

**方案。** 按 C3 阶段结构实施：保留当前 rg 之前的 `semanticLocations(definition + implementation)` 作为 S1 `semantic-seed` 候选生成阶段；新增的是 rg/source-index 召回之后、排序之前的 S3 **semantic-verify 阶段**（预算化、policy 化）：

- 对 anchor 符号取 `references`（incoming，谁引用我）→ 命中的候选标 `verified:reference`，给确认加分。
- 对 interface/port/abstract anchor 取已有 `typeHierarchy` 子类型（谁实现我）→ 命中标 `verified:impl`。
- 与现有 `semanticLocations(... includeImplementations)` 的关系：implementation 已能给一层实现者，`typeHierarchy` 的价值是更明确的层级方向、depth 控制和多层 subtype；第一版应去重合并，避免同一实现类重复加分。
- 对 method-level 影响面，在 `required` 或 diagnostic 路径下可小范围使用 `callHierarchy(incoming)`，但不进入默认 `auto` 第一版。
- **未被任何语义确认、且仅靠命名正则命中的候选**：在 `finalizeScore` 引入 confidence 衰减（与 P3 共用机制），下沉或裁掉。
- 触发分级：`fast` 不验证；`auto` 仅在已 warm（§4.4）时做 references 轻验证；`required` 在预算内全量验证。

**数据流。** S1 只产出高置信候选，不负责否定其它候选；S3 在 `auto` 下只更新 references 命中的已有候选或少量新候选，在 `required` 下可补入 typeHierarchy/callHierarchy 候选，并写入 `confidence`、`verifiedBy`、`scoreBreakdown`。去重规则沿用 `mergeCandidate`，但 E2 需要记录跨来源累加，避免同一个 implementation 同时来自 S1 和 S3 时 breakdown 对不上。

**改造范围。** `impact()`（agent-router）新增阶段与 confidence 标注；消费 `JdtlsSession.references/typeHierarchy/callHierarchy` 现有封装；`finalizeScore` 增 confidence 项。

**影响面。** 精度（正向）、延迟（LSP 调用增加，冷启动敏感）。

**预期收益。** 高：precision 直接受益，recall 不降（验证只重排/降权，不删除高置信召回）。这是把 0.41 往上抬最直接的杠杆。

**风险与代价。** 延迟与冷启动放大。缓解：严格 policy + warm gating + 单独预算（沿用前序 plan 的 `documentSymbolsWithRetry` 预算思路），冷启动 `auto` 绝不触发。

**验证。** 多项目 precision/recall A/B；断言“撞名但无引用关系”的文件被下沉。lishuedu 等价快照只绑定 `warmState=cold-nolsp`；P1 提升只在 `warm-auto` / `warm-required` 基线上验收。

### 4.2 P2 轻量类型关系图：把已采集的 implements/extends 组成图（P1）

**问题。** `source-index` 已采集 `implementsTypes`/`extendsType`/`typeName`/`packageName`，却没组图（§1.6）；“谁实现这个 port”只能退回 rg 猜。

**方案。** 在 `SourceIndex` 之上建一层**反向类型图**（随 facts 增量维护、JSONL 持久化）：

- 正向：`typeName → file`、`packageName.typeName → file`。
- 反向：`extendsType/implementsTypes → implementers[]`、`supertype → subtypes[]`。
- `impact()` 对 port/interface/repository/service anchor **先查图**得到实现者/子类作为高置信候选，减少对 rg 命名猜测的依赖；查不到再 rg 兜底。
- 每条边标置信度：regex 来源=heuristic（泛型/多接口/import 别名/跨包同名都可能错），documentSymbol/LSP 来源=high。

**改造范围。** `source-index` 增 `typeGraph`（构建 + 持久化 + 增量更新）；`agent-router` 在相关 profile 消费图。

**影响面。** port/repository/service 找实现的准确率与速度，且**冷启动（LSP 未就绪）时也可用**——这是它相对 P1 的独特价值。

**预期收益。** 中高：不需 LSP 就比 rg 准；与 P1 形成“便宜图 + 权威验证”的两级。

**风险与代价。** regex 解析 implements/extends 不可靠。缓解：图只产出**候选 + 置信度**，绝不做权威裁决；权威归 P1 的 LSP typeHierarchy；低置信边在排序中权重受限。

**验证。** 对已知 `port → impl`、`abstract → subclass` 关系断言图正确；标注置信度正确。

### 4.3 P3 召回引擎：符号锚定优先、命名正则降级为兜底（P1）

**问题。** `buildRgPlan()` 体系（`agent-router/index.ts:276-320` + `*Terms`）整体是“类名前缀正则广撒网”，同前缀不相关类大量进入候选——recall 高但 precision 被稀释。

**方案。** 召回改为**双路 + 置信度合并**：

- 路 A（符号锚定，高置信）：P2 类型图 + P1 LSP 关联得到的符号级关联文件。
- 路 B（命名网，兜底）：现有 rg 正则，保持 recall 安全垫；对“仅命名命中、无任何符号关联”的候选标 `lower-confidence`。
- `mergeCandidate`/`finalizeScore` 使用 C1 契约：来源合并时取最高 confidence、合并 `verifiedBy`，最终只在 `finalizeScore` 通过 `policy.confidenceDeltas` 加性调分；低置信候选不会成为一级排序键，但会在 `candidateLimit` 截断前自然下沉。

**改造范围。** `executeRgPlan`/`buildRgPlan`、`mergeCandidate`、`finalizeScore`、`candidateLimit` 截断逻辑。

**影响面。** 候选集构成与最终排序——牵动既有基线，面较大。

**预期收益。** 中高：直接削同前缀噪声，是 precision 的主干改造。

**风险与代价。** 大，回归风险高。缓解：原则 4 等价迁移 + 黄金快照；confidence 降权幅度由 `RoutingPolicy.confidenceDeltas` 内部控制，`lishuedu-legacy` 等价阶段保持 0，不暴露外部配置。

**说明。** P3 实质是把 P1（权威）+ P2（启发）落到召回主干的整合层，建议在 P1/P2 之后实施。

### 4.4 P4 auto 的 S3 references warm gate（P1）

**问题。** `shouldUseSemantic()`（`:239-247`）门控的是 S1 `semanticLocations(definition + implementation)`，不是 references；P1 新增的 references 轻验证属于 S3。若把 P4 写成“改 `shouldUseSemantic` 启用 references”，实现者会把 S3 调用错塞进 S1。

**方案。** P4 只负责 S3 references 轻验证的 warm gate，不改变 S1 的语义：

- 会话已 started 且 import idle（可由 `session.cacheStatus()` / progress 状态判定）→ `balanced/minimal + auto` 启用 S3 references 轻验证。
- 冷启动 / import 未就绪 → 维持当前克制策略，绝不在 `auto` 下触发昂贵等待。
- `shouldUseSemantic()` 继续只表达 S1 def/impl 候选生成；新增或拆出 `shouldUseSemanticVerify()` 表达 S3 references gate。

**改造范围。** `impact()` 的 S3 gating helper（如 `shouldUseSemanticVerify`）与 session warm 状态消费；不把 references 调用放进 `shouldUseSemantic`。

**影响面。** 默认 `auto` 路径的精度——受益面最广（agent 默认用 auto）。

**预期收益。** 中：balanced+auto 是默认路径，warm 后用 references 提升排序精度；precision/recall mode 作为现成全量语义入口保留。

**风险与代价。** 低；唯一红线是**绝不拖慢冷启动 auto**——靠 warm gating 保证。

**验证。** warm / cold 两态下断言 `auto` 的 `semantic.used` 行为符合预期。

---

## 5. 工程化方案（E 类）：决定它能不能被持续优化和安全发布

先标一个**不该动的优势**：`generated-code`（Lombok/APT）处理是通用版相对专用版的真实质量差距（报告 §7：同一 Lombok controller，通用版 diagnostics `0`、专用版 `3` 个 false-positive blank final field）。本轮所有改造都不得破坏它，且应补一条回归测试把它钉死。

### 5.1 E1 构建漂移防护：version stamp + status 暴露 + 启动校验（P0）

**问题。** 报告 P1 实测：用户级 runtime 仍是旧默认值（`idleTtlMs=1800000`、`importConcurrency=1`），本地构建已是 `2700000`/`2`。`install-runtime.sh` 用 rsync+`npm ci`+build，但**无版本校验**，`java_status` 也不暴露构建指纹——导致“以为在用新版，其实 Codex 注册的是旧 runtime”，且无法自检。这会让本文/前序 plan 的任何改造在“看似生效实则没装”的情况下被误判。

**方案。** build 时写 `dist/build-stamp.json`（git sha、build time、关键默认值指纹）；`java_status` 回显 `runtimeBuild` + 生效中的关键默认值；可选：启动时比对源构建指纹，不一致打 warning。

**改造范围。** `install-runtime.sh` / build 脚本（写 stamp）；`tools/status.ts`（读并回显）。小。

**预期收益。** 中高：发布可验证，杜绝漂移类“假性能”误判。

**风险。** 低。**验证。** 改默认值后，`java_status` 能显示新旧指纹差异。

### 5.2 E2 评分可解释：候选返回 score breakdown（P1）

**问题。** `scoreBase`/`finalizeScore` 全是魔数（`+180/+120/+90/+35...`），候选只暴露最终 `score`。调优靠猜，agent 也无法理解排序理由。routing policy 分层之后，不可解释会让调参更难。

**方案。** 累积 `scoreBreakdown`（每个加分项的来源与值），`diagnostic` / `explain` 模式下随候选返回；默认关闭以省 token（与 E3 联动）。

**记账点。** breakdown 必须覆盖当前 score 写入与合并的全部入口，而不只是 `scoreBase/finalizeScore`：

| 入口 | 当前语义 | E2 记账要求 |
|---|---|---|
| `candidateFromAnchor` | anchor 自身 `+1000` | `source=anchor`，`id=anchor.target` |
| `locationCandidate` | S1 semantic definition/implementation 的 `scoreBase +80/+120` | 拆成 `scoreBase.*` 与 `semantic-seed.definition/implementation` |
| `parseRgOutput` | rg 候选的 `scoreBase(section.category)` | `source=rg` + 命中的 `scoreRules`；若保留现有 `scoreBase` 内部 clamp，追加 `scoreBase.clamp` |
| `mergeCandidate` | 同文件跨来源分数累加 | 追加 incoming breakdown，记录 `source=merge` 的来源合并摘要 |
| `finalizeScore` | matchCount、focus、taskKeyword、test defer、crossModule、confidence | 每个 finalize delta 独立 item，confidence delta 走 C1 |

第一版允许只在内部对象保留 breakdown，`verbosity=diagnostic` 时输出；但验收必须断言 `sum(scoreBreakdown.delta) == finalScore`，否则说明有漏记账点。

**改造范围。** `candidateFromAnchor`/`locationCandidate`/`parseRgOutput`/`mergeCandidate`/`scoreBase`/`finalizeScore`（累积）、`formatCandidate`（可选输出）。

**预期收益。** 中：调优闭环 + agent 可解释。**风险。** 低（token，靠开关）。**验证。** breakdown 之和 == final score；`lishuedu-legacy` 每条旧规则都能通过 rule id 定位。

### 5.3 E3 token 分级 verbosity（P1）

**问题。** payload 比专用版高 1.5–3.4%（报告 §0/§9），增量来自 `metrics.sourceFacts`、`rgSummary.sections`（每段 top6 文件）、`evidenceGaps`（固定长文案）。CLAUDE 工作流明确在意低 token 输出。

**方案。** 增 `verbosity: compact | standard | diagnostic`：

- `compact`：砍 `rgSummary.sections[].files`、`metrics` 明细、合并去重 `evidenceGaps`，只留 files/readPlan/counts 核心。
- `standard`（默认）：当前行为。
- `diagnostic`：含 E2 的 score breakdown、全 metrics。

**改造范围。** `impact()` payload 组装、`withPhaseMs`（`tools/impact.ts`）。

**预期收益。** 中：compact 下 payload 估降 10–25%。**风险。** 低（勿砍 agent 依赖字段）。**验证。** 三档 byte 对比 + 核心字段保留断言。

### 5.4 E4 root 来源可观测（P2）

**问题。** 报告 P0 是专用版 root 漂移（`repoRoot=.../Application Support`）。通用版靠显式 `repoRoot`/`projectId` + `findRepoRoot` 向上探 build 文件，已显著更稳，但 `rootSource`（root 从哪来）不显式，agent 难以一眼判断是否漂移。

**方案。** `repo-resolver` 记录并回显 `rootSource: explicit | projectId | cwd | inferred`；`java_status` 回显之，并校验 root 下确有 build 文件，否则 warning。

**改造范围。** `repo-resolver`、`tools/status.ts`。小。

**预期收益。** 中：把 root 漂移从“事后事故”变“事前可见”。**风险。** 低。**验证。** 不同入参下 `rootSource` 正确、无 build 文件时告警。

---

## 6. 展望（X 类）：战略储备，不在本轮实施

### 6.1 X1 反馈驱动的轻量权重学习（P3）

把“agent 实际采纳了 readPlan 的哪些项 / 实际读了哪些文件”作为反馈信号，回调 `RoutingPolicy.weights`。收益中长期可观，但需要一条目前不存在的反馈回流通道，且有过拟合 / 信号噪声风险。**先记录，不实施；没有多项目 golden set 前不讨论学习。**

### 6.2 X2 多语言 / 多 LS 抽象（P3）

当前 router 与 JDT LS、与 Java/DDD 语义强绑定。若未来要支持 Kotlin 或其它语言，需要抽象 `LanguageBackend`（符号/引用/层级的统一接口）与语言无关 routing policy。改造很大，属战略方向。**本轮不为 X2 预留抽象层**；等 Java router 的证据引擎 / policy 边界被多项目数据证明后再说。

---

## 7. 与前序性能 plan 的关系：分工与协同

| 维度 | 前序《性能极致优化 plan》 | 本文《架构级效果提升》 |
|---|---|---|
| 目标 | 快（冷启动 / 稳态延迟） | 准 + 真通用 + 可运维 |
| 抓手 | L0 warm 复用、L1 首响应去阻塞、L2 import+JVM、L3 稳态、L4 资源 | G 通用化、P 精度、E 工程化 |
| 交点 | warm 状态的可得性 | P1/P4 的语义验证依赖 warm |

两份计划**不是并列而是耦合**：本文 P1（语义验证）/P4（auto 语义）的成本，几乎完全取决于会话是否已 warm——而“让 warm 廉价且常驻”正是性能 plan L0/L1 的产出。**先有性能 plan 的 warm 复用，本文的精度增强才便宜得起。** 因此实施次序上，性能 plan 的 L0/L1 应与本文 Batch 2 协同推进。

两点边界澄清，避免重复或冲突：

- **rg 并发**：本文 §1.7 已据真源修正前序“rg 串行”的判断（实为 `spawn`+`mapConcurrent` 异步并发）。该项从性能优化点移除。
- **source-index 同步 IO**（`appendFileSync`/`writeFileSync`）：归前序 plan 的稳态 IO 项，本文不重复展开；但 P2 的类型图持久化会复用同一套 JSONL 落盘，二者应一起异步化。

---

## 8. 开发改造计划（可开工版）

目标按“面向任意 Java 项目的真通用 LSP”推进。路线图不再把 G2 当条件项：`generic-java` 盲区 fixture、Maven reactor、单模块 Maven/Spring 三层、Gradle 多模块都必须进入验收面。每批都包含改造点、主要文件、验收和建议测试；不达标不进入下一批行为改造。

### Batch 0 — 度量与运行时可信度（P0）

**目标。** 先让效果可证伪、运行时可确认，避免在旧 runtime 或单项目样本上调权重。

**开发任务。**

| 任务 | 文件 / 交付物 | 开发要点 | 验收 |
|---|---|---|---|
| M0 多项目 golden set | `src/benchmark-agent-impact.ts`、`golden/*.scenarios.jsonl` | 外部化 scenario；支持 `projectId` 列表；记录 `repoCommit/layoutProfile/warmState/runtimeBuild`；输出候选集与 readPlan 两层指标 | `lishuedu/cipherlink/exam-parent-v3/generic-java` 都能运行；P/R@K、`R_read_must`、payload、P50/P95 可重复输出 |
| M0 warm/cold harness | benchmark runner | 支持 `cold-nolsp/cold-lsp/warm-auto/warm-required`；`warm-*` 复用 `waitForProgressIdle()` 判定 | 同一 scenario 能按 warmState 分列；`cold-nolsp` 不启动 JDT LS |
| E1 build stamp | build/install 脚本、`src/tools/status.ts` | 生成并回显 git sha、build time、关键默认值指纹 | 改默认值后 `java_status` 能显示新指纹；安装漂移可见 |
| E4 rootSource | `src/repo-resolver.ts`、`src/tools/status.ts` | 记录 `explicit/projectId/cwd/inferred`，校验 build 文件 | root 来源与 build 文件 warning 可在 status 中看到 |

**建议测试。**

- `benchmark-agent-impact` dry run：至少每个项目 1 个 scenario，验证 metadata 与指标完整。
- `java_status` 手动/自动 smoke：确认 runtime build stamp、rootSource、layoutProfile 回显。

**退出门槛。** 没有 `generic-java` fixture 前，不宣称“任意 Java 项目”达标；没有 warm/cold harness 前，不进入 P1/P4。

### Batch 1 — 开发契约与等价分层（P0）

**目标。** 先冻结 C1/C2/C3，并完成 A1/G1 的等价迁移。此批只允许内部结构变化，禁止宣称质量提升。

**开发任务。**

| 任务 | 文件 / 交付物 | 开发要点 | 验收 |
|---|---|---|---|
| C1 confidence contract | `src/agent-types.ts`、`src/agent-router/index.ts` | 内部扩展 `confidence/verifiedBy/scoreBreakdown`；`lishuedu-legacy.confidenceDeltas=0` | `cold-nolsp` 下 lishuedu 快照不因字段变化而排序变化 |
| C2 RoutingPolicy rules | `src/routing-policy.ts`（新增）、`src/agent-router/index.ts` | `scoreRules` 一对一迁移 `scoreBase()`；`termProviders` 承接 `dtoUpstream/testTerms` | 每条旧 if 有 rule id；legacy policy 输出与旧版一致 |
| C3 stage boundary | `src/agent-router/index.ts` | 明确 S1 semantic-seed、S3 semantic-verify 的开关与数据流；本批不启用 S3 | `cold-nolsp` 快照稳定；`semanticPolicy=fast` 不触发 LSP |
| A1 internal split | `src/agent-router/index.ts`、可选 `src/routing-policy.ts` | 证据生成与 policy 消费拆函数/类型；不改 public MCP tools | 7 个 public tools 不变；`java_impact` schema 不破坏 |
| G1 lishuedu legacy 等价 | `src/routing-policy.ts` | 现有魔数、专有正则、测试项、惩罚项原样迁移 | lishuedu 5 场景 `cold-nolsp` top5/readPlan 快照零差异 |

**建议测试。**

- `lishuedu` legacy golden：`warmState=cold-nolsp`，top5/readFiles/top-K 顺序按 §9.5 判定。
- 单元测试：`scoreRules` 覆盖 parser `+38/-70/+90`、dto test `+90`、sameFile/sameModule/focus/taskKeyword/common penalty。

**退出门槛。** `scoreBreakdown` 可以先不输出，但内部记账点必须能覆盖 anchor/semantic/rg/merge/finalize；否则 Batch 3 的 E2 会返工。

### Batch 2 — 真通用布局与 profile 基础（P0/P1）

**目标。** 让非 `modules/apps` 项目不再退化为全仓扫描，让 profile 判断不再主要依赖 lishuedu 类名。

**开发任务。**

| 任务 | 文件 / 交付物 | 开发要点 | 验收 |
|---|---|---|---|
| G2 layout probe | `src/layout-probe.ts`（新增）、`src/file-watcher.ts` | 复用 watcher 的 source root 探测；解析 Gradle include 与 Maven modules；支持 single module | Maven 单模块、Maven reactor、Gradle 多模块 sourceRoots 正确 |
| G2 helper 注入 | `src/repo-layout.ts`、`src/agent-router/index.ts` | `AgentRouter` 持有 `LayoutContext`；传入 `classifyPath/rootsFor/persistenceRoots/buildRgPlan/dtoUpstream` | 非 `modules/apps` 项目检索根不退化为 `["."]`，config/dto 上游证据不静默丢失；失败时 fallback 当前行为 |
| G1 generic policy | `src/routing-policy.ts` | 在 legacy 外新增 `generic-java/maven-reactor/ddd-gradle` 中性规则 | `cipherlink/exam/generic-java` baseline 不低于 Batch 1，且规则不含 lishuedu 业务词 |
| G3 profile voting | `src/agent-router/index.ts`、`src/routing-policy.ts` | 按 §3.3 权重表实现多信号投票；注解/类型优先于路径/后缀 | `@Service` + controller 路径等冲突 case 按权重胜出 |

**建议测试。**

- `layout-probe` fixture：单模块 Maven、Maven reactor、Gradle `settings.gradle`、`modules/apps`、无 build 文件 fallback。
- `inferProfile` 表驱动测试：annotation/type/path/suffix/role 冲突组合。
- Benchmark：`exam-parent-v3` 断言 module/sourceRoot/检索根正确；`generic-java` 断言不全仓扫描。

**退出门槛。** `generic-java` fixture 未通过前，不能进入“任意 Java 项目已可用”的结论；只能说布局探测在已覆盖样本上有效。

### Batch 3 — 语义精度核心（P0/P1）

**目标。** 把召回从“文本撞名”升级为“符号关联”，但冷启动默认路径不能变慢。

**开发任务。**

| 任务 | 文件 / 交付物 | 开发要点 | 验收 |
|---|---|---|---|
| P1 semantic-verify | `src/agent-router/index.ts` | S3 消费 `references/typeHierarchy`，必要时 `callHierarchy`；写 `confidence/verifiedBy` | warm 基线 precision 上升，`R_read_must=1.0` |
| P4 warm auto | `src/agent-router/index.ts`、`src/jdtls-session.ts` 状态消费 | `auto` 只在 import idle 后启用 S3 references gate；cold auto 不等待 | `cold-nolsp/cold-lsp` 延迟不回退；`warm-auto` semantic.used 符合预期 |
| P2 type graph | `src/source-index.ts`、`src/agent-router/index.ts` | 用 `implementsTypes/extendsType` 建反向图；低置信候选，不做权威裁决 | port/interface → impl fixture 命中；regex 来源标 `medium/low` |

**建议测试。**

- warm/cold A/B benchmark：同一 scenario 比较 `fast/auto/required`。
- 语义下沉测试：构造同名但无引用文件，确认 warm S3 后排名下降。
- 类型图测试：同名 interface、跨包同名、泛型 repository、mapper implements。

**退出门槛。** `cold auto` P50/P95 不得显著回退；P1/P4 的收益只在 `warm-auto/warm-required` 宣称。

### Batch 4 — 召回整合与可解释输出（P1）

**目标。** 把 P1/P2 的语义与类型信号整合进召回主干，并让调权可解释、payload 可控。

**开发任务。**

| 任务 | 文件 / 交付物 | 开发要点 | 验收 |
|---|---|---|---|
| P3 symbol-first recall | `src/agent-router/index.ts` | 路 A 符号锚定，路 B 命名兜底；低置信命中在 finalize 下沉 | 多项目 precision 不降，目标项目提升 |
| E2 score breakdown | `src/agent-router/index.ts`、`src/tools/impact.ts` | 覆盖 5 个记账点；`diagnostic` 输出 rule id 与 delta | `sum(delta)==final score`；可定位每个候选为什么排前 |
| E3 verbosity | `src/tools/impact.ts` | `compact/standard/diagnostic` 三档；diagnostic 包含 E2 | compact payload 下降 ≥10%，核心 files/readPlan/counts 保留 |

**建议测试。**

- Snapshot：`standard` 默认输出兼容；`diagnostic` 新增字段不影响排序。
- Payload byte test：三档输出大小与核心字段存在性。
- 多项目 regression：`lishuedu cold-nolsp` 等价、异构项目不降。

### 储备

**X1 反馈学习**、**X2 多语言抽象**、**公开 per-repo `rules.json`** 不排期。只有当 Batch 0–4 的多项目数据证明内置 policy 仍无法覆盖真实差异时，再设计外部 override；否则保持内部 policy，避免配置面膨胀。

---

## 9. 验证方法（M0 测试标准）

**本文所有“预期收益”均为基于真源的架构推断，未经本机实测。** 落地的第一步不是写 G/P 代码，而是建立能证伪这些推断的度量设施。M0 的交付物不是一段 benchmark 脚本，而是一套可复现、可比较、可判定的测试标准。

### 9.1 项目矩阵

当前真实 `projects.json` 配置是：

| 项目 | layoutProfile | 角色 | 主要检验 |
|---|---|---|---|
| `lishuedu` | `ddd-gradle` | 基线 / 黄金快照锚点 | 等价迁移不回归 |
| `cipherlink` | `ddd-gradle` | 同布局、异业务词汇对照组 | 验证 §1.2：布局不变、业务词汇变化后，lishuedu 专有 scoring 是否失效 |
| `exam-parent-v3` | `maven-reactor` | 异布局对照组 | 验证 G2：Maven reactor module/sourceRoot/检索根是否正确 |
| 必补 fixture | `generic-java` | 覆盖盲区 / 真通用硬门槛 | 验证单体/标准三层是否退化为全仓 `["."]` |

分析骨架：

- 词汇轴：`lishuedu` vs `cipherlink`，布局恒定，用来测专有规则依赖度：`P_cand(lishuedu) - P_cand(cipherlink)`。
- 布局轴：`ddd-gradle` vs `maven-reactor`，用来测 `classifyPath` / `rootsFor` / `persistenceRoots` 的泛化。
- `generic-java` 补齐前，G2 对单体/三层布局的收益必须标注为“未验证”，不得作为 Batch 2 达标结论。

### 9.2 Golden 标注规范

每个 scenario 的 golden 不再是单一扁平文件集，而是分层集合：

| 层级 | 含义 | 是否硬指标 |
|---|---|---|
| `T0` | anchor 自身文件 | must-hit |
| `T1` | 直接语义邻居：incoming references、直接实现/子类/父类型、anchor 直接依赖的 DTO/command/result/contract | must-hit |
| `T2` | 一跳传递协作者：controller→assembler→dto、service→repository impl 等 | should-hit |
| `side` | SQL/migration/mapper XML、测试 | 场景显式声明是否纳入 |

标注规则：

- `golden = { mustHit: T0 + T1, shouldHit: T2, side: explicit }`。
- 每项目每个核心 profile 至少 2 个 anchor；lishuedu 可复用现有 5 场景并补分层。
- 项目不存在的 profile 不强行补标，跳过并在 golden 文件头记录 `skippedProfiles` 与原因（例如 `parser` 不存在、无 mapper XML、非 Web 项目无 controller）。
- golden 文件头记录 `repoCommit`、`projectId`、`layoutProfile`、`scenarioVersion`、`warmState`、`skippedProfiles`；repo 演进后必须重标或确认。
- `mustHit` 建议双人标注后取交集 / 复核，避免 golden 自身噪声污染 pass/fail。

### 9.3 指标公式

候选集层，`cand = result.files`：

```text
P_cand@K = |cand[:K] ∩ golden_all| / K, K ∈ {5,10,all}
R_cand   = |cand ∩ golden_all| / |golden_all|
```

ReadPlan 层，`readFiles = distinct files in result.readPlan`：

```text
P_read       = |readFiles ∩ golden_all| / |readFiles|
R_read_must  = |readFiles ∩ mustHit| / |mustHit|
```

延迟与 payload：

- 每个 `(project × scenario × mode × semanticPolicy × warmState)` 重复 `N >= 5`，输出 P50/P95。
- 复用 `result.metrics.phaseMs`，冷 / warm 分列。
- payload 继续输出 `rawSearchPayload + readingPayload + estimatedTokens`。

关键区分：`P_cand` 衡量候选噪声，是 P 类主要要治的；`P_read` 衡量 agent 实际阅读质量。不得用候选集 precision 代替 readPlan 质量。

### 9.4 Cold / Warm 状态协议

| warmState | 协议 | 用途 |
|---|---|---|
| `cold-nolsp` | 不启动 JDT LS，`semanticPolicy=fast` | 纯 SourceIndex + rg baseline |
| `cold-lsp` | start 后立即测，不等 progress idle | import 争用下的最坏延迟 |
| `warm-auto` | start → 等 progress idle → `semanticPolicy=auto` | 验证 P4 默认路径收益 |
| `warm-required` | start → `documentSymbolsWithRetry(anchor)` 预热 → `semanticPolicy=required` | 验证 P1 权威语义路径 |

就绪判定镜像 `waitForProgressIdle()`：

```text
status().progress.active == 0
idleFor >= JAVA_LSP_PROGRESS_IDLE_MS
waited >= JAVA_LSP_MIN_SEMANTIC_WAIT_MS
```

每次 run 必须记录 metadata：`repoCommit`、`projectId`、`layoutProfile`、`warmState`、runtime build stamp、resource defaults 指纹（`idleTtlMs/importConcurrency/jdtlsXmx`）和关键 env。

### 9.5 Pass / Fail 判据

**baseline 定义。**

- `baseline` 默认指“本批行为改造前、同一 runtime build、同一 project/scenario/mode/semanticPolicy/warmState 下的当前输出”。
- A1/G1 等价迁移的 baseline 固定为 `lishuedu-legacy@cold-nolsp`，用于证明内部重构不改变行为。
- G2/G3/P1/P2/P3 的质量提升 baseline 固定为“上一批通过验收的输出”，不能混用旧专用版、legacy policy 和中性 policy 的结果。
- benchmark 报告必须在每个 scenario header 写清 `baselineBuild`、`candidateBuild`、`policyId`、`warmState`。

等价迁移锚定，适用于 lishuedu 的 A1/G1/P3，且默认只绑定 `warmState=cold-nolsp`；P3 等价快照还要求 `graphMode=off`，即 P2 类型图不注入新候选：

- `top5` 集合 Jaccard = `1.0`。
- `readFiles` 集合完全相同。
- `top-K` 顺序稳定；如需放宽，必须在报告中列出差异和原因。
- P1/P4 在 `warm-auto/warm-required` 下引入的语义调分不要求与 `cold-nolsp` 快照零差异；它们按跨项目质量门槛验收。

跨项目质量门槛：

- `must-hit` recall 硬性要求：`R_read_must = 1.0`，破即 fail。
- `should-hit` recall 作为质量分，不设硬门槛。
- `cipherlink`：`P_cand >= baseline - 0.01`，理想上升；用专有规则依赖度量化 §1.2。
- `exam-parent-v3`：module/sourceRoot/检索根正确，不退化为全仓 `["."]`；`R_cand >= baseline - 0.02`，G2 后 `P_cand` 应上升。
- latency 比 P50，允许 `±10%` 噪声；超过需看 `phaseMs` 定位。

### 9.6 Benchmark 改造清单

基于当前 `benchmark-agent-impact.ts`，M0 最小改造：

| 现状 | 改为 |
|---|---|
| `scenarios` 源码内联 | 外部 `golden/<projectId>.scenarios.jsonl`，按 `projectId` 加载 |
| 单 `repoRoot` env | project 列表，读 `projects.json` 或 CLI 指定 |
| 固定 `mode=balanced`、`semanticPolicy=auto` | 参数化 `(mode × semanticPolicy × warmState)` |
| 从不 start | 增 warm harness：start + progress idle / `documentSymbolsWithRetry` |
| `evaluate()` 只算候选集 | 增 readPlan 层、must/should 分层、@K |
| 单次运行 | `N >= 5`，输出 P50/P95 |
| 输出缺 metadata | 加 run metadata，与 E1 build stamp 共用指纹；记录 `baselineBuild/candidateBuild/policyId/warmState/skippedProfiles` |

度量结论须区分“已运行通过 / 未运行但建议 / 无法运行及原因”，不得把推断写成实测。

---

## 10. 风险与已定决策

### 10.1 风险表

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| 评分重构回归 | G1/P3 动评分核心 | 原则 4 等价迁移 + lishuedu 黄金快照锁定 |
| 语义验证拖慢冷启动 | P1 在 import 未就绪时误触发 | warm gating + 独立预算 + policy 分级，冷启动 auto 绝不触发 |
| 类型图误导排序 | P2 regex 解析 implements/extends 出错 | 只产候选 + 置信度，低置信限权；权威裁决归 LSP typeHierarchy |
| 布局探测错误 | G2 遇非常规布局 | 探测失败回退当前全仓行为（不劣于现状）+ `java_status` 回显 |
| 改了没装上 | installed runtime 漂移（报告 P1 已发生） | E1 build stamp + status 自检 |
| 盲改（无法验证收益） | 缺多项目 golden set | Batch 0：先建度量设施，再动 G/P |
| 配置面膨胀 | 过早公开 `rules.json` / DSL | 先用内部 policy + `layoutProfile`，等第二个真实项目证明需要再开放 |

### 10.2 已定决策

1. **战略定位已定：面向任意 Java 项目的真通用 LSP。** 因此 G2 是 P0，`generic-java` fixture 是硬门槛，不能只用 lishuedu 同构项目证明通用性。推进方式仍是「先证伪、再分层、最后外置」：E1/M0/A1/C1-C3 是稳定前置项；公开 `rules.json` 不是本轮前置项。
2. **P1 语义验证的默认启用面已定。** `auto` 仅在已 warm 时启用，且只做 references 轻验证；`cold auto` 不等待 import、不触发昂贵语义路径。
3. **token 默认档已定。** 默认 `standard`；向 agent 暴露 `compact` 显式档；`diagnostic` 保留给 breakdown / 调试场景。
4. **per-repo `rules.json` 已定。** 本轮不暴露；待第二个真实项目证明内置 policy 不足，再开放外部 override。

---

## 附录 A. 改造文件热力图（blast radius 速查）

| 文件 | 涉及方案 | 热度 |
|---|---|---|
| `src/agent-router/index.ts` | G1, G3, P1, P3, P4, E2 | 🔥 最热（评分/召回/语义核心） |
| `src/agent-types.ts` | C1（confidence / verifiedBy / scoreBreakdown 内部字段） | 中 |
| `src/source-index.ts` | P2（类型图）、IO 异步化（并入性能 plan） | 中高 |
| `src/repo-layout.ts` | G2（classifyPath / 布局） | 中 |
| `src/jdtls-session.ts` | P1（消费现有 references/typeHierarchy/callHierarchy；通常无需新增封装） | 低中 |
| `src/routing-policy.ts`（新增） | A1/G1（RoutingPolicy 类型 + 内置 policy 选择） | 中 |
| `src/layout-probe.ts`（新增） | G2（布局探测） | 中 |
| `src/file-watcher.ts` | G2（改为消费共享 layout-probe，避免重复探测逻辑） | 低 |
| `src/tools/impact.ts` | E3（verbosity） | 低中 |
| `src/tools/status.ts` | E1（build stamp）、E4（rootSource） | 低 |
| `src/repo-resolver.ts` | E4（rootSource 记录） | 低 |
| `install-runtime.sh` | E1（写 build stamp） | 低 |
| `src/benchmark-agent-impact.ts` | M0/§9（多项目 + golden set 度量） | 中（前置设施） |
| `golden/*.scenarios.jsonl`（新增） | M0（多项目 scenario + golden 标注） | 中（验收资产） |

---

## 附录 B. 一句话蓝图

> **性能 plan 让冷启动一天一次而非每次都付（快）；本文先把效果变得可证伪，再把证据引擎与 routing policy 分层，最后让召回从“撞名”升级为“符号关联”（准 + 可演进）。不扩工具面，不提前公开规则 DSL，才是这套 Java router 最短的长期路径。**
