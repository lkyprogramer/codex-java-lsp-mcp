# 报告规范与归因

每次实验目录包含：run.json（身份/预算/授权），raw tool/host events，results.json，score-report.json/md，repair-results（如有），resource-samples，decision.json，完整命令与exit。用SHA-256记录文件，不只截图成功字样。

报告第一段先写 scope：FUNCTION_PROBE / BUNDLED_SCOPED / FULL_UPSTREAM / LIVE_AGENT / PRODUCT_RELEASE。若来源不同，分别列行。旧三仓可继续作为supplemental，但不进入本独立集分母。

逐case失败归因固定：ENTRY_ABSENT、SCOPE_COLLISION、WRONG_DECLARATION、EVIDENCE_EVICTED、RANGE_MISS、STALE_VERSION、BINDING_AMBIGUOUS、TOOL_NOT_USED、ENV_ERROR、BUDGET_EXHAUSTED、ANSWER_WRONG、PATCH_TEST_FAIL。可以多因，但应注明first causal break；只因看到错误最后一行就猜根因不合格。

必须显示：当前已知失败、candidate新增失败、已关闭失败、持平；均值提升不能遮住新的critical regression。子集/全体、dev/locked、中文/英文、origin、corpus分组并列。小样本不给“稳健领先”的措辞。

费用/usage缺失写UNMEASURED，schema/bytes是工程代理。对生产运行状态只能引用实际安装与测量SHA；source HEAD并不等于installed runtime。

模板见templates/milestone-report.md、run-manifest.json、decision.json、label-challenge.md。模板中的null不是待AI编造的数字，而是尚未测量的合法状态；完成实际运行后才填入原始记录。
