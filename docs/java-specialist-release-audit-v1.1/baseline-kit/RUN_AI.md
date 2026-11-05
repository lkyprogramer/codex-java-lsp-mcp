# 交给实现 AI 的执行入口

你要修改的是用户指定的 codex-java-lsp-mcp 源码 checkout，不是本包评分器。首先阅读 AGENTS.md、docs/01-execution-master.md、docs/02-design-delta.md、docs/03-dataset-card.md、docs/05-evaluation-protocol.md、docs/06-metrics-and-gates.md。按 tasks/plan.json 的依赖执行，从 T01 开始，先记录现状再修改。

第一轮只完成 M0：运行 preflight、现有源码12探针、建立RED、修T02/T03并证明相应组转GREEN。M0完成后继续M1，不要同一轮又加embedding又改schema又换ranker。每卡提交差异、实际日志、退出码和阶段报告；未授权真实模型时继续离线可做项，将LIVE明确标为BLOCKED_AUTH。

任何与冻结数据/评分器冲突，走label challenge，禁止改答案、降低budget门槛或识别taskID做特判。需要安装/部署/外发源码等权限时不要自行执行。不要访问生产端口38456，不在在线release路径npm ci。

先确认当前源码HEAD是否仍与bundle基线一致；若不一致，只更新源码事实映射与preflight，独立任务标签不随源码HEAD变化。完成报告不得把self-check、源码probe、真实MCP、真实Agent、full-corpus、产品release六种scope的PASS混成一个。
