# 本交付已经验证的范围

## 已实际执行

上传和原devkit archive指纹核对；与旧d86快照比较；阅读当前静态发现、SQL、scope、name resolver、source docs、LIVE loop、canonical/JS评分、repair judge、dense cache与M3报告。

1. 原版frozen devkit自检五阶段全部通过，含56条套件测试与8组baseline/reference冻结Java测试校验。
2. b9内devkit自检失败：dataset字节不符，56条测试中54PASS、1FAIL、1ERROR；repair阶段因冻结验证未通过而没有执行，不能写8组repair都失败。
3. 原12源码探针在b9真实导出函数上12PASS。
4. 当前不依赖native parser的24条产品测试PASS；10条评测脚本测试PASS（未使用SDK transport被stub禁用）。
5. 原实验8条离线测试PASS、1条真实端点SKIP；repair测试文件硬编码个人路径，装载失败。不是其所有20条测试都已运行。
6. 本次新增实际导出函数反例27条：1PASS、26FAIL、0ERROR。包括真实JS loop最后chat payload、实际Node SQLite查询、真实dense cache（fakefetch）、真实frozen judge物化过程（J01调用javac/java）。
7. 本包发布清单检查器22条单元测试通过；仅验证检查器，绝非产品22项上线通过。
8. portable `tools/run_audit.py`重新运行，取得相同27条结果，退出1符合当前缺陷基线。

具体raw在evidence/。全套打包与解包校验结果追加于 `evidence/package-validation.json`，该文件不是产品PASS报告。

## 未完成 / 阻塞

`npm ci`由于registry DNS EAI_AGAIN失败；完整tsc/native编译/产品npm test未执行。`entity-search-bounded.test`单独装载因缺tree-sitter失败，之后明确选纯函数/SQL测试子集24PASS，不把选择性执行写为全量测试通过。

本轮使用全局TS5.8.3转译而非项目声明版本类型检查。环境Linux不验证macOS launchd/部署、真实JDT、watcher全矩阵或生产SLO。没有真实API/model/embedding调用，没有复跑用户私有仓，没有独立核实个人raw目录内的历史144/72/48 runs，没有下载新full公共语料，也未部署。

## 证据边界

27个反例不是独立业务样本，也不是真实任务错误率；N01等使用构造的Facts，证明函数策略缺陷而非AST全部实现。wire测试使用fakechat检查最后messages，不证明真实模型理解能力；D01使用fakeembedding证明缓存语义，不证明某个远端模型质量。

baseline-kit保留了原公开项目源码种子和完整原任务：4份固定原文件并非完整四仓；hydrate入口和独立full-corpus profile也保留。不要把原包参考修复、oracle输出用于被测Agent，或者把已经看过的locked当未见过。

原方案/kit也是本助手先前交付，原12探针覆盖了首轮缺陷但遗漏了最后模型消息、cache reload和scope交叉边界。本包补齐这些盲点；不把旧测试当成完整保证，也不为维护旧方案而给当前结果不当签字。
