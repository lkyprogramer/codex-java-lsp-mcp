# 指标、门禁与统计口径

## 检索

声明命中键为源码path+声明起始行+name，避免同FQN合并或匹配调用行。R@k=top-k去重声明中命中gold数量/gold数量；MRR=第一个gold命中的倒数名次；nDCG@10使用二值gold相关性。别名/等效起始行未列入当前契约，需schema升级而非评分器暗中宽容。

RequiredLineRecall=selected源码行集合∩required行集合/required行集合。重叠去重用于coverage，但重复输出的lines/bytes照常计预算。RangeLineRecall与received_line_recall分开，后者只由校验过的read_events产生。显式anchor containment必须为1或诚实返回预算/环境失败。

## QA与repair

QA contract pass必须同时：输入输出合法、预算内、answer严格类型和值相等、实际received证据覆盖required。候选列表含所有文件仍不能通过。结构化QA是窄任务判定，不是自然语言整体答案质量评分。

repair只有外部干净编译+冻结断言正常退出才通过。编译失败、超时、非零退出、禁止改动都失败。原始版本必须能编译并在目标业务断言失败；否则无从证明用例有效。reference通过不是测试完备性证明，后续增加独立mutants而非只测唯一补丁字符串。

## 状态与分母

OK/PARTIAL/NOT_FOUND是合法结果状态；PARTIAL也不能称“完整无引用”。MISSING/ERROR/TIMEOUT/UNSUPPORTED按失败检索计0，保留原因。输入无效/越界/hash错使结果invalid，不靠抛异常过滤掉。预算超出单列并导致QA/qualification失败；原始coverage可保留诊断值，不允许以其绕过预算门禁。

## 冻结工程门槛

schemas/gates.json是v1提议门槛，供所有者在实施前冻结：核心正确性100%、新增critical regression=0；QA结构契约floor0.8仅用于QA资格检查；warm static P95目标150ms、event-loop P95目标20ms、impact配对P95≤1.2倍。它们不是本次实测达到的数值，也不是统一行业标准。

`harness gate`只输出STRUCTURED_QA资格，不是release。release还需要产品32契约集成、8实际Agent修复、完整公开语料、真实模型任务/usage、macOS原生依赖与JDT回归。单次scorer正确不替代这些项目。

## 成本

Wire bytes、planned source bytes、received source bytes、实际provider usage分别报告。bytes/4只允许写estimate，禁止填actual tokens。input/output/cached/reasoning按provider原字段记录，缺失=null；cached input不再从input总数重复加一遍。完整task累计重新发送历史上下文是真实成本，不作为重复计数删掉。

CostPerValidatedSuccess=所有attempt总成本/真实成功数；零成功则不可用。必须同时公布成功率和失败成本；选择性只看两臂都成功子集有survivorship bias。

## 统计

配对要求数据/语料/配置和case universe一致。先平均同task的中英文和repeat，再计算task差值；cluster bootstrap对12个语料cluster有放回抽样2000次，固定随机种子1984。输出task-macro和cluster-macro，不把二者混名。interval是这份便利样本上的不确定性描述，不证明生产总体泛化。

支持向量的初筛信号：locked未知入口R@10约+0.10，或有预先声明的高价值机制修复；质量不降时实际input中位数约降15%，或成功率提升且成本在预算内。小样本信号不足时判INCONCLUSIVE，不为绿色报告下调分母。
