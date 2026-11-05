# 12 结果、失败与报告规范

每任务一个目录，位于用户指定的隔离work root，不向生产release写报告。建议：

```text
<runRoot>/Q03/<attempt>/
  identity.json
  preregistration.json
  commands.jsonl
  results.json
  review.md
  raw/
```

## identity

记录sourceHead、dirtyDiffHash、productBuildDigest、distDigest、nativeDigest、dependencyDigest；installed身份无法读取时null并给原因。datasetId/digest/split、scope/corpus/hash、模型及provider版本、request预算、机器OS/arch/APFS/电源/睡眠记录分列。禁止只写branch名。

## commands.jsonl

每行保留argv数组、cwd、开始/结束UTC、exitCode、signal、timeout、stdout/stderr文件hash。不要记录API密钥或完整私有源码到公开日志。nonce/授权凭据不写进仓库。

## results.json

见templates。所有“measured”字段必须关联原始证据与对应身份；null表示未知，不默认0。不要把候选吞吐、plannedSourceBytes或工具响应大小冒充providerusage。

## review

独立review区分代码静态检查、重算报告、重跑测试。只读审查不能写“独立重测通过”。P0/P1/P2未关闭时停止进入发布资格；已接受的历史P3写明范围，不能自动豁免新缺陷。

## 失败重试

预先规定最多一次host污染重试并保留原记录。真性能超限不是host污染；需源代码改变则新candidate identity。有效失败不能移到NOT_RUN，不同候选样本不能拼成同一PASS。

## 总报告至少回答

1. 修改了什么、没改什么，是否触发条件成立。
2. 在哪种代码/任务/环境上验证，哪些不能访问。
3. 质量是否提高，何处退化；任务与证据分母各是什么。
4. 总成本、首用成本和维护成本，是否有可解释净收益。
5. 结论是采用、停止还是不确定；部署是否仍需授权。

“测试全绿”没有以上五项，不是完整效果报告。
