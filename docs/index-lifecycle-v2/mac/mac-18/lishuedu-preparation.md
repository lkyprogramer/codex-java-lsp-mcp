# lishuedu 安装准备与语义验收

## 依赖准备

1. 在注册的隔离运行目录内复制 [Maven 输入清单](lishuedu-maven-local.json)。在清单旁的 `repository/` 下按清单相对路径放入五个文件。只准备 BOM POM、Starter POM、Starter JAR 和两个 SNAPSHOT 元数据文件。
2. 在原 Gradle 准备计划设置 `projectId: "lishuedu"`，将 `lishueduMavenLocal` 指向复制后的清单绝对路径。保留同一业务副本、私有 HOME、工具链和代理。Gradle home 必须为空。
3. 用 `install-runtime.sh --prepare-gradle <plan.json>` 执行现有隔离准备入口。准备器核对清单并把五个文件写入私有 Maven 仓库。正式准备沿用 Gradle 的 `mavenLocal()`。准备器记录实际解析的 JAR，不复制 Maven 文件。
4. 保留准备器的 `result.json` 和 `artifact-manifest.json`。后者绑定 Maven 输入、Gradle 缓存、应用模块 APT 模型选出的 Lombok 和共享 JAR 索引清单。Eclipse 模型须实际引用清单中的 Starter JAR。

## 真实语义验收

验收复用同一业务副本、私有 HOME、Gradle home 和已有静态缓存。外层隔离夹具先申请共享配额，再以封存工件的签名 native owner 启动入口。外层夹具负责跟踪进程和释放配额。以下参数传给 native owner。各路径使用绝对路径。

```sh
<candidate>/dist/native/ilv2-mac owner <private-cache> \
  <candidate>/scripts/ilv2-mac-lishuedu-acceptance.mjs \
  --result <preparation-output>/result.json \
  --repo <isolated-lishuedu-root> --deadline <ISO-8601-deadline>
```

环境沿用准备计划。设置 `JAVA_LSP_ISOLATED_VALIDATION=1`。`JAVA_LSP_CACHE_BASE` 与 native owner 的私有缓存相同。`JAVA_LSP_PROJECTS_JSON` 必须启用对应 `lishuedu` 别名。使用临时端口。验收脚本按下列顺序运行。

1. 校验实际 owner 锁和准备产物。校验 Maven 文件、Gradle 缓存、模型输入、JAR 索引及其原 JAR 时间戳。
2. 启动临时服务并核对端点 PID。只用 `java_status(start=false)` 等静态快照达到 `FRESH`。核对快照绑定、目标符号位置和源码摘要。此阶段独立于 JDT 导入计时。
3. 发出一次语义启动请求。保留 120 秒启动与导入预算和 600 秒索引屏障。请求超时后，观察原 JDT 进程。`READY` 后，用源码位置核对精确定义和引用。

## 复用证据与正式环境

封存工件 `525e9651feed` 已完成一次隔离验收。原空 Gradle home 准备耗时 172.31 秒。清单含 1,415 个 Gradle 依赖文件和 403 个共享 JAR 索引。实际导入 40.21 秒，索引屏障 46.74 秒，首请求至 `READY` 为 87.43 秒。精确定义及 1 个预期引用均命中。历史准备清单 SHA-256 为 `ae15df2a8cd1a8efd53514ffd3b2e30e04e23bd3e13f01d30161d7c4a6f98558`。共享索引清单 SHA-256 为 `1906f078982d9dd42921e7028b3ad95eafc6bb82878c16260bfe5506c3ff8f67`。本次脚本变更复用这些实际文件做清单校验，未重跑语义验收。

正式 `38456` 可以直接服务已启用的项目。预置 Gradle 依赖和共享 JAR 索引是冷启动准备，与 Codex MCP 注册分开。当前正式准备参数绑定 `lishu-v2`。已有正式缓存可用时，启用 Codex MCP 只须指向当前端点。
