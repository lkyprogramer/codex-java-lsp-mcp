# 数据集卡：Java Specialist Bench 1.0

## 构成与来源

36 个任务组：24 个原创完整 fixture 任务（8 个小型 Java 工程，每个3任务）+12 个公开源码范围任务（4 项目，每个3任务）。24 dev、12 locked；每任务中文原句和英文改写共72查询。28结构化QA，8冻结repair。三个工作流 entry/impact/debug 各12任务。

公开来源固定为 PetClinic 818c4136、MyBatis 78bb677e、Gson 828a97be、HikariCP 98bd21c8；完整SHA与逐文件blob校验见 provenance/upstream.json。随包每公开项目只有一个原始源文件，不包含完整项目或完整编译依赖；为了避免伪造源码，文件内容保持原字节，Git blob SHA已核验。

full 模式通过 `hydrate-public` 获取完整固定 checkout 并校验这些种子文件。相同任务在更大语料里才能检验真正未知入口的发现能力；corpus_hash变化，必须作为独立 profile。full 获取脚本是随包可执行工具，但本次网络受限没有完成下载，也没运行上游测试。

## 独立性含义

不依赖 lishuedu/cipherlink/exam-parent-v3，不使用它们的规则或gold，不需要它们的路径与凭据。它不是经第三方独立标注/认证的行业标准集；作者知道任务与参考答案，且原创fixture刻意针对机制。12个cluster内部任务相关，中英文/多次repeat不是新独立样本；原创多个场景还可能共享作者风格。

## 任务与标签

公开任务在 prompts/*.jsonl：任务描述、语言变体、预算、输出键类型、必要显式anchor；不含 gold ID、答案或补丁。gold/*.jsonl：targets、required_evidence、optional_evidence、answer、edit_targets、标注状态与理由。

`targets` 是可定位声明（path+声明起始行+name），不是任意出现该单词的调用行。`required_evidence` 是用于解释/判定的源码范围。`edit_targets` 只约束修复任务允许改动的位置，不等于所有要阅读的文件。

## 覆盖

原创语料涵盖幂等键、库存预留、过期边界、跨模块同FQN、金额舍入、订阅隔离、余额状态、整数溢出；包含多文件调用、XML字段映射、中文注释、长方法与同名/关键词干扰文件。契约fixtures额外含record、nested/local、重载、CRLF/Unicode、解析错误、配置canary与多态静态目标。

## 明确缺口

核心36任务未覆盖真实Spring容器装配、完整MyBatis运行、Lombok/APT、复杂多模块classpath、分布式事务或数百万行持续索引。32条机制规格里的运行时场景也不是全部已实现的自动测试；实际已有的12个source probes与待补集成项分开列示。

36任务可作为稳定开发验收起点，不能支撑“超过业界工具”“Java语义全面正确”之类结论。发布性能/泛化主张至少增加完整公开语料、真实模型轨迹和独立标注复审；必要时在新版本增加第三方真实issue任务，不混成原版分母。

## 版本与许可

数据集变更必须生成新 manifest/hash并两臂重跑。不因为candidate失败降低required集合。新编写语料/工具按根LICENSE，公开文件保留Apache许可头；source-guide是用户来源参考材料，不作为公开源码重新授权。
