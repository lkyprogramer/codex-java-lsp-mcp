# Java Specialist：ILV2 之后的证据质量与 Agent 效果计划

**版本：POST-ILV2/1.1 · 2026-11-10**（1.0于2026-11-05发布；修订内容见文末“1.1修订记录”）  
**源码基线：** `codex/index-lifecycle-v2 @ b1475cddac01ab6ce589a1d465578d5ab7772533`  
**性质：** 调研、增量设计、AI执行计划与机制验收附件；不是已实施的产品补丁。

## 方向已经确定

**保留已经有效的 ILV2 底座，不重启 embedding。下一阶段主线是 Java 证据的可定位性、可读取性和任务有效性；性能只做有重复等待证据的窄优化。**

产品目标收敛为：找到正确入口 → 比较同文件候选 → 读到关键源码 → 必要时请求 JDT 绑定 → 用真实任务判断是否减少错误与总成本。不是再做通用图平台、IDE、全程序类型推断或新的 Agent。

## 从这里开始

- AI 执行入口：[RUN_AI.md](RUN_AI.md)
- 分支完成情况与待核实边界：[01-branch-audit.md](docs/01-branch-audit.md)
- 决策和优先级：[03-direction.md](docs/03-direction.md)
- 增量设计和接口：[04-design.md](docs/04-design.md)、[05-contracts.md](docs/05-contracts.md)
- 分阶段实施：[08-execution-plan.md](docs/08-execution-plan.md)
- 测试、报告、门禁：[06-evaluation.md](docs/06-evaluation.md)、[09-acceptance.md](docs/09-acceptance.md)
- 本次交付验证：[14-delivery-verification.md](docs/14-delivery-verification.md)

## 只启动最小批次

先做 **Q00**（身份与时间合同）。之后 **Q01/Q02**（测量）与 **Q03**（outline）并行；**Q04**（Java evidence）在Q01与Q03之后。G0只门控Q10的付费LIVE，不阻塞功能实现。Q05–Q09 是按失败归因触发的候选任务，不要求全部完成。Q10 做一次受控效果验证；Q11/Q12 做受影响回归与删减收口。没有净收益就停止扩张。

## 包内有什么

`docs/` 为完整设计、研究、评测与治理；`tasks/` 为13张任务卡；`contracts/` 为DAG和统一初值；`fixtures/` 为原创Java机制语料；`evaluator/` 为语料标签（不向执行产品暴露）；`tools/` 为离线完整性/最终消息凭据检查；`tests/` 为附件自测；`evidence/` 为来源与本次运行记录；`templates/` 为报告格式。

这些机制夹具不替代私有 `mac10-v3` 的50题，不是第三方盲测，也不能凭它们宣称真实Java成功率。外部项目只作机制借鉴，没有跑竞品排名。

## 离线检查

```bash
python tools/verify_bundle.py
python -m unittest discover -s tests -v
python tools/check_fixtures.py --output /tmp/post-ilv2-fixture-report.json
```

前两条需要 Python 3.10+；第三条还需要 JDK 17+。这些命令只验证附件，不启动产品、网络、模型、JDT或生产服务。产品验证必须在用户的Mac隔离开发目录执行。详细状态见交付验证说明。

## 重要边界

用户说明版本已上线；公开状态账本仍是 IN_PROGRESS/NOT_READY。两者可能只是记录滞后。Q00只读对齐已安装身份，不能凭本包否认真实部署，也不能把未读到的上线证据补成PASS。历史验收的120秒总预算与当前120秒导入+600秒索引等待分开记账。embedding已否决，本路线没有向量阶段。

## 1.1修订记录（2026-11-10）

由独立review对照`cc5db6b`源码后修订。产品源码与1.0基线`b1475cd`相同（只多`.gitattributes`和本包）。

| 修订 | 原问题 | 位置 |
|---|---|---|
| DAG：Q03只依赖Q00；Q04依赖Q01+Q03；Q05–Q08加依赖Q02；Q10依赖Q01+Q02+Q04 | 原DAG让outline等G0，与09“仍可做纯函数实现”矛盾；P2触发证据来自Q02但未声明依赖 | `contracts/tasks.json`、[08](docs/08-execution-plan.md)、[09](docs/09-acceptance.md)、各卡头部 |
| outline的nearLine改为“包含者→距离→源码顺序” | 原规则“包含者优先其余按源码顺序”会在大文件尾部丢掉邻近重载 | [04](docs/04-design.md)、[05](docs/05-contracts.md)、[Q03](tasks/Q03.md) |
| outline纳入字段；定义`detail`沿用`summary\|diagnostic` | 字段/接口影响是三大工作流之一；`detail`原未定义 | 同上 |
| Q03实现前先测真实大文件的ID/签名字节分布 | 4096B能否放下8条长symbolId未验证 | [Q03](tasks/Q03.md) |
| Q04复用`anchor-windows.ts`；明确对原生read的唯一效果假设；记录80行预算的截断率 | 已有T03 anchorWindows而计划拟另写；evidence相对原生read的价值未单列 | [Q04](tasks/Q04.md) |
| Q10先审计并复用`run-agent-trace-live/matrix`、`openai-compatible-chat`、`eval-pilot-compare` | 1.0未识别仓库已有live设施，拟新建runner | [Q10](tasks/Q10.md) |
| E2定位到`07c6ccf`；Q00改正产品README时间描述并收口ILV2账本 | 时间合同来源可由git直接确定；README仍写120秒内等待索引 | [01](docs/01-branch-audit.md)、[07](docs/07-mac-performance.md)、[10](docs/10-traceability.md)、[Q00](tasks/Q00.md) |
| 验证命令改为存在的测试文件 | `dist/tools/symbol.test.js`、`dist/discovery/query.test.js`不存在；Q07路径缺`src/agent-router/`前缀 | Q03、Q04、Q06、Q07 |

1.1未改动：方向与非目标、预算数值、评测分母与门禁、原创fixture与evaluator标签、附件检查器。
