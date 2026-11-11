# 受影响工程门与候选资格（Q11）

**状态：BLOCKED_ENV / NOT_RUN。** 本轮按用户要求不编译、不测试；Mac 门和私有 raw 都不在本环境，因此三项结论分开给出：

| 字段 | 值 | 理由 |
|---|---|---|
| engineeringEligibility | NOT_ASSESSED | 受影响门未在同一构建上运行，不能写 ENGINEERING_ELIGIBLE |
| benefit | UNMEASURED | Q10 没有 LIVE slot（G0 未满足） |
| deployAuthorized | false | 未获授权；本轮不安装、不推送、不重启生产 |

## 按实际 diff 映射的受影响门

本计划只改了 `src/discovery/{outline,evidence-unit,evidence-source-reader}.ts`、`src/tools/symbol.ts`、`src/mcp-server-factory.ts`（描述文字）和 `src/java-index/java-index-client-api.ts`（一个类型联合）。没有改 snapshot/*、builder、repo-runtime-manager、worktree-cache-cleanup、http-server、JDT 或 native/launcher，所以不需要重跑底座修复的门，也不需要重跑 K26/K28 或 TCC/安装。facts schema 没有变化，但合入前仍要运行 `check-facts-revision`。

| 改动 | 受影响的门 / 测试 |
|---|---|
| outline（Q03） | `outline.test`（选择规则、parseState、源码改动、增量发布后 generation、越界、wire 收缩、deadline）；`symbol-static.test`（FRESH view 下的 wire、STALE/NOT_READY 持有视图、FRESH 下不完整覆盖、limit 与参数组合拒绝、源码改动、无 JDT）；`output-shape.test`（公开 wire 信封与 4096 B）；`mcp-server-factory.test`（五工具、schema，未直接测 outline） |
| evidence v2（Q04） | `evidence-unit.test`、`evidence-source-reader.test`、`anchor-windows.test`、`sql-read-ranges.test`、`symbol-static.test`、`scripts/eval-evidence-e2e.test.mjs`、`eval-tool-wire.test.mjs`、`evaluate-java-task.test.mjs` |
| 共享读取器 | 同上，加 symlink、2 MiB 上限、deadline 用例 |
| 评测脚本（Q01/Q02/Q10） | `ilv2-mac-delivery-receipt.test`（含假模型全链）、`eval-repair-adapter.test`、`openai-compatible-chat.test`、`ilv2-mac-repair-oracle.test`、`ilv2-mac-eval-chain.test`、`ilv2-quality-attribution.test`、`run-agent-trace-live.test`、`evaluate-java-task-arms.test` |
| 其他引用 `javaSymbol` 的测试 | `jdtls-session.test`、`mac-platform/gradle-domain.test`（`npm test` 会覆盖，定向清单也列上） |

Q11 卡要求的 outline 补充用例已写（NOT_RUN）：STALE/NOT_READY 持有视图与 FRESH 下不完整覆盖（`symbol-static.test`）、请求前/查询中/读源码前三处 deadline（`outline.test`）、共享读取器 deadline（`evidence-source-reader.test`）、60 方法长泛型文件的公开 wire 信封与 4096 B 上限（`output-shape.test`）。仍未覆盖：`detail=diagnostic` 的附加计时/省略原因（实现也未做，handler 忽略 detail）、SNAPSHOT 条目经 contentManifestId 铸造 evidenceHandle 的 outline 路径、field 条目的公开 wire。

并发 lease 方面：outline 和 evidence 走的都是现有的 `withContext` 请求视图与 `waitStaticIndexReady`，没有新增 lease 路径。这一点是读代码得出的推断，还要靠上表的测试在 Mac 上确认。

## 在授权的 Mac 隔离 checkout 上运行

```bash
git checkout feat/post-ilv2-quality
npm ci && npm run build
node scripts/check-facts-revision.mjs
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test \
  dist/discovery/outline.test.js dist/discovery/evidence-unit.test.js dist/discovery/evidence-source-reader.test.js \
  dist/discovery/anchor-windows.test.js dist/java-index/sql/sql-read-ranges.test.js \
  dist/tools/symbol-static.test.js dist/tools/output-shape.test.js dist/mcp-server-factory.test.js \
  dist/jdtls-session.test.js dist/mac-platform/gradle-domain.test.js
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test \
  scripts/ilv2-mac-delivery-receipt.test.mjs scripts/eval-repair-adapter.test.mjs scripts/openai-compatible-chat.test.mjs scripts/ilv2-mac-repair-oracle.test.mjs \
  scripts/ilv2-mac-eval-chain.test.mjs scripts/ilv2-quality-attribution.test.mjs scripts/run-agent-trace-live.test.mjs scripts/evaluate-java-task-arms.test.mjs \
  scripts/eval-evidence-e2e.test.mjs scripts/eval-tool-wire.test.mjs scripts/evaluate-java-task.test.mjs
npm test && npm run gate:pr && npm run measure:tool-schema
```

上述命令全部通过、独立 review 没有未处置的 P1/P2 之后，才能把 engineeringEligibility 改为 ENGINEERING_ELIGIBLE。G14 地板限制照旧披露；skip 白名单和原有 FAIL 保留。
