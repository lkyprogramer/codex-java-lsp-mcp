# `$TMPDIR` 历史证据提炼记录（2026-10-13）

原 `$TMPDIR`（`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/`）下 20 个工作目录共 12,432.9 MiB、194,217 个文件（du 口径约 12.6 GiB），来自 2026-10-11/12 的 7 条工作流。各工作流的结论在完成时已写入 `docs/next-stage/` 的 plan/review 文档。其中尚未进入仓库的原始记录共 3,473 个文件、67.8 MiB，压缩为 `unique-raw.tar.xz`（2.6 MiB）；`manifest.json` 记录每个原目录全部字节的去向。

这两个文件只保存在本机，不进入仓库：`/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/tmp-distill-2026-10-13/`。原因是它们属于原始记录，并且其中 agent 会话记录含输入业务仓库的源码片段。

## 去向

按 sha256 判定。去重基准是生成时的仓库工作区，包括已跟踪文件和当时未跟踪的 `docs/next-stage/*-evidence/`，不含 `.git`、`node_modules` 和 `dist`。

| 去向 | MiB | 内容 |
| --- | ---: | --- |
| 可再生缓存与副本，未保留 | 8,126.8 | JDT LS 私有 home 及其 Gradle 缓存 2,629.4，私有 `gradle-home` 2,048.0，未使用的 Gradle seed 1,083.6，`node_modules` 14 份副本 1,071.4，候选 clone 的 `.git` 844.9，JDT workspace 445.4 |
| 仓库工作区已有逐字节相同副本 | 3,891.5 | 候选源码树里的仓库文件，以及已拷入 `docs/next-stage/*-evidence/` 的记录 |
| 丢弃 | 346.8 | 运行期缓存（MCP 索引缓存、node compile cache）300.9，源码副本中的旧版本文件 24.8，SQLite 索引 11.3，编译产物 7.0，测试临时 fixture 2.9 |
| 本机归档 | 67.8 | `unique-raw.tar.xz` |

## 工作流与结论

| 原目录 | 原大小 MiB | 结论文档 | 判定 | 归档内容 |
| --- | ---: | --- | --- | --- |
| `codex-java-jdt-readiness-ua9mfgpr` | 6,345.3 | [JDT 导入就绪](../../next-stage/jdt-import-readiness-review.md) | 修复并安装 `83aa814049e5`；6 个 focused 与 146 个相关用例 PASS；cipherlink A/B 中基线复现 unsafe lock，串行导入组无该错误 | 69 个文件：根目录日志、补丁、安装与评审记录，各轮 `result.json`，agent 答案 |
| `java-lsp-runtime-integrity-cs6vd1k0` | 1,378.8 | [Runtime integrity 验收](../../next-stage/runtime-integrity-release-review.md) | R12 31 PASS / 1 FAIL，R13 NO_GO；release profile 1335/1335 源码测试、368/368 脚本测试 | 307 个文件：`runs/` 下 JDT red/green、live-model 冻结评分与 judge 原始记录 |
| `java-lsp-qa-release-t14dzuaq` | 917.5 | [QA 合同发布验收](../../next-stage/qa-contract-release-review.md) | 生产替换为 `8f737ac7cd14`，health/ready 与五工具 smoke PASS；原检查器仍为 `ELIGIBLE_FOR_MANUAL_REVIEW` | 28 个文件：perf probe 变体、中间候选 `c022bb76fe5c` 的 12 个独有文件版本 |
| `java-lsp-k29-remediation-uHvCvY` | 305.2 | [K29 修复结果](../../next-stage/k29-remediation-review.md) | K29 仍 FAIL；严格 QA 未达 80% 门槛 | 76 个文件：live-full / live-smoke 的模型请求、工具结果、attempts、results-pack |
| `codex-java-agent-guidance-i7fjv7b9` | 105.8 | [Agent 指导与 hook](../../next-stage/java-agent-guidance-review.md) | 安装 `48bad915c854`；4 个真实 agent 会话 3 PASS + 1 PARTIAL | 59 个文件：安装日志、修改前快照、agent 答案 |
| `java-lsp-evidence-experiment-xsnbz3zg` | 36.6 | [证据协议实验](../../next-stage/evidence-protocol-experiment-review.md)、[12/28 分析](../../next-stage/qa-12-of-28-analysis.md) | 四阶段完成；两臂 12/28，QA 80% 门槛 FAIL；生产保持 1 worker | 830 个文件：P4 各 block 的 judge、attempts 与诊断记录 |
| `java-lsp-k29-round2-analysis-agnt6_vn` | 22.5 | [默认容量分析](../../next-stage/qa-contract-release-evidence/p4-release/default-capacity-analysis.md) | 性能探针原始数据，结论见左侧文档 | 1,039 个文件：`perf/fixture.sqlite` 与生成用源码、paired probes、stage records、agent traces |
| `java-lsp-k29-agent-analysis-f2g_mk_r` | 19.6 | [K29 修复结果](../../next-stage/k29-remediation-review.md) | agent 行为与缓存探针数据 | 1,026 个文件：perf 探针、failure data、harness 记录 |
| `codex-java-lsp-isolated-validation-*` ×12 | 3,301.6 | 由各 `*-evidence/` JSON 作为运行位置引用 | 隔离验证保留的运行根 | 每个 2–5 个文件：`candidate.patch`、`projects.json`、`dependency-inventory.json` |

## 历史引用的解析

历史文档里的 `$TMPDIR/<原目录>/<相对路径>` 不改写。在本机归档目录中按以下顺序解析：

1. 在 `manifest.json` 的 `workstreams.<原目录>.archived` 中：`xz -dc unique-raw.tar.xz | tar -xf - './<原目录>/<相对路径>'`。
2. qa-release 的引用：`copied-files-inventory.json` 的 `source` 对应仓库路径 `path`。该 inventory 和大部分被映射的文件已随 [仓库内证据提炼](../inrepo-distill-2026-10-13/README.md) 移入本机的 `inrepo-raw.tar.xz`，原路径不变。
3. 其他工作流中的引用：`workstreams.<原目录>.referencedInRepo.entries[].repoPath`，先查仓库，再查 `inrepo-raw.tar.xz`。
4. 不在以上三处的路径不再保留。另有 651 个引用在整理前就已不存在，主要是 judge 的运行期临时路径。

源码副本的身份：JDT readiness 的 cipherlink 副本均为 `fa433982e92e`；isolated validation 与 K29 的候选副本为 `04058e43b8b2` 加未提交改动，改动由归档里的 `candidate.patch` 或 `before.patch` 保留；`a77b6428ca43` 与 `8f737ac7cd14` 的 git bundle 在 `inrepo-raw.tar.xz` 中。

## 校验

```bash
cd /Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/tmp-distill-2026-10-13
shasum -a 256 unique-raw.tar.xz   # 562c69219065d2aacc1022363eb960299f450356af17278cc32732fce31d3373
xz -dc unique-raw.tar.xz | tar -tf - | grep -vc '/$'   # 3473
```
