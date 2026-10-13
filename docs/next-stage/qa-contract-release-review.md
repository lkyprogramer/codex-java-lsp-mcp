# QA 合同实现与 daemon 发布验收

2026-10-11。现有生产 daemon 已实际替换，线上 `buildSha=8f737ac7cd14`。代码、原发布门、真实模型评测、隔离升级与回滚及标准生产 installer 验证均完成；生产 health/ready 和五工具 smoke 为 PASS。原始 `release-evidence.json` 及历史 NO_GO 保留。[本次资格清单](qa-contract-release-evidence/release-evidence.json) 与 [原检查器结果](qa-contract-release-evidence/release-verdict.json) 负责资格；[真实生产 proof](qa-contract-release-evidence/native-deployment/production-attempt-8/production-proof.json) 负责实际部署状态。原检查器仍返回 `ELIGIBLE_FOR_MANUAL_REVIEW/deploymentPerformed=false`，不将其历史快照改标为真实执行。

公开答案合同已独立版本化；schema 与最终提交使用共享严格校验，最多一次格式恢复。`rg` 正确区分文件和目录路径、明确不存在路径与运行错误；定向读取保留文件长度和读取范围。后续默认单 reader 容量修复减少 SQL 批量查询和重复数组处理。`broad`、worker 默认值、源码预算、原任务、gold、冻结评分器和门槛保持不变。

## 固定源码与阶段

业务、模型和 K 合同评估固定源码为 611 文件，SHA-256 `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`。测量基线 `04058e43b8b2658864d0de09c8d6024e9928dfc5`；对应私有干净快照 `a77b6428ca432259c4008ead6c5e58cdc5e53cef`。两者逐文件可执行源码一致，不能把私有打包提交视为主仓提交。主仓未提交、未推送。

受管安装验证期间，查询共享单测的冷启动身份检查耗时约 488ms，随后 41ms 查询超过其原 500ms caller budget，原空结果符合 deadline 合同。[实际诊断](qa-contract-release-evidence/native-deployment/deadline-diagnostic-analysis.json) 支持仅在该单测开始预算前 `await session.ensureStarted()`；10/500ms、40ms handler、全部断言和另一个冷启动共享单测均保留。新安装快照为 `8f737ac7cd141d0eb07de37bb212d4d6648d96a3`，sourceDigest `3ee9f884412d43e061699c42d11427fc70c3ba355d52bcc475d682db1c9dfcbc`。1,843 文件只该测试变化，1,842 文件逐字节相同，文件模式全部相同。旧模型原始记录仍绑定 6d/a77；没有将其改标为新提交执行。[测试差异](qa-contract-release-evidence/native-deployment/test-fixture-only.diff)、[新包绑定](qa-contract-release-evidence/native-deployment/test-fixture-source-binding.json)、[独立采用评审](qa-contract-release-evidence/native-deployment/test-fixture-adoption-review.md)。修正后完整 JDT 会话测试文件实际 54/54 PASS，无跳过。独立 PASS 只批准上述源码等价证据用于 native 部署，实际安装结果须另行证明。

P0 合同、P1 实现、P2 八题双臂和 P3 完整 28 题均通过阶段评审；性能修复后的最终候选重新执行完整 QA、原八组修复、full public 和新 independent locked。较早候选的结果保留，不替代最终结果。[源码绑定](qa-contract-release-evidence/p4-release/final-source-binding.json)、[打包评审](qa-contract-release-evidence/p4-release/package-source-review-r2.md)、[原件保全](qa-contract-release-evidence/p4-release/final-frozen-preservation.json)。

## 实际结果

| 最终候选范围 | Product | Control | 实际执行 |
| --- | ---: | ---: | ---: |
| 原 28 QA，已暴露 regression | 26/28 | 24/28 | 56/56 |
| 原八组真实模型修复 | 8/8 | 8/8 | 16/16 |
| 完整 upstream public：28 QA | 26/28 | 25/28 | 与修复合计 72/72 |
| 完整 upstream public：八组修复 | 8/8 | 8/8 | 同上 |
| 新独立冻结：9 QA | 9/9 | 9/9 | 与修复合计 24/24 |
| 新独立冻结：3 修复 | 2/3 | 2/3 | 同上 |

最终候选共 168 个计划 slot，168 个真实结果，missing 0。此总数只表示完整性，QA 分母按 profile 分开。全部使用 `openclaw/Qwen3.8-next`、`max_tokens=2048`、`reasoning_effort=none`、`enable_thinking=false`、16 rounds、ordering seed 1984；provider sampling seed 未设。调用失败、恢复调用和成本全部保留；不宣称统计优势或货币成本下降。

新 12 题由独立 owner 新建并在任何模型调用前冻结，另一评审代理私下核实答案、必需证据与真实业务 oracle。私有 gold 和测试持久保存在 owner 管理目录，未放进公开合同、模型输入或本归档。最终新 QA 满足原 80% floor，新增修复两臂均有一题整数中间加法溢出而失败。没有筛除、重跑、调参或补改模型候选。原发布合同要求原八组真实修复实测；没有增加新修复必须全通过的门槛。[冻结评审](qa-contract-release-evidence/p5-independent-locked-v1-r2/review.md)、[实际结果独立评审](qa-contract-release-evidence/p5-independent-locked-v1-r2/results-review.md)。

完整 public 的原 CLI qualification 两臂均为 `QUALIFICATION_FAIL`。QA floor、预算和 QA 测量完成，但原修复检索指标存在零 anchor、补丁后读取与初始 corpus 的 hash/range 差异；真实 repair 成败另由原 judge 给出。本次 `FULL_PUBLIC=PASS` 表示原发布要求的单独 profile 已真实完整测量，不声称原 CLI qualification 通过。新 locked 的 block-20/24 也保留辅助 `valid=false`；不声明全部检索记录 valid。[public 独立审计](qa-contract-release-evidence/p4-release/full-public-new/review.md)。

## 工程验证与容量

原 15 发布门、K01–K32 使用原 policy 和 verifier。评估候选 6d/a77 的隔离 release profile 实跑：1366 source tests + 436 script tests，通过且无跳过；编译、HTTP 五工具 smoke、真实 JDT K26/K28 通过。冻结 harness 56 单测、faultcheck、八组 oracle、12 source probes、27 counterexamples 通过。恢复的 34 个 gitignored 原件均匹配历史冻结 SHA；357-file 包检查通过，历史输入与证据 293 文件无差异。新测试快照的 mandatory installer 验证独立记录，不冒用上述原结果。

默认单 reader 在原 1000 文件、100 请求 profile：K29 concurrency20 P95=125.462ms；并发增量写入 P95=127.665ms，均低于原 150ms。event-loop P95=1.612/1.555ms，均低于 20ms。未收缩 `broad`，未改生产 worker 默认值。仅支持固定 corpus、本机实测范围，不证明生产各仓 P95。归档后主仓文件列表超过现有 `candidateIdentity` 子进程默认 1MiB buffer；终审使用同一排序、过滤、SHA 规则只读复算，611 文件与 digest 仍一致。私有干净安装快照不受该文档归档限制；没有为改 helper 而更动冻结源码。[完整工程评审](qa-contract-release-evidence/p4-release/final-engineering-review.md)、[32 项 K 合同结果](qa-contract-release-evidence/p4-release/k-contracts/k-contract-results.json)。

实际检查命令：

```sh
python3 docs/java-specialist-release-audit-v1.1/tools/verify_release.py docs/next-stage/qa-contract-release-evidence/release-evidence.json --evidence-root docs/next-stage/qa-contract-release-evidence --out docs/next-stage/qa-contract-release-evidence/release-verdict.json
```

退出 0，errors 空。verifier 只核对清单与 hash，固定返回 `deploymentPerformed=false`；真实执行可信度来自各 profile 独立原始 trace 审计，实际部署另由 native proof 表示。归档 copier 的 `package-authority.json` 保留 `NO_GO/EVIDENCE_COPY_ONLY_NOT_RELEASE_AUTHORITY`，不承担发布资格判定。

## 安装与回滚记录

整体独立资格评审已通过。使用同一 installer，在隔离 runtime / cache / ownership / projects / LaunchAgent 上实际执行当前已部署旧版二进制副本 → 新版安装 → `rollback-release` → 旧版就绪 → 卸载临时 job。旧二进制副本 5,672 常规文件全部核验 hash，并核验 symlink 文本和隔离 containment。新包 mandatory installer 实际编译并通过 1,366 源码测试与 436 脚本测试，无失败、无跳过；候选端口和固定端口的五工具 smoke 均为 `8f737ac7cd14/ready`，实际 rollback 为 `09b9851e888a/ready`。[隔离实际证明](qa-contract-release-evidence/native-deployment/isolated-attempt-6/isolated-proof.json)。

隔离 driver 在所有生命周期操作成功后，首次端口 bind 仍返回 `EADDRINUSE`，原 driver exit1 和原日志保留。后续只读恢复未重跑 installer、测试或生命周期：实际核验 job absent、两个端口无 `SO_REUSEADDR` 可绑定、旧 current 指针和实际安装文件，recovery exit0。composite PASS 明确区分这两次 exit，不伪称原 driver exit0。确切失败时 socket 状态未采样，不断言 TIME_WAIT。[原失败日志](qa-contract-release-evidence/native-deployment/isolated-driver-attempt-6.log)、[补充证明](qa-contract-release-evidence/native-deployment/isolated-attempt-6/cleanup-recovery.json)。

原包验收元数据漏标 29 份 `docs/**/*.log` 的 `installerRsyncExcluded`。原 installer 本已排除所有 `*.log`；未改 installer 或原 manifest，另以原 16 条 rsync 规则生成 [安装文件选择清单](qa-contract-release-evidence/native-deployment/installed-source-selection.json)。1843 输入中，1780 实装源码文件全部匹配，63 排除文件全部为文档日志，src/scripts/fixtures 无遗漏。被排除的日志仍保留在工作区和证据归档。

native 实际原始命令、日志、健康与指针验证保存在 [native-deployment](qa-contract-release-evidence/native-deployment/)。早期 attempt 的依赖链接、历史 V4 git 验证对象缺失和上述 500ms 单测失败均保留；未把失败改标为 PASS，临时 job 已卸载且端口释放。历史 V4 对象补入私有 Git 验证 ref，源码不变。旧版源码 full test 的 1207/1208 FAIL 保留，实际回滚目标改用逐文件核验的已部署二进制。本次不以既有 HTTP smoke 代替受管安装与回滚。

首轮生产 installer 在切换前的测试阶段失败：安装进程继承旧 daemon PATH，缺少 `/usr/sbin`，导致 query-worker 的 `lsof` 资源核验 1 FAIL/1 SKIP，source 总计 1364 PASS/1366，脚本测试及切换未执行。当次旧 current、plist、项目配置和 `09b9851e888a/ready` 均保持原状态。精确 PATH 诊断后，在原隔离 runner 中重跑完整失败文件 18/18 PASS，无 skip；产品、测试及 daemon PATH 均未改。最后安装进程仅在原 PATH 后追加 `/usr/sbin:/sbin`，原 Node/npm/rsync/ps 解析保持一致，daemon PATH 仍由原 installer 构造并逐字段验证。[实际 PATH 诊断](qa-contract-release-evidence/native-deployment/production-path-diagnostic.json)、[定向重测](qa-contract-release-evidence/native-deployment/production-path-failed-file-recheck.json)、[独立 r8 评审](qa-contract-release-evidence/native-deployment/driver-r8-review.md)。

实际 production attempt-8 全部通过：原 qualification 与 clean-source exit0，标准 installer `--port 38456 --canary-port 38457` exit0，mandatory 1366+436 tests 全 PASS，无 fail/skip，独立端口与固定端口 smoke 均为新 build。current 为 `releases/8f737ac7cd14-20261011T123708Z`，previous-current 为 `releases/09b9851e888a-20260929T085025Z`；healthz/readyz 均 `ok/ready`，instanceId 已更新。1,780 实装源码文件 hash 全匹配，项目配置 SHA 和所有既有 environment 字段（仅 instanceId 更新）保持一致，包括 daemon PATH、cache/ownership、900000ms idle TTL。MCP URL 保持 `http://127.0.0.1:38456/mcp`，未执行 `--activate-http`。新版本和旧版09保留；安装器按原策略清理未引用的较早 d86 和失败 attempt-7 release。生产未执行回滚，成功版本保留；真实四仓 JDT 和生产负载没有在安装后重跑，不宣称生产各仓 P95。

## 既有依赖告警

本次 installer 的 `npm ci` 报告 6 个受影响 package 条目：3 moderate、2 high、1 critical。随后实跑 `npm audit --json`（exit1），原件保存在 [dependency-audit.json](qa-contract-release-evidence/native-deployment/dependency-audit.json)。旧版、新版和主仓 lock SHA 相同，未更换锁定依赖，也不声明 audit clean。

独立狭窄审查未发现当前调用链实际可达的新增 critical 或部署阻断。critical proxy-addr 需要指定的短前缀 trusted-proxy subnet；代码没有设置该信任配置，当前所装 Express 实测 `trust proxy=false`。SDK OAuth client 的告警涉及出站 OAuth credential 路径，本 daemon 为 server，唯一 smoke client 为无 authProvider 的 loopback。fast-uri 未观察到 SSRF 出站调用链。条件判断与官方 advisory 链接见 [依赖风险评审](qa-contract-release-evidence/native-deployment/dependency-risk-review.md)。另外 3 个 moderate 未逐项进行漏洞利用验证；此次未作整依赖升级或零漏洞认证。
