# B3 升级报告：G2 不可解（图/索引层缺口）

日期：2026-08-24  
状态：**STOP**。这是 2026-08-24 收口计划的唯一停点。`main` 未动。没有第四次 live。`java_context` 仍不在公开工具面。

## 证据链

1. **G2（旧 golden）**：ruoyi 留出折 recall/pRead/rReadMust 回撤 0.179/0.516/0.477 > 0.15。第一次刀打在 N4 planner，LORO 测的是 impact 默认链。
2. **A1**：六条预注册规则，holdout 未读。ruoyi tuning noisyRate **0.464** ≥ 0.30；三仓对照 0。裁决 `GOLDEN_NOISY`。
3. **A2a**：规则取反过滤 eligible 382→238，整文件替换 40 场景。tuning 再审计 noisyRate 0。LORO 三折 GO；ruoyi **recall 回撤 0.121 过门**，**pRead 0.536 / rReadMust 0.416 仍超 0.15**。裁决 `GOLDEN_FIXED_CHAIN_STILL_FAILS`。
4. **B0**：仅 tuning 28 条。76 个 mustHit 缺失文件：
   - `NOT_IN_POOL` **50%**（> 40% → 结构性）
   - `IN_POOL_EVICTED` 30.3%
   - `RANGE_MISS` 19.7%
   - 选择层合计 50% < 60%，**不进 B1/B2**。
   模式：未入池的普通 `*.java` / `*ServiceImpl` / `*Mapper` 多于预算驱逐。

结论：H-golden 只解释了一部分；扣掉噪声后，ruoyi 留出失败的主体是 **候选池没找到文件**（图/索引/candidate 生成），不是 `read-plan-budget` 两把条件刀能修的选择层问题。按计划不得开第三把刀、不得重写图架构。

## 三个方向（等用户）

| 选项 | 做什么 | 后果 |
|---|---|---|
| A. 接受风险合并 | 跳过 G2 门，走 F1 三仓对比后合 `main` | ruoyi 作为第四仓质量无保证；F1 仍用三仓 goldens |
| B. 立项图层改造 | 新工作项：candidate 生成 / 图边 / MyBatis-Plus 发现 | 超出本收尾范围；`main` 继续用 V4 旧链路 |
| C. ruoyi 降观察仓 | 等价 A2b：LORO 门改为三仓折 GO + ruoyi 仅记账 | 可继续 F1；G2 记观察而非过拟合 FAIL |

推荐不在本报告里替用户选。停在这里。

## 硬禁令仍有效

- 不合并 `main`（本轮）
- 不第四次 live
- 不把 `java_context` 加回 `PUBLIC_JAVA_TOOLS`
- 不读 holdout 调参
- 不放宽 15% / F1 数字门
