# 增量设计：保持 Java 底座，修复可信交付链

本章是拟实施规范，不代表这些接口已经在 b9 中存在。文件改动映射在任务卡；所有新接口须由拥有该任务的实现者定义并单测。

## 1. 数据流边界

```mermaid
flowchart LR
    P[原始产品工具结果] --> N[工具专属解码与规范化]
    N --> S[保持合法JSON的有界序列化]
    S --> M[最终model tool message]
    M --> C[chat请求边界]
    C --> E[带payload hash的交付事件]
    E --> F[原冻结scorer适配]
    C --> A[模型答案或candidate修改]
    A --> F
    F --> R[逐attempt结果和固定分母]
```

schema变小不允许丢失语义。生成式模型没有读到源码时，不能根据内部 reader 事件证明它读过。

### 1.1 最小序列化接口（R01）

新增 `scripts/eval-tool-wire.mjs`：

```ts
// 规格类型；实现文件为 ESM .mjs，使用 JSDoc 或独立 .d.ts 固定契约。
type SourceSlice = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  fileContentHash?: string;
  sliceHash: string;
};
type ModelToolResult = {
  content: string;             // 始终合法 JSON；不得直接截断 JSON 字符串
  slices: SourceSlice[];        // 只含 content 中确实保留的原始源码
  rawHash: string;
  modelPayloadHash: string;
  truncated: boolean;
};
function serializeModelToolResult(
  toolName: string,
  raw: unknown,
  options: { maxBytes: number }
): ModelToolResult;
```

支持 `java_symbol`、`java_impact`、`read`、`list`、`rg`、`write_file`、`test` 与错误；MCP envelope 的 structuredContent/text 不得重复注入，也不能丢除第一个text之外的有效块。未知工具不是自动 impact：返回明确 unsupported，不静默空结构。工具错误保留原错误分类，输出敏感数据按下文策略控制。

预算初值：单次模型工具消息 maxBytes=32768，源码preview默认4096/片段、单query合计16384，普通 read 最大16000源码字节（来自原冻结任务预算）。过长时裁剪**结构中的片段/行**，再重新JSON编码，仍超限则返回显式预算错误。控制元数据和源码分别统计，不能为了节约输出抹掉唯一命中行。不得对未知结构盲目JSON.stringify整个对象后 slice。

接线：`runLiveAgentTask` 内在 `messages.push(role=tool)` 处调用 serializer；在真正调用 chat 的请求边界计算正文 hash、绑定 requestId/callId，再提交 `MODEL_PAYLOAD_ATTACHED/DISPATCHED` 事件。工具调用后但未发下一轮、或被预算截掉的内容只记 FETCHED/PLANNED，不记模型收到。多tool-call响应保持所有tool reply对应正确callId，nudge放完整tool回复之后。

`SOURCE_RECEIVED` 是原评测结果字段名，可以通过adapter从实际dispatch事件映射，不修改其冻结含义。模型服务接受请求仍不证明模型注意到了该内容；真实理解只由答案/测试结果判断。

### 1.2 唯一评分（R02）

新增 `scripts/eval-frozen-adapter.mjs`，输入最终payload-derived slices、严格解析答案和运行元数据，输出原 `java-specialist-results/v1`。在指定冻结kit根目录调用 `python -m harness score --input "$RUNS/results.jsonl" --split all --output "$RUNS/score.json"`；先使用随包 `--help` 校验命令。不再维护第二套 String() 比较器。

严格JSON先用支持 object_pairs_hook 的 Python解析（包括嵌套重复key），或与之等价经测试的parser；不是用正则检测重复key。允许/拒绝markdown fence由原task输出规范决定，本轮按严格JSON拒绝；也可在transport归一化层另报format failure，但不得暗改gold类型。使用有限输入长度，NaN/Infinity/extra key一律拒绝。

```ts
type AttemptKey = { taskId: string; variant: string; arm: string; repeat: number };
type AttemptState = "COMPLETED" | "FAILED_RUNTIME" | "TIMEOUT" | "MISSING_RESULT" | "BLOCKED_SETUP";
type AttemptOutcome = {
  key: AttemptKey; state: AttemptState;
  taskSuccess: boolean | null;
  usage: null | { inputTokens: number | null; outputTokens: number | null;
                 cachedInputTokens: number | null; reasoningTokens: number | null };
};
```

先冻结完整计划行（task×variant×arm×repeat），每行恰好一个结果。运行失败/超时作为不成功进入 end-to-end success 分母；尚未授权的整轮应标 BLOCKED_AUTH，不生成伪零分benchmark。可另报 conditional accuracy=成功/确实评分数，但不能替代 successRate=成功/计划数。未测usage不是0，provider原始字段/hash要保存。

### 1.3 A/B 与修复工作区（R03/R04）

同一基础prompt：“完成给定Java任务；可使用列出的工具，也可不用；代码证据优先；只输出任务规定的最终格式。”不要求首先调用 MCP。两臂相同 native list/rg/read；repair两臂都有受限write_file/test，工具只针对该attempt candidate。baseline可完全不创建不需要的MCP session，不将索引准备费算入无MCP对照。

每个 repeat 的实际分析 root、read root、write root、test root 必须相同；会话/索引使用独立owner/cache或正确共享只读快照。写入后等待该candidate变更确认或返回PARTIAL，不能继续检索pristine。不复制真实凭据到candidate。原生工具统一做canonical containment、symlink检查、字节/进程/时间限制；prefix字符串 startsWith 不是containment判断。

优先通过薄桥调用原 Python frozen repair judge，避免维护两份代码。candidate allowed-edits删除：本v1任务要求保留这些源码文件，删除应明确 `REJECTED_MISSING_ALLOWED_FILE`；若未来增加删除任务，再版本化数据集行为，不能恢复原文件假装候选。编译器缺失=BLOCKED_ENV，编译成功且业务AssertionError=有效RED；TIMEOUT不是检测到目标缺陷的证明。子进程有总输出上限128KiB、timeout与进程树清理（沿用原process执行器），不可把 `--release` 称为 JDK8 javac 支持：runner自身要求JDK9+，本套件基线JDK17+。

## 2. 声明身份与范围（R05/R06）

继续采用路径化ID，不回退v1字符串。修改 `TypeRegistryView.byFqn` 为 `ReadonlyMap<string, readonly string[]>`，SQL 对应返回集合。重复FQN先用 compilation context（module/source-root/build可见性）缩小；缺上下文返回 AMBIGUOUS。sourceSet test 可以看到本模块main，main不反向看到test；不同模块依赖按已解析布局，布局缺失不能推断所有仓相互可见。

不把跨模块两个同FQN文件当作同一编译单元合法并列；fixture模拟两个独立编译范围。JDT_BOUND只由对应classpath下JDT确证，静态候选即使唯一也不得随意升级运行时唯一目标。

新增 `src/discovery/scope.ts`：

```ts
type SourceRootRecord = {
  id: string; relativePath: string; module: string;
  sourceSet: "main" | "test"; kind: "java" | "resource";
};
type ResolvedSearchScope =
 | { state: "RESOLVED"; sourceRootIds: string[] }
 | { state: "EMPTY"; reason: "UNKNOWN_MODULE" | "NO_SOURCE_ROOT" }
 | { state: "PARTIAL"; reason: "LAYOUT_UNKNOWN" };
function resolveSearchScope(
  roots: readonly SourceRootRecord[],
  request: {module?: string; sourceSet?: "main" | "test"}
): ResolvedSearchScope;
```

roots来自现有layout/index元数据，不由agent任意创建。module/sourceSet条件是AND；prefix拼接只可在一个规范root内用于路径过滤。不认识module应EMPTY明确原因或参数错误，不放大到全仓。scope过滤下推SQL，在postings预算、排序、cap之前； exact范围内唯一性也在同一scope判。

## 3. query、limit 与物理预算（R07/R09）

`query` 保留原句；`terms` 最多6个，每个最多64 UTF16 code units，为附加搜索词，不替换原句。原句最多512 code units。exact只有用户明确选exact或**整个**输入满足精确selector规则才走精确查找；exact miss不回退BM25，返回 miss/ambiguous/unsupported，调用Agent自己决定改用text。

limit统一默认8、最大20；topK不等于穷尽。通过cap+1检测selectionLimited，work budget中断用 `truncated=true/stopReason`，不要把“仍可能有更多”写成complete。所有查询阶段统一接受现有绝对deadline。入口已经过期时不开始SQL；运行中不能仅因 async 声明以为可抢占 DatabaseSync。

在现有统计表与 postings 上先修scope/入口deadline/阶段检查；记录exact rows、postings、排序候选、previewBytes/IO及event-loop延迟。若宽查询实测超门槛，再引入**一个共享有界只读 query worker**，不为每仓恢复全图堆。所有SQL和映射过程都计入预算；队列初值32、查询并发1、到期等待者撤出、worker强制结束要关闭连接且不影响writer。此worker不是本轮默认必做项，profile证据决定。

## 4. 来源与新鲜度（R08）

扩展 SearchDocument：目标声明身份与证据来源分离。

```ts
type SearchEvidence = {
  declarationId: string;
  source: { relativePath: string; contentHash: string; startLine: number; endLine: number };
  sourceKind: "signature" | "comment" | "framework-key";
  representationVersion: 2;
  normalizedText: string;
};
```

XMLnamespace/statement的source为XML路径/hash/range，target仍是Java mapper method。XML更新即使Java文件未变也替换相关search-doc；ID包含source path/hash、target与representationVersion。动态SQL关联不等于真实执行结果。

queryHits与coverage/generation从同一只读snapshot取得，不能query与status分别看到两个generation后拼成READY。preview校验文件hash不一致时不保留可执行旧locator：返回该候选stale/drop计数并使结果PARTIAL，或按ID在新snapshot重定位。负查询只在同scope/materialization状态下成立；排名未命中不是引用不存在。

preview读取每个唯一文件一次，异步读取并限制2MiB/文件、8MiB/请求、4096字节/片段、16384字节/请求preview总量；超限只给安全locator及原因，不切断UTF8字符。上述是本轮新增安全初值，需性能profile验证，不作为已实测最优值。每个preview必须对应真实source range；跨行截断需实际重算范围。原始源码因secret策略被红act后只能标 `redacted-preview`，不能冒充source原文进入received evidence。

默认preview不得回显已识别credential fixture值；不声称有限正则能识别所有现实密钥。远端embedding另有显式授权和allowlist。不要靠删除证据来让线召回看起来更好，无法交付时诚实PARTIAL。

## 5. 可选 dense 只修实验，不默认上线（R10/R11）

cache key采用 canonical JSON 的SHA256：endpointOrigin+路径、provider、model、revision/可用的配置fingerprint、维度/metric、representationVersion、实际embed文本hash、declarationId、source内容fingerprint。key不能包含API key；endpoint相同而revision不可得时必须声明unversioned并使用显式cache epoch，不声称跨时间可复现。

构建聚合文本应从保序的同一 SearchDocument 表示读取，不从无序token集合重建文章。多个source文件的表示hash组成有序manifest。内容相同但模型身份不同不共享向量；cache-hit验证vector维度、有限数值、行数和key；原子临时文件rename、单writer或独立构建目录，避免每entry重读重写整张大JSON。优先小型每key文件/批次表，不引入新服务。

超时覆盖连接、header、body解码、所有重试和退避总时长；所有timer finally清理。缺有效source hash的hint不得带可执行旧行号，重读当前文件并重新定位后才映射为source evidence。错误只降级，不将错误信息拼成向量文本。

最终A2/A3预算固定，候选和source窗口共用同一renderer；dense召回8额外候选不等于最终允许输出16。原生zvec整套系统对比与同表示dense消融分开命名。不再用多个provider轮次混合抵消错误。
