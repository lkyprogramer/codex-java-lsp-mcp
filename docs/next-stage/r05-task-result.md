# R05 — 贯通重复 FQN 多候选与编译范围消歧（N01）

**Status**: DONE（GREEN；源码导出层 + parser/SQL 层 + 真实 cold build 运行态。JDT 绑定不在本任务范围）
**源码基线**: `04f8e2d`（R01–R04 审查修复）；RED 在同一基线上取得
**Date**: 2026-10-09

## RED / GREEN

| 轮次 | 命令 | 结果 | 证据（`java-specialist-audit-runs/`） |
|---|---|---|---|
| RED | `run_audit.py --cases N01`（`04f8e2d`） | FAIL：`demo.Shared` 在未知编译上下文下被解析为 `RESOLVED_REPO` → `a/Shared.java`（最小 id 赢家） | `r05-red/`，counterexamples sha256 `8b7c4ea8…` |
| GREEN | 同命令（本提交） | PASS：`AMBIGUOUS`，候选两条 | `r05-green/`，sha256 `e401764b…` |
| 全量反例 | `run_audit.py`（27 条） | 13 PASS / 14 FAIL / 0 ERROR；仅 N01 由 FAIL→PASS，其余 14 条属 R06–R10，无回退 | `r05/audit-all/` |

## 根因

`buildTypeRegistryView()` 与 SQL `typeIdByFqn` 对同一 FQN 只保留字典序最小的 v2 id，`JavaNameResolver` 的 QUALIFIED / 显式 import / 同包 / 通配符四个步骤都直接用这个“赢家”。存储层不再覆盖（R00 前的 T02 修复），但解析层仍在多个独立编译范围之间任选一个。

## 机制（单机制：FQN → 候选集合 → 按编译位置可见性选择）

1. `TypeRegistryView.byFqn.get(fqn)` 返回该 FQN 的**全部**声明 id（有序）；新增 `locationOf(typeId)`（来自文件的 `module`/`sourceSet`/`sourceRoot`）。SQL 侧 `SqlFactsStore.typeIdsByFqn` 同义，`typeIdByFqn`/`typeByFqn` 删除（不保留双路），改为 `typesByFqn` 与 `declarationLocation`。
2. `selectVisibleDeclaration(candidates, from, locationOf)`：同模块同 sourceSet → 同模块 main（仅 test 引用方）→ 其他模块 main 或位置未知；main 看不到 test，其他模块的 test 不可见。第一个非空层级决定：1 个绑定，多个 `AMBIGUOUS`；引用方位置未知时所有候选同层，重复 FQN 一律 `AMBIGUOUS`。不推断模块间依赖。
3. `JavaResolutionContext.location`：edge-builder 由被解析文件的 layout 事实填入；`typeLookup(typeText, scopeFile)` 由 scope 文件填入。repo-unique 简单名兜底（步骤 8）只剔除可证明不可见的候选，不增加偏好。
4. 生产 consumer 全部改为候选语义：`plan-query` 按引用文件位置选择（歧义不播种）；`persistence-edge-builder` 多声明不绑定实体、也不误标 external；MyBatis namespace 重同步刷新全部同名声明；框架层旧 `type:<fqn>` 别名被两个声明共享时不再取最小 id，而是记为 missing；`queryTypes` 精确查找重复 FQN 返回 AMBIGUOUS（ids 进 missingIds）。
5. `JAVA_FACTS_REVISION` 2→3：旧快照里按最小 id 写入的 refs/edges 整体重建，不与新语义混用。无 SQL schema 变更（`file` 表已有 module/source_root）。

## 回归锁与边界

| 用例 | 层级 | 文件 |
|---|---|---|
| 无上下文 AMBIGUOUS 且候选集合完整 | parser + 内存 registry | `name-resolver.test.ts` |
| 模块 B 内绑定 B；test 看到本模块 main；他模块 test 不可见；无本地副本时 a/b main 同层 → AMBIGUOUS | 同上 | 同上 |
| 删除 A 后解析到 B | 同上 | 同上 |
| main/test 同名：test 取自身、main 取 main、main 看不到 test-only（含简单名兜底） | 同上 | 同上 |
| nested `Shared.Inner`、两模块同签名 `track()`：字段类型与 CALLS 边都落在本模块 | parser + edge-builder | 同上 |
| SQL 与内存 registry 解析逐项一致；`typeLookup` 按 scope 文件；SQL 视图上的 edge-builder 同结果 | SQL 存储 | 同上 |
| tier 选择器（含 generated/未知位置） | 纯函数 | 同上 |
| store 候选与内存一致、`declarationLocation` 一致 | SQL 存储 | `sql/facts-store.test.ts` |
| 旧别名被两个声明共享 → missing（两种 bundle 顺序） | 框架投影 | `framework-index-view.test.ts` |
| MyBatis resultType 重复 → 不绑定实体、不标 external | 知识图谱 | `persistence-edge-builder.test.ts` |
| 真实 `runSqlColdBuild` 跑冻结 admissions 语料（graduate/undergrad 两模块各有 `demo.Shared`）+ 每模块一个调用方：各自 CALLS 落在本模块 `track()`，根模块无边且 `AMBIGUOUS` | 运行态 cold build（隔离 clone 内 dist） | `r05/r05-runtime.mjs`、`r05/runtime-admissions.log` |

变异检查：把选择器改回“最小 id 唯一”后 7 条 R05 解析用例中 6 条失败（“删 A 留 B”在两种语义下都应通过）；把 persistence / 别名两处改回旧逻辑后各自的新用例失败。

## 回归面

| 项 | 结果 |
|---|---|
| targeted（name-resolver / edge-builder / facts-store / build-fingerprint） | 43/43 |
| scripts 评测 + live e2e / experiments | 76/76 / 30 + 1 SKIP |
| 原 12 源码探针 | 12/12（`probe-12.log` sha `1e06c9b3…`，与 R04 相同） |
| 冻结自检（仓库内 / 原版） | 5/5 / 5/5（summary sha `5f6f4cb1…` 未变） |
| `check_bundle.py` / kit 单测 | PASS 357 / OK |
| `npm run build:isolated` / `npm test` | PASS / 见提交说明（最终在已提交树上复跑） |

## 限制与剩余缺口

- 模块间依赖不从 pom/gradle 解析：没有本地副本时，多个其他模块的同名 main 声明保持 AMBIGUOUS（设计 §2：布局缺失不能推断全仓互相可见）。
- 静态候选即使唯一也只是 `RESOLVED_REPO`，不冒充 JDT_BOUND；复杂泛型不做程序级推断。
- 运行态检查使用 cold build 与 SQL 查询；`java_symbol` 的 scope/exact 语义属 R06/R07，未在本任务改动。
- 观察到的既有限制（未改）：`new Shared().track()` 这种构造表达式接收者不产生 CALLS 边，只有 CONSTRUCTS。
