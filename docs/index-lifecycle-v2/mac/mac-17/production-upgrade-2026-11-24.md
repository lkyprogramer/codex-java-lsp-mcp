# 2026-11-24 索引首次调用恢复提示与生产验收

生产 `38456` 已部署 `23546737bcbf3d0f22c1d2475f01dd14f90a6f2d`，发布 tag 为 `prod-2026-11-24`。验收通过。源码分支为 `codex/index-readiness-recovery-20261124`，部署验收后以 merge commit 合入 main。

本次以原生产版本 `950fd6ae87ae` 为基线，包含其 compact impact 遥测计量修复。索引准备仍最多等待 1 秒；尚无可用快照时，静态查询返回带 `INDEX_NOT_READY`、准备状态、等待时间和 `java_status` 调用参数的恢复信息。`isError=true` 和 `_meta.errorCode=INDEX_PARTIAL` 保留。状态查询显示构建、调度、失败退避或不可用状态。

## 验证结果

| 检查 | 总数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| Mac 源码单测 | 1708 | 1707 | 0 | 1 |
| Mac 发布脚本测试 | 833 | 822 | 0 | 11 |
| 三项恢复合同定向复跑 | 3 | 3 | 0 | 0 |

[最终提交的 CI](https://github.com/lkyprogramer/codex-java-lsp-mcp/actions/runs/45316008360) 已通过 `gate:pr`，包括 hygiene、lint、隔离编译和源码单测。Mac 完整封存验证复用了定向检查的同一候选。封存文件 SHA-256 为 `ed67f9c8bf627b14c60404a347c29288bef387fcfc7ee54da77e49c02b2cd90b`。

首次封存的脚本测试有三项失败。MAC11 和 K06 仍匹配旧错误文本，K03 的初次查询没有处理未就绪响应。更新后严格核对错误码、仓库路径、`retryable`、等待时间和 `nextAction`，保留原有 deadline、歧义消解及 worktree 内容隔离断言。最终定向和完整验证均通过。

## 生产首次调用恢复验收

通过真实生产 HTTP MCP 创建了含 5001 个 Java 文件的独立测试仓。执行顺序如下。

1. `java_status(start=false)` 返回 `NOT_STARTED`，没有启动索引。
2. 首次 `java_impact` 在 1095 ms 返回 `INDEX_NOT_READY`，准备状态为 `BUILDING`，`retryable=true`、`retryAfterMs=1000`，`nextAction` 指定该仓库的 `java_status(start=false)`。
3. 客户端按返回参数查询状态。首次恢复响应约 15.2 秒后已有可用快照。
4. 使用原工具和原参数重试 `java_impact`，1194 ms 成功返回候选上下文。`semantic.used=false`。
5. 测试仓源码已删除，测试索引由 owner 按现有 GC 策略回收。

这次验收验证了恢复信息及客户端按提示继续调用的完整过程，没有调用模型判断恢复策略。

## 现有服务与索引

- 隔离端口 `38457` 和生产端口 `38456` 的 HTTP smoke 均通过，生产 `/readyz` 为 `ready`，build SHA 为 `23546737bcbf`。
- 部署前的 28 个既有索引绑定全部保留。部署后当前快照均通过只读 SQLite 检查。
- 六个常用仓库的已知声明查询均成功，静态覆盖状态均为 `READY`。
- 固定 launcher 路径、owner 参数和生产环境变量已核对；环境变量仅更新了实例 ID。
- 回滚记录 `state/previous-current` 指向 `releases/950fd6ae87ae-20261120T144756Z`，由控制器按 runtime 根解析。回滚命令为 `daemonctl.sh rollback-release`，本次未执行回滚。

安装后的首个验收脚本误将回滚记录视为 runtime 根目录下的普通符号链接，检查失败。按控制器实际读取方式修正后复核通过，没有重复部署。

原始记录位于 Mac 持久运行根 `runs/upgrade/index-readiness-23546737-20261124/`。主要文件为 `ci.json`、`release-proof.json`、`deploy-result.json`、`live-verification.json`、`live-calls.jsonl`、`indexes-before.json`、`indexes-after.json` 和 `configuration-verification.json`。首次失败记录保存在相邻的 `index-readiness-0ecd38d6-20261124/` 运行根。
