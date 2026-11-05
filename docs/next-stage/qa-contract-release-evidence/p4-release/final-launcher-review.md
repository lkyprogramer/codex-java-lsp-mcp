# 最终 launcher 独立只读预检

结论：**PASS。已发现的 CLI 入口缺陷修复并经负向 RED/GREEN 闭合，无未关闭具体 finding。** 此结论仅覆盖 launcher 计划及执行/保存/评分边界，不代表工程、最终模型质量、完整公共语料结果或部署已经通过。当前尚待主代理封印工程与公共准备门；封印缺失时脚本会在凭据读取之前拒绝执行。

## 冻结对象与范围

读取 `launch-final.mjs`、notes、10项离线测试与原9项日志、CLI RED/GREEN日志，追踪原 `buildPlan`／`pendingScoringRows`、原helper `verifyKit`／`measuredSession`、candidate evaluator默认repairJudge和scoreWithFrozenKit、fullPublicPreparation/fullAttemptOptions。原 scorer与完整公共准备模块由独立owner另行评审，本报告只核对调用与封印边界。

最终 launcher SHA-256：`93439e4c6ecd08742eaf281abbf7d42d7a467f8bada2d05eff9b56d66a4d82d1`。离线测试 SHA-256：`ff6652bc8987ba47911e7eb692a6009537a6c836e9bfcf3634644fb2cdf3af96`。历史初版launcher哈希 `db5d1fe9c98fc3840b0ae76bac8ddcdb8408b2a67d5b385e241fc6665d30758b` 被本次入口修复取代；旧运行与测试日志保留。

## 具体 finding 闭合

初版末行使用path.resolve(argv1)与canonical import.meta.url比较。ROOT的/var路径实际为/private/var；symlink入口导致main不运行却exit0。已向作者及主代理即时报告。作者仅将guard改为fs.realpathSync(argv1)比较launcherPath，增加无参数symlink CLI测试；实测RED为actual0/expected1，GREEN为exit1与required业务校验消息。测试仅PATH环境、无候选/动作参数，在main首个参数检查拒绝，不会读取凭据或运行模型。修复后累计10/10 PASS、0skip日志已读取；本代理未重跑。

## 计划、冻结与公平性

- QA按原28题双臂56slot、repair按原8题双臂16slot；public拼接两者为原36题双臂72slot。原armOrder种子1984、每题每臂repeat1、唯一key与broad保留；八题历史不覆盖。本轮全部已暴露regression，不构成新的独立locked证据。
- assertFrozenUniverse逐内容比较baseline tasks/gold与原kit dev+locked，36唯一id均要求匹配。verifyKit对原150文件范围的hash及file-set检查保留；合同、protocol、evaluator/adapter、原launcher/helper、工具/submit schemas及全部prep .mjs均进入prereg binding。
- 当前candidate来源为state.p4Candidate（6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864、611files、zlPTg7），不会误用历史state.sourceDigest 5f9c8f。P1/P2/P3 PASS、worker1原性能PASS及report hash、同digest工程PASS、prep modules/review seal均在prepare/drycheck/run及每slot前后校验。工程与prep实际PASS seal由主代理提供；缺失时不自动绕过。
- public用全语料repoRoots、原fullAttemptOptions与默认真实repairJudge，结束后仅调用一次scoreFullPublic，不借用scoped scorer代替。corpus binding包括文件集合/hash、输入/provenance；不把变化的完成时间戳作为漂移。实际完整语料有效性由validateCorpusInputs及独立prep review承担，执行前后与评分后均调用校核。

## 评分、分母、数据保存

- raw `live-runs.json`先保存；QA保留行taskSuccess=null、UNMEASURED。原live的clone传给原冻结scorer，只有返回frozen-kit后才将结果提升。throw或authority失败保留pending QA且停止，planned余行仍为missing，不将preliminary或patchApplied当正确性证明。
- 模型NO_SUBMISSION、FAILED_RUNTIME、blocked/rejected等原boundary返回行继续按scheduled执行，不删历史或补替换。内部throw/漂移则保存FAIL、原planned分母、missing列表及已获得raw；不伪造未返回的模型结果。QA与repair scheduled/actual/missing/measured/success分母分开，repair仍依据默认原judge实际测量。
- stage与run若存在均拒绝覆盖。保存attempts/execution/results/completion，逐block产物独立，旧P2/P3及其他history路径未用作写入目标。provider usage仅用原runs/assemblePack测量，不把wall转换为token或币值。block wall含workspace/session/model/judge/close、排除scorer；额外scoring及overall边界已公开。
- prepare/drycheck仅静态import、冻结校核及准备，不进入provider文件分支。provider配置读取仅run且所有前置binding成功后；worker只接受冻结model与none，并继承原2048 completion token请求、thinking false、16round。两臂统一公开合同，product broad、生产默认单worker、预算及原门不变。

## 已运行与未运行

本代理只执行只读源码/日志阅读、定向检索与SHA-256核对；仅写此报告。观察作者日志：原9/9离线通过、入口RED→GREEN1/1、修复后累计10/10通过零skip。未运行：任何模型、实际prepare/drycheck/run、凭据读取、JDT、benchmark、full suite、installer或daemon替换。

允许主代理在工程和完整公共准备独立封印之后执行最终计划。完整公共准备模块独立CLI也有同类guard，已转owner；final通过import调用它，未触发该CLI guard，不影响本launcher路径。任何模块修复须更新moduleHash/review seal后再prepare。
