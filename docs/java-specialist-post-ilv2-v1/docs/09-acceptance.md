# 09 验收、发布资格与授权

## 不用一个PASS覆盖一切

| 维度 | 可接受输出 | 不允许的推导 |
|---|---|---|
| 工程合同 | PASS / FAIL / BLOCKED_ENV | 原创fixture通过→Mac产品通过 |
| 效果 | BENEFIT_MEASURED / NO_GAIN / INCONCLUSIVE / UNMEASURED | 系统稳定→任务成功；代码上线→token降低 |
| 候选资格 | ENGINEERING_ELIGIBLE / NOT_ELIGIBLE | 资格→用户已授权部署 |
| 生产状态 | USER_REPORTED / VERIFIED_IDENTITY / DEPLOYED_RECEIPT | 远端branch HEAD→本机正在运行同工件 |

Q00只读对齐，不自动重新安装。若生产比所审SHA更新，以安装回执+source/build digest建立映射；文档滞后单独更新，不能让旧FAIL覆盖新通过，也不能用新通过擦掉原失败。

## G0：测量可用

- scheduled/attempted/outcome分母完整；缺失usage不填0。
- 最终tool message中的源码、path/hash/range验证通过；false-path、redacted、wrong-hash控制被拒绝。
- repair known-bad/known-good/early-exit-zero三个控制有效；测试和gold不进入Agent工作区。
- 本次dataset、scope、budget、模型/工具链身份冻结；exposed holdout标注。

缺一个，暂停付费效果实验，但仍可做纯函数/fixture实现。

## G1：最小能力正确

- static query/outline/evidence的JDT启动计数0。
- 同FQN跨scope、同名重载、匿名/局部stability无错误重绑。
- 明确anchor不被预算静默丢弃；不能满足时结构化partial；UTF-8预算不破坏字符或JSON。
- Java和XML来源各自hash/坐标正确；stale/跨workspace请求拒绝或降级，不给确定性否定。
- 最终public wire有必要身份/遗漏/下一步信息，内部key不泄漏。

## G2：候选增量有依据

Q05–Q09每卡要求：至少两个不同任务组或一个关键确定性bug的证据；明确先前缺口在哪一级；同输入对照；预先限制范围和退出条件。没有触发的卡NOT_TRIGGERED，不算失败也不实施。

## G3：效果门

逐任务展示质量与代价。质量更高且代价可接受，或质量非劣且总成本更低，才可选择采用。CI覆盖0、差异只来自少数题、不同语言/仓库方向反转时INCONCLUSIVE。任何关键错误不能被平均token节省抵消。

初始筛选阈值见06；均是待冻结工程决策，不能事后根据结果修改。判定不要求达到所有任务100%；但不能把已知失败从分母删掉。既有三仓绝对地板例外由用户已批准的G14合同处理，不作本轮新增豁免。[S07]

## G4：受影响运行态门

沿现有K32 overlay与MAC手册：新静态接口触及held view/资源读取，需要workspace隔离、source mutation、deadline、lease与GC受影响测试；JDT改动额外跑真实首次语义、共享启动与取消；native/owner没有改时不要强行重跑全部安装/TCC实验。

候选最终固定sourceDigest/dist/native/依赖身份；全量工程回归运行一次，失败按机制最窄复验，不无理由无限重试。SKIP必须匹配白名单+原因；不是任何“有文字的skip”均可PASS。

## 部署与失效处置

本包不授予生产安装、TCC授权、启用enforce GC、修改全局guidance或API费用权限。用户已取消的旧兼容/回滚工作不重新变成强制任务。不满足新工程硬门的候选停止切换；如发现线上重要正确性问题，建议停用受影响新增功能，由用户决定生产处置，不直接改运行目录。

## 独立review清单

确认测试验证了实际wire而不是内部对象；检查是否读取gold；是否把fixture与业务数据混算；source变化与共享view是否安全；proof是否夸大；资源测量是否同冷态；报告是否同SHA；剩余P1/P2是否有明示处置。独立review只能由不同上下文的执行者完成；本包自身校验不是独立产品review。
