# 性能与生命周期实验

先保证质量和scope正确，再测速度。不要拿源码小片段的milliseconds预测完整仓库。

```bash
python -m harness.scale --files 1000 --output /tmp/java-load-1000
python -m harness.scale --files 10000 --output /tmp/java-load-10000
```

生成物是负载数据，不增加36个quality tasks。每文件12方法，常见process/value词制造宽posting列表；新增rare exact名控制路径。负载manifest写在repo外，避免被检索器读成答案。

## 采样矩阵

同机固定Node/SQLite/磁盘，记录idle、first-open、cold-build、warm-query、single-file-update、comment-only-update、sibling-copy、delete/rename、20并发宽词、idle WAL recovery。warm先确认READY/当前hash，再做5预热与至少50测量；cold至少5次新cache，每次保留原始样本，不用P95掩盖个别timeout。

每样本：elapsedTotal、queueWait、SQL execute、rows/postings visited、JS candidates、sourceBytes、dbBytes/WAL、daemon RSS、builder峰值、JDT RSS、eventLoopDelay。若无法取到某项填null与理由，不从wall time反推。

20并发使用固定到达序列，并保留队列拒绝/超时；不能只对成功请求算P95。既报成功延迟分布，也报deadline-miss与拒绝率。macOS和Linux容器结果不能混为一台参考机。

## SQL实验

先拆exact与suffix；stats移writer；过滤前推；记录EXPLAIN。对posting实现与FTS5实验固定同一语料、分词和排序目标。FTS5自然排序不同不等于错误，但比较是检索算法变化；必须再过质量门禁。只保留一种默认实现。

返回limit=8不证明只访问8条；必须采集实际work计数。若进程内DatabaseSync超时不能打断，worker方案要明确队列、最大运行时、终止/重新创建和连接释放。不得预取全部kg节点去修SQL响应。

## 门槛

150ms static warm P95/20ms event-loop P95/impact≤1.2x均来自本轮工程目标，不是已测结果。未达时先归因，不直接扩大deadline；修复正确性带来的必要成本可以提出例外，但由所有者批准，写进版本化decision，不悄悄改gate。
