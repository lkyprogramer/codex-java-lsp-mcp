# 执行约束

1. 本包是计划，先核对当前checkout是否仍是基线SHA。超过基线的提交按受影响函数重新审查，不回滚新代码来迁就计划。
2. 不修改正在使用的runtime、生产cache、launcher/TCC、私有Gradle home或用户的全局AGENTS。没有具体授权，不安装、不重启、不推送、不调用付费模型、不外发源码。
3. Mac/arm64/APFS和已冻结工具链是产品边界。附件Python/JDK控制可在其他系统跑，但不能被表述为Mac产品验收。
4. 不启动embedding、向量库、RAG后端、第二daemon、新图数据库、完整Java resolver、自有LLM或多语言扩张。
5. 每任务先写可观察失败，再最小实现，再定向验证。既有行为已满足则记录REUSED_WITH_EVIDENCE，不为制造RED破坏正确代码。禁止仅凭测试数量宣称准确率。
6. 每阶段串行；阶段内无重叠文件才可并行。接口、symbol.ts、索引协议由单一集成者合入。独立review员不能引用自己的实现说明当证据。
7. 不改gold、任务分母、绝对地板、预算或冻结fixture来使新报告转绿。真实标签错误提交label-issue，双方按新版本一起重测。
8. 已经看过的holdout登记为exposed/regression，不再当新盲测。只给产品fixture/任务输入，不给evaluator标签与答案。
9. runtime的`indexView`、workspaceId、contentManifestId、coverage和completion必须保留；同代次数字不证明同字节；局部精确关系不证明全仓穷尽。
10. 不把STATIC_CANDIDATE、JDT绑定、override-family或运行时行为混为一谈。JDT仅按需增强；静态搜索与outline/evidence不能偷偷启动JDT。
11. 计划行不等于收到的源码。只统计最终请求中实际存在且对上hash/范围的source块。重复输入、cached input、reasoning和缺失usage分别记账。
12. 一张卡最多一个效果假设。两次没有新可解释收益，停止叠权重/加模块，回到失败归因。允许NOT_TRIGGERED和NO_GAIN。
13. 不能访问私有raw或Mac时记录UNMEASURED/BLOCKED_ENV。不要“猜”线上SHA，不用旧zip结果冒充新分支。
14. 本轮不恢复旧版本兼容层；用户取消的回滚任务不重新强制加入。有问题停用候选，生产切换需单独具体授权。
15. 输出每任务result.json、commands.jsonl、差异说明、失败原记录；阶段再统一review和必要受影响整测。不得无限重复全量canary直到碰到绿。
