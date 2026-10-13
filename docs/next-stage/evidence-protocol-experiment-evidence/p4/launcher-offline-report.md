# P4 launcher 离线修复验证

2026-10-11。状态：OFFLINE PASS，14/14 tests。未执行模型、真实 MCP、prepare 或 preregistration 写入；未读取 Pi settings/models 或其他 credentials。没有修改仓库、tasks/gold、baseline kit 或历史结果；仅 launcher/test/本报告及临时离线测试证据。

验证候选：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-M49hJN/candidate`，实际 sourceDigest `a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313`，baseSha `04058e43b8b2658864d0de09c8d6024e9928dfc5`。最终根代理 freeze 必须再次确认候选和 launcher；本报告不授权 launch。

修复：

- 将计划、门禁、执行器拆为 exported functions 并以 main guard 保护导入。full 72 原 slot，前4是原计划 smoke；diagnostic 原24 slot、second12 为 first12 逆序、外部 blockRepeat 1/2。诊断每 slot 独立目录，最终按 profile + blockRepeat 六组（每组4）复用 assemblePack，不碰 frozen repeat=1。
- live 返回后首先写 live-runs.json（包括答案/submission/usage）；attempts.json 的未评分 QA success=null、原 JS 判断只保留 preliminary。评分克隆上执行；仅 kind=frozen-kit 时采用评分结果；scorer 失败没有重试或预判成功兜底。
- 执行器 try/finally 写终态 results-pack/completion；首slot throw、scorer failure、smoke blocked 保留已执行结果及72/24分母；未执行slot明确 MISSING_RESULT、success=null。COMPLETE 还必须有全部计划结果。每次成功评分产生独立slot pack。
- 主进程与 --worker 共用 P3 PASS、diagnostic full COMPLETE、worker OPENAI_MODEL 一致校验。prepare/drycheck 不读凭据；只有实际主进程 launch 且门禁通过才保留原 Pi 读取分支。drycheck --diagnostic 校验诊断门禁。
- prereg v2 绑定 launcher 自身hash、候选identity、tasks/gold、evaluation protocol原文件hash及schema、public prompt、原native/tool submit/profile schemas。读取父目录 immutable-input-hashes.json 中实际150 baseline-kit文件并逐一比较原hash；每block前后复核 binding，不把 candidateIdentity 单独当 docs/kit 真源。
- MAX_COMPLETION_TOKENS 保留正常任务失败；usage 有实测时不因此阻断smoke。FAILED_RUNTIME/setup 或usage不可测才 BLOCKED。connect throw也记录 finally elapsed/failed。blockWallMs 到 runLiveEvalRun return（含session close）；Python frozen评分单列 scoringMs；overallMs包含评分及编排。

实际命令：

`node --test /var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-evidence-experiment-xsnbz3zg/p4/launcher.test.mjs` — PASS 14/14。

`node --check /var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-evidence-experiment-xsnbz3zg/p4/launch-model.mjs` — PASS。

最后一次完整TAP：`/private/tmp/p4-launcher-offline-tests.tap`。离线临时输出目录已清理；Python 使用候选原 frozen harness，仅本地 scorer，不请求模型。模拟完整72/24成功路径检查全部唯一slot；真实Python scorer的单QA假答为 false，另一missing为null，pack scorer为 frozen-kit，completion因missing为 FAIL。另验证150实际kit hashes、worker三种门禁、connect失败计时、smoke早退、scorer前落盘。

审计hash：launch-model.mjs `93fe5048652c5d0c4b3c19f11d0f68e5aaf4fa6790cc525ef476cbe00b328b64`；launcher.test.mjs `5abb902078240c0cbd584a06dbf08f64c61156a8980a45d14b725e9533f46f53`。

限制：离线 fake live/scorer 的完整路径仅证明编排，不证明模型/provider/MCP行为；真实Python scorer仅检查单QA false/missing映射。真实 provider 参数遵守、session生命周期及测量coverage待最终freeze后根代理授权执行；原 P1/P2 MCP证据不替代本轮模型结果。硬进程kill/power-loss不受JavaScript finally保证；已写raw文件可审计，不能据此伪造completion。前置门禁拒绝发生在新run目录创建之前，不覆盖既有结果。

复审追加：原 manifest 覆盖 dataset 全树133文件、harness全树16文件及 schemas/gates.json 一文件。verifyKit 在这些执行范围递归枚举当前file set，拒绝 extra/missing/symlink，再验证原hash；无关 README/docs/unused adapters/reports 不进入新真源。离线复制原150文件并追加 dataset Java、harness Python分别被拒绝；删除原文件被拒绝；root README不影响该执行范围。中途第二次checkBinding（首slot评分后）抛漂移，答案/usage/frozen false保留，另71slot MISSING_RESULT，completion FAIL。共同verifyKit路径修改后重新执行完整14tests和node --check，均PASS。

冻结元数据明确 orderingSeed=1984（编排排序）、providerSamplingSeed=null（实际API没有seed字段）；staticReaderCount=1，configuration=production default; no experimental configureSharedQueryWorker in MCP child。没有改变实际请求/工具/计划，P3双reader实验配置不进入P4。
