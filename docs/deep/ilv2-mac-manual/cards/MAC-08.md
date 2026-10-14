# MAC-08 — 正式接入、旧路径删除与早期回归（分卡验收）

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** `repo-runtime-manager.ts`、`mcp-server-factory.ts`、`application.ts`、`agent-router/java-index-router.ts`、`java-index-client-api.ts`、`sql-client.ts`、stdio/HTTP入口、受影响K/三仓drivers。

| 子卡 / 门 | 依赖 | 实施与目标测试（均待实现，经§5.1入口） | 完成判据 |
| --- | --- | --- | --- |
| MAC-08A / G08A | MAC-05、MAC-06、MAC-07 | budget→prepare→一次acquire→query worker→preview→取消/释放；`dist/java-index/snapshot/request-view.test.js`：`nonzero-deadline-bounds-all-stages`、`publish-does-not-upgrade-held-view`、`symbol-id-survives-unrelated-publish` | resolve/create/SQL/preview挂起均有界且收敛；hash/coverage/标签同view；NOT_READY/PARTIAL正确；跨请求稳定符号ID成功 |
| MAC-08B / G08B | MAC-08A | stdio只转发、status纯读、新调用图与旧runtime同提交替换；MCP合同测试`status-only-does-not-bootstrap`、`stdio-http-share-one-owner` | 删除D01/D04/D05和D09运行时部分（IDLE_WARMING、先acquire后fresh、无取消race）；保留有效业务断言；guidance文字留MAC-13 |
| MAC-08C / G08C | MAC-08B | 前移K29的新版driver及三仓runner/verifier合同适配；运行容量和三仓门 | 新query池/IPC/lease/preview被负载经过；1000文件/20并发/p95≤150ms/eventloop≤20ms；三仓质量无回退、每cell 5次且严格p95比≤1.25，无+50ms宽限 |

G08C不沿用绕过新query池的旧SQL直连benchmark冒充请求路径证明；输入/并发/样本分母相同，计时覆盖请求进入到返回。命令用§6.3，task-id取`mac-08`且run-id新建；K容量选`--cases K29`，无需JDT输入。同步修runner的selected-only退出码/汇总测试，不把其余NOT_RUN算全K PASS。

当前三仓verifier实际采用`newP95 ≤ max(oldP95 × 1.25, oldP95 + 50ms)`，`--p95-limit 1.25`本身不能证明本计划的严格比例承诺。MAC-08C对本计划新版contractVersion落实`newP95 ≤ oldP95 × 1.25`，记录实际old/new/ratio/判定策略，runner内验收与独立verifier必须共用该合同；历史报告保持原式，不重标。增加100→140 ms必须FAIL、100→125 ms通过及旧合同不能冒充新门的反例；无效/零基线标INVALID_EXPERIMENT，不静默除零或加宽限。其余三仓质量断言、采样/分母和主机政策保留；修改当前合同/runbook的适用版本说明，不能混用历史宽限解释新PASS。

父门G08为三子门全部PASS。失败先修直接回归再进入MAC-09；MAC-14在最终候选复用身份未变且仍有效的证据，source/native/runtime/driver或直接影响行为变化才重跑，不能仅凭任务号不同就强制重复。
