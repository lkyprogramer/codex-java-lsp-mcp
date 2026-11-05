# P0 公开答案合同独立评审

2026-10-11。最终结论：PASS，无剩余阻断 finding。仅限P0合同；P1实现、模型效果和发布/daemon替换尚未验证，不能据本评审改标原QA或发布门。

## 已关闭的具体缺陷

初读发现JSB-PAYMENTS-01.storageType被限制为简单标识符，不能表示源码声明及冻结gold中的泛型集合类型。回答简单类名会通过新格式但失败于原strict scorer；保留泛型会被新pattern拒绝，两者不可同时满足。

主代理已修复：storageType保留string，改为minLength=1和“源码声明的collection type expression，保留泛型与源码类型拼写”的描述，去除简单标识符pattern；MD也明确区分短类型名与集合类型表达式。没有写具体集合类型或泛型实参到合同，没有改gold或归一化答案。独立复核该finding关闭。

## 合同覆盖及表示域

只读解析全部原36题，取28 QA，对照新JSON的28个唯一ID：任务集合一致；每题properties键集合、基础type与原output_contract.answer_keys完全一致。逐字段核对冻结gold的类型、enum、pattern、minLength、array items及lexical顺序约束，28/28均可表示，无冲突。

这些是文件内容的只读比较，不是运行项目测试或执行新validator。P1仍须证明schema生成与validator确实共享同一公开约束，且不读取gold。

约束均对应公开字段角色/表示：方法、字段、短类型名与枚举常量是简单名称；源码集合声明是可含泛型的类型表达式；原始字符串、XML列、map key、错误码和异常消息保留内容、大小写、空白及标点，不剥前缀、翻译或替换。数组公开items类型；没有依赖私有答案推断元素值或归一化对象数组。

合同没有每题正确方法名、返回值、单选正确enum、数值常量或必需源码path/line坐标。源于问题文本的名称及字段角色不是私有答案注入。合同taskFile/taskSha256用于绑定原任务输入，不是必需证据提示。

## 关键歧义裁决

- **MYBATIS-03**：原问题询问为何用户参数不被自动生成名覆盖。源码插入分支使用“无冲突”条件；新guard明确要求“已有冲突”为true的正向检测谓词。它与保留的gold极性相同，与原防覆盖问题自洽。合同没有公布谓词代码，不能在实现中删除`!`或翻转模型表达式。新版本成绩属于澄清后的新公开合同，不回算旧guard输出。
- **NOTIFICATIONS-01**：subscriptions / distinct_channels完整公开了原问题中的两种计数类别及英语表示。模型仍必须读取实现选择类别；未标注哪种正确，属于公开表示合同。
- **HIKARI-01**：equals / identity均公开；direction同时公开head-to-tail / tail-to-head，将头/尾查找起点明确为完整遍历方向和固定连字符表示。未指明源码选择，未把旧tail/tail_to_head输出静默转换为新值。
- **ADMISSIONS-01**：两个模块的两个声明必须分别检索，结果是两个字符串组成的数组，按码点词典序排序。排序只改变输出顺序，不合并声明、不去重、不增加module/path对象。现有两个源码返回字符串和冻结数组顺序一致；合同不公开其具体值。
- **ACCESS-01 / PAGINATION-02**：前者参数名按声明顺序，后者字段名按实际调用顺序；不能因ADMISSIONS采用排序而全局排序其他数组。
- **ADMISSIONS-02**：decision对应判定方法、format对应展示方法、accepted对应展示字面量；该角色澄清不泄漏实际方法或字面量。

未知公共任务边界：JSON selection明确是这28个显式ID的evaluation overlay，不是任意任务的默认合同。P1不能按未知任务名称、字段名或相似题推断隐式simple-name/enum/order约束；本轮没有实施该路径，因此仅确认公开文件的作用域，不声明运行时已经满足。

## 冻结与历史边界

原tasks/gold文件hash与此前P4冻结值一致：

- tasks.jsonl：`dec9129e685b12510ab3f116e1245be549b6c468bfb820d157a2030542dc6eee`。
- gold.jsonl：`6774d9d48879c199bda6307e4ddc896c075ee06b6a9a7ba0dce39c86eacacf78`。

按本轮baseline/immutable-input-hashes.json只读核对原baseline-kit实际150项，全部hash一致。原harness/scoring.py仍使用类型及递归精确相等；数组顺序、string值和标点均不归一化。

- scoring.py SHA256：`5c41e12a994a7a9269725e94646bfb691e6929c2d3dba7c306255754095d4a28`。
- 活跃evaluation-protocol.json和独立存档evaluation-protocol-v1.4.json逐字节摘要相同：`a2f06a1cfa3ce2c9457495d49d0dc7e5a7fdc5ba66fd9696a14a8ed66e71f5c5`。

public-qa/v1.0是显式新overlay；后续v1.5须记录实际应用状态及合同hash，旧任务/gold/scorer、160行/16000字节预算、80%门槛、12/28及其他历史结果保持不变。即使新格式更容易满足，也不能回算或清洗旧答案。

最终评审输入：

- public-answer-contract-v1.0.json SHA256：`2debcf5ef20d58e6e994025f4d5a69861d3e869e0f67b8a2780ee59b6592f1d3`。
- public-answer-contract-v1.0.md SHA256：`26240ea06c8515e4134370ba8609c25ea4245df20f29a46e09753d660d5f92ea`。

已读取qa-contract-release-plan.md、qa-12-of-28-analysis.md、全部公开合同、原tasks/gold、原scoring.py，以及PAYMENTS/MYBATIS/ADMISSIONS/NOTIFICATIONS/HIKARI等相关源码。未运行模型、项目测试、构建、安装或scorer；未改工作区源代码、合同、冻结输入或旧结果。只写本评审与不含答案值的coverage.json。

结论置信度：当前28题键/type覆盖、gold表示域兼容和歧义裁决高；公开约束的实现效果及模型改进未测。P0可继续进入P1，后续阶段仍按原门完成真实验证，不预设80%必然通过。
