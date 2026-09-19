# 统一评测协议

## 三条独立轨道

R：检索/区域选择。输入任务和源码，输出声明与ranges；不要求模型答题。Q：结构化QA，必须有正确answer及经过源文本核验的read_events。P：真实修复，Agent产生patch后，由evaluator在干净副本运行冻结Java断言。

R的高分不代表Q通过；Q通过不代表P通过。`regions`是计划/选择，不自动当已读。`read_events`必须包含实际传给Agent或由其读取的完整源文本，text必须匹配hash与范围；summary不算源文本。录制器来自可信harness，不接受SUT自报的task_success。

## 运行包

结果是一个JSON对象，schema=java-specialist-results/v1，含dataset_hash、run_profile、arm、source_sha、results。run_profile固定corpus_hash、variant_set、repeats、evaluation_mode、模型/宿主/预算/冷暖条件。单条结果以task_id+variant+repeat唯一；缺失补MISSING，额外/重复ID报错。

检索对照mode=retrieval，QA指标为null/UNMEASURED。真实QA/Agent模式设置evaluation_mode=structured-qa或agent；同时固定模型ID、宿主、generation设置、预算和录制器版本。禁止把baseline无模型和treatment有模型直接比较QA成功率。

## 建议实验臂

A0当前源码；A1修身份/anchor；A2静态发现+源表示；A3=A2加可选dense。Z为stock zvec完整产品对照。先做A0/A1回归，再做A1/A2效果；A2稳定前不启动A3。相同representation才可以归因embedding单因素，stock Z只能比较整套系统。

## 冷暖

`run-adapter`每attempt创建全新任务stage，默认测隔离检索正确性及adapter总耗时；不等同warm SLO测量。真正warm需要先固定同一stage和READY索引，多次执行、不修改语料，并分离首次建库。每次新MCP进程的startup、每仓build、query执行、model加载均单列，不静默删除。

## 对照公平性

同一task、同一语料hash、同一基础prompt、同一模型与宿主、同一turn/token/wall预算。两臂保留原生rg/read/build，允许Agent不使用MCP；工具schema/使用说明只添加一般性规则，不泄漏目标文件。运行顺序AB/BA交错，记录repeat ID；三次repeat不算三道任务。

## 实验pilot

configs/experiment.json固定12个dev任务，2臂×3repeat=72attempt，不是72独立任务。先一个模型，方向稳定再扩大36任务或第二模型。模型/网络授权仍需明确，包内不附带自动花费代码或APIkey。

## 结果归档

保存输入manifest、source preflight、参数、原始输出、score报告、坏case归因、资源记录、review结论。报告hash锁定源码/评分器/标签。失败、超时、环境错误分别统计但不从任务分母消失。环境失败使该轮不能做强算法结论，应修环境后完整配对重跑。
