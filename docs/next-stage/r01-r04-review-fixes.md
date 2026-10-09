# R01–R04 审查修复（2026-10-09）

**基线**：`c8ab600`（R04 提交）。**范围**：2026-10-09 对 R01–R04 的独立审查发现，全部在本提交修复；不触碰产品 `src/`、冻结 dataset/harness/gates/evidence。
**结论**：S1「可信评测」的四个机制现在在真实 live 主路径上成立（scripted 端到端 + 一次真实模型 pilot）。这不是任何模型有效性或 A/B 结论。

## 修复清单

| # | 严重度 | 缺陷（审查时） | 修复 | 回归锁 |
|---|---|---|---|---|
| 1 | P0 | `main()` 的 `planned` 用 `arms.map` 只展平一层，所有 live 结果被合成为 MISSING_RESULT（8 条成功 → rate 0） | `buildPlannedAttempts` 扁平计划，先写 `schedule.jsonl`；`assemblePack` 拒绝非扁平计划、计划外结果、重复计划行 | `eval-live-e2e.test.mjs`（经 `main()`）；变异回退后 2 项失败 |
| 2 | P0 | QA 证据门与 kit adapter 按工具原始返回（预截断）计分，A02 复现 | 原始返回改记 `SOURCE_FETCHED`（不计分）；`SOURCE_RECEIVED` 只由随 chat 请求发出的 tool 消息切片铸造（`recordModelDelivery`）；kit `read_events` 用 `fileContentHash` | `W04`、fetched-only 用例、adapter→kit CLI 截断用例；变异回退后失败 |
| 3 | P1 | nudge 插在 `assistant.tool_calls` 与 tool 回复之间（OpenAI 协议 400） | nudge 在本轮全部 tool 回复之后追加 | 协议顺序用例（含错误/非法参数调用）；变异回退后失败；真实端点 12 次 attempt 无 400 |
| 4 | P1 | 序列化：截断后 slice 行号不收缩、混入截断标记、半行切割；java_symbol 起始行用 `selection.line`；未知工具/单个超大候选无界；缺 `rawHash/modelPayloadHash/truncated` | 重写于 `scripts/eval-tool-wire.mjs`（设计 §1.1 位置）：整行二分裁剪、精确 `endLine/nextStartLine`；java_symbol 全字段保真、按排名贪心（带 preview → 仅 locator → 截尾）；切片取 `evidenceRange` 且行数必须一致；list/rg/test 有界、不作为证据；未知工具 `UNSUPPORTED_TOOL_RESULT`；最终硬上限否则显式 `MODEL_BUDGET_EXCEEDED`；32 KiB 默认 | serializer 属性用例（6 种形状 × 5 尺寸 × 3 预算） |
| 5 | P1 | forced-answer 请求不铸造回执 | 所有请求统一走 `dispatch` 边界（请求发出前铸造，带 `requestIndex/newReceipts`） | forced 请求用例、context-cap「从未发出」用例 |
| 6 | P1 | live repair 从未判定：`repairTester` 未传、签名拿不到 candidate、同步调用 | `runLiveEvalRun` 每 attempt 调 `evaluateRepair`（冻结 Python judge）判 candidate 树；`scoreRunOutcome` 只认 `validatedSuccess===true`；BLOCKED_ENV/SETUP/JUDGE_ERROR→null 留分母；loop 失败也判树 | e2e：正确补丁 VALIDATED_SUCCESS、错误补丁 TEST_FAILED（两者都自报 patchApplied=true） |
| 7 | P1 | adapter 探测 `$JAVA_HOME/bin/javac`，冻结 judge 却用 PATH 上的 javac/java | `javaHome/bin` 置于 judge 子进程 PATH 首位；探测同时校验 `java` | PATH 去掉 java 后仍 VALIDATED_SUCCESS；变异回退后失败 |
| 8 | P1 | agent-ab：JS 兜底 judge 的 PASS 计为成功；candidate TIMEOUT 计为 null；`rate`=成功/measured；API key 写入 results-pack；QA 不传任何 received → 恒失败（R02 引入） | 只用冻结 Python judge，阻塞即 null；rate=成功/全部计划（`ab-summary.mjs`）；backend 去凭据；接 recorder/onChat；复用 `buildToolSet`/`createAttemptWorkspace`、会话开在 candidate 上并在写后重开、seeded 臂序 | `ab-summary.test.mjs`；本地 scripted 冒烟（4 attempt，无凭据泄露） |
| 9 | P2 | R03：无 test 工具；无 seed 平衡臂序；java_symbol 首写前绑 pristine、只 rebind 一次；rebind 失败被吞；`liveProjectCacheRoot` 第三参被忽略（缓存未隔离） | repair 两臂共享 `test`（javac 编译到 candidate 外的临时目录）；`armOrder(seed, task, repeat)`；product 会话从一开始绑定 candidate，每次写后在新索引上重开；失败记 `SESSION_REBIND_FAILED`、后续 java_symbol 返回 PARTIAL 错误；每 attempt/每代独立缓存目录 | e2e：写后 java_symbol 预览含新代码；armOrder 用例 |
| 10 | P2 | 工作区：已存在目录被合并、attemptId 净化撞名、`.git` 子串过滤误删 `.gitignore/.github`、经 symlink 目录写新文件可逃逸 | 目录名含 key 的 sha256 前缀；已存在即拒绝；只跳过名为 `.git` 的路径段；不存在目标按最近存在祖先做 realpath 包含校验，写前复检 | 隔离/symlink 目录写入用例 |
| 11 | P2 | adapter 接受计划外 attempt（rate 可 >1）；`corpus_mode` 硬编码 external-full；kit scorer 未接入 live | 计划外/重复计划行报错；`corpusMode` 必填；`main --kit-root` 每臂产出 `java-specialist-results/v1` 并调用 `python -m harness score`，QA `taskSuccess` 以 kit `qa_contract_pass` 为准（JS 结果保留为 `preliminary`） | adapter 用例；adapter→kit CLI 端到端（替换了原先在 Python 里自造 pack、从未经过 adapter 的“端到端”） |
| 12 | P2 | `check_bundle.py` 因 R01–R04 卡片被改而 FAIL；R00 卡片/plan.json 状态未更新；提交了 3 个 `.pyc`；R01/R03 报告日期写成 2026-07-17 | 卡片恢复交付字节（`b061409` 版本），进度改记 `remediation-status.json`；删除 `.pyc` 并加入 `.gitignore`；日期按提交更正 | `check_bundle.py` PASS 357 |
| 13 | P2 | `read` 末尾换行多一行、无字节上限；`rg` 超时当完整结果、maxResults 实为每文件；`findDuplicateJsonKeys` 不解码转义键；chat 请求无截止时间 | read 精确行（保留终止符）+ 文件 sha256 + 16000 字节整行上限；rg 总行数上限、超时/截断标记；重复键按解码后比较；`openaiCompatibleChat` 增加覆盖 header+body 的绝对截止（默认 300s） | 对应单测 |

审查中另外发现、**未在本提交修复**（属 R08，不混入）：`src/discovery/query.ts` `previewAt` 的 `split(/(?<=\r\n|\n|\r)/)` 会把 CRLF 拆成 `"\r"`、`"\n"` 两行，CRLF 文件的 preview 窗口与 `evidenceRange` 都错。本提交的切片校验（preview 行数必须等于 range）会拒绝把这种 preview 记为 received，因此不会被错误计分。另：同一会话写入后 java_symbol 仍返回旧 locator 且 `scopeState=READY`（Q08 已知），评测侧以写后重开会话规避，产品侧仍待 R08。

## 验证

| 项 | 结果 | 证据（`java-specialist-audit-runs/r01-r04-fix/`） |
|---|---|---|
| scripts 评测单测 + 端到端（wire/native/adapter/evaluate/trace/e2e/chat） | PASS | `scripts-eval-tests.log` |
| experiments（semantic/repair-judge/ab-summary） | PASS（1 SKIP：未开启的 embedding 端点用例） | `experiments-tests.log` |
| 审计反例 27 条 | 12 PASS / 15 FAIL / 0 ERROR，与修复前相同；15 条属 R05–R10 | `audit-all/` |
| 原 12 源码探针 | 12/12 | `probe-12.log` |
| 冻结自检（仓库内 devkit / 原版 kit） | 均 5/5 | `selfcheck-checkout/`、`selfcheck-original/` |
| `check_bundle.py` / kit 单测 | PASS 357 / OK | — |
| `npm run build:isolated` | PASS | `build-isolated.log` |
| `npm test`（full isolated，已提交树） | 1199 + 338 PASS，0 FAIL。中间一次运行 `dist/repo-runtime-manager.test.js`「compatibility RouterIndex … caller deadline」失败 1 次，单独复跑 3/3 通过、全量复跑通过；本提交不涉及 `src/`，记为既有时序敏感用例 | `npm-test-final2.log`、`npm-test-final.log` |
| 变异检查 | 4/4 被新测试抓住（扁平计划、fetched 计分、nudge 位置、javaHome PATH） | 本文 |
| 真实模型 pilot | 12/12 attempt COMPLETED，kit 判定有效 12/12 | `live-qwen38next-pilot/` |

## 真实模型 pilot（用户 2026-10-09 授权）

- 端点：用户 `~/.pi/agent/models.json` 的 openclaw provider，模型 `openclaw/Qwen3.8-next`（返回 model 字段一致；成本 0）。key 只在进程环境中，运行目录内检索不到。
- 范围：dev 6 任务（QA：PAYMENTS-01/ACCESS-01/PRICING-01/GSON-01；repair：PAYMENTS-03/PRICING-03）× product/control × 1 repeat = 12 attempt，seed 1984，maxRounds 16，经 `evaluate-java-task.mjs --kit-root`（原版 baseline-kit）。
- 机制结果：12/12 `COMPLETED`，无 HTTP 4xx/5xx（nudge 顺序在真实端点被接受）；分母 12，无 MISSING；scorer=`frozen-kit`（scorer hash `5c41e12a…`），12 行 kit `valid=true`、receipt `errors=[]`——每条 SOURCE_RECEIVED 切片都被 kit 按语料逐字节复核通过；QA 上 kit 结论与 JS preliminary 6/6 一致；repair 4/4 由冻结 Python judge 判 `VALIDATED_SUCCESS`；provider usage 逐 attempt 记录。
- 观察到的数字（**不是效果结论**，样本 6 任务×1 次）：product 2/6、control 3/6。QA 失败均为严格合约失败：`"Set<String> (HashSet)"`、带 FQN 的方法名、非 JSON 散文、一次 control 收取 280 行超出 160 行预算（`RECEIVED_OVER_BUDGET`）。这些是冻结协议的既定口径，不是评分器缺陷。

## 限制

- scripted e2e 由脚本扮演 agent，只证明闭环机制；不是 LIVE 样本。
- 真实 pilot 只验证真实 transport 往返与评分链（详见下文），任务少、1 次重复，不能据此做 product/control 效果判断；四臂/同预算实验仍属 R10/R11。
- `test` 工具只做编译检查（没有可暴露的评测测试），两臂一致。
- rg/list 输出不计为 received 证据（导航文本，非精确源码窗口）；control 臂必须 `read` 才能拿到证据，与 product 臂 preview 的口径一致。
