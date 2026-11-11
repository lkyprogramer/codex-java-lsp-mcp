# 10 来源 → 方向 → 任务 → 验证

| 证据/需求 | 分类 | 执行任务 | 最小验收 |
|---|---|---|---|
| 用户已上线 vs status NOT_READY | 待对齐，不判用户错误 | Q00 | source/installed/measured三身份与未知项 |
| JDT报告120s vs 当前独立600s | CODE/REPORT差异，来源已定位为`07c6ccf` | Q00（含README改正）、条件Q09 | 阶段预算与caller deadline有明确合同；README与源码一致 |
| G12 seed巨大收益 | REPO_REPORT，保留成果 | Q11 | 不重写owner；受影响回归 |
| G13低recall/evidence未改善 | REPO_REPORT | Q02、Q03、Q04 | 文件/声明/范围/最终消息分层 |
| MAC16未建立绑定缺陷 | REPO_REPORT | Q08条件门 | 未触发不重写resolver |
| 当前symbol无outline | CODE | Q03 | 五tool不变；静态文件内候选 |
| evidence仅XML FQN关联 | CODE | Q04 | Java声明和XML各自source hash |
| compact已保护选中证据 | CODE | Q07条件门 | 同候选spans保真，不再修旧问题 |
| 当前有有限关系/ReadUnit | CODE | Q05、Q07条件门 | 局部增量而非全图/增预算 |
| no_vocabulary_overlap/terms已有 | CODE | Q06条件门 | 宿主显式terms，无后台LLM |
| MAC10 planner弱/模型未测 | REPO_REPORT | Q01、Q10 | 不用单词rg给native造弱基线 |
| repair固定marker漏洞已披露 | CODE | Q01 | early-exit-zero不通过；无沙箱夸大 |
| UsageBench范围与family区别 | 外部方法 | Q08 | 标识符范围/目标/家族分别计分 |
| RepoNav后检索导航假设 | 外部方法，Python边界 | Q03、Q10 | outline能力与组织方式分开消融 |
| 用户embedding否决 | 用户硬边界 | 全部 | 无dense臂、无模型下载与向量依赖 |
| Mac个人项目可维护性 | 用户硬边界 | Q12 | 一条默认链、无长期双后端 |

## 不能从来源推出的结论

不能说G12使Java分析精度提高；不能说K32通过证明Agent任务通过；不能说MAC16 NOT_RUN意味着JDT不可靠；不能从UsageBench11题得出Bifrost全面优于JDT；不能从RepoNav采用dense得出本项目应重启embedding；不能从未读到部署回执得出用户未部署。

## 变更范围账本

每卡记录：新建/修改文件、原路径是否存在、纯展示还是候选变化、schema变化、数据集/原地板是否保持、受影响K编号、online LOC净变化。Q11验证账本与git diff一致。
