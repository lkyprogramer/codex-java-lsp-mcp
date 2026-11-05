# P1 公开合同与读取协议独立评审

2026-10-11。最终结论：P1 PASS；P2 launcher preflight PASS。无剩余已知 correctness/security/fairness/source-receipt finding。P0报告保持不变。可以由主代理按已授权阶段推进八题模型实验；本评审不证明模型质量、80%门槛或发布/daemon替换通过。

## 精确候选与评审范围

P1起点是baseline/source.json的611文件摘要 `a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313`，不是git基线的大diff。独立核对P4保留候选M49hJN中本次11文件的hash，均与该起点一致，再逐文件diff到当前源码，未将已有历史改动归入P1。

本次范围：scripts/eval-answer-contract、eval-native-tools、eval-tool-wire、run-agent-trace-live、evaluate-java-task五组.mjs/.test.mjs，以及eval-evidence-e2e.test.mjs的一处v1.4→v1.5版本断言。文档读取public-answer-contract-v1.0.json、evaluation-protocol-v1.4/v1.5/活跃版本。另按主代理追加请求，只读检查ROOT/launch-model.mjs及其helper probe。

最终源码和隔离编译候选co0Y6G的记录摘要一致：`5f9c8f2f7d4c12e9ec3e6bbfc1ba26fda973f150e3a1ebe5ac8c257a23d6981b`，611文件，git base `04058e43b8b2658864d0de09c8d6024e9928dfc5`。candidate.json记录293个原始/历史冻结文件hash保留；独立另核对原baseline-kit150项hash全部一致。

## 代码结论

- **公开schema与validator同源**：publicFields先核对exact key/type及允许的description/pattern/minLength/string enum/items/order，buildSubmitAnswerTool与validateSubmission都使用它。items递归检查；integer用Number.isInteger，数组用Array.isArray；lexical通过Unicode码点比较，仅验证顺序，不排序输入。order不作为不支持的JSON Schema关键字发送，已公开的description及taskText包含其规则。
- **实际合同接线对称**：runLiveEvalRun在请求前对所有QA显式ID检查合同存在与基础type匹配。两臂同用fields、公开角色说明和system prompt；不按未知任务名或字段名补隐式约束。未显式启用contract时保留基础类型路径并记录null；启用时记录version/hash及每attempt applied状态。repair不套QA fields，继续原patchApplied/summary合同。
- **一次恢复不纠事实值**：runner的schema与本地校验都接同一fields；恢复仅告诉公开字段及违反的rule，只开放submit_answer，至多一次。原raw arguments、draft和stop reason保留；没有gold或私有缺失行反馈，不删除FQN/receiver/否定号，不翻转表达式，不翻译词汇。事实正确性仍由原frozen scorer判定。
- **源码回执边界保留**：mixed submit/其他工具不会invoke；accepted submit只绑定此前dispatch的receipts。新增totalLines/hasMore是元数据，source slice仍是精确whole-line文本与对应范围/hash；wire clipping仍结算实际保留的源码，不把rg/list当SOURCE_RECEIVED。
- **rg真实路径修复**：先走原containment/realpath校验、拒不存在路径为PATH_NOT_FOUND；从candidate root运行，将经校验的相对文件或目录作为`--`后的显式argv，保留fixed-string、with-filename及全局结果/字节/时间上限。正常文件搜索不再使用文件作为cwd；未将新路径处理扩成shell命令。缺binary仍明确BLOCKED_ENV。
- **read可见性**：totalLines与hasMore在最终wire内容保留；普通完整请求窗口不因文件还有后文冒称truncated，wire/source clipping仍分别标明。定向读取指引要求跟具体字段/实现/callee/helper/XML定位，不包含gold值或私有坐标，也不提高160行/16000字节预算。
- **独立版本**：EVAL_PROTOCOL_VERSION为v1.5；活跃protocol与v1.5文件hash相同，v1.4原摘要保持不变。pack及attempt记录公开合同version/hash；源码预算、gold/scorer及历史结果未改。

## 本代理实际执行的最小只读helper检查

加载当前公开合同，使用当前buildSubmitAnswerTool与validateSubmission对原28个QA的冻结答案做表示域兼容性检查（不发送模型、不运行scorer、不输出答案到合同）：28/28 accepted，28/28解析值与原对象deep-equal，0失败。该检查证明实现没有重写当前gold的字符串/表达式/数组，不代表模型会提交正确答案。

另以纯RegExp表达式检查当前simple-member pattern不接受结尾LF；不是新增约束或运行项目测试。其余验证由主代理运行，本代理只读取原日志，不重复其套件。

## 验证证据与失败处理

- red.log：四个真实缺陷用例0/4通过，分别为公开字段约束、rg文件/目录边界、read总行数wire、公开字段恢复提示。
- targeted-green-r2.log：同四用例4/4 PASS，0 skip。
- integration.log：合同loader、两臂schema/role对称与错误事实不被纠正，2/2 PASS。
- cumulative.log：152用例，151 PASS、1 FAIL、0 skip。唯一失败是eval-evidence-e2e.test.mjs固定断言v1.4，与新v1.5版本失配；没有隐藏该失败或表述为本次全152一次通过。
- 修复仅把该断言改为实际v1.5，未删assert或改judge/receipt要求。e2e-revalidated.log记录隔离重新编译、真实MCP TYPE evidence→exact XML dispatch→原frozen judge，1/1 PASS、0 skip。原151通过证据加失败用例修复后1/1复验已满足此次最窄重验要求，不必重复全套。
- 主代理记录git diff --check PASS；本代理未自行运行该命令、编译、测试套件、模型、容量或安装。

## 新launcher finding及关闭

初读ROOT/launch-model.mjs发现QA原live初判直接进入allRuns；冻结scorer返回preliminary-js或throw时，终态byArm可将JS初判true计为严格成功。该缺陷已立即报主代理，修复前未给P2启动通过。

主代理已修：pendingScoringRows保存preliminary，QA taskSuccess=null/taskOutcome=UNMEASURED；原live-runs先落盘。scorer在独立live.runs克隆上执行，仅返回kind=frozen-kit后Object.assign到retained；失败/throw保持null。静态复审确认实现正确，finding关闭。

launcher-check.log记录纯离线helper probe：八题/full/repair分别16/56/16唯一配对slot；评分失败pending对象原raw不变、strict null、measuredAttempts=0、计划分母1、无初判成功计数。该probe没有运行模型或评分器；它不是实际八题成绩。

launcher其余前置边界：candidate/source identity、launcher及复用helper hash、150实际kit文件集/hash、protocol、原tasks/gold、公开合同及product/native/submit schemas绑定；每slot前后重核。prepare/drycheck/worker共用P1及P2阶段门禁；worker核对实际model；正常launch才读取Pi配置。八题两臂同候选/合同/模型/budget/default reader1/product broad，seed1984为arm顺序，providerSamplingSeed=null。独立candidate及原冻结scorer逐slot计分，失败终态保留全计划，不覆盖已有run目录。没有private answer提示或自动source oracle。

P2 preflight只证明此launcher和阶段冻结适合执行授权实验；之后仍须审计实际16次raw/schema/receipt/usage和原score，再决定P3，不预设成功。

## 冻结摘要与剩余边界

- public-answer-contract-v1.0.json：`2debcf5ef20d58e6e994025f4d5a69861d3e869e0f67b8a2780ee59b6592f1d3`；ROOT/p0-contract副本相同。
- evaluation-protocol-v1.4.json：`a2f06a1cfa3ce2c9457495d49d0dc7e5a7fdc5ba66fd9696a14a8ed66e71f5c5`。
- 活跃及v1.5 protocol：`c9c6682b434793707e7538b449a5fb78900e3c95c8f77bda63e6c02e138833c6`。
- 最终ROOT/launch-model.mjs：`3d9a23dc73bddc3c52224fd1542599e69fcb14c7a95faa4d15a01557c30d55b4`。

11文件精确起点/当前hash另存own-review-hashes.json。P0报告保留。未修改源码、合同、launcher、旧输入或raw；仅写本评审与own辅助JSON。

未运行边界：新的真实模型QA/repair、容量、真实JDT、完整public/独立locked、发布安装与回滚。本轮已暴露regression的未来提高不能代替泛化或原发布门；public broad及默认worker边界未变，旧QA12/28/NO_GO不会被本次实现改标。
