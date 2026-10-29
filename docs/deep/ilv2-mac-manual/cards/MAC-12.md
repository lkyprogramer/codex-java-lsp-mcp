# MAC-12 — 只实现测量支持的收益项

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** MAC-11 明确的热点与其定向测试；目标 schema 在 MAC-17 前一次定版。

**决策顺序：**

1. 如果少量变化仍重写大量 DB 页，先缩小受影响关系/索引更新，删除全表重戳/重建；不能只加解析并行掩盖写放大。
2. parse 占 full CPU/墙钟关键路径 ≥ 30% 才试 {1,2,4} worker；逐文件 logicalDigest 一致，选满足资源与延迟门的最小池。
3. 在真实多 worktree trace 中潜在语法复用率 ≥ 30%，且 parse 确为热点时试内容寻址语法缓存；位置无关 payload 与绑定步骤分离，损坏项明确重算，加入 schema/version/hash 与 GC 合同。
4. 只有 dbstat/profile 表明 facts 编码是主要空间项才试字典压缩；与现有 deflate 比总物理增长、解码 CPU、seed/查询 p95，不只比较 JSON 长度。

**验收 G12：** 每个采用项相对 MAC-11 同输入至少改善其目标成本 20%，逻辑/coverage 一致、查询和编辑可见 p95 不劣于 1.1 倍且仍满足绝对门；重复 ≥ 3 次。达不到则删除试验代码/配置，记 NOT_RUN 或 FAIL 决策证据，不留双实现。G12 以及最终 G14 必须满足 §6 全部适用工程性能硬门，包括 0/20/200 物理门、full/seed、公平性和编辑可见；不再保留“350 MiB 逻辑尺寸唯一通过条件”。

**封存合同（方案 B，`733ea9f4`）：** 移除无生产消费者的 manifest 全库逻辑摘要并拒绝旧格式的事实保留；当前 manifest 为 `ilv2-snapshot-manifest/mac3`。full 构建在绑定前执行全库校验；克隆 base 的 delta/rescan 在绑定前检查 checkpoint、无 sidecar、census/pipeline/schema 和本次写集的引用、安全整数及 facts 可解码；其余全库完整性、外键、未改动行和文件 sha256 由后台校验完成。FAILED 隔离与 full 重建遵循[合同§2.7](../contract.md#27-封存绑定读-lease-与-gc)，离线 full/delta 逻辑 oracle、原子发布和 lease/GC 不变。收益计时包含各路径实际 verify、manifest 与持久化成本，不能仅凭 manifest 降耗判 G12 通过。

完整性校验若并行化，须保持固定全局 worker 上限。full 和后台全库校验仍须覆盖 global quick、完整 schema 逐表 integrity 及损坏拒绝；不得以 quick-only 或部分表替代。结果须收齐，失败/取消须等待 worker 真实退出，读取期间文件变化不得发布；这些要求不把 delta 写集检查恢复成无差别完整封存。

**当前身份修复：** 方法键改为 `method:v3:<owner>#signature`，`identityVersion=3`、`factsRevision=6`，外层 `jsym:mac1` 不变。旧 method key（含 mac1 包裹）返回 `REJECTED` 并提示重新定位，mac1 包裹的旧键为 `reason=MALFORMED`，不设别名；type/field ID 保留。修正参数类型与声明符数组维度、带注解 varargs，旧库和缓存按现有版本机制重建。开发验证与正式门状态见 MAC-12 结果文档；开发测试不替代 G12 正式证据。

**最终验证流程：** 一次正式构建，定向集执行一次；复用同一冻结产物完成三次必要性能测量，再做独立评审、必要的最窄复验和统一 closeout，不做三次无关全量回归。有效样本边界仍为 `load1 < 20`；`load1 < 10` 只用于起跑安静条件，不能删除 10–20 的慢样本。20% 收益相对 MAC-11 同输入基线，不要求相对前一个小候选再改善 20%。

每组独立保留原始结果和全部样本。若主测硬门通过、唯一失败是有效样本不足，可用现有 supplement/reanalyze 只补该组缺口；原始 FAIL 不改写，补测仍为 NOT_GATED，合并后逐项验收该组。第二、第三组不得借用第一组样本或通过跨组混合分位数掩盖失败。长测及其结果检查一次顺序调度，起跑等待放在有界后台脚本中，定时任务只读简短进度；失败停止，不自动重试、不重复构建或生成新的等待脚本。

**查询非退化口径（用户决定 D1-a，2026-10-29）：** 每对比较中，候选固定探针查询 p95 ≤ max(1.1 × 基线 p95, 基线 p95 + 10 ms) 即通过，仍须满足 §6 绝对门；编辑可见 p95 ≤ 1.1 倍、目标成本至少改善 20%、三对各自通过的要求不变。此为候选失败后经用户明确批准的放宽（§6.1），批准人 lky，依据为该日答复"D1:a"；原 1.1 倍口径下的首对 FAIL 保留。同日决定 D2：本次最终测量后 G12 收口，之后只有正确性、隔离、截止、资源类失败回到改代码。

**MAC-00旧profile给出的先验（不替代MAC-11新profile）：** 旧full里parse只占约18%墙钟，低于第2步的30%门槛，graph-search约58%、resolve约22%（[MAC-00结果](../../../index-lifecycle-v2/mac/mac-00/task-result.json)）。所以旧数据不支持先做parser并行或语法缓存；若MAC-11新profile仍是图/搜索重算为主，先做第1步写放大与闭包收缩，再看图/搜索阶段的增量化。只有新profile显示parse≥30%时才进入第2/3步。
