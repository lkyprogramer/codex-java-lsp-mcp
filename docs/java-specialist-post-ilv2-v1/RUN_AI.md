# 给执行 AI 的入口

你的目标不是实现本包的全部可能能力，而是在当前 ILV2 分支上，以最小改动提高 Java 任务的证据到达率。

## 先读

依次读取 `AGENTS.md`、`docs/01-branch-audit.md`、`docs/03-direction.md`、`docs/04-design.md`、`docs/05-contracts.md`、`docs/08-execution-plan.md`。开始某张卡时只加读该卡引用的测试/报告章节，不需要重读所有历史方案。

## 初始命令

下面在**本包目录**（仓库内`docs/java-specialist-post-ilv2-v1/`）执行：

```bash
python tools/verify_bundle.py
python -m unittest discover -s tests -v
python tools/check_fixtures.py --output /tmp/post-ilv2-fixtures.json
```

下面在**用户确认的独立产品checkout**执行，只读：

```bash
git rev-parse HEAD
git status --short
git log -12 --format='%H %ad %s' --date=iso-strict
node --version
```

不要在运行中的release内执行npm ci。不要因缺旧附件停止；当前源码/手册是实施依据，旧包只是历史要求。Q00要求的运行身份、Mac环境和授权缺失时，先完成不依赖它们的离线工作，再准确列阻塞项。

## 执行顺序

1. Q00：冻结source/runtime/measured三种身份，确认实际部署、timeout合同（来源已定位为`07c6ccf`）和原已接受例外；改正产品README时间描述，收口ILV2账本。
2. Q00之后三条线并行：
   - Q01：复用MAC-10/MAC-15设施（含`run-agent-trace-live`、`openai-compatible-chat`），证明最终模型消息的source凭据与repair完成判定可靠。
   - Q02：重做逐阶段失败归因，形成dev队列；已有holdout不得用于选规则。
   - Q03：outline。不等G0；它是`queryFiles`的纯投影。
3. Q04：Q01与Q03完成后扩展Java evidence；复用`anchor-windows.ts`。共享symbol.ts的接线由集成者串行提交。
4. 只依据Q02/Q04失败选择Q05/Q06/Q07；Q08/Q09另有触发门，没有触发就不做。
5. Q10受控Agent配对（需G0全部满足与模型费用/数据授权；先审计复用现有live runner）；Q11受影响工程回归；Q12唯一文档入口与候选交接。

## 每张卡的闭环

固定输入与预期失败 → 增加测试 → 观察RED或确认已有正确行为 → 最小改动 → 定向GREEN → raw/结果 → 独立review。阶段结束才运行受影响整合门。修改接口后必须覆盖最终wire，不能仅测handler内部对象。

有子代理时任务可分工，但每个phase有不同于实现者的review/test角色；没有子代理工具就显式标明single-executor，不冒充独立review。

## 首批完成条件

Q00–Q04工程合同通过，原数据/预算不变，query→outline→evidence→必要JDT的短链可用；实际收益仍待Q10。不要把“新功能完成”写成“token节省已证明”。不必先做Q05–Q09才交付首批。

## 禁止的捷径

不增默认maxFiles来掩盖排序；不返回整文件来提高行覆盖；不把synthetic夹具当生产准确率；不靠ORACLE PASS字符串/模型自评判修复；不升级JDT/Node来躲避当前基线；不将本包checker通过当作产品可上线。
