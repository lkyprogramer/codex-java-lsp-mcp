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
git checkout main  # feat/post-ilv2-quality merged via PR #4 (88e6f4a) and deleted
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
  scripts/eval-evidence-e2e.test.mjs scripts/eval-tool-wire.test.mjs scripts/evaluate-java-task.test.mjs scripts/runtime-artifacts.test.mjs \
  scripts/eval-mac10-live.test.mjs scripts/eval-frozen-adapter.test.mjs
npm test && npm run gate:pr && npm run measure:tool-schema
```

上述命令全部通过、独立 review 没有未处置的 P1/P2 之后，才能把 engineeringEligibility 改为 ENGINEERING_ELIGIBLE。G14 地板限制照旧披露；skip 白名单和原有 FAIL 保留。

## Q10 MAC-10 LIVE 前置（D11）

`b96a9c1` 之后的提交只改了 `scripts/` 和文档，`src/` 没动，server 构建身份不变。下面几步全部不调用模型，按顺序在同一 Tier-1 候选（`--reuse`）上执行，环境按上节设置。另需 `ILV2_TOOLCHAINS`（冻结 JDK，适配器会逐个核对 javaHome 下文件的 hash），以及与数据集冻结时一致的 `ILV2_MAC10_DATASET` 和 `ILV2_MAC10_INPUTS`。`ILV2_MAC10_INPUTS` 里每个输入 checkout 必须停在冻结 head，且 `git status --porcelain --ignored --untracked-files=all` 为空；否则适配器拒绝运行。如果冻结输入里有构建目录，需要先另做一份干净的 checkout，并在新的 inputs 记录里指向它（head 和 manifest 不变）。

1. 脚本套件：上节第二条命令（已加入 `eval-mac10-live.test.mjs` 和 `eval-frozen-adapter.test.mjs`）。
2. 冻结数据集上的模型无关全链：`node --test scripts/eval-mac10-live-chain.test.mjs scripts/ilv2-mac-eval-chain.test.mjs`。用的是真实 APFS 物化、`dist/server.js`、FRESH 就绪等待和 javac oracle。每个 pinned dev 题都要满足：QA 走 b2 路径（outline 加读取，用 gold 脚本化提交），必须 taskSuccess；repair 在 control 臂写入冻结修复后必须 `VALIDATED_SUCCESS`，不改动则必须 `TEST_FAILED`；在 b2 臂写入修复后也必须 `VALIDATED_SUCCESS`，候选里只改了 oracle 文件，并发生两次就绪等待。最后这一项用来确认 product session 不会往候选里写文件，否则 product 臂的 repair 会被系统性判为越权。汇总写入 `$ILV2_EVIDENCE_ROOT/mac10-live-chain.json`。
3. oracle 稳定性：`node scripts/ilv2-mac-repair-oracle.mjs check --dataset "$ILV2_MAC10_DATASET" --inputs "$ILV2_MAC10_INPUTS" --split all --repeats 3 --java-home <toolchains.json 的 javaHome> --out "$ILV2_RUN_ROOT/oracle-check"`，exit 0 且 status=PASS。
4. LIVE 矩阵的严格 dry-run（冻结 schedule，不发请求）：

```bash
node scripts/evaluate-java-task.mjs --dataset "$ILV2_MAC10_DATASET" \
  --tasks <dataset>/tasks-dev.jsonl --gold <dataset>/private/gold-dev.jsonl --inputs "$ILV2_MAC10_INPUTS" \
  --source-budget <none|LINES:BYTES> --pilot 12 --pilot-seed <seed> --arms b0,b2 --repeats 3 \
  --require-identity --server-js dist/server.js --dry-run --output "$ILV2_RUN_ROOT/q10-dry"
```

   期望 exit 0，`results-pack.json` 中：`identity.identityCheck.status=VERIFIED`、`denominator=72`、`identity.pilot.taskIds` 12 个、`identity.mac10.corpora` 与冻结输入一致；有 repair 题时还要求 `identity.mac10.java` 非空且 `frozenFiles` 大于 0。`identity.indexReadyTimeoutMs=900000`。缺 `--source-budget`、同时给 `--repo-roots`/`--kit-root`、pilot 超出题数时 exit 2，且不写 schedule。

以上四步通过后，Q10 LIVE 的工程前置才算满足。真正发出 LIVE 请求（去掉 `--dry-run` 并配置 `OPENAI_*`）属于产生费用的操作，需要用户单独授权，并先确定预算、split 和 seed。

### Mac 执行结果

在 `d7a295e4` 的同一个隔离候选上，本地无模型验证通过。定向脚本 201 项、源码定向 67 项、真实 MAC-10 链路 2 项全部通过，无失败或跳过。真实链路包含 5 个 oracle 的正确和错误版本各重复 3 次。3 个 B2 修复控制均只改了 oracle 文件。

严格 dry-run 以 `20261105` 固定选题和执行顺序，使用 QA 源码上限 `80:16000`，冻结 72 个 slot。三仓与 JDK 身份核对通过。缺预算、冲突 repo roots、冲突 kit、超额选题、server 缺失五个负例均退出 `2`，未写 schedule。真实 B2 MCP 返回的 Java 和 XML 证据也通过了假 transport 的最终请求回执校验。命令、退出码和产物哈希见 [Q10 结果](results/Q10.json)。

### 正式 LIVE 验收（D13）

MAC-10 dev 的 12 个任务组各跑 B0、B2 两臂，每臂重复三次。冻结的 72 个 slot 全部返回结果，进程退出码为 0，正式矩阵内共 474 次串行模型请求。66 个 QA 最终请求的 222 个源码单元通过独立回执复验。76 个索引会话都有查询计数差值。B2 的一个 QA slot 达到轮次上限，按失败计入。使用的模型和预算见 [v1.8 协议](../next-stage/evaluation-protocol-v1.8.json)。

B0 通过 11/36，B2 通过 15/36。按任务组配对的差值为 +11.1 个百分点，95% bootstrap 区间为 −2.8 至 +27.8 个百分点。三仓方向不一致，B2 每 slot 的输入 token 中位数增加 18.0%。运行验收为 `PASS`，收益判定为 `INCONCLUSIVE`。见 [Q10 结果及原始产物哈希](results/Q10.json)。

## 最终候选无模型验收（D14）

以下结果对应已推送的冻结候选 `13f9dc9a`。主分支合同对照使用 `665d66e`。

| 工程门 | 结果 |
|---|---|
| `npm test` | 2,363 通过、0 失败、10 个既有条件跳过，stdio smoke 通过 |
| `npm run gate:pr` | 1,654 通过、0 失败、1 个既有条件跳过 |
| `npm run measure:tool-schema` | 5 个工具，共 9,086 B。 `java_symbol` 为 3,532 B，比主分支增加 649 B |

三项命令均退出 0。后台原始汇总把四条通过的嵌套候选登记计入顶层记录，数量断言报错并保留为 `FAIL`。离线复核验证了三项入口的 455 个编译文件逐字节一致、10 个条件跳过项符合历史白名单。当前候选的工程门为 `PASS`，独立评审尚未执行。见 [Q11 最终候选记录](results/Q11.json)。

真实 MCP 对照中，evidence v1/v2 均接受坐标和 `symbolId`。实测样例的旧 XML 单元字段、源码和哈希一致。v2 另加 Java 声明、`role` 与 `proof`，并更改了 `schemaVersion` 和 `supportedScope`。严格匹配 v1 的调用方需要适配。见 [Q11 合同对照](results/Q11.json)。
