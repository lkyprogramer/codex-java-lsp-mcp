# 独立发布评估

结论：当前仍为 **NO_GO**。用户已授权最终替换既有 daemon，但授权不替代质量门。新阶段计划可以推进公开合同、工具修复及原28题回归；现有输入不能在“不改变原 frozen tasks/gold/scorer/gates”的条件下恢复已暴露 locked 的独立性。另有 FULL_PUBLIC 评分接线和干净安装源码的具体缺口。不得以测试总数、双reader通过或重写旧证据放行。

本评估只读计划、代码、旧证据清单及本机运行元数据；仅写本文件与 compact JSON。未运行模型、全测、benchmark、安装、真实仓库索引或JDT。未读取/输出daemon.env内容或凭据。原清单的PASS是其历史候选的声明，未在本次逐一重验全部raw哈希，不算新候选PASS。

## 发布真源与必须补齐的门

`docs/java-specialist-release-audit-v1.1/contracts/release-policy.json` 要求15个gate、K01–K32全部PASS、QA≥0.8、新critical regression=0、8个actual repair task groups、完整scheduled/received记录、REAL_AGENT、FROZEN_CANONICAL。`tools/verify_release.py:22-86` 只核清单/哈希和阈值，全部满足也仅输出ELIGIBLE_FOR_MANUAL_REVIEW；它不证明实验执行，也不自行安装。`docs/07-release-runbook.md:14-18` 明确8组repair要求真实候选全部被测，不要求临时新增的100% repair成功率。

旧 `docs/next-stage/release-evidence.json` 唯一非PASS契约为K29；gate缺口为PERFORMANCE FAIL、INDEPENDENT_LOCKED NOT_RUN、FULL_PUBLIC NOT_RUN，另QA=12/28<0.8。其余PASS绑定旧sourceDigest `2d4f09405670e73bc655173b3ffe2ec72dc5b4beafddb396ea15c3fd4c0400d1`，不能直接挂到最终新候选。

| 门或证明 | 新候选需补什么 | 已有输入/边界 |
| --- | --- | --- |
| QA floor / LIVE_PAIRED | 按新公开合同但原任务、gold、冻结scorer及预算运行28 QA×两臂，原planned行全留；release QA率≥0.8，即28题至少23题。控制臂须完整可比，不据此另增控制臂必须80%的门。保留答案值/源码覆盖/预算/严格成功分别计数。 | 原28题、原gold/scorer、两臂runner及已使用的模型配置存在；本次未读取凭据或核实时点授权额度。八题阶段只是诊断，不能代全量。 |
| REPAIR / LIVE_PAIRED | 同最终候选覆盖原8个repair group，两臂真实Agent候选、独立任务目录和冻结judge结果；不能用patchApplied或reference oracle代替。全部scheduled/received对齐，provider usage缺失应如实限制成本声明。 | 原repair manifest、冻结judge、runner路径已有；旧72-run测量不能代新协议/新候选。QA分母不混入repair。 |
| INDEPENDENT_LOCKED | 独立evaluator保管未用于实现/调参的样本、gold/judge，预注册候选、配置、曝光与执行边界，提供逐case结果及无新增critical regression证据。 | 原12 locked已暴露，只能regression；当前未找到新的独立holdout输入。详见下节，不能靠换代理恢复盲性。 |
| FULL_PUBLIC | 对固定完整公开语料单独运行同候选的paired profile；记录外部corpus_hash、相同忽略规则、完整任务分母、源码回执；使用原冻结评分器对同一full corpus评分，保留scoped/full分栏。 | 已验证本机full-stage可复用，见下节；JS live scorer接线目前不支持正确external-full标记/根目录。 |
| K29 / PERFORMANCE | 默认1 reader原负载重跑并通过原150ms/20ms门；修复根因后才重复。 | 原load runner、4查询与gate在；最近三对实验的单reader仍3 FAIL，双reader3 PASS不可替代。 |
| K01–K32 / PRODUCT_COUNTEREXAMPLES / ORIGINAL_PROBES / MCP_ROUNDTRIP | 最终候选运行原契约矩阵、27机制反例、原12源码probe、真实SDK/五工具MCP回合；K26/K28提供同candidate sourceDigest的真实JDT证据，不能拿fake或配置声明顶替。 | `scripts/run-release-contracts.mjs`及其测试映射、`scripts/release-jdt-contracts.mjs`的依赖极小Maven fixture可用；后者真实验证定义/引用和共享请求取消。无需为该门启动用户业务仓JDT。 |
| DATASET / CANONICAL_SCORER / REPAIR_JUDGE / WIRE_SENTINEL | 冻结内容完整性与哈希、scorer self/faultcheck、原8 oracle baseline业务RED/reference GREEN、最终模型payload/source-receipt边界；新增公开合同不得改原题gold或值后处理。 | 原kit及检查入口均有；旧打包曾需恢复ignored log，最终包应保留真字节而非刷新manifest掩盖漂移。 |
| MACOS_BUILD / MACOS_FULL_TEST / EXISTING_RELEASE_GATE | 最终冻结candidate隔离build/native依赖、源码及script全测、stdio smoke及隔离HTTP五工具smoke；不能仅复用旧118定向集成数。 | `npm run gate:release` → `scripts/run-v4-gates.mjs:41-57` 为isolated full + 38491 HTTP smoke；它不覆盖全部模型质量/locked/full-public/K29门。 |
| REVIEW / 安装回滚 | 独立审逐case/raw/candidate绑定、暴露与限制；新run目录填release manifest并运行冻结verify_release；隔离installroot、非生产端口演练失败回滚，再按授权执行受管替换。 | 安装器/daemonctl及现行运维文档可用，当前生产回滚文件存在；实际演练尚未运行。 |

执行依赖：合同/实现冻结与相关窄测 → 八题诊断 → 全28及8 repair → 完整公开语料/独立输入与工程门 → 最终候选绑定及人工review → 隔离安装回滚 → 受管替换。可复用已绑定且受影响范围不变的证据，但必须明确来源；不能用旧candidate的总通过数代表新门。

## FULL_PUBLIC可以保留原冻结内容，但当前接线必须补齐

冻结 `baseline-kit/harness/cli.py:93,174-191` 已支持 `--corpora-root`、`hydrate-public --allow-network`、固定SHA/seed哈希和external-full fingerprint。完整语料不要求执行上游构建；Java语义/真实修复另按相应门验证。

已只读核验可用目录 `/Users/luo/Documents/github/java-devkit-v1-runs/m3/full-stage`：四个Git checkout均clean且HEAD匹配；四个seed逐文件SHA全部匹配；八个authored目录存在。按冻结corpus_fingerprint重算2533个非.git文件得到 `13d529a6d262bfbe43a44c84b5666dedaa8527447768a098778682f1539de747`，与相邻 `full-stage-manifest.json` 完全一致。

| corpus | frozen commit |
| --- | --- |
| petclinic | 818c4136ea971c21674525f9053de0d9c7ad8cfe |
| mybatis | 78bb677e2bf04b43386d3f1544cec51ff47662a2 |
| hikari | 98bd21c8fe506cfb6f329002669b2129bdb847db |
| gson | 828a97be0f8d58108b140b77df8dc76b657f4a87 |

可从此输入制作隔离per-task工作区，不必重复网络hydrate。历史m3/full报告属于不同候选/实验，不能直接关闭新FULL_PUBLIC。

精确非.git file-set及逐文件SHA、固定commit、seed检查和重算fingerprint保存于本目录 `release-inputs.json`。其2533文件口径为冻结harness的全文件fingerprint；旧文档所称1725文件不是本次重算口径，不能混写。

已确认接线缺陷：`scripts/evaluate-java-task.mjs:989-1032` 的scoreWithFrozenKit固定指向kit/dataset/corpora、写corpusMode=bundled-scoped，调用harness score未传`--corpora-root`。`--repo-roots`只改变live执行路径。因此直接传full repo roots会产生错误的scoped评分来源声明，不能作为FULL_PUBLIC。最小方案是在非冻结适配层提供明确full corpus输入/哈希/profile，并调用不变的冻结harness `--corpora-root <full-stage> score`；或在独立后置评分适配器中正确转换结果包。先做scoped/full来源与失败路径测试，不修改冻结scorer/tasks/gold/gates。仅文件存在和hydrate成功也不足以gate PASS。

## INDEPENDENT_LOCKED不能靠现有旧题自动闭合

冻结审计 `AGENTS.md:29` 明确“已暴露的 locked 登记 exposure 并降为 regression”；baseline `AGENTS.md:33` 同样要求已见gold转regression。旧release evidence及 `docs/next-stage/runtime-integrity-plan.md:30` 已承认暴露。新QA合同实施又明确分析全部28题，不能把其中locked子集重新称未调参。

在原tasks/gold保持字节不变前提下，可以完整重跑旧locked并报告regression，但**不能据此把INDEPENDENT_LOCKED标PASS**。需要所有者提供或安排独立标注者制作新增、未参与调参的holdout，单独冻结输入/版本和evaluator隔离/曝光记录；原数据及其结果仍保留。是否接受该独立补充输入满足该发布门，需要所有者给出明确方案，不由实现AI自行改名、换分母、复用已见答案或修改冻结policy。若用户不提供/授权新输入，则原完整发布门保持NO_GO；不能改成受限试用后继续宣称原门全通过。

## K29必须保留的负载和判据

`scripts/run-release-contracts.mjs:127-138`实际运行`dist/benchmark/measure-query-load.js --files 1000 --samples 100 --steps 1,5,20 --output <new-dir>`，没有worker-count覆盖，因此必须是默认单reader。原四类query（rare-fqn/common-word/broad/auto refundOrder）、每step100样本、deadline1000ms、update20且writer100ms保留。broad检索边界、预算、正确性和generation语义不可为过门收缩。

`loadEvidenceGate:56-62`要求队列/settled机制通过，并对全部常规steps和withUpdates均检查warm P95≤150ms、event-loop P95≤20ms。检查器minimum-shape条件比完整预注册负载宽，review仍必须检查1/5/20/update四单元和100样本，不能利用minimum条件少跑。报告raw、每query/cohort、真实预热、默认worker数、queue/service、CPU/RSS与终止结算。双reader实验仅为容量参考，不能更改默认配置或代替单reader门。最近P3单reader c20约188–194ms及update约188–194ms仍FAIL，缺陷未因双readerPASS关闭。

## 本机安装与回滚现状

只读观察：`~/Library/Application Support/codex-java-lsp-mcp/current` → `releases/09b9851e888a-20260929T085025Z`，stamp gitSha=09b9851e888a；`state/previous-current` → `releases/d86dba38fccc-20260912T012805Z`，对应release目录/stamp存在。previous-current是state内保存的相对target字符串，安装器按runtime-root解释/复制它，不应把state目录下自然解引用失败误判为没有回滚版本。

`GET http://127.0.0.1:38456/healthz`及`/readyz`均返回ok/ready、activeRequests0、buildSha09b9851e888a、同managed instance；错误的`/health`返回404后已按代码真源改查正确路径，未调用任何索引工具。当前安装facts revision=2，源候选revision=5；首次静态使用将重建旧facts。代码回滚不等于数据库内容回滚，需保持所有cache/ownership/pin数据并使用已验证的重建流程，禁止删库/WAL。

`state/rollback-09b9851e888a-20260929T085025Z`中daemon.env、plist、run-daemon/run.sh/daemonctl及previous-current的备份和present markers均存在。本次只查文件存在/marker，不读取env内容，因此不声称已验证所有前序配置兼容或实际回滚成功。

安装器要点：

1. `install-runtime.sh:337-359`调用`verify-clean-source-tree.mjs`，tracked和untracked修改均会拒绝；随后复制immutable release、npm ci/build、隔离npm test。当前dirty源码不能直接满足此门。主代理已选择优先准备独立发布快照、保留主工作区dirty；需记录snapshot commit与逐文件/sourceDigest绑定，不通过关闭clean检查或伪造BUILD_SHA绕过。本评审未提交。
2. installer备份state、plist、稳定入口及previous-current；隔离candidate canary成功后，原子保存旧current到`state/previous-current`、切current并重启受管daemon。固定38456沿用，canary默认38457，前置HTTP gate用38491。保持现有MCP URL；不使用`--activate-http`，其为独立注册切换并非升级路径。
3. `install-runtime.sh:974-992`新daemon失败先确认stop，再恢复release和完整配置，随后start/smoke；无法确认停止时不把另一版本覆盖到仍存活进程。`daemonctl.sh:234-307`的`rollback-release`同样要求完备备份和前序managed state。
4. 安装成功后只保留新current和previous release，其余immutable releases会被prune；应提前明确此既有行为及需要另行留存的诊断证据。此次安装后首要回滚目标应是当前09b9851e888a版本；现有更老d86dba38fccc不保证继续留存。
5. 最终验收绑定新build、instance、current、state/previous-current、health/ready和五工具面；隔离回滚演练要记录失败与恢复时间/PID/build。生产替换会短暂断开连接，facts2→5重建期间不得把尚未完整解析的状态报READY。未演练或安装前不得写deploymentPerformed=true。

现有快照真源：`scripts/run-three-repo-cold-matrix.mjs:594`的captureCandidatePatch收集当前差异；`scripts/isolation-utils.mjs:38-50`用local shared clone和detached checkout；`scripts/run-isolated-validation.mjs:129-155`将patch `git apply --index`到clone并记录write-tree。它们能物化逐字候选，但**没有把修改后的tree提交成可供安装的clean release snapshot**。本次针对release/snapshot/isolation/install脚本检索未找到现成的clean snapshot入口，不能声称运行该validator即可满足安装器。

此外captureCandidatePatch的未跟踪输入仅包含src/golden/fixtures/scripts和package/tsconfig；新未跟踪docs协议不会随该通用候选快照自动进入clone。若新协议由运行时/评分入口读取，主代理必须显式绑定并物化这些输入，不能因代码编译通过就假定其已包含。

推荐主代理在最终门完成后准备独立snapshot方案：保留主工作区dirty，隔离clone中物化同一文件集合，取得干净snapshot commit，并证明逐文件内容/冻结输入一致；安装仍调用原安装器。`candidateIdentity`在`run-release-contracts.mjs:37-47`仅涵盖src/scripts/fixtures/package/tsconfig，不涵盖根目录install-runtime.sh、daemonctl.sh及冻结docs，所以发布快照的文件绑定必须额外包含实际打包文件和安装/回滚入口，不能只比较611-file sourceDigest。

## 主代理需要解决的输入与决策

- 独立holdout的来源、所有者/独立evaluator、冻结及曝光隔离方案。当前旧locked不能满足独立门，这是证据输入阻塞，重跑不会消除。
- 最终干净发布源码的具体快照步骤与完整文件绑定仍需主代理准备；已有“优先独立快照、保留主dirty”决定，无需为这一准备动作重新询问安装意图。若用户明确禁止范围包含隔离快照的提交对象，则需澄清该限制；不静默修改安装器。
- 最终provider/model/预算/新协议绑定、有效模型访问与费用约束需在运行前安全确认；已有历史配置不是当前认证可用证明，本评审不读取凭据。用户已授权实施及最终替换，不应重复询问同一安装意图。

其余关键输入已具备：原冻结数据/评分器/judge、完整公开源码、K/load/JDT/工程gate入口、健康的既有runtime与前序配置备份。默认单reader性能及QA是否达标属于待修复/实测结果，不能要求用户以批准替代。所有新证据写本轮run目录，不覆盖旧NO_GO；达到门禁之前继续完成不依赖缺失独立输入的已授权阶段。
