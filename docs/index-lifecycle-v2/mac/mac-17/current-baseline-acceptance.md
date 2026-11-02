# MAC-17 当前主机基线隔离验收

2026-11-02，用户授权固定依赖恢复和实际加载检查，以当前 OS/Clang 冻结新基线，继续完整 installer 安装、升级、回滚及空 Gradle home 首次语义验收。硬截止仍为 **2026-11-03 18:00+08:00**。本轮不 push、不操作生产、不追溯旧环境，不修改 native 5 秒时限、测试断言或依赖版本。

## 固定边界

- 历史 [G17 FAIL](README.md) 与所有失败证据保留。新基线的成功不改写旧失败，也不说明历史超时根因已经确定。
- 新运行根为 `/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T023000Z-new-baseline-acceptance`。新 runtime 及 compiler/SDK 身份在该根单独冻结，不复制旧 production 观测字段。
- 当前基线为 macOS 26.7.2 (25G332)、Apple clang 21.0.0 (clang-2100.1.1.101)、冻结 Node 22.16.0。JDT/Java/Gradle 使用既有冻结工具链，正式探针重新核对实际文件。
- 生产固定 launcher 的 TCC、业务读取及升级后复读为 `NOT_RUN`。本轮隔离验收不表示 `READY_FOR_DEPLOY`、生产部署或 MAC-18/19 完成。

## 依赖准备合同

`scripts/ilv2-mac-dependencies.mjs restore` 只接受预登记运行根下的新目录。先验证已知归档 SHA256，再用 macOS `/usr/bin/tar` 恢复 `./node_modules`。恢复后逐项核对既有文件/目录/相对链接 inventory。不得用会将 AppleDouble 元数据展开成普通 `._*.node` 文件的提取方式；不得覆盖旧目录。

`check --repo-root <absolute-root>` 必须在新 Node 进程中执行。它记录真实 loader/binding 路径及 hash，拒绝 AppleDouble 和越出依赖根的实际 binding，并实际加载 Tree-sitter Java parser 解析固定 Java 文本。完整 installer 在真实 npm ci 后、构建前检查；隔离 broker 在复制依赖后、tsc 前以原命令记录器检查。失败原样终止，不自动修补 vendor loader、不跳过检查。

## 验收顺序与停止点

1. 完成最窄依赖测试和独立只读评审。
2. 用新 runtime/Clang 构建并完成正式环境探针。
3. 完整 installer A 执行真实 npm ci、签名构建、完整 npm test、安装和服务身份读回。
4. 在真实冻结业务隔离副本和物理空 Gradle home 中执行首次精确定义/引用语义验收，记录首次耗时、下载/cache 和磁盘成本。
5. 停止 A 并释放配额；同源完整 installer B 执行停服升级；真实 daemonctl 回滚 A 并核对配对状态。
6. 读取实际退出、全局配额、独立评审及原始日志；统一归档和清理本次资源。

A/B 是同一源码的两份独立构建，不代表跨版本迁移或零停机升级。full CLI 失败时停止原 pipeline，先读取第一条原始错误；同因无新证据不得重放。首次 Gradle 失败保留原错，仍执行升级/回滚。完成或到期都汇报，达到验收标准后停止扩展。

当前状态：`IN_PROGRESS`。最终计数、工件、身份和剩余边界以本轮生成结果为准。
