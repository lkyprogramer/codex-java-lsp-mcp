# Java agent 工具指导与 hook 同步

结果（2026-10-11）：全局指导与 hook 已落地，新 build `48bad915c854` 已安装。最终安装验证通过；四个真实 agent 会话为 **3 PASS + 1 PARTIAL**。精确 JDT 引用超时，不能写成四例全部通过。

本次范围：全局 `~/.codex/AGENTS.md` 增加 Java 工具选择策略；普通仓库和 worktree 的 `UserPromptSubmit` hook 统一为静态定位优先、JDT 按需启动。关键词触发和 5 秒 hook 超时保持不变。具体参数仍以 MCP schema 为准。

未知位置先使用静态 `java_symbol(operation=query)`，取得真实锚点后使用 `java_impact`。需要精确实现、引用或诊断时使用语义路径；读取关键源码并报告 PARTIAL、歧义及超时缺口。普通查询复用 runtime，不主动重启、关闭或清缓存。

发布使用原 `install-runtime.sh` 和新的干净源码快照，保留当前 release 作为回滚目标。全局 AGENTS 独立保存修改前文件；daemon rollback 不恢复全局指导。原 QA release 的模型、容量与发布记录属于原候选，不作为本次 hook 行为验证。

验收检查普通仓库与 worktree 的提示一致、hook 定向测试、原 installer mandatory tests、固定 MCP URL 与环境保留，以及新 agent 会话中的真实 Java 工具选择。agent 提示只描述业务任务和只读约束，不指定工具顺序；以实际调用、工具结果和源码核实判断，不以调用次数判断成功。

## 安装与验证结果

[全局 AGENTS.md](/Users/luo/.codex/AGENTS.md:122) 追加第 12 节，修改前正文按字节保留。Java 指导包括准确 `repoRoot`、静态定位、真实锚点、语义按需启动、实际源码核实及 PARTIAL 披露。

发行快照在 QA 安装基线 `8f737ac7cd14` 上仅修改 hook、对应测试和三份说明文档；没有将维护工作区的其他实验改动打包。本次运行时代码只改 hook 提示，原关键词判断、静默放行和 5 秒超时不变。[源码绑定](java-agent-guidance-evidence/release-source-binding.json) 记录完整候选 SHA、基线、源清单哈希和五个文件的哈希。

| 检查 | 实际结果 |
|---|---|
| hook 定向测试 | 2 PASS、0 FAIL、0 SKIP |
| 最终原 installer 源码测试 | 1366 PASS、0 FAIL、0 SKIP |
| 最终原 installer 脚本测试 | 436 PASS、0 FAIL、0 SKIP |
| 已安装 wrapper 四个输入 | 4 PASS；0.098–0.712 秒，均小于原 5 秒超时 |
| health / ready / 五工具 smoke | PASS，build `48bad915c854` |
| 安装源码逐文件比对 | 1781 个文件哈希一致；63 份文档日志按原安装规则不复制 |
| 环境与项目配置 | MCP URL、项目配置、JDK/Node/JDT 路径、cache/ownership 与 15 分钟 idle TTL 保持原值 |

当前指针为 `releases/48bad915c854-20261011T135529Z`；`state/previous-current` 保留 `releases/8f737ac7cd14-20261011T123708Z`。生产未执行回滚。[安装 proof](java-agent-guidance-evidence/production-proof.json) 与 [已安装 hook proof](java-agent-guidance-evidence/installed-hook-proof.json) 绑定实际结果。

定向测试通过原隔离入口执行：`sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --keep --profile targeted -- node --test dist/hooks/hook-gate.test.js`。安装实际命令及 cwd 见安装 proof 的 `installer.command` 和源码绑定的 `sourceSnapshotRoot`；使用原 `install-runtime.sh --port 38456 --canary-port 38457`，没有跳过 mandatory tests。

## 真实 agent 会话

使用 Codex CLI `0.162.1`、现有默认配置 `gpt-6-luna` / `max`，没有模型覆盖。每例为新的 `codex exec --sandbox read-only --ephemeral --json` 会话，通过现有 MCP URL 访问新版本；提示只描述任务及只读限制。冻结提示和验收条件见 [协议](java-agent-guidance-evidence/agent-check-protocol.json)，实际参数见 [harness](java-agent-guidance-evidence/agent-harness.json) 和 [运行记录](java-agent-guidance-evidence/agent-run-records.json)。

| 场景 | 结果 | 已观察行为 |
|---|---|---|
| `exam-parent-v3` 声明与方法体 | PASS | `status(start=false)` → 静态 query → 接口及实现源码；未发起语义调用或显式预启 JDT |
| `cipherlink` 真实实现与生产引用 | PARTIAL | 精确根目录和静态定位正确；按真实锚点调用 `impact(required)`、JDT references；语义结果超时，继续读取实现、两个 Controller、Repository/Mapper，并明确披露缺口 |
| `cipherlink` linked worktree 声明 | PASS | 所有 Java MCP 调用使用准确 worktree 根目录；静态声明与本 worktree 文件哈希相符，完成源码读取，未发起语义调用 |
| `exam-parent-v3` 纯 README 任务 | PASS | 即使提示含 hook 关键词“排查”，仍只用文件读取核对 README，没有 Java MCP 或构建执行 |

四份 prompt 与冻结协议逐字一致；四个会话正常退出，Git 状态保持不变。独立只读审验核对了实际调用、工具结果、源码和最终答案，与上述结论一致。[逐项审验](java-agent-guidance-evidence/agent-audit.json) 保留工具参数、结果状态、读取命令和原始产物哈希。

语义例的 `java_impact` 返回 `semantic.completion=PARTIAL_TIMEOUT`，实现候选来自静态 `TYPEGRAPH:IMPLEMENTATION-LOOKUP`；JDT references 在 2918ms 后 deadline 失败。静态实现候选和源码搜索不能替代成功的精确语义结果。工具选路与降级披露通过，精确语义验收仍未满足。最窄后续检查是核实该仓库的 JDT 导入及 deadline 状态，再取得一次成功的精确实现或引用结果；不需要重跑已通过的静态和文档用例。

这些会话证明组合指导下的实际行为；wrapper 单独检查证明安装入口能输出正确建议。没有隔离测量 hook 文案自身的因果贡献，也未直接证明每个 CLI 会话内的 hook 注入过程。

## 保留的失败与回滚边界

最终 PASS 不覆盖前两次安装失败。[失败记录](java-agent-guidance-evidence/verification-failures.json) 分别保留原始日志哈希与更正/复核结果：

- 第一次验证 driver 继承线上 `JAVA_LSP_HTTP_INSTANCE_ID`，影响缺失实例标识的测试 fixture；driver 已排除此继承值，原失败文件独立复跑 28/28 PASS。原 daemon guard 未修改；外部导出的实例 ID 可影响既有 predecessor guard，这个条件限制仍保留。
- 第二次既有 20ms 请求预算测试出现 `Missing expected rejection`；单独原用例复跑 1/1 PASS，最终原全套通过。相关 runtime/deadline 文件相对已安装基线未变，测试断言未修改；日志不足以唯一确认触发原因，未将时序假设写成已复现根因。

原始 installer 日志、四个会话轨迹/答案、全局 AGENTS 修改前后备份、完整源清单和复核日志保存于私有 [证据清单](/Users/luo/Documents/Codex/codex-java-lsp-mcp/2026-10-11/java-agent-guidance-48bad915c854/archive-manifest.json) 所在目录，文件权限 0600、目录权限 0700；定位及清单哈希见 [证据位置](java-agent-guidance-evidence/raw-evidence-location.json)。daemon 回滚目标为 `8f737ac7cd14`；全局 AGENTS 需使用其独立备份恢复，daemon rollback 不会恢复它。
