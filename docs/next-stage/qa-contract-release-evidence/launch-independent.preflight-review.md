# P5 independent locked 公开runner独立预检

结论：**公开adapter与copier selector预检PASS，无具体finding；不授予未完成owner封定/复审的运行许可。** 9QA+3repair、24两臂独立locked计划尚未由本代理执行。Private owner/gold/测试/证据坐标的正确性和安全receipt语义须由专属owner独立评审覆盖，本报告不越过该边界。

本代理只读公开runner、原executor必要路径、公开README、作者offline测试与TAP、copier精确selector、freeze-public元数据（hash/版本/count/opaque seal字段）。没有读取privategold/owner私有实现或坐标，没有importowner，没有执行prepare/drycheck/model/test/build/JDT/collect/copy，也没有读取Pi凭据。只写本新预检报告，旧copier r3等报告保留。

## 最终文件绑定

- 最终`launch-independent.mjs` SHA256 `92d57fc50218ecd85c6f37038a67a75f960f5d85110efb32de7a19b59f8ba9af`。最后变更仅按父要求把说明改为`24 planned single paired independent locked attempts`，不再误称新集为regression。作者先前c003…及7b815…/c068…为历史版本，不作为本报告freeze。
- 原`launch-final.mjs`实际SHA仍 `93439e4c6ecd08742eaf281abbf7d42d7a467f8bada2d05eff9b56d66a4d82d1`，未篡改。
- `launch-independent.offline-r5-final.tap`实际SHA `52a6ac169c34a0a1fef075de8f30b84f6ec5802b0df3612ec6cab637ef3fec36`，5/5PASS、fail0、skip0。早期r3 5/5与r4 profile窄重跑1/1（另外4skip）保留，未误写成该窄跑零skip全suite。
- copier实际SHA `0c3a0761146bcd88ede5b91e705318f457e7fa002bee4adf6dc0bac84a8d8a02`；新增selector proof实际SHA `42c8bd01344b9c410d31c1492173d7a58b660298b031fc468978300bdcef4b19`，1/1PASS。
- r2公开freeze-public实际SHA `0f1faaab3dfecc2b53bc59b24dc7a0b29037547696996d330f87c654e35a2528`，25publicFiles、source6d/611、version independent-locked-release/v1.0-r2；公开接口登记SHA `82133f37fd2197de71dcece7f03586e580e57dc80a4efe0b3de9483fee0340ad`。这里只核公开登记元数据，不替代ownerprivate seal真实性复审。

## runner已核查路径

1. buildLockedPlan严格12唯一tasks，9QA/3repair，QA budget160lines/16000bytes；原armOrder seed1984/repeat1生成24product/control键。source固定6d/611、broad、默认reader1、Qwen3.8-next、2048completion/none/thinkingfalse/16rounds等配置保留。Prereg绑定公开manifest/files、candidate/evaluator/protocol/helper/executor/launcherhash、tool schema和opaqueownerseal；checkBinding以完整对象与schedule比较，块前后重检。
2. 可运行公开根仅p5-independent-locked-v1-r2；v1历史根另存。Public input路径拒绝绝对/空/./../symlink；所有登记公开文件hash与corpus精确file-set核验，不读取gold.jsonl/private-manifest。公开datasetHash/corpusHash须64hex并入prereg，不将opaquehash解释成答案或坐标。
3. prepare/drycheck在任何owner import和Pi读取之前返回；要求父state登记FROZEN_REVIEWED、真实reviewstatus/hash和该manifest/source绑定，因此当前未封定接口不能因本adapterPASS直接运行。stage/run不覆盖。
4. 实际run的父进程沿原Pi配置读取provider后，仅把所需凭据传入isolated child ENV，不落盘credential，也不放入prereg/pack。worker校验model/none，才import公开owner interface；scope内异常由原executor与child顶层按APIkey脱敏。Prepare/drycheck没有这些副作用。
5. wrapper复用原runLiveEvalRun和executeFinal，hardcoded旧kitRoot由参数覆盖为publicRoot，并传public repoRoots。gold始终new Map，原API空gold行为经proof观察为UNMEASURED/taskSuccess=null/NO_GOLD。原executor保存raw live，保留pending clones，只有scoring正常返回才把scored clone提升；正常失败及fatalmissing仍保留24原planned分母。
6. verifyOwner同步核opaque seal/count/privateManifestSha256，在block/live/repairjudge/scoring前及score后检查。Repair callback只把原taskId/candidateRoot/outputRoot映射到owner的outputDir；没有读取private参考测试/答案。receipt内容及privatejudge隔离由ownerreview负责，本预检没有假称已验证其实现。
7. owner.score显式透传model/arms/repeats/productProfile=broad与runs/outputDir，不依赖owner默认；拒绝Promise、preliminary-js和非frozen-kit结果。返回datasetHash必须精确等于public frozen manifest.datasetHash，且后续不可变；pack datasetHash在首次接受该原owner score之前保持null。未自行归一化答案或重打分。

## 已有offline证据与剩余范围

作者5tests验证：原emptygold null、24keys、wrapper参数/repairoutput映射及broad透传、opaque seal/非原score/Promise与dataset mismatch拒绝、公开file-set漂移、score失败时原executor仍保留24计划与null。均为fakeowner/session或直接原纯函数；没有模型请求或private访问，不能称新locked实际通过。

Copier仅新增两个精确root目录selector`p5-independent-locked-v1`及`p5-independent-locked-v1-r2`。新增fakeproof保留两处独立raw目录，拒绝private-owner根目录，且v10仍OUTSIDE_TASK_DIRECTORY_SELECTOR。既有P4guard和NO_GO/copy-only权限边界未改变；没有以selector加入推导P5/locked/perf/发布PASS，也没有实际collect或检查真实ROOT完整包。

下一停止点：先完成r2 owner公开/私有seal及safe receipt独立评审和父state登记，再按用户授权运行prepare/drycheck与24原plannedattempts。实际请求、canonical owner判断、完整失败分母、最终门和打包收据分别记录。本报告只关闭公开runner/selector准备阶段，没有改原exposed56/16/72的分母，也不把新locked独立性外推为生产性能。
