# 两臂 QA 通过率偏低原因分析

2026-10-11。两臂同为 12/28，但失败构成不同。product 获得了更多必需源码，却提交了更多与冻结 gold 不一致的答案。下一阶段应先收紧公开答案表示约束、修复原生检索的路径错误并改善定向读取；当前结果不足以支持收缩 broad。

56 次 QA 中共有 21 次答案值不符。逐项核对后，13 次属于答案表示或字段绑定问题，6 次涉及公开词汇或表达式含义歧义，2 次是明确的源码结论错误。此分类用于解释失败，不改变任何历史分数。原 QA 80% 门槛仍为 FAIL。

## 数据和判定边界

分析使用[原实验汇总](evidence-protocol-experiment-review.md)、[逐次模型审计](evidence-protocol-experiment-evidence/p4/model-audit.json)、[公开任务](evidence-protocol-experiment-evidence/tasks.jsonl)、[冻结 gold](evidence-protocol-experiment-evidence/gold.jsonl)和实际请求、响应、工具结果。候选源码摘要仍为 `a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313`，611 个可执行源码文件。

完整范围为原 28 题 × control/product 两臂，共 56 次 QA；另分析原四题、三 profile、两次重复的 24 次诊断。不将修复题并入 QA 分母，也不把已暴露题当作泛化证据。

[分析数据](qa-12-of-28-analysis-evidence.json)保留每题的公开问题、gold、实际提交、逐字段比较、漏读行、收到的源码范围、工具调用顺序及原始日志哈希。完整消息和源码文本在[原始日志归档](evidence-protocol-experiment-evidence/p4/model-raw.tar.gz)中；JSON 的 `block` 指向归档内目录，`calls` 保留该目录的实际调用顺序和参数。

原评分器执行严格递归相等比较：字符串不归一化，数组逐项比较且顺序必须一致。QA 同时要求值符合 gold、所有必需行已通过 `SOURCE_RECEIVED` 派发、源码预算通过。`rg` 和 `list` 输出是导航信息；即使其中有源码文本，也不产生可计分的源码回执。[评分器](../java-specialist-release-audit-v1.1/baseline-kit/harness/scoring.py)、[wire](../../scripts/eval-tool-wire.mjs)和[协议](evaluation-protocol.json)是这些规则的真源。

## 失败构成

| 判定 | control | product broad |
| --- | ---: | ---: |
| 严格通过 | 12/28 | 12/28 |
| 提交键和顶层类型合规 | 28/28 | 28/28 |
| 值符合冻结 gold | 19/28 | 16/28 |
| 必需源码完整 | 20/28 | 24/28 |
| 原源码预算通过 | 28/28 | 28/28 |
| 仅缺证据 | 7 | 4 |
| 仅值不符 | 8 | 12 |
| 值与证据均不符 | 1 | 0 |

28 个 QA 配对中，双方通过 9 题、仅 control 通过 3 题、仅 product 通过 3 题、双方失败 13 题。control 独有的通过题为 GSON-01、ADMISSIONS-01、MYBATIS-01；product 独有的通过题为 PRICING-02、MYBATIS-02、NOTIFICATIONS-02。

若仅补齐当前漏读源码、其他提交保持原样，上限分别是 19/28 和 16/28，仍低于 80%。若仅修正当前答案值、其他读取保持原样，上限分别是 20/28 和 24/28。它们是固定现有轨迹的逻辑上限，不是新模型运行的预测成绩。

### 答案值不符的具体类型

| 类型 | control 次数 | product 次数 | 题目 |
| --- | ---: | ---: | --- |
| 源码结论错误 | 0 | 2 | GSON-01、MYBATIS-01 |
| 答案表示或字段绑定 | 6 | 7 | ADMISSIONS-01/02、PRICING-01、PETCLINIC-03、GSON-02、PAGINATION-02、HIKARI-03 |
| 公开词汇或表达式含义歧义 | 3 | 3 | MYBATIS-03、NOTIFICATIONS-01、HIKARI-01 |

所有这些提交都通过了 P1 的公开 JSON 键和顶层类型检查。因此“typed submission 通过”不代表成员名、数组元素类型、字段语义或词汇形式正确。[`buildSubmitAnswerTool` 和 `validateSubmission`](../../scripts/eval-answer-contract.mjs)只生成并校验 `string/array/integer/boolean`，未校验数组元素、简单标识符或字段角色。它也不应该读取 gold 来判断答案内容。

已有 system prompt 明确要求成员名和枚举值使用简单名称，并禁止在字符串中加入解释。PRICING-01、PETCLINIC-03 等属于未遵循已有要求；再次加入同一句提示不足以构成修复证明。HIKARI-03 的异常类型短名、ADMISSIONS-01 的数组元素和排序，以及两个自然语言分类字段，则需要更明确的公开表示规范。

## 逐题对照

下表省略 `JSB-` 前缀。`V✓/E✓` 表示答案值与必需源码均通过；`V×/E✓` 为仅值失败；`V✓/E×` 为仅证据失败。`S/G/L/R` 分别表示 `java_symbol/rg/list/read` 的实际调用次数，不含 `submit_answer`。源码范围均为模型实际收到的范围；完整路径和调用参数在分析 JSON 中。

| 题目 | control 判定与读取 | product 判定与读取 | 值或证据缺口 | 工具问题 |
| --- | --- | --- | --- | --- |
| PAYMENTS-01 | V✓/E✓；G1 R1；PaymentService 1–14 | V✓/E✓；S1 R1；同范围 | 无；两臂读到去重集合与检查方法 | 无 |
| PAYMENTS-02 | V✓/E×；G1 L1 R1；仅 ReceiptMapper.xml 1–5 | V✓/E×；S1 G1；0 行源码回执 | C 缺 ReceiptAssembler:4、Receipt:5；P 还缺 XML:3。实际答案都正确 | 工具返回了定位结果；模型将导航信息当成完成依据 |
| INVENTORY-01 | V✓/E✓；G2 L2 R1；StockService 1–16 | V✓/E✓；S1 G1 R1；同范围 | 无 | C 的空路径 list 被拒绝，随后恢复 |
| INVENTORY-02 | V✓/E✓；G2 L2 R6；53 行，含 3 个无关辅助文件 | V✓/E✓；S1 L1 R3；入口、服务、Reservation 共 31 行 | P 用更短路径覆盖同一证据链 | 两臂各有一次空路径 list，均恢复 |
| ACCESS-01 | V✓/E×；G1 L1 R2；Policy 1–80、81–160 | V✓/E×；S2 G2 R2；同范围 | 两臂漏掉实际比较行 199；160 行预算用尽 | P 首次英文查询候选较泛，切换中文后已定位正确方法；失败落在读取策略 |
| ACCESS-02 | V✓/E×；G2 R4；Endpoint 1–7、Policy 1–80/80–119/119–151 | V✓/E×；G1 R1；仅 Endpoint 1–7 | 两臂均缺 Policy:199；C 重叠两行并耗尽预算，P 在入口处停止 | 无执行错误；冻结标注额外要求策略实现行 |
| ADMISSIONS-01 | V✓/E✓；L2 R2；两模块 Shared 各 1–4 | V×/E✓；S1；两模块预览各 2–4 | P 提交含 module/path/track 的对象数组，gold 要字符串数组；两个 track 值均已找到 | C 空路径 list 后恢复；P 未混淆两个声明 |
| ADMISSIONS-02 | V×/E✓；G3 L2 R3；17 行 | V×/E✓；S1 L1 R2；11 行 | 两臂解释中都包含 admit/status/ADMITTED，但未按 decision/format/accepted 对应填入三个值 | 两臂空路径 list 后恢复；不是源码定位失败 |
| PRICING-01 | V×/E✓；G1 L1 R1；MoneyPolicy 1–8 | V×/E✓；S1 G1 R1；同范围 | 两臂均返回 RoundingMode.DOWN，gold 为 DOWN；scale=2 正确 | 无；都按实际代码读到 DOWN，而非误信注释的 HALF_UP |
| PRICING-02 | V✓/E×；G2 R2；Assembler 1–6、MoneyPolicy 1–8 | V✓/E✓；S3 R1；31 行，含 InvoiceLine 4–7 | C 漏 InvoiceLine:5 的字段声明；P 已补齐 | 无执行错误；P 也收到部分无关/重复预览 |
| PETCLINIC-01 | V✓/E✓；G1 L2 R1；PetValidator 1–69 | V✓/E✓；S1 L1 R1；同范围 | 无 | C 向不存在路径 rg，被误报 BLOCKED_ENV；随后正确读取 |
| PETCLINIC-02 | V✓/E✓；G2 R1；PetValidator 1–69 | V✓/E✓；S1 G1 R1；PetValidator 30–69 | 无 | C 向不存在路径 rg，被误报 BLOCKED_ENV；不影响最终覆盖 |
| PETCLINIC-03 | V×/E✓；G1 R1；PetValidator 55–69 | V×/E✓；S1 R1；PetValidator 60–69 | comparison 返回完整调用 Pet.class.isAssignableFrom(clazz)，gold 为方法名 isAssignableFrom；子类判定正确 | 无 |
| MYBATIS-01 | V✓/E✓；G2 R1；ParamNameResolver 55–104 | V×/E✓；S2 R1；160 行，只有 89 个不同源码行 | P 将 @Param 注解当成特殊参数类型：Param 而非 ResultHandler；name="1"、RowBounds 正确 | 显式请求多候选 preview，两次检索重复 71 行并耗尽预算；关键 isSpecialParameter 97–98 已收到 |
| MYBATIS-02 | V✓/E×；G2 L3 R1；ParamNameResolver 1–160 | V✓/E✓；G1 S1 R2；60–139、140–177 | C 漏 helper 的 161–174；P 覆盖调用与 helper，实现答案相同 | C 不存在路径 rg 被误报 BLOCKED_ENV，并有空路径 list；最终失败是窗口位置 |
| MYBATIS-03 | V×/E✓；G1 R1；ParamNameResolver 1–160 | V×/E✓；S1 R2；34–45、45–154 | 两臂返回 !names.containsValue(genericParamName)，与实际 if 条件一致；gold 为不带 ! 的冲突检测表达式 | P 一次 maxLine 参数拼写错误，改为 maxLines 后读到完整条件；应先澄清 guard 含义 |
| GSON-01 | V✓/E✓；G1 R1；FieldNamingPolicy 179–208 | V×/E✓；S1 R1；170–209 | P result=a_URL，正确为 a_U_R_L；还返回了带 owner 的 method | 无；核心循环已收到，属于实际计算错误 |
| GSON-02 | V×/E×；G1 R1；FieldNamingPolicy 1–160 | V×/E✓；S1 R2；135 行，包含 helper 179–188 | 两臂 locale=Locale.ENGLISH 而非 ENGLISH；C 另缺 helper 179–188。结果字符串均正确 | 无执行错误；C 再次把预算用在文件前部 |
| GSON-03 | V✓/E✓；G1 R1；FieldNamingPolicy 180–213 | V✓/E✓；S1 R2；185–209、209–213 | 无 | 无；P 重复收到一行，但预算与覆盖通过 |
| NOTIFICATIONS-01 | V×/E✓；G1 L1 R1；DispatchBus 1–13 | V×/E✓；S1 G1 R3；27 行 | 两臂正确识别订阅条目数，gold 只接受 subscriptions；公开中文问题未指定此英语词形 | P 的 subscriber 查询未命中，改读正确文件后仍因词形失败 |
| NOTIFICATIONS-02 | V✓/E×；G2 L2 R1；仅 Endpoint 1–7 | V✓/E✓；S3 L1 R2；Endpoint、Bus、Subscription 共 25 行 | C 缺 DispatchBus:9、Subscription:5；P 读到完整字段与实现链 | 两臂空路径 list 后恢复；C 在入口处停止 |
| LEDGER-01 | V✓/E✓；G1 L1 R1；Ledger 1–13 | V✓/E✓；S1 G1 L1 R3；26 行 | 无；P 额外读 Command 与 Endpoint | 两臂空路径 list 后恢复 |
| LEDGER-02 | V✓/E×；G1 R2；Endpoint 1–7、Command 1–6 | V✓/E×；S1 G1 R1；仅 Command 1–6 | C 缺 Ledger:7；P 还缺 Endpoint:6。方法和字段答案正确 | 无执行错误；导航候选/rg 已指出相关行，但模型没有继续 read |
| PAGINATION-01 | V✓/E✓；G4 L2 R7；45 行，含无关辅助文件和 pom | V✓/E✓；S1 L1 R2；Window、Endpoint 共 15 行 | P 更短路径覆盖答案；C 的多余检索没有改变答案 | 两臂空路径 list；C 三次对文件 rg 返回 ENOTDIR，最终仍通过 |
| PAGINATION-02 | V×/E✓；G1 L2 R3；Request、Window、Endpoint 共 22 行 | V×/E✓；S2 R3；同三个文件共 22 行 | 两臂 arguments=[r.page,r.size]，gold 为 [page,size]；P 的 entry 还带 FQN | C 空路径 list 后恢复；字段顺序和实际传参均已读对 |
| HIKARI-01 | V×/E✓；G4 R1；FastList 125–154 | V×/E✓；S1 R1；125–204 | equality=identity、count=1 正确；direction 分别为 tail、tail_to_head，gold 为 tail-to-head | C 两次对文件 rg 返回 ENOTDIR；读取后源码充分 |
| HIKARI-02 | V✓/E✓；G3 R1；FastList 39–158 | V✓/E✓；S1 R1；140–169 | P 更短窗口覆盖 clear；两臂答案一致 | C 两次对文件 rg 返回 ENOTDIR，仍正确读取 |
| HIKARI-03 | V×/E✓；G1 R1；FastList 200–259 | V×/E✓；S1 R1；214–313 | 两臂 exception=java.util.NoSuchElementException，gold 为短类名；method/message 正确 | 无执行错误；P 的宽候选已通过显式 read 收敛 |

## 关键调用轨迹和根因

### 导航结果不能代替源码回执

PAYMENTS-02 的 control 先 `rg("amount")`，结果同时展示 ReceiptAssembler:4、Receipt:5 和 XML:3，随后 `list(".")`、`read(XML,1,15)`，最后提交全部正确的三个答案值。它仅获得 XML 1–5 的回执，两个 Java 行未计入证据。

product 执行 `java_symbol("receipt amount field XML column", terms=...)` 和同一 `rg("amount")` 后直接提交，完全没有 read 或显式 preview，收到的可计分源码为 0 行。不是工具找不到这些声明，而是模型看到了足够填写答案的导航信息后提前结束。

LEDGER-02 同样如此。product 的 symbol 已给出 Ledger.transfer:7 和 Endpoint.submit:6 的定位，rg 又展示了调用行，但只读取 TransferCommand 就提交。control 多读了 Endpoint，仍没读 Ledger。P1 的合法提交动作解决了“怎样提交”，没有解决“什么时候证据已经足够”。

### 顺序读文件前部耗尽了预算

ACCESS-01 两臂均读 1–80、81–160，漏掉 199 行比较；ACCESS-02 的 control 在 Endpoint 7 行后读 Policy 1–80、80–119、119–151，重叠两行并耗尽 160 行。MYBATIS-02 control 读 1–160，真正的 collection/list/array 键在 161–171；GSON-02 control 读 1–160，helper 在 179–188。这五次尝试都没有超预算，而是在正确文件中选错窗口。

`invokeRead` 原始返回已有 `totalLines`，但 [`serializeRead`](../../scripts/eval-tool-wire.mjs)未把它交给模型。普通 maxLines 窗口也不因“文件尚有后文”返回截断标志。这是可改善的可见性缺口，但并不能独自解释模型为何不搜索具体 return/helper；本次没有运行带此元数据的新模型对照。

最小改善方向是先定位比较、return、被调 helper 或字段声明的具体行，再读取短窗口。无需提高预算或扩大默认 read 窗口；增大窗口会更早耗尽本来就只有 160 行的额度。

### 更多预览没有消除源码理解错误

MYBATIS-01 的 control 两次 rg 后定向读 55–104，共 50 行，正确回答 `ResultHandler/RowBounds`。product 第一次请求 `preview=window`，七个候选预览先消耗 83 行，再 read 57–96 消耗 40 行，第二次带 preview 的查询消耗剩余 37 行。总计 160 行，71 行为重复交付；`isSpecialParameter` 的 97–98 已在第一次预览中出现。

product 最终把 `Param` 填成特殊参数类型，而源码明确判断 `RowBounds` 或 `ResultHandler`。可以确认答案内容错误；重复窗口和无关候选是同时存在的噪声，尚不能证明它们导致了该误判。

GSON-01 product 的 symbol 已定位 helper，随后读 170–209。179–188 的循环对每个非首位大写字母分别插入 `_`，`aURL` 的简短执行结果依次为 `a`、`a_U`、`a_U_R`、`a_U_R_L`。提交 `a_URL` 与此不符，不能通过规范成员名解决。

### 严格词形与源码结论应分开评价

NOTIFICATIONS-01 的公开问题问“订阅条目还是不同频道数”，两臂回答了订阅条目数，并读到 DispatchBus 8–9。唯一值差异是 gold 的英语词形 `subscriptions`。system prompt 的“不加解释”可以约束 product 的长描述，但不能推出 control 的简短中文答案必须写成哪个英语词形。

HIKARI-01 的公开问题问“从头或尾查找”，源码从 `size-1` 递减到 0。control 的 `tail` 回答了起点；product 的 `tail_to_head` 明确描述方向。gold 的连字符形式没有在公开合同中指定。三 profile 的重复诊断也都取得完整证据，仍返回 `tail`、`tail_to_head` 或 `tail to head`。

MYBATIS-03 的源码 137 行为 `if (!names.containsValue(genericParamName))`。两臂返回真实的插入分支条件；gold 的正向表达式则表示“检测是否冲突”。两种表达式服务于同一防覆盖逻辑，但布尔值相反。必须先明确 `guard` 要插入条件还是冲突检测，不能删除 `!` 做静默归一化，也不能据此认定两臂错误理解了防覆盖逻辑。

此外，ACCESS-02、LEDGER-02 的必需标注要求被调方法中的额外行，公开问题本身主要询问入口、字段和被调方法名称。未来应明确这种证据闭合要求。本次仍按原标注认定漏读，不减轻必需证据规则。

## 工具问题及其影响

56 次 QA 中有 25 次返回 `error` 的工具调用，属于不同问题，不能统一算作环境故障。

| 问题 | 调用数 | 实际影响 |
| --- | ---: | --- |
| `list(path="")` | C 9、P 5 | 无效参数；模型随后改用有效路径或直接读取。多数所在题仍通过 |
| `read(maxLine=...)` | P 1 | 参数拼写错误；MYBATIS-03 随后使用 maxLines 恢复，必需证据完整 |
| 对文件路径执行 rg | C 7 | 文件被作为 cwd，spawn ENOTDIR；影响 PAGINATION-01、HIKARI-01/02 |
| 对不存在路径执行 rg | C 3 | cwd 不存在，却误报 rg binary not found / BLOCKED_ENV；影响 PETCLINIC-01/02、MYBATIS-02 |

[`EVAL_RG_TOOL`](../../scripts/eval-native-tools.mjs)当前把 path 描述为目录。因此模型传文件路径属于超出当前声明的用法；实现仍应给出准确参数错误，而不能把它变成 spawn 错误。`invokeRg` 在 358 行把目标用作 cwd，又在 361 行把所有 ENOENT 都归为二进制缺失，后者是已证实的错误归因。

只读复现确认：同一存在的 FastList.java 文件路径返回 ENOTDIR；改用其目录或省略 path 均正常得到 8 个匹配；不存在路径返回错误的 BLOCKED_ENV。复现结果在分析 JSON 的 `nativeRgReproduction` 中。

十次 rg 错误分布在六次 control 尝试，其中四题最终通过。两道失败题是 HIKARI-01 的词形差异和 MYBATIS-02 的漏读后文；两者也都找到正确文件。因此可以确认工具造成了失败调用和额外回退，不能把这十次错误直接换算成十次 QA 失败或若干可保证的新增通过。

没有观察到 provider 失败、JDT 启动失败或源码过期导致这 56 次 QA 无法完成。`selectionLimited`、无匹配结果、预算耗尽和合法的 XML 空关联结果也不属于执行故障。

## 四题诊断如何补充主对照

| 题目 | broad 两次 | evidence 两次 | exact evidence 两次 | 轨迹结论 |
| --- | --- | --- | --- | --- |
| PAYMENTS-02 | 0/2；均 0 行源码回执 | 1/2；首次 read Java + TYPE XML 单元齐全，第二次仅 XML | 0/2；均缺 Assembler，首次 assembler 还答成 Receipt | XML 工具有效交付过，但不会自动补齐 Java 字段和组装链 |
| HIKARI-01 | 0/2；证据均完整 | 0/2；证据均完整 | 0/2；证据均完整 | 三种检索模式都未解决 direction 的表示差异 |
| NOTIFICATIONS-01 | 0/2；证据均完整 | 0/2；证据均完整 | 0/2；证据均完整 | 三种检索模式都未解决 countUnit 的公开词汇缺口 |
| MYBATIS-02 | 1/2；第二次读 1–160 后耗尽预算 | 2/2 | 2/2 | 成功与覆盖 helper 有关；这些尝试没有调用 java_evidence |

整个诊断中 `java_evidence` 有 8 次调用：3 次合法 TYPE 返回 XML 单元、2 次合法 METHOD 返回 READY 空单元、3 次字段/构造器锚点返回 ANCHOR_UNRESOLVED。后者没有按工具说明使用 TYPE 锚点；字段不是支持的锚点，构造器也不能代替 resultMap 的 TYPE 关联。READY 空单元只表示该锚点没有受支持的 XML 关联，不能代替读取 Java 实现。

PAYMENTS-02 的 evidence 第二次在 Receipt:5 字段和 Receipt:6 构造器失败后，调用 Assembler.toReceipt:4 得到 READY 空单元，最后只 read XML；缺的 Java 行仍在。exact-evidence 两次都取得 XML，也都没有读取 Assembler。问题包含锚点选择和提前结束，不能解释为 XML 单元工具全面失效。

诊断合计仍为 broad 1/8、evidence 3/8、exact-evidence 2/8。只有四个已暴露任务，且其中两题受公开答案表示影响，不能用这组数字决定删除 broad。

## 调用成本与解释限制

下面只统计这 56 次 QA，不混入原 8 个 repair 任务。

| QA 调用指标 | control | product broad |
| --- | ---: | ---: |
| provider 响应次数 | 132 | 102 |
| 原生或产品工具调用，不含 submit | 119 | 93 |
| read 调用 | 50 | 42 |
| 收到的源码行，含重复 | 1525 | 1339 |
| 重复交付源码行 | 2 | 88 |
| prompt tokens | 203936 | 219716 |
| completion tokens | 6370 | 5167 |
| cached input tokens | 148191 | 144012 |
| uncached input tokens | 55745 | 75704 |

product 调用较少，但 uncached 输入多约 35.8%。MYBATIS-01 一题就贡献了 71 行重复源码。宽候选元数据、预览与消息历史会增加输入成本；这些记录支持进一步改善工具信息表达和读取选择，不支持归因到单个 worker 或 SQL 执行速度。

模型设置为 `openclaw/Qwen3.8-next`、reasoning none、thinking false、completion cap 2048。没有同题同轨迹的思考模式对照，不能把两次明确内容错误归因于关闭 thinking。执行顺序 seed=1984 也不是 provider sampling seed，不能将本次不同检索顺序的差异解释为确定的因果效应。

## 下一阶段的最小改动方案

### 先确定公开合同和歧义题的含义

先形成新的公开字段描述，独立于 gold 值：方法/字段简单名称、异常类型短名、枚举简单名称、原始字符串字面量、数组元素类型及顺序。`decision` 对应录取方法、`format` 对应展示方法、`accepted` 对应通过时的展示字面量，避免模糊键名诱导不同角色。

对 MYBATIS-03 明确 guard 指插入分支条件还是冲突检测；对 NOTIFICATIONS-01、HIKARI-01 明确分类字段的所有合法表示。应先核对源码和题意再确定新合同，而不是从模型输出反推一个“都能过”的别名表。若需要改题意或 gold，使用独立版本，不覆盖原任务或 gold，不回算历史 12/28。

公开约束必须是表示形式或字段含义，不能把每题正确的方法名、返回值或必需行坐标放进模型提示。数组顺序也应按题意区分：track 集合可声明排序规则，传参数组必须保留调用顺序，不能统一排序。

### 收紧提交表示和修复原生工具边界

实现范围优先限于五个现有评测模块及其现有测试：

| 位置 | 最小改动 | 直接证明 |
| --- | --- | --- |
| `scripts/eval-answer-contract.mjs` | 从公开字段描述生成 items、description、必要的简单名称约束，并由本地 validator 同步检查；仍不读 gold | 对象数组与字符串数组、FQN 与简单名、方法名与调用表达式确实区分；字面量保持原字节 |
| `scripts/evaluate-java-task.mjs` | 对两臂传入相同的公开字段描述；明确 rg/list 和无 preview 的 symbol 是导航，提交前应读取回答所依赖的实现与字段 | 两臂 schema/prompt 对称；未注入答案值或私有必需行；原 budget 和原 scorer 保持不变 |
| `scripts/run-agent-trace-live.mjs` | 将公开字段描述同时传给 schema 生成与本地校验；恢复提示说明违反的公开规则 | schema 与 validator 使用同一公开约束；恢复仍最多一次且只开放 submit_answer；repair 合同保持原样 |
| `scripts/eval-native-tools.mjs` | rg 在 candidate 根执行，把经 containment 校验的文件或目录作为参数；不存在路径与缺少 binary 分开归因；同步更新公开 path 描述 | 根、目录、文件都能正确定位；不存在路径准确报错；路径逃逸、输出上限和 fixed-string 行为保持原约束 |
| `scripts/eval-tool-wire.mjs` | 保留 read 已有的 totalLines；继续区分当前窗口结束与源码预算耗尽 | ACCESS/MYBATIS 的固定轨迹能看见尚有后文；wire 截断与 SOURCE_RECEIVED 结算不改变 |

复用现有的一次公开格式恢复。恢复提示只能说明违反了哪条公开表示规则，不能提供正确答案。此恢复只开放 `submit_answer`、不能继续检索，因此它适合修格式，不适合补源码；不要把私有缺失行反馈给提交恢复过程。

不新增自动“找全题目证据”的推断器，不自动删除 FQN、`!` 或 receiver，不把 rg 文本计成源码，不提高 160 行预算。GSON-01 和 MYBATIS-01 的实际结论错误应保留为后续模型验证项；当前 source 已充分，尚无证据支持为它们扩展检索架构。

### 用最小验证决定是否扩大模型实验

1. 离线验证公开字段约束、一次恢复、文件/目录 rg 和 read 元数据；固定现有工具结果回放只证明协议行为，不宣称 QA 成绩提高。共享 runner 的 repair 提交合同用现有定向测试回归。
2. 小规模试验选 PAYMENTS-02、ACCESS-01、ADMISSIONS-01/02、PRICING-01、GSON-01、MYBATIS-01/02，共八题、两臂。覆盖提前提交、窗口错误、数组和字段绑定、枚举表示及两次真实内容错误；每题仍独立计分、保留失败和完整调用轨迹。八题不能代替完整门槛。
3. 小规模结果满足新公开合同且没有已知回归后，再运行原 28 QA × 两臂的完整对照。两臂使用同一新协议，保持模型、预算、默认单 worker 和 broad；单独报告值、证据、严格成功与成本。与旧 12/28 的比较是跨轮观察，不宣称仅某个补丁造成提升。

只有在合同与原生工具问题排除后，才值得重做 broad/evidence/exact-evidence 的有限对照。各阶段应在相关验证、评审和修复通过后继续；本方案没有预设下一轮一定达到 80%，也没有预设删除 broad。

## 已执行检查和未执行范围

本次只新增这份分析和分析 JSON。已核对 56 次完整 QA、24 次诊断的三个原始日志文件，共 240 次哈希检查；175 个模型消息内源码切片与对应 attempt 文件逐字节一致；293 个冻结历史输入文件哈希未变。当前 611 文件源码摘要也未变。

已执行只读 rg 边界复现：文件路径 ENOTDIR、目录和根路径正常匹配、不存在路径错误归为 BLOCKED_ENV。该结果验证当前缺陷，没有实施修复。

`git diff --check` 通过；分析表的 28 个唯一题目、56 个两臂结果、21 次值不符分类、输入哈希和本地引用检查通过。

未修改代码、任务、gold、协议、原评分器或历史结果；未发起新模型请求；未运行构建或全仓测试。下一阶段的补丁和模型效果均尚未验证。
