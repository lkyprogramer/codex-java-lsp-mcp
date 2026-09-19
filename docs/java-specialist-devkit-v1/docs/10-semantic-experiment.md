# 可结束的语义发现实验

前置：M0/M1完成，A2改良lexical已稳定，完整公开语料准备好。现阶段没有安装zvec，没有下载任何模型；本文件不是预先裁定它有用或无用。

阶段Z0：并列使用stock zvec，在独立package/进程和固定checkout上运行。固定版本优先采用上位guide核查的e76c89f1e0d0577713fa74b67acc882343fe982d；执行前核实包导出/模型身份，若升级单独记录。主工程依赖树不导入整包。

阶段Z1：adapter只返回provider/path/ranges/rank/providerIndexIdentity/可得的indexedContentHash。当前文件hash无法核对时只能作为路径提示，必须重新读取并定位；不承认旧行号。相似性证据标DISCOVERY_HINT，不标JDT_BOUND。

阶段Z2：有明确增益才接可选provider；exact、position、已知anchor路径不调用embedding。失败/缺模型/离线/timeout安静退回A2，不无限重试；不自动外发源码。

## 实验控制

初轮最多低资源code模型与一个多语言模型。中文query测的是跨语言表达+语料，不是向量库吞吐；若A3多读了正文而A2只索引名称，结论必须是系统对比。能够对齐表示时，比较同一SearchDocument上的lexical/dense/RRF，再决定归因。

unknown-entry任务单独分层；已知名称/stack/route也要做负对照。所有预算等同，provider schema/token开销算入model总账，建库/模型下载/更新成本另列并摊销，不只报warm nearest-neighbor耗时。

## 决策

GO_OPTIONAL：锁定质量/任务收益明确、精确路径无回退、可维护成本可接受。KEEP_EXTERNAL：独立工具足够好，内部融合无净收益。NO_GO：收益不足或代价/误导显著。INCONCLUSIVE：样本/环境/统计不足。

连续两轮没有新的可解释净收益，结束该分支，保留报告，不继续因为路线里写了“向量”就追加平台。T11复杂Java绑定也同样由残余失败触发。
