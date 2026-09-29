# 修复后还能优化什么：按收益排序，而不是按新技术排序

## 第一优先：消除错误与不可信证据

R01/R02/R05/R06/R08属于正确性，不以提速或recall高多少为前提。scope错误和source路径错会误导agent；wire丢失会使再强的retriever也失效。先修这些，暂时停止更换更强模型解释零修复。

## 第二优先：让已有词法表示更完整、更便宜

现有文档已经包含comment/signature/framework，下一步是把**匹配的那个文档**的路径、range、原因交到Agent，而不是总给声明头12行。中文业务意图可利用现有JavaDoc、route/statement/key，无需先embedding。改变一个XML或注释应只更新相关doc/stats，不重算整仓；保持同generation事务。

同一type下的多个method由剩余任务词竞争，exact/identifier与comment/framework通道rank融合按小规模dev实验判断。目前按路由轮流拿rank的round-robin不等于RRF，不能给它未实现的算法名。先保证合理候选入池与scope，再比较rank策略；不用增加一堆魔数。

## 第三优先：减少实际重读，而非仅减wire长度

将源码片段的命中行与必要签名一次返回；重复的class header去掉。同文件多候选复用一次request读取/校验；累计preview有byte预算。度量actual repeat-read calls、首次有效入口rank、received key-line recall和provider累计usage。不把“每个tool少两百字”当作任务总成本优化。

若有力证据表明readPlan只列位置造成重复read，就比较signature-only和短原文preview两种renderer；两臂模型工具不变、最终预算一致。不重新增加server端多轮Context Engine，Agent本来就能决定后续阅读。

## 第四优先：物理SQL优化

观察scoped common-token请求的visited postings、候选数、sort、previewIO和event-loop。采用EXPLAIN验证pointlookup、索引过滤是否真生效；输出top8不说明底层只访问8条。优先scope pushdown/stats和topK有界算法；只有测到主线程阻塞才单readonly worker。不为无证据的百万行目标重写整个引擎。

任何可能返回部分结果的优化必须给coverage/stopReason，不能为了低P95丢掉难查询而从统计分母删除。重要度高且超预算的任务可以显式让Agent缩scope或增budget，而不是静默假阴性。

## 第五优先：有限Java精度

重复FQN/overload/static dispatch失效样例先构造，再判断应补源码scope、JDT binding还是framework来源。若按需JDT能解决，就不新建JDT Core侧车/SCIP主索引。将静态推断、compiler binding、runtime observation严格分层，不承诺Spring profile在未知部署环境下唯一注入。

## 最后：可选向量是否值得

同预算有效实验之后，dense可能帮中文未知入口，也可能只复现词法候选。GO_OPTIONAL应由新的、可复现的任务收益支持。任何结果都无需改变Java-only定位；KEEP_EXTERNAL甚至彻底不维护该实验包都是合理选项。不能把本次发现的cache/评测bug解释为“向量一定无用”或“修完一定大幅提升”。

## 小项目的开发资源分配建议

先完成S0–S2，再补K32，不在多个新模型/新存储上同时下注。每个改动包含它关闭的反例、原有无回退范围、维护成本。下一批任务只从新有效轨迹里高频失败的环节选；没有证据就停止优化，不为了路线图完整填功能。
