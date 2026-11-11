# 14 本次交付验证与限制

## 交付性质

这是2026-11-05生成的Post-ILV2方向与执行计划，不是对产品的代码修改，也不是新一轮生产通过证明。项目结论固定到`b1475cddac01ab6ce589a1d465578d5ab7772533`。后续HEAD变化必须先执行Q00。

## 已实际执行的附件验证

| 项目 | 结果 | 证明范围 |
|---|---|---|
| 最终消息receipt检查器测试 | 28/28通过 | 附件检查器在已列输入上的行为 |
| RED控制 | 故意全放行stub：28题中24题失败，退出1 | 负控制不是永远为绿 |
| 两个checker变异体 | 删除source hash守卫、删除最终正文比较都被杀 | 测试能发现这两种验收弱化 |
| 原创机制语料 | 8组、24case，27个语料文件，16个Java源码 | 可重复的公开机制素材，不是业务基准 |
| JDK编译 | 9个独立编译单元通过 | 同FQN两个模块分别编译；不强行合并classpaths |
| JDK控制程序 | 4个运行通过 | 少量重载/动态调用/状态/Unicode控制 |
| 示例request receipt | 1个source unit、4行、147字节核对通过 | 构造的最终request正控制，不是产品或模型运行 |
| 文档/任务DAG/本地链接/字节清单 | 由verify_bundle.py检查 | 包的自洽性与完整性，不是产品发布资格 |

执行环境为Linux容器、Python 3.13.5、Node v22.16.0、JDK javac 21.0.12.1。Java源码以`--release 17 -proc:none`编译。与用户Mac/JDT冻结环境不同，不能外推为其原生兼容性测试。原始日志和JSON见`evidence/`。

## 明确没有执行

- 当前分支完整npm安装、类型检查、全量产品测试；容器获取完整源码的网络路径DNS失败，关键源码通过GitHub连接器读取。
- macOS APFS clone、FSEvents、native flock/launcher、launchd/TCC、真实worktree回收与真实JDT。
- 私有mac10-v3、三仓、真实Agent/付费模型或embedding调用。
- 生产安装身份核验、部署、重启、全局guidance修改。
- Bifrost/Serena/Graphify等竞品横向实测。
- 独立子代理产品review。本包只有当前执行者的文档自审和附件自动检查。

## 证据使用规则

G12/G13/G14/G17数字全部来自仓库报告，正文注明其阶段/快照限制。不能将本包28个测试加到产品原测试数量中，也不能将24个机制case当24个独立业务任务。接口中的outline和evidence v2为拟新增合同，不是当前已支持的功能。

## 1.1修订验证（2026-11-10）

修订内容见[README](../README.md)“1.1修订记录”。只改了文档、任务卡和`contracts/`；fixtures、evaluator标签、tools、tests和evidence都没动，上表1.0的附件验证结论仍然只对应1.0的检查器与语料。

| 项目 | 结果 | 说明 |
|---|---|---|
| 修订依据的源码事实 | 对`cc5db6b`只读核对 | `anchor-windows.ts`、`symbol-static.test.ts`/`output-shape.test.ts`、query相关测试、live runner脚本、`07c6ccf`引入600秒索引预算，均在仓库中确认存在 |
| `verify_bundle.py` | 重新封存`SHA256SUMS`后运行 | 检查字节清单、新DAG顺序、链接与fence |
| `python -m unittest discover -s tests` | 运行 | 检查器自测，与修订内容无直接关系 |
| `check_fixtures.py` | 未运行 | 修订环境没有JDK；fixtures未改动，沿用1.0结果 |
| 产品构建/测试 | 未运行 | 本次只修订计划，不改产品代码 |
| `evidence/receipt-checker-{green,red}.log` | 从清单移除 | 1.0清单登记了这两份原始日志，但仓库`.gitignore`的`*.log`规则使它们从未入库，1.0在仓库内运行`verify_bundle.py`必然报MISSING。其结果（28/28通过；RED stub 24/28失败、退出1）仍保存在`evidence/local-validation.json`，原始日志已不可得 |

## 1.2修订验证（2026-11-11）

修订内容见[README](../README.md)“1.2修订记录”。只改了文档与任务卡；`contracts/`、fixtures、evaluator、tools、tests、evidence未动。

| 项目 | 结果 | 说明 |
|---|---|---|
| 修订依据的源码事实 | 对`main@665d66e`只读核对 | `git diff cc5db6b 665d66e -- src scripts`的文件清单；`index-owner.ts`常量（200ms fence、1s prepare、1s–5min退避、lineage 256）；`mcp-server-factory.ts`的`queryCounters`；`java-index-file-parse.ts`的FAILED行；`evidence-sources.ts`的`ANCHOR_PARSE_INCOMPLETE`；`facts-store.ts`的callers/callees走边表 |
| 两轮底座修复的Mac验证 | 用户报告已通过 | 用户在本机Mac完成构建与测试（2026-11-11）；本包未收录原始日志 |
| `verify_bundle.py` | 重新封存`SHA256SUMS`后运行，PASS | 84个文件、13个任务，无错误 |
| `python -m unittest discover -s tests` | 运行，28/28通过 | 检查器自测，与修订内容无直接关系 |
| `check_fixtures.py` | 未运行 | fixtures未改动，沿用1.0结果 |
| 产品构建/测试 | 未运行 | 本次只修订计划；另修正了产品README资源策略列表中残留的未实现变量 |

## 完整性

`SHA256SUMS`覆盖包内所有交付文件（不含清单自身和运行时__pycache__）。验证脚本同时拒绝未登记文件，检查任务依赖顺序、Markdown fence与本地链接。对合法编辑后的套件，应新版本重新封存，不能用更新hash来掩盖fixture/gold漂移。
