# MAC-04 — 一个新 schema 和可比较逻辑真值

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** `src/java-index/sql/{schema,sym,rows,facts-store,driver}.ts`、身份生成/引用读写点、新 snapshot manifest schema；新增 `scripts/ilv2-mac-snapshot-equivalence.mjs`。

**步骤：** workspace stat/root 移出事实库；使用 surrogate PK + hash BLOB/原文判等，缩短重复身份和索引键；落实§2.8稳定symbolId与snapshot evidenceHandle的边界。建立不依赖自增行号/压缩字节/插入顺序的逻辑导出与 logicalDigest。旧版本只由离线 benchmark driver 调用，正式读取不带双 schema 分支。

**验收 G04：** hash 碰撞注入仍保存两个不同实体；大 hash 不经过 Number；safe integer 边界和 orphan FK 被拒绝；编码往返、Java/XML 事实、关系/coverage 逻辑导出正确；改变工作区stat/root不重写共享事实库；命名symbolId在同workspace无关编辑/行位移/full重建后保持稳定，源路径/签名改变或删除才失效；跨workspace不能误绑定。删除D08中本卡负责的旧路径（边界见下文）。字典压缩不列入本卡硬任务。

**D08收尾边界：** 上述删除目标由多卡共同完成，G04不代表D08整体关闭。当前显式残留①发布元数据页由MAC-07 + MAC-08B消除，②框架adapter进程内alias由MAC-13消除；各卡仍须交付对应删除与验收证据，见[删除账本](../ledger.md)。历史G04结果中的②“待指定owner”保留为当次验收记录，当前归属以账本和MAC-13卡为准。

**MAC-00实测约束（旧布局，lishu-v2，[MAC-00结果](../../../index-lifecycle-v2/mac/mac-00/task-result.json)）：** 封闭基线DB 779,632,640 B（约190,340个4 KiB页）。B20/B200实际解析20/200个文件、affected 109/856，逻辑页差分别为21,435/59,476页，约占全库11.3%/31.2%，已超过10%/30%默认物理门；A只重戳5,887行stat就改动1,800页、耗时约7.5 s。这些是逻辑页结构归因，物理COW比例为INVALID_EXPERIMENT，不能当物理基线。本卡的schema须让：stat/root变化0页写入事实库；单文件变化的页写入只随受影响行/索引增长，而不随全库身份字符串/全表索引增长。G04增加一项结构自测：在合成库上测20/200文件变化的逻辑页差，报告各表/索引占比，作为MAC-05薄切片的预期；它不是物理门PASS。
