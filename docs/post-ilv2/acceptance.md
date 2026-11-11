# 受影响工程门与候选资格（Q11）

下表记录首次交付时的状态。后续 Mac 验收按下方命令记录独立证据。

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

outline 的定向覆盖包括 STALE/NOT_READY 持有视图、FRESH 下覆盖不全、三个阶段的 deadline、共享读取器 deadline，以及 60 方法长泛型文件的 4096 B 上限。`detail=diagnostic` 在同一字节上限内追加 `diagnostic.elapsedMs` 和 `diagnostic.omissions`。计时从等待静态索引开始，截止到公开身份和视图投影结束。省略计数区分 `limitEntries`、`wireEntries` 和保留条目中的 `wireSignatures`。`summary` 不输出诊断字段。

`mcp-server-factory.test` 通过真实 owner 和 MCP 调用校验 SNAPSHOT handle 的 snapshot、manifest、路径和源码哈希，校验 field 的公开身份与紧凑签名，并在新索引发布暂停时并发调用 outline 和 evidence。请求 lease 释放沿用 `request-view.test` 的全量回归。

## 在授权的 Mac 隔离 checkout 上运行

按 [Mac 验证手册 §5.1](../deep/ilv2-mac-manual/verification.md#51-当前可用命令与新增-cli-的边界) 设置冻结 Node、runtime 和 `ILV2_TOOLCHAINS`。在 `MAC_WORK_ROOT/runs` 下登记本次运行根，并将 `TMPDIR` 放在运行根内。运行 MAC-10 链路时设置 `ILV2_MAC10_DATASET` 和 `ILV2_MAC10_INPUTS`，使用数据集冻结时记录的输入文件。`evaluate-java-task --require-identity --dry-run` 可校验原生 MAC-10 schedule，LIVE 仍需适配该数据集的题目、答案合同与评分路径。

评测协议 v1.7 在各臂使用同一份按证据需求选工具的提示词。`java_evidence` 的工具声明说明如何从查询结果传入 Java 锚点，并取得 Java 源码与关联 MyBatis XML。对仓库内置开发题，使用 `--public-answer-contract docs/next-stage/public-answer-contract-v1.0.json` 把字段角色和元素类型发给所有臂。

```bash
git checkout feat/post-ilv2-quality
npm ci && npm run build
node scripts/check-facts-revision.mjs --ack 'EvidenceSource only adds the java-declaration string literal to its TypeScript relation union. It does not change persisted index facts.'
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test \
  dist/discovery/outline.test.js dist/discovery/evidence-unit.test.js dist/discovery/evidence-source-reader.test.js \
  dist/discovery/anchor-windows.test.js dist/java-index/sql/sql-read-ranges.test.js \
  dist/tools/symbol-static.test.js dist/tools/output-shape.test.js dist/mcp-server-factory.test.js \
  dist/jdtls-session.test.js dist/mac-platform/gradle-domain.test.js
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test \
  scripts/ilv2-mac-delivery-receipt.test.mjs scripts/eval-repair-adapter.test.mjs scripts/openai-compatible-chat.test.mjs scripts/ilv2-mac-repair-oracle.test.mjs \
  scripts/ilv2-mac-eval-chain.test.mjs scripts/ilv2-quality-attribution.test.mjs scripts/run-agent-trace-live.test.mjs scripts/evaluate-java-task-arms.test.mjs \
  scripts/eval-evidence-e2e.test.mjs scripts/eval-tool-wire.test.mjs scripts/evaluate-java-task.test.mjs scripts/runtime-artifacts.test.mjs
npm test && npm run gate:pr && npm run measure:tool-schema
```

上述命令全部通过、独立 review 没有未处置的 P1/P2 之后，才能把 engineeringEligibility 改为 ENGINEERING_ELIGIBLE。G14 地板限制照旧披露；skip 白名单和原有 FAIL 保留。
