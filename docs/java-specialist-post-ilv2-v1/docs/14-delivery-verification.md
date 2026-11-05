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

## 完整性

`SHA256SUMS`覆盖包内所有交付文件（不含清单自身和运行时__pycache__）。验证脚本同时拒绝未登记文件，检查任务依赖顺序、Markdown fence与本地链接。对合法编辑后的套件，应新版本重新封存，不能用更新hash来掩盖fixture/gold漂移。
