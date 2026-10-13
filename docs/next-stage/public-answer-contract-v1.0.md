# QA 公开答案合同第一版

此合同只明确公开问题的字段角色和表示形式，供两臂相同使用。[合同 JSON](public-answer-contract-v1.0.json)覆盖全部 28 个已暴露 QA，版本为 `public-qa/v1.0`。原任务、gold、scorer、源码预算、80% 门槛及历史结果保持不变。它不是公共 MCP 工具合同，也不改变 broad 或 worker 默认值。

方法、字段、短类型名和枚举常量使用简单名称；不含包、owner、receiver、签名、调用参数或解释。PAYMENTS-01 的集合类型是源码声明的类型表达式，须保留泛型参数，不能缩成简单类名。字符串返回值、XML 列、map key、错误码和消息保留实际字面量，不做去前缀、替换、翻译或标点归一化。公开数组规定元素类型；传参数组保持源码顺序，track 集合明确按码点词典序排列。

## 歧义裁决

| 题目 | 公开含义 | 保留边界 |
| --- | --- | --- |
| MYBATIS-03 | guard 表示“生成名已经与用户参数名冲突”的正向谓词，而不是允许插入的 if 条件 | 对防覆盖问题明确请求的布尔含义；不提供谓词代码或正确方法名，不删除模型表达式里的否定号 |
| NOTIFICATIONS-01 | countUnit 的两种合法表示为 subscriptions 和 distinct_channels | 两个语义选项都公开，模型从实现中选择；不是告诉模型哪一项正确 |
| HIKARI-01 | direction 表示完整遍历方向，合法表示为 head-to-tail 和 tail-to-head | 问题的头/尾起点延伸为完整方向，标点固定；不公布源码选择 |
| ADMISSIONS-01 | tracks 是两个返回字符串组成的数组，按码点词典序排序 | 不添加 module/path 对象；检索时仍必须保留两个不同模块的声明 |
| ADMISSIONS-02 | decision 是判定方法，format 是展示状态方法，accepted 是通过时展示的字符串字面量 | format 不是 HTTP/文本格式，accepted 不是布尔决策结果 |
| PAGINATION-02 | arguments 是实际调用中传入字段的简单名称，保留源码参数顺序 | 不带 receiver，不自动排序 |

原标注的必需证据仍全部生效，包括入口、字段和被调实现行。本合同不公布这些私有坐标。rg/list/无源码预览的 symbol 都只提供导航；回答所依赖的实现、字段、helper 和 XML 应按具体缺失事实定向读取。完整文件前缀和重复预览不是默认读取策略。

提交生成器和 validator 使用同一公开约束；被拒绝时只指出违反的公开规则，并保留原提交。最多一次格式恢复，不提供 gold 或缺失必需行反馈。合法提交仍由冻结 scorer 判断答案值与源码证据，合同不能代替评分。

## 版本与历史

原 v1.4 协议原样保存在 [evaluation-protocol-v1.4.json](evaluation-protocol-v1.4.json)。后续评测升级为独立 v1.5，记录本合同文件 SHA-256、实际应用状态、模型与配置。旧 12/28 不回算，新旧协议成绩只作跨轮观察。
