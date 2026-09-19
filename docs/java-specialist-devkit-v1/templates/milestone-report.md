# Milestone report

## 身份与范围

填写真实 source SHA / dirty tree hash / installed runtime SHA（未测则 UNMEASURED）；dataset_hash、corpus_hash、scorer hash、profile、模型和host版本；本轮属于 FUNCTION_PROBE / SCOPED / FULL / LIVE / RELEASE 哪些轨道。

## 假设和改动

阐明目标失败机制；列实际改动文件、是否增加依赖、删除的旧分支。说明为什么该变动不是按task ID或gold做特判。

## 执行证据

| Command | Exit | Raw log | SHA-256 | Meaning |
|---|---:|---|---|---|

没有运行的命令不得填0。补充build、unit、contract、独立检索、QA、repair、资源和原release各自结果。

## 逐任务差异

| Task / variant / repeat | Baseline | Candidate | First causal break | Closed/new/known |
|---|---|---|---|---|

## 成本与统计

列真实provider usage、missing字段、失败成本；grouped task/corpus统计；budget、冷暖、建库/更新/模型加载分开。无实际model则省token结论为UNMEASURED。

## 限制与决定

写出未测矩阵、locked暴露情况、标签争议。决定GO/NO_GO/INCONCLUSIVE或语义实验四种之一；不得以工具自检替代产品发布验收。
