# MAC-12 — 只实现测量支持的收益项

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** MAC-11 明确的热点与其定向测试；目标 schema 在 MAC-17 前一次定版。

**决策顺序：**

1. 如果少量变化仍重写大量 DB 页，先缩小受影响关系/索引更新，删除全表重戳/重建；不能只加解析并行掩盖写放大。
2. parse 占 full CPU/墙钟关键路径 ≥ 30% 才试 {1,2,4} worker；逐文件 logicalDigest 一致，选满足资源与延迟门的最小池。
3. 在真实多 worktree trace 中潜在语法复用率 ≥ 30%，且 parse 确为热点时试内容寻址语法缓存；位置无关 payload 与绑定步骤分离，损坏项明确重算，加入 schema/version/hash 与 GC 合同。
4. 只有 dbstat/profile 表明 facts 编码是主要空间项才试字典压缩；与现有 deflate 比总物理增长、解码 CPU、seed/查询 p95，不只比较 JSON 长度。

**验收 G12：** 每个采用项相对 MAC-11 同输入至少改善其目标成本 20%，逻辑/coverage 一致、查询和编辑可见 p95 不劣于 1.1 倍且仍满足绝对门；重复 ≥ 3 次。达不到则删除试验代码/配置，记 NOT_RUN 或 FAIL 决策证据，不留双实现。G12 以及最终 G14 必须满足 §6 全部适用工程性能硬门，包括 0/20/200 物理门、full/seed、公平性和编辑可见；不再保留“350 MiB 逻辑尺寸唯一通过条件”。

**MAC-00旧profile给出的先验（不替代MAC-11新profile）：** 旧full里parse只占约18%墙钟，低于第2步的30%门槛，graph-search约58%、resolve约22%（[MAC-00结果](../../../index-lifecycle-v2/mac/mac-00/task-result.json)）。所以旧数据不支持先做parser并行或语法缓存；若MAC-11新profile仍是图/搜索重算为主，先做第1步写放大与闭包收缩，再看图/搜索阶段的增量化。只有新profile显示parse≥30%时才进入第2/3步。
