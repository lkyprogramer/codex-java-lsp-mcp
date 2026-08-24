# Task 30：Token-aware、多 range ReadPlan Planner 最终验证报告

日期：2026-08-04

分支：`codex/java-intelligence-v3`

基线：`652e9765ff3691214116782b383ce9d3ffa7c6ef`
候选：当前未提交工作树；源码与 golden fixture diff（不含本报告）的 SHA-256 为 `6538ab277db57ffdebf9a513e75f2aa169a04f82c35880302bb98494b3ae5bc9`。

## 结论：实现与三仓门禁通过

Task 30 的本地实现、回归和最终三仓 cold-nolsp 配对门禁均通过。新候选在 lishuedu、cipherlink、exam-parent-v3 的 `R_read_must` 都为 `1.0000`；recall 与 `P_read` 没有低于同提交旧实现；候选 P95/旧实现 P95 均不超过 `1.10×`。

此次结论只对应上方 diff hash 所标识的未提交候选。`runtimeBuild.gitSha` 仍显示基线 SHA，因为构建印章无法表达工作树差异；不得把它误作候选提交标识。Git 提交/推送不在本报告的验证范围内。

## 修复范围

- protected-core 和边际效用不再把 `utility/byte` 作为第一排序键；字节上限仍由 `canAdd()` 硬性执行。这样不会让低字节但低价值的粗粒度候选挤掉已解析的结构关系。
- 关系 provider 将冷态 AST 调用、嵌套调用、接口到实现的有界续接、参数/泛型返回类型事实转成带来源和深度的证据。`callOrigin` 区分锚点直接调用与实现续接，避免后者覆盖前者。
- 仅当名称解析器已证明 wildcard import 在仓库中唯一时，才将其用于 repository receiver/签名类型；最终候选仍要求精确目标方法。没有按仓库名、目录名或文件名添加规则。
- 有界的直接调用发现会优先保留锚点声明字段的 receiver，再按调用嵌套深度和源码位置取前 12 个；同名参数遮蔽字段时不享受该优先级。
- 具体锚点直接声明的接口/父类型以 `TYPE_SYMMETRIC` 作为公开契约，位于实现扩展和字段上下文之前；这恢复了端口实现的契约文件，而不是为某个项目写特例。
- 已索引的精确 `resolvedCallees` 也显式标为锚点 depth 0 调用，避免其因缺少表达式位置元数据而丧失 protected-core 槽位。
- `testReadMode=defer` 的测试候选仍可出现在候选输出，但不得通过 pre-semantic protected path 占用 range-query shortlist；shortlist 对外部 protected path 同样防御性过滤。
- `queryReadRanges()` 对同一文件只计算一次换行偏移，避免每个 range 重复完整扫描。

新增/扩展回归覆盖了：直接锚点调用与实现续接的身份去重、唯一 wildcard import、字段 receiver 被调用上限保留、接口契约优先级、受限 mapper 竞争、排序键修复以及 range 偏移复用。

## 验证

### 类型与回归

已运行并通过：

- `node node_modules/.bin/tsc -p tsconfig.json`
- `node --test dist/agent-router/read-plan.test.js dist/agent-router/providers/relationship-provider.test.js`
- `JDTLS_BIN=/usr/bin/false JAVA_LSP_FILE_WATCH=0 node --test --test-concurrency=1 "dist/**/*.test.js"`：`688/688` pass，0 failed，0 skipped。
- `git diff --check`

全量测试及所有 benchmark 子进程均设置 `JDTLS_BIN=/usr/bin/false` 和 `JAVA_LSP_FILE_WATCH=0`。它们不会连接、重启或共享正在使用的 JDT LS；每个 benchmark cell 使用独立的 `/private/tmp` index cache。

### 最终三仓 cold-nolsp 矩阵

唯一用于本结论的原始数据位于 [`matrix-final4-20260804`](../../artifacts/model-eval/task30-20260804/matrix-final4-20260804/)。矩阵为每仓 AB/BA/AB 三轮、每格 5 runs：旧实现和当前候选各 15 次/场景，共 18 份 JSON、480 个 scenario attempts。每一轮内项目顺序固定；每个项目的顺序为 old/new、new/old、old/new。

| 仓库 | 旧 recall | 新 recall | 旧 `P_read` | 新 `P_read` | 新 `R_read_must` | 旧 P95 ms | 新 P95 ms | 比值 | 门禁 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| lishuedu | 0.7546 | 0.7546 | 0.5972 | 0.6806 | 1.0000 | 203.01 | 210.44 | 1.037× | PASS |
| cipherlink | 0.9214 | 0.9214 | 0.5333 | 0.6200 | 1.0000 | 85.38 | 83.73 | 0.981× | PASS |
| exam-parent-v3 | 0.8600 | 0.8600 | 0.7000 | 0.7000 | 1.0000 | 121.65 | 130.03 | 1.069× | PASS |

P95 按各仓 3 轮全部 scenario attempts 汇合后，以 `ceil(n × 0.95) - 1` 取样；quality 指标为相同 attempts 的算术平均。所有候选 attempt 的 `R_read_must` 均为 1.0，而非只用平均值掩盖单场景遗漏。

门槛及结果：

- `R_read_must = 1.0000`：三仓通过。
- `recall`、`P_read` 不低于旧实现：三仓通过。
- `P95(new) <= 1.10 × P95(old)`：三仓通过，最接近门线的是 exam-parent-v3 的 `1.069×`。

此前的 `matrix-final`、`matrix-final2`、`matrix-final3` 和定向 probe 是诊断过程产物，不参与最终判定：它们分别暴露 paired quality/P95、cipherlink must、以及审查发现的 deferred-test shortlist 边界。不能将这些中间数据与本节矩阵混合。

## 经验与边界

1. `R_read_must`、recall、`P_read` 与配对 P95 是并列硬门；绝对 P95 低于 300 ms 不能替代配对质量门。
2. 冷态关系扩展必须保持语义来源：锚点直接调用、实现续接和纯结构候选不应共享同一无来源优先级。
3. 限额问题应先确定保留哪些已证明的事实，再施加文件/字节上限；单纯增大数量上限或按文件名补规则会掩盖真实排序缺陷。
4. 每次改变全局排序后必须重跑三仓完整矩阵；不能回放旧 shadow 或局部 probe。矩阵脚本也必须使用 shell 数组/显式参数，不能依赖 zsh 的多词字符串展开。

未覆盖项：本轮是 cold-nolsp，不替代真实 JDT LS 的 warm/startup 性能或未纳入的第四仓质量验证；候选尚未被用户授权提交，因此报告以 diff hash 保障可追溯性。性能门已解除，后续任务可以在保留该候选边界的前提下开始；正式交付前仍应提交这一已验证的源码与报告。
