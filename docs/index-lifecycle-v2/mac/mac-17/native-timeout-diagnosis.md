# MAC-17 native 超时补证据结果

2026-10-31。本轮有界诊断已收尾：**NOT_REPRODUCED，根因 UNDETERMINED**。原两次完整 installer 的同项失败保持有效，**G17 = FAIL，candidateStatus = NOT_READY**。本轮未修改产品代码、原用例断言或 5 秒时限，未 push、未操作生产，也未重新启动 installer、构建或 canary。

[原安装验收报告](README.md)、[正式 G17 结果](task-result.json) 保持不变。本轮事实摘要见 [native-timeout-summary.json](native-timeout-summary.json)，命令、各次身份及资源结果由 [native-timeout-task-result.json](native-timeout-task-result.json) 从原 validation-index 和 closeout 生成，单列为 `WF-MAC17-NATIVE-DIAG`，不覆盖 G17。

## 已观察事实

原失败位于 `scripts/ilv2-mac-retrieval-eval.test.mjs:153`，native capability 调用触发 `native process deadline exceeded`。旧日志没有同一 native PID 的启动、stdout、exit、管道 close 及超时前栈，不能判定卡在程序启动、系统调用、调度还是退出后的管道关闭。

本轮只在恢复的取证候选中增加临时观察脚本，经已有 broker 的 `--reuse` 身份检查执行。观察器记录同一 PID 的 stdout、exit、close、kill；3 秒仍未关闭时才采样。原测试文件与 5 秒上限保持不变。

| 场景 | 实际结果 | capability 从 spawn 返回到 close |
|---|---|---|
| 原 retrieval 文件 | 9/9 PASS | 1169.356 ms |
| 最近前五个 script 文件加原 retrieval | 26/26 PASS | 4.136 ms |
| 原失败前序 46 个 script 文件加原 retrieval | 284 PASS、1 具名 SKIP、0 FAIL | 4.317 ms |
| 同字节新 inode，144 字节路径 | 1/1 PASS | 701.807 ms |
| 同字节新 inode，194 字节路径，与原失败路径等长 | 1/1 PASS | 294.826 ms |

五次均产生 98 字节有效 stdout、stderr 为 0、exit 0，exit 到 close 间隔均小于 1 ms。均未达到 3 秒采样点，没有 timeout-time 栈或 kill 记录。计时从 `spawn()` 返回开始，不能当作整个 spawn 调用的墙钟耗时。上述正常结果没有证明原故障已经消失，也没有证明 close 事件有缺陷。

前序源码观测另有 **1600 PASS + 1 FAIL**：私有 runner 漏传原冻结 `JAVA_HOME/JDTLS_JAVA_HOME`，一个 HTTP/JDT fixture 报 `JDT_CONFIG_ERROR`。这是本轮准备错误；恢复原 Java 25 环境后仅补跑该 fixture，1/1 PASS，未重跑 1601 项源码套件。原 FAIL 和修正后的定向 PASS 分别保留，不能合称源码全 PASS，也不能作为原 native 超时的解释。script-prefix 的具名 skip 为未选择 MAC-10 数据集，未改断言或新增 skip。

## 工件身份与证据限制

恢复来源为此前保留的 UNQUALIFIED release 包，SHA256 `3a3b4ebf2a1ccb73efdd083124494511d2f0485740c82f37ddb8bbd1fe9afc27`。本轮仅为新 consumer 必要恢复，没有重复核验旧归档。

- 原失败默认 broker native SHA256：`d4d88d282ccaddd7edba04bf633e837244de51db25c7ba84f1b17586f592fdd6`。
- 本轮恢复 native SHA256：`8a7526baf36fa8039a7314219cb4c3c04e162ae2405a5c646a5dc12fbae14b74`。
- 记录支持两者具有相同 native 源码摘要、协议、Team 和 designated requirement。二者不是同一字节工件；缺少原失败默认 broker 的直接 CDHash 读回，不能用 release 或其他 fixture 的签名结果替代。
- 本轮产品源码、compiled dist、native 和原断言未改；增加观察脚本后的 v1/v2/v3 整体 source digest 分别保存，不能冒称单一 source identity。
- 两个新文件副本执行前已有 `com.apple.provenance`。短路径后长路径的单次结果不能证明系统策略缓存冷启动或路径长度因果。

**当前关键缺口是原失败工件和失败现场。** 先前 closeout 保留的是 release 包，没有保留失败默认 broker 的 native 文件及其元数据。恢复 release 上的正常观测不能重建原失败进程状态。

## 系统日志能说明什么

按原失败 native 完整路径过滤的历史日志共 950 条，其中两条 kernel ASP provenance 消息带错误码 `268451845`。本机 SDK `mach/message.h` 确认该值为 `MACH_RCV_INTERRUPTED`。同窗 syspolicyd 精确故障字符串共 109209 条：103093 条 `dispatch_mig_server returned 268435459`，6116 条 `Unable to initialize qtn_proc: 3`。

这些是相关线索，没有同一失败进程的栈或时序将其连接到 5 秒超时，**不能认定系统 IPC、句柄耗尽或 statfs 是根因**。只读 FD 探针返回 EPERM，结果不可用，不能解释为零 FD 或资源耗尽。路径过滤结果中的 `AUTHREQ_PROMPTING` 为 0，也不能排除未归属的日志或证明生产 TCC 行为。生产 TCC 仍为 NOT_RUN。

本轮未运行 lsof；未修改系统策略、TCC 数据、权限或服务；未向系统服务 PID 发送信号。系统 PID481 只作为外部观测对象记录，不属于本次资源清单。

## 独立复核与收尾

独立评审结论为 `PASS_REVIEW_OF_NOT_REPRODUCED`、无 findings，含义是事实与边界复核通过，不是故障修复或 G17 验收通过。评审读取原始 TAP、五次进程 trace、身份及实际资源，没有重跑测试或构建。

193 个 PID、57 个自有进程组、37 个精确 launchd job 均实际退出；全局两张 fixture 配额表均为 0。统一 closeout 为 PASS，`unregisteredPaths=[]`、`expiredResidualBytes=0`，本次 raw/tmp 已删除。临时观察代码和必要清单作为 LOCAL 证据保留，未写入产品源码。

运行根为 `/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261031T094215Z-native-timeout-evidence`。其 `closeout/raw-evidence.tar.gz` 保留 417 个原始证据文件，逻辑字节 156716124；已一次物理解压并核对全文件 hash，SHA256：

`c21f0f9bc12ade5894f7ae2d3b24824d1d8ab29c7557e22990a0bb83d7afa0e9`

## 下一项有价值的检查

当前证据不足以提出确定的产品修复，不应放宽 5 秒上限、预热或通过重复套件替代原因。按本轮停止条件，不再构造新签名样本或继续相同负向实验。

下一项检查应直接覆盖**原失败的 broker 构造与第一次 capability 调用边界**：在清理前保留该 broker 实际 native 字节及文件元数据，同步记录同一 PID 的 spawn 调用前后、stdout、exit、pipe close、kill 和超时前栈。只有再次失败时的这些证据，才能区分启动前系统阻塞、native 内部阻塞与关闭延迟；正常结果仍须标记 NOT_REPRODUCED。

取得有区分力的证据后再决定最小修复及定向复验。完整安装激活、空 Gradle home 首次语义、完整升级/回滚仍未验收；生产固定 launcher 的 TCC 授权与实际业务读回单列待办，仍需具体生产授权。原硬截止保持 2026-11-03 18:00+08，本轮已提前收回资源并汇报，不自动恢复旧任务。
