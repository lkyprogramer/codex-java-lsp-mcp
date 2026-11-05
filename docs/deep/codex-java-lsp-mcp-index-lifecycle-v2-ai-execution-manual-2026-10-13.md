# codex-java-lsp-mcp 索引生命周期 v2：Mac 专用执行手册

| 项 | 值 |
| --- | --- |
| 版本 | `ILV2-MAC/6`，2026-10-14（结构修订：手册拆为索引+规则/合同/卡片/验证/账本，MAC-00 spike约束回填MAC-04/05/12，G06C不再重复真实launchd恢复证明，执行顺序MAC-03A∥MAC-04→MAC-05；产品合同与阈值不变）。前版 `ILV2-MAC/5`：工作根迁出TCC保护目录、门状态单源、两级开发循环。替代本文件的旧 P0–P4 执行顺序 |
| 当前状态 | `IN_PROGRESS`。各门状态唯一真源为 [`docs/index-lifecycle-v2/mac/status.json`](../index-lifecycle-v2/mac/status.json)，`scripts/ilv2-mac-status.mjs` 校验它与各 `task-result.json` 及本手册一致；本手册不复制逐卡执行状态 |
| 目标 | 消除构建活锁、错误新鲜度、跨 worktree 内容污染和请求失控；让同内容复用、真实差量构建及后续 agent 收益可测 |
| 平台 | Mac 专用：2026-10-13 读取为 `arm64`、macOS `26.5.1 (25F80)`、Node `22.16.0`、SQLite `3.49.1`；MAC-00 冻结绝对可执行路径、digest和完整versions，并核对实际生产工件；不自动升级 |
| 技术路线 | TypeScript + SQLite + 小型 macOS 原生 helper；APFS 硬前提；唯一 daemon、不可变内容快照、显式 full/delta、统一 lease |
| 不做 | Linux/Windows/Intel 适配、旧 schema 迁移、旧输出兼容层、普通复制兜底、先修旧版再部署；提前恢复新服务按 §3.1 选择 |
| 实施起点 | 分支 `codex/index-lifecycle-v2`；手册重写前 HEAD `9b3a110`；历史源码基线 `ad412ceb51bc616df3700feca7d3c14ea6dc5ee0` |
| 设计输入 | [Mac 深度 review](codex-java-lsp-mcp-index-lifecycle-v2-macos-review-2026-10-13.md)，F01–F12 |

本手册是实施任务合同，不是实现完成记录或操作授权。`PLAN_READY` 不意味着产品已修复。旧 P0-T0 的历史成果保留；旧任务的 PASS 不能转成 MAC 任务的 PASS。启动实施须有用户的实施指令，具体副作用继续遵守 §0.1。


## 文件结构

每张卡只需加载本索引、对应卡片和卡片引用的章节。章节号保持不变，§x.y 引用按下表找文件。

| 文件 | 章节 | 内容 |
| --- | --- | --- |
| [rules.md](ilv2-mac-manual/rules.md) | §0、§1 | 权限、完成合同、产物边界；历史输入与根因 |
| [contract.md](ilv2-mac-manual/contract.md) | §2 | 唯一目标合同 |
| [cards/MAC-xx.md](ilv2-mac-manual/cards/) | §3 各卡 | 每卡范围、步骤、目标测试与门 |
| [verification.md](ilv2-mac-manual/verification.md) | §5、§6 | 命令、负载/oracle、证据结构、物理成本；验收门与三仓命令 |
| [ledger.md](ilv2-mac-manual/ledger.md) | §4、§7–§9 | 旧路径删除账本、F01–F12 追踪、历史任务替代、来源 |

## 3. 实施顺序与任务卡

任务表是依赖 DAG。没有依赖冲突的只读工作、数据集建设可并行；不并发修改同一所有权/状态模块。MAC-00先用旧实现做成本spike，MAC-05跑真库薄切片，MAC-08前置查询/三仓回归，MAC-11完成含调度、故障和GC的系统闭环，再进入MAC-12热点优化；不以“全量单测绿”代替它。

| 任务 | 交付 | 依赖 | 完成门 |
| --- | --- | --- | --- |
| MAC-00 | 冻结runtime/输入、旧实现spike和成本边界 | 无 | G00 |
| MAC-01 | 状态/故障 oracle、runner 和遥测骨架 | MAC-00 | G01 |
| MAC-02 | native构建/clone、flock launcher、FSEvents三张子卡 | MAC-00、MAC-01 | G02 |
| MAC-03 | 同字节捕获与tracker两张子卡 | MAC-01；MAC-03B另需MAC-02C | G03 |
| MAC-04 | 唯一新schema、稳定符号ID、逻辑导出 | MAC-00、MAC-01 | G04 |
| MAC-05 | 显式full/delta及真库薄切片 | MAC-02A、MAC-03A、MAC-04 | G05 |
| MAC-06 | owner/调度、query取消、恢复三张子卡 | MAC-02B、MAC-05 | G06 |
| MAC-07 | SnapshotStore、原子绑定与统一 lease | MAC-03、MAC-04、MAC-06 | G07 |
| MAC-08 | 请求/transport接入、删除、早期回归三张子卡 | MAC-05、MAC-06、MAC-07 | G08 |
| MAC-09 | GC 与真实故障矩阵 | MAC-08 | G09 |
| MAC-10 | 真实 task/gold/oracle 与无模型评测 | MAC-01 | G10 |
| MAC-11 | lishu-v2完整系统闭环；可选提前发布检查点 | MAC-09 | G11 |
| MAC-12 | 根据 profile 优化写放大、并行与语法复用 | MAC-11 | G12 |
| MAC-13 | 面向任务的工具合同与 guidance | MAC-10、MAC-11 | G13 |
| MAC-14 | K01–K32、全量和三仓整合验收 | MAC-09、MAC-12、MAC-13 | G14 |
| MAC-15 | 成对模型 A/B 与最终 holdout | MAC-10、MAC-13、MAC-14；最终holdout另需MAC-16 | G15 |
| MAC-16 | 语义精度实验，按失败证据决定 | MAC-14 | G16 |
| MAC-17 | 最终候选、安装包、canary 和交接 | MAC-14、MAC-16 | G17 |
| MAC-18 | 最终候选正式切换（或提前版本的后续升级） | MAC-17、明确安装授权 | G18 |
| MAC-19 | 观察、结果分账和收尾 | MAC-18 | G19 |

**推荐执行顺序（DAG 内的调度选择，不改变上表依赖）：**

1. MAC-03A ∥ MAC-04：两者只依赖已通过的 MAC-00/01，所有权按卡片范围划分：MAC-03A 为 `java-index-file-parse.ts`、`search-document.ts` 与 capture 类型，MAC-04 为 `src/java-index/sql/*` 与身份读写点。两者都要改 `index-builder` 调用点时，先合入的一方拥有该文件，另一方 rebase。并行时各用一个 git worktree，放在 `MAC_WORK_ROOT` 下，不放 TCC 保护目录；不并发修改同一状态模块。
2. MAC-05，含 lishu-v2 真库薄切片：尽早用 MAC-00 实测约束（`cards/MAC-05.md`）验证 5 s/15 s 首证据和页写入预算；falsifier 成立时回到 MAC-04/05 修，不推迟到 MAC-11。
3. MAC-06 → MAC-07 → MAC-08。MAC-03B 只依赖 MAC-02C 与 MAC-03A，可插在 MAC-05 之后，须在 MAC-07 之前完成。
4. MAC-10 只依赖 MAC-01，可在任意空闲时段并行；不得占用正在跑三仓/真库测量的主机窗口。

MAC-15 的付费授权不阻塞工程候选 MAC-17，但缺实测时不能宣称 agent 成功率/token 提升。MAC-16 可以因没有语义失败证据而 NOT_RUN；若实施语义修改，MAC-17 必须使用修改后的源码，并重新完成 MAC-14 受影响门。MAC-15 可以先做 dev pilot；最终 holdout 必须等 MAC-16 PASS/有依据 NOT_RUN、相关 MAC-14 重验以及 source/native/driver/guidance 冻结后才运行。若 holdout 后又有影响行为的修改，旧收益证据过期，只能使用新 holdout，不能在同一保留集补测调优。这样避免把条件实验伪装成已完成能力。

### 3.1 可选提前恢复服务，默认不执行

G11正确性通过后可以准备提前候选，避免把数据集/模型实验/后续优化误当恢复服务的必需前提。这不是自动部署授权，也不是“只要G11绿即可安装”。提前候选必须完成G00–G09适用合同、G08C容量/三仓、G11正确性/有界资源，并前置执行MAC-14的必需全量/PR/K01–K32（含实际提供语义能力的真实JDT证据）、MAC-17的工件身份/canary/回滚要求。提前检查只前置复用这些任务中的验证/打包步骤，不把尚依赖后续功能的整张MAC-14/17标PASS；单独生成`early-release-checklist.json`，逐项绑定当前代码实际提供的合同。复用相同身份的有效证据，不重复跑。

提前canary沿用MAC-17的隔离、至少2 h/1000次请求、工件身份、故障/回滚场景，但按`early-release-checklist.json`判定：正确性、隔离、截止、资源回收、必需K/K29必须通过；full/seed/编辑可见等其余性能完整实测并披露，不调用完整G17的最终性能PASS条件，也不把整张G17标PASS。最终候选G17仍要求§6全部适用SLO。

可以暂不完成MAC-10/12/13/15/16的后续收益工作；G11已测出的性能缺口必须列入候选报告，不能标成最终性能PASS。正确性、隔离、deadline、资源回收、K29或必需K阻塞不得豁免。如果希望缩小对外能力范围，先形成明确的版本化合同和影响清单，不能静默绕过失败门。

准备好具体SHA/runtime/native/缓存根/性能缺口/回滚证据后，由用户决定是否提前安装。执行与读回复用MAC-18，观察复用MAC-19，各自以`early`候选身份单独记账；之后最终候选仍需自己的验证与安装授权。若schema/buildKey后来变化，直接重建新缓存，旧格式不迁移；额外冷建时间和暂时双缓存磁盘成本在提前报告中列出。提前可用不等于整个计划LANDED。未选择提前方案时继续原默认顺序。


### 任务卡

- [MAC-00 — 冻结runtime、输入和最早成本spike](ilv2-mac-manual/cards/MAC-00.md)
- [MAC-01 — 先让错误可测](ilv2-mac-manual/cards/MAC-01.md)
- [MAC-02 — native边界与构建供应链（分卡验收）](ilv2-mac-manual/cards/MAC-02.md)
- [MAC-03 — 同字节捕获与tracker分开推进](ilv2-mac-manual/cards/MAC-03.md)
- [MAC-04 — 一个新 schema 和可比较逻辑真值](ilv2-mac-manual/cards/MAC-04.md)
- [MAC-05 — full/delta 显式流水线](ilv2-mac-manual/cards/MAC-05.md)
- [MAC-06 — owner、调度与取消（分卡验收）](ilv2-mac-manual/cards/MAC-06.md)
- [MAC-07 — 封存与原子 workspace 绑定](ilv2-mac-manual/cards/MAC-07.md)
- [MAC-08 — 正式接入、旧路径删除与早期回归（分卡验收）](ilv2-mac-manual/cards/MAC-08.md)
- [MAC-09 — GC 和故障恢复闭环](ilv2-mac-manual/cards/MAC-09.md)
- [MAC-10 — 可运行的真实任务评测基础](ilv2-mac-manual/cards/MAC-10.md)
- [MAC-11 — 完整系统闭环与提前候选检查点](ilv2-mac-manual/cards/MAC-11.md)
- [MAC-12 — 只实现测量支持的收益项](ilv2-mac-manual/cards/MAC-12.md)
- [MAC-13 — 工具面与 guidance](ilv2-mac-manual/cards/MAC-13.md)
- [MAC-14 — 整合门和 K 合同换代](ilv2-mac-manual/cards/MAC-14.md)
- [MAC-15 — 模型收益与保留集](ilv2-mac-manual/cards/MAC-15.md)
- [MAC-16 — 语义精度条件任务](ilv2-mac-manual/cards/MAC-16.md)
- [MAC-17 — 最终构建、canary 与可审查安装包](ilv2-mac-manual/cards/MAC-17.md)
- [MAC-18 — 具体候选的生产切换](ilv2-mac-manual/cards/MAC-18.md)
- [MAC-19 — 观察和收尾](ilv2-mac-manual/cards/MAC-19.md)
