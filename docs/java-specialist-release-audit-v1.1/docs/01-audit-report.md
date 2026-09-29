# b9c3cc3 深度审计与上线判断

## 1. 结论

**不建议将当前快照按“Devkit v1 完整达标”上线。** 静态发现等功能已经存在，原 C1/C2/C3 定向修复有真实进展；但评测数据流、评分规则、向量实验设计和产品边界均有可复现缺陷。原 v1 要求也没有全部完成。

必须区分：实现已提交、局部测试通过、独立任务有效测量、完整上线资格、用户部署授权。仓库报告的 `M3=GO` 主要描述任务路线收口；末尾又把 NOT_RUN 运行态契约视为非阻塞，与原 gates 的“all product-level contract tests measured and passed”不一致。`permittedToDeploy=false` 被作者解释为未授权安装，不能代替质量审查。

本审计不是断言所有线上请求都会失败。这里证明的是具体输入下的错误与已保存实验解释的不成立；这些错误在日常真实任务中的频率尚未量化。

## 2. 基线与比对范围

上传 ZIP 的 comment、GitHub main 均为 `b9c3cc325491947b198342575e9ea251c024b521`，最新提交 2026-09-28。ZIP SHA256 为 `5e7f4996ca86e2c9924df273f1e5b63664bcbf854824ad1bb1418662546ea0f4`。原 devkit ZIP SHA256 为 `350ce2ddcb4544297a75fadec1fa6d64a521c542c569f27b0e58cd4d37482386`。关键源文件内容指纹与 Git blob 放在 `provenance/audited-files.json`；zip comment 是版本声明，不等于所有文件都已独立和 Git tree 全量验签。

比对输入包括原版 246 文件 devkit、原阶段指南、旧 d86 源码与 b9 附件，以及最近提交。原版基准数据/scorer 在本包 `baseline-kit/` 原样保留，不采用 b9 内已经改变的 fixture 来重新定义基线。

当前环境：Linux、Node 22.16.0、TS 5.8.3 `transpileModule`、Python 3.13.5、OpenJDK 21.0.11。项目声明的 TS 版本与本次全局转译版本不相同；本次没有完成类型检查。`npm ci` 遇到 registry DNS EAI_AGAIN，随后 npm 退出异常；归类环境阻塞，不归类产品编译缺陷。没有 macOS、JDT、真实模型或 embedding 端点测试；没有替换生产 daemon。

## 3. 已兑现的成果

原 `probe-source.mjs` 的 12 条期望在当前真实导出函数上全部通过。新 type ID 含路径，使两模块同 FQN 的存储行不再覆盖；text intent 不再一遇 simpleName 就停止；长方法的明确 anchor 窗口改造有效。静态 java_symbol 已接入公开工厂，preview、query budget、搜索文档和独立语义实验包已提交。

本次还执行了 24 条不依赖 native parser 的当前产品测试、10 条当前评测测试，均通过；实验已有 8 条离线测试通过，1 条真实端点测试跳过。它们的通过与下面反例失败并不矛盾：现有测试没有观察到最后模型消息、缓存重载碰撞、scope 与 cap 的组合等关键边界。

原 frozen kit 自检五阶段在同一环境全部通过；**b9 内 kit 自检失败**。新测试不是从“所有基础改造都没有价值”出发，而是进一步检查接口组合和证据链。

## 4. 缺陷清单

### A01｜P0 验收阻塞：冻结 Unicode fixture 字节漂移

`docs/java-specialist-devkit-v1/dataset/contracts/fixtures/unicode/src/main/java/demo/Unicode.java` 从 CRLF 变成 LF。原哈希 `294cd139…`，当前 `42f1c89b…`，文本归一化后相等。不能把它指控为篡改答案；原因可能是换行转换，但本次没有证明由哪一步造成。可以确认的是原 frozen MANIFEST 不匹配，`harness.selfcheck` 的 dataset/repair 步骤退出 2，56 条套件测试出现 1 FAIL、1 ERROR。

原报告“dataset 零 diff”在字节口径不成立。**恢复原 CRLF、设置该 fixture 的 `.gitattributes -text`、检查全新 clone 的哈希**，不要改 frozen manifest 接受错误字节。恢复脚本默认 dry-run，本次未对附件源目录执行恢复。

### A02｜P0 评测有效性：模型看不到新的工具返回

`run-agent-trace-live.mjs:576` 把所有非 `java_context` 工具结果交给 `compactImpactForModel()`；该压缩器仅保留 files/readPlan/evidenceGaps。`java_symbol` 返回的 candidates、`read` 返回的 text、`write_file` 回执都丢失。

实际回放 W01 中工具原始结果有 `int auditSentinel=73619;`，下一次 chat 收到的 tool 内容却是：

```json
{"files":[],"readPlan":[],"evidenceGaps":[]}
```

与此同时，调用工具处的 recorder 在转换前写 `SOURCE_RECEIVED`。这能证明 harness 取到了原始内容，不能证明它交付给模型。W01–W04 均失败，使用真实 loop + 假 chat 捕获实际送入下一轮的 messages，没有调用模型。

**处理：把受影响 LIVE QA/repair 运行标记为 INVALID_EXPERIMENT（观察丢失/不实 delivery 语义），保留历史记录但停止用于能力归因。** 所有模型共用错误 loop，换多个模型也不能排除同一系统性混淆。0/24 的冻结结果可以仍是当时工作区的真实失败；“失败是模型拒绝而非 harness”不受这些数据支持。

### A03｜P0 评测一致性：绕开原 scorer、类型强转、缺失证据、分母丢失

新 `scoreQaAnswer()` 使用 `String()` 比较；`{"ok":"true"}` 可通过期待 boolean true 的答案；额外 key、重复 key 也接受。`scoreRunOutcome()` 仅核对答案，不验证原 gold 所要求的 received ranges。E01–E04 复现。原 Python scorer 未被修改，但 LIVE 没有调用它，因此“scorer 文件零 diff”不等于评分口径相同。

`assemblePack()` 虽保留所有 rows，却将成功率除以 `taskSuccess!==null` 的子集。E05 的一成功、一运行失败得到 rate=1.0，而非所有已调度任务的 0.5。可以附报 measured-only accuracy，但名称和分母必须明确；不能以这个条件成功率代替 task success rate。

修复须复用冻结 Python evaluator 或通过薄 adapter 输入其 schema；模型 JSON 在边界严格解析，拒绝重复 key，语义等价不依赖字符串强转。代码出现路径或读取记录不是任务成功；本套 benchmark 的 QA 是“答案值/键/类型 + 规定证据”联合契约。这是该数据集定义，不是对所有问答产品的一般要求。

### A04｜P0 A/B 解释：提示词、工具面与 candidate workspace 不对齐

`EVAL_SYSTEM_PROMPT` 继承旧提示“仅用 java_impact”，又告知可用 java_symbol/read；实际工具列表没有 java_impact。旧 M2 control 只给 read，没有 list/rg/search，入口未知时构成受限对照，不是原生 Agent 基线。M3 repair 的读写针对 candidateRoot，symbol session 却绑定 pristine repoRoot；改过文件后检索可能继续返回旧内容。

这是源码可见的协议偏离，W05 提示冲突已复现。需要一个中性、与 capabilities 一致的 system prompt；两臂都保留 native list/rg/read（repair 另有 write/test）；只有待测发现能力不同。每个 repeat 独立 candidate 和 MCP root。被测 Agent 不接收 gold/reference。旧 raw 未随包提供时，不能补写“模型已读到”来归因。

### A05｜P0 实验可复现性：同文件声明共用 embedding cache key

`DenseDiscoveryIndex.build()` 的 key 是 `model::relativePath::contentHash`，没有 declaration ID、实际文本 hash、表示版本或 endpoint。一个文件两个声明在冷建得到 `[1,0]`、`[0,1]`；写同 key 后重载得到 `[0,1]`、`[0,1]`。D01 实际证明 cold 和 cache-hit 的向量不同。不能只在报告上写 provider identity 就认为底层 cache 安全。

providerIndexIdentity 固定 `openrouter`，不含实际 endpoint；不同 endpoint 同模型得到相同 identity（D02）。此外 hash 不匹配的 hint 仍返回旧 line range（D03），fetch header 返回就清 timer，body 解析不在 deadline 内（D04）。此处是独立实验包，不意味着生产静态路径已经调用 dense。**禁止据此实验批准 optional integration，静态 core 可以在明确关闭它的条件下独立整改。**

### A06｜P0 效果解释：A3 的 recall 增益和零回退没有同预算基础

`compare.mjs` 的 A3 是 `A2所有候选 + dense最多8条`，没有融合后重新裁至同 K、同 source-line/byte 预算；A2 preview 约12行，dense declarationRows 可跨多个文档合并成大跨度。`coverage()` 对任意相交计一个证据项全命中，对无行号的 path-only 直接视为整文件命中。该指标不是原 RequiredLineRecall/Recall@10；所谓 micro 实际是任务平均值。

在单调覆盖指标上 `coverage(A2 ∪ dense) ≥ coverage(A2)`，所以零回退部分由实现保证。这个结论来自源码和集合关系，不需要再花 API 费用“复测零回退”。历史 0.694→0.778、full 0.574→0.625 可保留为该不同预算 exploratory 指标的 SOURCE_REPORTED 观察，但不能归因成同预算 dense 提升或无伤害。

### A07｜P1 产品正确性：scope 后置、组合为 OR、unknown module 静默扩大

SQL 路由在 `fqnHits(...cap)` / rankBm25(...cap) 之后才调用 filterHitsByScope。Q01 中目标位于第二个模块、cap=1，先被外部候选占满，随后过滤变空并返回 complete。注释说“先过滤后 cap”，实现正相反。

`validateArgs()` 把 sourceSet=test 变为根前缀 src/test，多模块 `m/src/test` 不匹配；module=m 和 sourceSet=test 形成两项 OR，选入 `m/src/main` 与根下其他测试。Q06 已复现。未知 module 则静默忽略（Q07），违反显式限定的最小惊讶原则。修复应使用规范 source-root 元数据和 AND 过滤，过滤在统计工作/排序/截断之前生效。

### A08｜P1 产品契约：query/terms、exact miss、deadline、limit 自相矛盾

有 terms 时丢弃原 query，仅搜索 terms；明确 exact 找不到 FQN 时继续 BM25，返回近似声明；已经过期的 exact lookup 仍成功；外层 maximum20 而内层 maximum10，返回10且 truncated=false。Q02–Q05 均复现。

词法选项可以不同，但必须由一份契约决定：terms 补充 query；explicit exact 无 fuzzy fallback；进入/退出每阶段检查绝对 deadline；limit 是返回上限，不应承诺必定返回 N，不过**达到内部截断时必须如实 hasMore/truncated**，不能把 limit20 被固定10 截断说成完整。

### A09｜P1 身份语义：存储不再覆盖，resolver 仍选“最小 ID”

`buildTypeRegistryView()` 对同 FQN 只存一个 typeId，并特意选择字典序最小者，SQL facts store 对齐同样策略。N01 中两个独立模块的 `demo.Shared`，编译上下文未知，resolver 仍返回 RESOLVED_REPO 指向 a。

可重复不等于正确。保留 FQN→多声明集合，在实际 module/source-root 可见性证明唯一时才绑定，否则 AMBIGUOUS。既不自行实现完整 Java 编译器，也不以未知为理由任选一个。原12存储探针通过不覆盖这条调用链，因此 T02 仅部分符合，T11 “没有绑定缺陷触发”也需要重新核查。

### A10｜P1 证据归属/新鲜度：XML 行号配 Java 文件；stale locator 仍 READY；单行 preview 无字节界

buildSearchDocuments 的 MyBatis key 使用 statement.range，但继承 Java base.path/base.contentHash。P01 返回 Java `Mapper.java` 的300–310行，实际证据属于 XML。关联目标 declaration 与证据来源必须分字段。doc ID/cache key 也要包含 source path/hash，不能只修显示字段。

Q08 证明文件与 index hash 不同只撤掉 preview，旧 selection 和 hash 仍当 source-declaration/READY 返回；必须显式 stale/partial 或重新定位，不给可执行旧位置。Q09 用10万字节单行证明12行限制不是 byte cap，且 preview 同步整文件读、多候选重复读可能放大延迟。16KiB 是本包新增安全反例上限，不是声称旧文档固定该值；新设计生产默认更严格。不能据静态机制推算实际 P95，本次没有完整负载测量。

### A11｜P1 修复判定器与可搬运性

judgeRepair 把 candidate overlay 到 pristine，只复制存在的 allowed files；candidate 删除 allowed file 时被原件恢复。J01 中 candidate 没有 A.java，judge 却恢复原件并 PASS。该特制 baseline 原本正确，用于分离 materialization 错误；不暗示旧8条失败基线必然因此误判。

路径硬编码使 repair-judge.test 在非 `/Users/luo/Documents/github/...` 目录 ENOENT，整测试文件无法运行。还有 stdout/stderr 无限累计、只 kill 直接子进程、symlink 不纳入 walk、missing javac 被当 compile failure 的风险；这些后者为静态发现，应按 R04 补边界测试，不冒充本次均已攻击复现。

### A12｜P0 完整上线签字：原契约未完成、raw evidence 不可交付

仓库自己列 K01–K32 为 PASS10、PARTIAL12、NOT_RUN10。NOT_RUN 集中在 main/test 同名、watcher/delete/rename、worktree/XML-only、绑定、共享 JDT 取消等；这些不是只读工具可以忽略的边界。原门禁没有授权自动豁免。需要真实运行验证，或用户另行批准严格的“非完整范围 canary”；不能重写历史 gate 成已达标。

新 LIVE/full-public raw 指向个人绝对目录，附件主要只有摘要，没有足够可移交的逐 run 输入/最终模型 payload、候选树、judge 原始结果、完整数据/协议 hash。因此多项数字目前只能归为仓库报告，不算本次独立复核。日期、0/33与0/24、不同分母还需统一。`docs/deep` 历史保存不应掩盖当前证据缺口。

## 5. 本次实际验证表

| 项目 | 结果 | 正确解释 |
|---|---|---|
| 原版 frozen kit 自检 | 5/5阶段 PASS | 数据/评分器原版在此环境可运行 |
| b9 内 kit 自检 | FAIL | frozen dataset 字节不一致；unit56中54通过、1失败、1error |
| 原12产品源码探针 | 12/12 PASS | 首轮定向机制修复真实有效 |
| 当前产品纯函数/SQL测试选集 | 24/24 PASS | 不含 native parser/JDT/MCP |
| 当前 JS评测测试 | 10/10 PASS | 使用未启用 SDK transport stub；不能证明最终 payload 正确 |
| 实验包原离线测试 | 8 PASS，1 endpoint SKIP，1文件加载FAIL | repair test硬编码路径造成文件级失败；不是20条repair全跑 |
| 新离线反例 | 27检查：1 PASS、26 FAIL、0ERROR | 按需构造的机制检查，不是27个独立业务任务 |
| npm ci/full build/full test | BLOCKED_ENV | npm registry EAI_AGAIN，未做完整类型检查 |
| macOS/runtime/JDT/live/dense真实端点 | NOT_RUN | 没有相应机器/授权，不能填 PASS |

原报告的1199+296全绿、真实API190次、1725文件full corpus、0/24等不被删除，但全部明确为 SOURCE_REPORTED。不能把本包假fetch测试冒充对这190次API原始返回的验证。

## 6. 方向建议

不要再换更强模型来解释当前零修复，不扩大候选预算来展示新 recall，也不重做 SQLite/JavaIndex。首先修正确交付与统一评分；其次修静态scope/身份/provenance；补完原runtime contract；最后只做一次同预算 optional experiment，允许 KEEP_EXTERNAL/NO_GO/INCONCLUSIVE。

修后最有价值的优化仍是：未知入口的词法表示、命中片段的实际交付、局部关系辅助，不是技术种类数量。完整方案和执行细节见后续文档与 R00–R13。
