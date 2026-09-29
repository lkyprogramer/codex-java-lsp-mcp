# 可结束的语义发现实验 v1.1

## 先做判定修正，不再追加模型

当前T10数字必须保留原始名称/版本并标 `INVALID_EXPERIMENT_FOR_CAUSAL_CLAIMS`。安全工程决策仍可 `KEEP_EXTERNAL`（不进入生产依赖）；但不能继续宣称已证明“对齐表示、零回退、无伤害、模型封顶”。scope/身份/证据交付仍有问题，先修A2才有合理增量对照。

## 两个不同问题，两套实验

**产品增量问题：**相同Agent原生工具下，A2静态发现能否比native baseline少绕路且更正确？A2/A3前先完成这一对照。native具备list/rg/read/build/test，不是read-only孤立工具。索引预建成本另列，不将被测静态工具强制为入口。

**dense机制问题：**同SearchDocument文本、同scope、同候选/源码预算，dense是否补到A2未发现的正确入口？A2=词法，A3=词法+dense经RRF融合。candidate K=10；source160行/16000字节；query maxTokens等固定；class/method去重同declarationId；两臂相同片段renderer。候选路径缺范围不计line coverage。

若native zvec产生不同chunk/正文和检索输出，作为第三个**系统级**外部工具profile，不归因单一embedding。没有必要为了完成任务再次下载zvec或接入三个模型。当前实验包可保持禁用；完成offline缓存/取消测试后，最多一个provider一次预注册pilot。

## 可执行算法约束

```text
A2 candidates = bounded lexical(query, scope)
A3 pool       = union(A2 candidates, bounded dense(query, scope))
A3 candidates = RRF(rank_lexical, rank_dense, k0=60).dedup(declarationId).top(10)
A2 evidence   = sameRenderer(A2 candidates.top(10), sourceBudget)
A3 evidence   = sameRenderer(A3 candidates, sourceBudget)
score         = frozen evaluator(actual file/hash/ranges)
```

cap是总预算，不是每通道最终返回预算。不存在同一候选时不写排名0加高分，未出现通道贡献0；同doc多个hit按declaration去重，source相关度仍有出处。k0=60是冻结初值而不是宣称最优；调参只能dev一次，locked不可反复选择赢家。

## 冷热一致性先决条件

同文件两个方法不同文本：cold、内存hit、disk reload得分与向量一致；改变一个method body/comment只使其representation缓存失效。切endpoint/model/revision/dim全部隔离；相同contentHash不同声明不能共用entry。provider响应非finite值、dimension错、索引重复序号、部分batch、JSON body超时、离线、缓存损坏必须可解释降级到A2。

sourceHash失配只可返回path hint或DROP，旧range无效。无hash的candidate不得加WholeFile覆盖；旧工作树同名文件必须过滤。真实API调用/授权由配置独立约束，不把环境变量存在当授权。

## 四向结论与补充状态

| 主决策 | 需要支持的事实 |
|---|---|
| GO_OPTIONAL | 同预算未污染任务中净质量/成本收益，并通过缓存、freshness、离线与资源门禁 |
| KEEP_EXTERNAL | 独立工具有使用价值但内部融合不划算，或明确不承担其维护面；不能附未证实的“无害”结论 |
| NO_GO | 有效实验未产生足够增益/存在可复现回退且成本不接受 |
| INCONCLUSIVE | 样本不足、置信区间宽、任务效果未能分离 |

INVALID_EXPERIMENT 是本轮证据有效性状态，不用强行塞进上述产品决策；先修协议，再产生四向结论。失败成本保留；成功为零时cost-per-success不可用。

延续原devkit建议：dense Recall@10 +0.10，或达到事先定义高价值任务改善；真实input usage中位数ratio≤0.85需完整usage和质量不回退。小样本门槛只是筛选信号，必须按task/corpus分组bootstrap与逐任务方向报告；同一8工程里的24任务也非完全独立。任何所谓“无伤害”需要预注册非劣界与足够证据，未显著区别不等于证明等价。

## 停止条件

只有“wire正常、scorer一致、cache冷热一致、预算对称、A2静态正确”之后才跑真实dense。一次pilot + 一次经批准确认仍不清晰，关闭为INCONCLUSIVE/KEEP_EXTERNAL，不继续换更大模型等待好分数。新功能没有可解释incremental benefit时，保留报告而不是保留永久复杂代码。
