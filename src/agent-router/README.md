一旦我所属的文件夹有所变化，请更新我。
本目录承载 `java_impact` 的 agent 级 Java 语义路由器。
它先用源码索引和内部 rg 收敛影响面，再按策略进行有界 JDT LS 增强。

## 文件清单

- `README.md` | 目录说明 | 说明 agent router 目录职责。
- `index.ts` | 路由实现 | 解析 anchor/profile，生成 rgPlan，执行安全 rg，合并 LSP candidates，评分并输出 readPlan、suppressed、evidenceGaps 和 metrics。
