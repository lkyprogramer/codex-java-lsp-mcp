# Java Specialist：ILV2 之后的证据质量与 Agent 效果计划

**版本：POST-ILV2/1.0 · 2026-11-05**  
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

先做 **Q00–Q02**（身份与测量），再做 **Q03–Q04**（文件内导航和 Java 证据）。Q05–Q09 是按失败归因触发的候选任务，不要求全部完成。Q10 做一次受控效果验证；Q11/Q12 做受影响回归与删减收口。没有净收益就停止扩张。

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
