# 最终 candidate repair16 实际独立评审

结论：**PASS，无具体宿主或产物 finding，可进入原public72阶段。** 原8repair groups在product/control各8/8实际MEASURED及VALIDATED_SUCCESS；16scheduled/actual，无missing。本报告未新增repair成功率门：原门要求实际candidate与原judge被测量，本轮实际结果全通过。QA26/28与24/28阶段报告单独保留，不混入repair分母；public72尚未测量，不宣称整体发布完成。

候选6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864、611files与prereg/currentcandidateIdentity一致；launcher93439e4c6ecd08742eaf281abbf7d42d7a467f8bada2d05eff9b56d66a4d82d1不变。1154项只读核查零错误，逐slot文件树、mutation数、artifact SHA、原frozen test SHA与usage在review.json。后续source-package-r2初始Git快照不作为模型本轮base。

## 实际修改和原判定器

逐项读取16个模型修改候选、原工具日志、accepted提交与frozen-judge.json；在内存从冻结原corpus依序重放成功replace_file的before/after字节，验证before仅一次匹配。所有最终重放文件逐个SHA等于真实candidate，且candidate完整文件集合/hash等于judge artifact.candidate_tree。只发生原allowed_edits内变化，policy无violations／missingAllowed／symlink／额外删除；没有拿reference-change或offline oracle的positive candidate替代模型产物。

每个artifact.task_id正确且mode=candidate；frozen_test_sha256对应原manifest test_file，judge_wrapper_sha256对应原harness静态wrapper（74c1f6e982f0cc2e5d26c388dc67b48d3b9446c29e6541c71e7ddef136379232）。实际javac与java均exit0，无timeout/output_limit，PASS、validated_success和frozen_test_completed均true。原150-file kit内容/file-set、tasks/gold及launcher绑定核查通过。

原八组baseline业务RED来自本P4冻结selfcheck已保存的repair-oracles.json：各组同原test SHA、同原corpus tree，javac成功、run exit1且AssertionError。这里只复用它的baseline实测，并与当前模型candidate GREEN逐组绑定；reference成功不计入本阶段模型结果。本代理未重新运行test或oracle。

原harness使用TemporaryDirectory，内部复制源树、classes、wrapper文件及nonce完成文件已清理。本评审核查保留artifact中的compile/run argv、退出值及frozen_test_completed元数据、静态wrapperhash和真实candidate；未声称读取已删除的nonce或独立重执行judge。

## 原始链路、源码和提交

98真实request/response逐一对应身份、序号、messages payloadHash、模型与2048/none/thinkingfalse配置。91原工具结果rawHash正确；accepted submit_answer关联真实response，仅patchApplied:boolean与summary:string两字段，repair使用typed v1 schema，public QA角色applied=false；不把QA v2/schema套给repair。patchApplied只是模型声明，成功只由实际original judge产生。

31个SOURCE_RECEIVED均能映射保留快照、文件/切片hash、准确行窗与真实请求tool正文；candidateReceiptValidation均VALID。修改后finalCandidateMatches=false是正常版本差异，核对的是当时读取快照，不把修改前源码与修改后候选混淆。

Control PAGINATION-03实际SOURCE_RECEIVED=0。它通过rg定位、执行真实replacement并经原judge通过；不能据此称其源码回执完整，也不凭新增QA源码门否定原repair成功。所有source历史与原结果保留。

## 实测usage与时间

| 指标 | Product | Control |
|---|---:|---:|
| scheduled / actual / measured / success | 8 / 8 / 8 / 8 | 8 / 8 / 8 / 8 |
| input tokens | 102703 | 89130 |
| output tokens | 2723 | 2505 |
| total tokens | 105426 | 91635 |
| cached input tokens | 84345 | 73198 |

全部provider usage非负整数、cached≤prompt、total=input+output，98response相加与16slot原usage一致；input包含历史重传，不重复加cache，不虚构货币成本。Overall178701.738ms，block wall167101.344165ms、原scoring6124.102542ms。wall包含session、模型、真实judge与关闭，不能当独立索引构建或纯推理耗时。

## 范围和下一步

两臂同原8groups、repeat1、broad/defaultworker1、原模型配置、原allowed-edit策略与冻结test；不替换失败、不放宽门、不反馈gold。已暴露regression结果不宣称独立泛化。可按既定计划进入public72，仍须完成其实际全语料模型/评分和独立审查。

本代理实际执行只读JSON/hash/内存mutation重放/原validator与identity检查，仅写review.md/json。未运行模型、judge/scorer、测试、benchmark、JDT、fullsuite或installer；未修改源码、candidate或raw。
