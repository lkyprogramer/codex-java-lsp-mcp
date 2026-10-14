# MAC-01：可复验的验收工具

状态：**PASS（G01）**。独立复验、暂存扫描、归档逐文件核对和实际收尾均通过。本目录只收聚合结果；原始记录留在私有持久归档。

本卡交付离线HTTP JSON driver、负载回放、SLO判定、故障控制器和遥测类型。合成服务验证工具的判定及资源生命周期，不代表新索引流水线、产品status、原生helper、真实JDT或正式性能门通过。

## 已实现的边界

- 测量入口校验冻结Node的execPath、realpath、binary SHA-256、完整versions、架构和macOS build。冻结输入检查HEAD、status、fsck、实际路径集合及清单中每个必需文件的字节/hash。
- `start`拒绝占用端口，创建自己的服务目录，校验实际服务PID和完整实例身份，只回收自己启动的进程组。`attach`校验instance/source/build/native/runtime/cache/owner/protocol，不停止附加服务。两种模式均禁止生产端口和生产路径；HTTP重定向被拒绝。
- 全机fixture共用持久工作根下的SQLite事务配额，最多两个槽。子launcher在IPC握手前不启动服务；事务登记完成后控制器才发启动消息。控制器断开或直属服务退出后，launcher有界回收整个自身进程组，包括忽略SIGTERM的孙进程；在途事务被杀由SQLite回滚。该launcher仅是有界测试进程，不是目标产品owner方案。
- 故障控制器等待真实进程的阻塞阶段确认，再注入信号；result与进程退出分别观察。取消及证据写入失败也执行finally回收，进程组未退出不释放配额。
- 每次调用保留单调时间和slot身份，first-correct同时核验内容、hash、workspace和snapshot。nearest-rank使用计划分母；超时、漏结果、重复样本、错hash/workspace均不能通过。报告验证plan/driver/calls digest，正常与故障窗口不混算。
- 暂存扫描读取index中的实际blob，只输出路径、规则ID、计数和hash；docs没有整体豁免。明确排除项必须绑定精确blob/rule/count及审核原因；二进制、私有任务/RAW类型和体积错误不能用排除项绕过。
- closeout检查实际剩余目录。RAW/BULK/INPUT必须声明到期门；跨门保留须给出consumer。未登记、到期文件、零字节文件及到期目录都拒绝通过。
- 两个既有broker创建随机根后立即向stderr输出登记JSON并写登记文件。启动前的run-root.txt与TMPDIR约束覆盖输出前SIGKILL窗口；原stdout载荷格式保留。

## 接口

入口与参数见[执行手册§5](../../../deep/codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md)。辅助入口：

```text
scripts/ilv2-mac-staged-scan.mjs --repo <repo> [--policy <private-policy.json>]
scripts/ilv2-mac-closeout.mjs --manifest <private-manifest.json>
```

driver使用`ilv2-mac-run/v1`与`http-json/v1`。配置包含冻结runtime manifest hash、启动argv、期望实例身份及每个operation的HTTP method/path/body/normalize映射。启动argv必须使用冻结绝对Node及受管根内脚本；status POST的`readOnlyField`指向显式false，GET须有`start=false`。模板参数只在JSON/argv中替换，不经shell。

回放plan包含唯一slot ID、operation、workspace、normal/fault窗口、dispatch offset、deadline、stop limit、query oracle及所选SLO。CLI另要求冻结输入记录；真实负载的commit/diff/build-kind/base等数据由对应后续任务填入计划。oracle参与评分，不自动生成query参数。100–200ms polling记录全部尝试和最终slot，未命中保留失败。

退出码：0表示全部所选计划断言通过；1表示已测失败；2表示前置、身份、环境或证据错误。取消返回130/143。CLI退出0不能单独替代执行手册的G门结论。

## 验证范围

本卡使用平铺的`ilv2-mac-*.test.mjs`。定向测试包含：生产端口零fetch、错误attach身份、占用端口、status-only、证据写失败回收、五个事务/注册/启动故障窗口、两槽跨进程配额、百分位/分母、暂存blob泄漏扫描、到期残留及broker输出前被杀。

失败尝试、修正后命令、source/tree/runtime身份、真实四仓guard、独立复验和收尾结果由`task-result.json`引用。未运行新full/delta、K/正式三仓、真实JDT、模型、部署或生产调用。

各轮测试按候选身份分账：核心49项、输入合同13项、最后受影响25项分别通过；独立复验先验证8项阻塞场景，再对最后候选验证2项后代回收场景。不同候选和重复覆盖不合计为一次完整通过。孙进程泄漏的2项RED以及更早失败记录均保留在私有归档。原broker argv未序列化，保留其TAP及源身份，不宣称已恢复精确命令；独立复验的实际argv完整保留。
