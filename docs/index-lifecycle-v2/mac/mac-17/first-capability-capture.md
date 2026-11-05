# MAC-17 首次 capability 现场与解决方案

2026-11-02。已查明并修正**本轮取证环境的 NOT_READY 原因**：AppleDouble 元数据被依赖加载器误选为原生模块。同一已构建候选仅恢复依赖后，原 product-mcp 单项 **1/1 PASS**。历史 native **5 秒超时仍为 NOT_REPRODUCED，根因 UNDETERMINED**；正式 **G17 FAIL / 候选 NOT_READY 保留**。

本轮没有修改产品源码、native C、原断言或 5000 ms 时限，没有 push、生产操作、installer 重放、完整矩阵或 canary。原 MAC-16、G12/G14 及两小时 canary 证据不重跑。截止点仍为北京时间 2026-11-03 18:00。

## 分开的三个问题

| 问题 | 证据与结论 |
|---|---|
| 历史两次 native 5 秒超时 | 原 FAIL 保留。原失败默认 broker 的实际二进制和当时进程现场缺失，本轮未复现，不能给出确定产品根因 |
| 本轮恢复后索引 NOT_READY | **已定因并完成最窄复验**：Python 解包把 AppleDouble 元数据恢复为普通 `.node` 文件，加载器选错文件；原生 tar 正确恢复后原单项通过 |
| 当前环境与原冻结环境不同 | 原 macOS 26.5.1 / 25F80，当前为 26.7.2 / 25G332，clang 也变化。原 runtime guard 在构建前如实阻断；当前系统另建诊断 profile，历史 manifest 未改 |

原验收报告见 [README](README.md)，前一轮未复现结果见 [native-timeout-diagnosis.md](native-timeout-diagnosis.md)。本轮聚合证据见 [first-capability-summary.json](first-capability-summary.json)，各次结果由已有生成器单列为诊断 workflow，不覆盖正式 [G17 结果](task-result.json)。

当前系统和编译器变化与取消 sample 同时发生，当前运行不是 sample 因果 A/B。取消 sample 后仍有文件保全、xattr 读取等观察工作，不能称为零扰动对照。

## 实际捕获的首次启动现场

原 broker 先调用真实构建，再执行原测试。构建阶段已经通过 promisified `execFile` 执行一次 capability；该构建调用原本没有 5 秒 timeout。测试阶段通过 `native-exec` 的 `spawn` 执行，原 5000 ms 计时在 spawn 返回后开始。这两个“首次”分别记录。

在旧系统上的新构建样本中，native PID **84463**、Node 父 PID **84443** 的完整时序为：

| 事件 | 从调用前开始计时 |
|---|---:|
| spawn 返回 | 3.918 ms |
| 父计时器观测：native 活着、无 stdout | 2506.407 ms；timer lag 6.336 ms |
| 独立进程实际 ps，随后才启动 sample | 约 2562.708 ms |
| 首次有效 stdout | 3240.294 ms |
| exit 0 | 3240.832 ms |
| close | 3241.093 ms |

从 spawn 返回到 close 为约 3237.175 ms。native 和父 Node 的同 PID 采样均实际完成；native 样本位于 dyld 启动及通知路径，父进程主线程主要在 `kevent`。精确路径的九秒系统日志中，amfid 在 00:00:05.796700 进入该文件，XProtect 结果在 08.952767，kernel exec allowed 在 08.954353，stdout 在 09.036 左右出现。

这些证据确认**成功调用的首次执行前段存在延迟**。采样开始前已等了约 2.56 秒，因此慢启动事实不由 sample 首先造成。采样后的 Mach/dyld 通知栈仍可能包含观察扰动；该日志没有识别通知接收端，也没有证明安全评估独占全部延迟。不能据此认定原 5 秒超时、statfs、管道关闭或 syspolicyd 故障的根因。

Apple 的 [RemoteNotificationResponder 源码](https://github.com/apple-oss-distributions/dyld/blob/main/dyld/RemoteNotificationResponder.cpp) 有同步 Mach 通知等待，但此源码不是本机 dyld 的严格版本对照，只用于解释符号含义。

本轮保留了实际执行文件，SHA256：

`44c785794330382af9b9d248124d35e74933f020be1e0931648b5fd553026b09`

大小 56464 bytes，严格签名核验通过，Team `2UVGT2J459`，CDHash `64c1294487a7180fe03ceb3f15b36dca6651fd74`。其实际文件、stat、原路径 xattr 和签名记录均留在本机 `20261031T155807Z-first-capability-retry1/closeout/native-images/`。它不是历史失败的 `d4d88…` 工件。测试阶段的 capability PID84576 则在调用前至 close **5.051 ms** 成功返回；随后发生的是索引 NOT_READY。

## NOT_READY 的确定根因与闭环

原取证包由 macOS tar 创建，包含用于扩展属性的 AppleDouble 元数据条目。前一轮诊断用 Python `tarfile` 恢复依赖，将其当普通文件写到了 `node_modules`。`node-gyp-build` 在 `build/Release` 中按 `\.node$` 筛选并选择第一项，因而选中了元数据文件。

| 文件 | 实际内容 |
|---|---|
| `._tree_sitter_runtime_binding.node` | 163 bytes，文件头 `0005160700020000`，AppleDouble；SHA256 `9eda034a8c251883dd5b45c9c6122f6d242ead036f3c7c42ea0a01d944b38379` |
| `tree_sitter_runtime_binding.node` | 676368 bytes，文件头 `cffaedfe0c000001`，实际 Mach-O；SHA256 `70285a6cce2c47acdc84d619c108658a6fcdd442c9ffee7a5b4284ba04e9f2de` |

当前 profile 的原 owner stderr 直接记录了前者的 `ERR_DLOPEN_FAILED` / `slice is not valid mach-o file`。实际 loader.resolve 与实际加载预检再次确认误选。旧系统那次 NOT_READY 的依赖中也有相同坏文件和加载器，但其 owner stderr 正文当时没有保存，不能将新日志冒称旧日志。

本轮在消费者退出后保留坏输入，用 `/usr/bin/tar` 仅恢复同一已核验取证包的 `node_modules`。这是新 consumer 的依赖恢复，没有重复进行旧归档的物理解压核验。恢复后 AppleDouble 普通文件为 0，加载器选择真实 Mach-O，tree-sitter 与 Java grammar 实际加载及解析通过。

依赖清单从 **8894** 个文件恢复为 **4110** 个，目录仍为 667 个，相对链接仍为 7 个。修正后的依赖 SHA256 为：

`b98c82f00de9c1d77cef1fe947256fcffe2a80fd77a9939b90805dab08da1e4c`

这与此前正确恢复环境的依赖身份相同。新冻结身份仅 `dependencies` 和 `workspaceDependencies` 两项改变；`source`、`candidateSource`、`runtime`、`native`、`build`、`dist` 均逐项相等。原 frozen、原 FAIL 和坏输入分别保留。

随后通过原 broker 的 `--reuse` 严格校验，原 product-mcp 单项 **1/1 PASS**，用例耗时 **1963.424416 ms**。没有重建、修改断言或时限，也没有自动重试。该结果闭合的是依赖恢复错误，不是历史 native 5 秒故障。

## 可审查的解决方案

1. **固定诊断包的恢复路径。** macOS 上使用本轮已验证的系统 tar 恢复；使用其他解包器时按载荷 manifest 还原文件，将 AppleDouble 作为元数据处理，不能把 `._*.node` 放入模块搜索路径。保留相对链接，并在运行前核对依赖清单、实际 loader 路径和原生模块真实加载。正式 installer 使用 npm ci；当前证据不支持修改产品解析器或 `node-gyp-build`。
2. **保留第一条底层错误。** 私有观察器现已将 owner stderr 原字节写入 RAW。后续验收 runner 应在失败时保留已有 owner stderr、实际 native 文件/元数据及同 PID 时序，避免只输出 `state NOT_READY` 或在构建 catch 中先删现场。生产常态无需启用采样器。
3. **历史 5 秒问题按证据决定修法。** 只有明确关联的 exec allowed 晚于期限，才进入执行准入/签名分发路径；许可已到且无输出，才调查 native 启动及函数体；输出已到而 close 迟到，才调查管道继承。当前没有足够证据选择其中一个产品补丁。保持原 5 秒及原 FAIL，不以预热、放宽期限或关闭系统保护取得通过。
4. **后续正式验收先选定新基线。** 当前 OS、clang 已变化，继续 MAC-17 正式验收需单独冻结新候选与运行时，并明确复用旧证据的边界。随后补完整 installer 激活、空 Gradle home 首次语义、完整升级及回滚。当前诊断 profile 的单项 PASS 不能替代这些验收。生产 TCC、MAC-18/19 继续单列 NOT_RUN，仍须具体生产授权。

身份稳定的本地开发签名、Developer ID 分发签名和公证是不同事项；本轮只观察到 Apple Development 签名，未执行公证或分发评估。有关分发的要求应以 [Apple 公证文档](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) 为准，不能用严格 codesign PASS 代替。

## 运行记录与收尾

| 运行根后缀 | 结果记录 | 实际结果 |
|---|---|---|
| 20261031T154611Z-first-capability | [准备失败](first-capability-preparation-result.json) | INVALID_EXPERIMENT；Python 缺少 xattr 接口，观察器退出，监督器中断构建，未运行目标测试 |
| 20261031T155807Z-first-capability-retry1 | [原系统捕获](first-capability-original-host-result.json) | 首次 capability 成功但较慢；目标 capability 正常；原单项因 NOT_READY 失败，原 stderr 正文缺失 |
| 20261102T013000Z-passive-capability | [环境漂移阻断](first-capability-host-drift-result.json) | BLOCKED_ENV；原 runtime guard 在构建前阻断，未执行 build/test 命令 |
| 20261102T013814Z-current-host-diagnosis | [当前系统捕获与修正](first-capability-result.json) | 首次 NOT_READY FAIL 保留；确定依赖恢复根因，修正后同一 broker 原单项 1/1 PASS |

当前系统的实际 native 文件 SHA256 为 `7a7a5be8ce18a87abde3aaa1dcd577f8e69cfd56760483a762d8487f830bae94`，与旧系统样本分别保留。当前诊断 runtime manifest SHA256 为 `f6bbab98ebf4ad63077a0b251c3013a257137f7604b96bd92d68e096fb2997ce`。修正依赖后没有重建此文件。

独立复核结论 `PASS_REVIEW_OF_LIMITED_DIAGNOSIS`、无 findings；复核者只读检查原始记录、身份变化及实际退出，没有执行测试、构建或 native。登记的 **45 个 PID、18 个自有进程组均已退出**，无运行根 argv 残留。精确 launchd job 清单为 0，没有猜测标签或清理其他 job；全局两张 fixture 配额表均为 0。

四根统一 closeout 均 PASS，`unregisteredPaths=[]`、`expiredResidualBytes=0`，本次到期 raw/tmp/HOME 和准备源码/依赖树已删除。99 个 RAW 文件各随所属根打包，并各做一次物理解压全文件 hash 核验。实际二进制和必要元数据单独作为最小 LOCAL 现场保留；没有把整套源码或依赖树改成长期保留。

以下 SHA256 对应各运行根内的 `closeout/raw-evidence.tar.gz`：

| 运行根后缀 | PID / 自有组 | RAW 文件数 | archive SHA256 |
|---|---|---:|---|
| 20261031T154611Z-first-capability | 7 / 3 | 16 | `f5b63c89b29bb2a9ffd8879eab70255525dcdf203585826f7deb674e8decc52a` |
| 20261031T155807Z-first-capability-retry1 | 14 / 4 | 32 | `0d9ce6c3e9c6527177d5cbdbb6c7f38b0a5a13a75a8c61a3d787c40959c8fc12` |
| 20261102T013000Z-passive-capability | 4 / 3 | 10 | `134b420b83cacf5b0f532b80e967bd73f65861d212f7cffd73bee0d1d4d04880` |
| 20261102T013814Z-current-host-diagnosis | 20 / 8 | 41 | `d750ad217a5801345b20b31f0805e6edcf7d980a3893eb4a04a853a570e1aff7` |

上述根均位于 `/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/`。已有候选包、历史归档与历史失败记录保持不变。本轮在原截止前停止新增实验，没有后台 runner 继续测试；未自动推进安装或生产授权步骤。
