# 最终验收清单

## 数据和评测工具

- [ ] 数据集hash与发布manifest一致，全部gold范围对应真实文件。
- [ ] 公开seed Git blob/SHA-256匹配；许可头保留。
- [ ] scorer恶意输入、假success、重复/missing、pathescape、stale、CRLF/UTF8、预算用例通过。
- [ ] 八个repair baseline编译成功且目标断言失败，reference通过。
- [ ] locked暴露情况登记；公开/原创/full/scoped分组明确。

## 产品机制

- [ ] C1/C2/C3源码probe修复后的全部12项通过。
- [ ] K01–K32每项要么有真实集成PASS，要么明确BLOCKED，不能只引用规格存在。
- [ ] staticquery不启动JDT，真实MCP可交付locator→impact。
- [ ] 最终serializer保留anchor，超预算诚实partial。
- [ ] SQLite/watcher/多worktree/WAL/取消/边界无新增回归。

## 效果

- [ ] dev和未用于调参的locked分别有逐case结果。
- [ ] full public corpus独立profile运行；不能用scoped高分替代。
- [ ] 实际Agent QA/repair、provider usage测量完成；native工具未被强制禁止。
- [ ] 质量/成本不劣或例外明确批准，无新critical失败。
- [ ] 语义provider得出四类之一结论；无收益时无默认依赖遗留。

## 工程交付

- [ ] git worktree干净提交、raw日志可追溯、source/runtime/measured版本分开。
- [ ] 原产品full/release/schema测量通过或保留真实失败说明。
- [ ] 没有gold-aware路由、项目名特判、未授权外发、线上目录改动。
- [ ] 当前文档入口唯一，历史材料归档，不强迫后续AI读取全部旧路线。

本清单交付时故意不勾选产品/真实Agent项，因为它们尚未执行。reports/self-check只对应本包已经做过的验证，不替你提前签字。
