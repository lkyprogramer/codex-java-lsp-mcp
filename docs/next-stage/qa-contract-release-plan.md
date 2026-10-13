# QA 公开合同实施与 daemon 替换计划

2026-10-11。目标是按阶段修复 QA 提交与读取路径，完成八题双臂和完整 28 题验收，并在原发布门全部通过后替换本机受管 Java LSP daemon。

起始候选为 `a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313`，611 个可执行源码文件，Git 基线 `04058e43b8b2658864d0de09c8d6024e9928dfc5`。保留现有工作区改动，不提交或推送。运行与阶段证据目录为 `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-qa-release-t14dzuaq`。

## 范围和阶段

| 阶段 | 工作和结束判据 |
| --- | --- |
| P0 公开合同 | 独立版本描述全部 28 题的公开字段角色和表示形式；明确 MYBATIS guard、分类词汇、数组元素及顺序；原任务、gold、scorer 和门槛不改。文档评审、修复及合同覆盖检查通过。 |
| P1 实现 | 共享 schema 与 validator 同步使用公开约束；最多一次格式恢复；修复 rg 文件/目录边界与错误归因，保留 read 文件长度并指导定向读取。先记录针对真实缺陷的失败，再实现并完成定向、集成与独立评审。 |
| P2 八题 | PAYMENTS-02、ACCESS-01、ADMISSIONS-01/02、PRICING-01、GSON-01、MYBATIS-01/02 × 两臂，全部计划行保留；冻结 scorer 实测值、证据、严格成功、成本。不能以样本替代完整门槛；结果评审并修复已观察根因后才进入下一阶段。 |
| P3 全量 | 原 28 个 QA × 两臂；保留原预算及 80% 门槛；同一候选、模型和新协议，独立任务工作区及完整请求/结果/回执。发布要求另覆盖原八个 real-agent repair group，不拿 patchApplied 或脚本化 oracle 替代。 |
| P4 发布与替换 | 在最终候选完成原发布合同、默认单 worker 容量、真实 JDT、完整外部 public 与独立 locked 的证据核验、构建/测试、隔离 HTTP 与安装/回滚验证。全部原门达到后，使用 immutable release 安装器原子替换现有 daemon，核对健康、工具面、build 与 previous-current 回滚点。 |

每阶段均完成评审、关闭具体 finding、运行最小相关验证后推进。实现与评审按全局 AGENTS.md 的约定由不同代理承担；共享写入和集成由主代理串行处理。模型运行和容量测量不并行争用资源。

## 不变边界

原任务、gold、冻结评分器、门槛、历史证据及结果保持字节不变；v1.4 活跃协议先原样保存为独立版本，新合同使用独立版本。公开合同不包含每题正确答案或私有必需行；不做答案值后处理或别名归一化。

不收缩 broad，不改变生产 worker 默认值，不提高源码预算，不改五个公开 MCP 工具和 SQLite/Tree-sitter/JDT 边界。已暴露题只作 regression，不宣称独立泛化。新的发布证据单独保存，不覆盖原 NO_GO。

## 已知发布缺口

原清单存在 K29/PERFORMANCE 失败、INDEPENDENT_LOCKED 与 FULL_PUBLIC 未运行，以及 QA floor 失败。双 worker 的实验通过不能替代默认单 worker 的发布验收；冻结门仍为原标准。后续应先核对各门的实际输入和观察边界，不能仅将旧证据改标 PASS。

本机当前指针为 `releases/09b9851e888a-20260929T085025Z`；替换目标是用户明确请求的既有受管 HTTP daemon。继续保留 MCP URL 和项目配置，不使用历史 `--activate-http`。安装前说明索引 facts revision 变化、短暂连接中断与回滚方法；失败时恢复前序 release。操作不得删除生产 cache、ownership 或 pin 索引。
