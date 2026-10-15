# MAC-05 — explicit full/delta

门状态与证据以生成的 [task-result.json](task-result.json) 和 [status.json](../status.json) 为准。G03A 在 `4daafb2` 通过并提交后才开始本卡；本卡不扩大 G04 的历史结论。

实现将 capture、parse、resolve、graph/search 和 SQL 分开。delta 按声明依赖计算有界闭包，分别判断事实、静态边、图和文档是否需要更新；无闭包证明时明确升级 full。共享图节点及正反向边由 owner 关系保留到最后一个 owner 释放。同分 search 文档按稳定逻辑身份选择 evidence，来源 hash 取当前来源行。schema v13 使旧库重建。

直接依赖在现有解析不动点内按声明的已解析形状传播，保留 owner 的成员列表变化与 import 引起的绑定变化；仅方法体使用的 import 不广播未变声明。refresh 与 full 使用相同的源根和忽略目录规则；现有 full 未接纳的 `integrationTest/java`、`smartDoc/java` 不因显式 refresh 路径进入索引，已有范围外行按删除清理。非法目录输入仍报错并使 coverage 降级。

验证使用冻结输入的真实 first-parent 历史范围，记录实际 Java 文件数；XML 与构建文件在真库切片中保持 HEAD，其变化由定向用例验证。计时包含 job、checkpoint/同步和首次正确查询。不变量、页差、chain oracle 与 full 确定性单独验证。主机无效的计时记 `INVALID_EXPERIMENT`，未到达步骤记 `NOT_RUN`。

独立评审和收尾绑定最终候选。开发循环、历史候选、诊断和正式门证据分别保留，不合并通过计数。历史失败不改写；变更后的补测只覆盖受影响范围。

本卡不声明 publisher、GC、tracker、物理 COW 收益、JDT 或生产验收。racy-stat 归 MAC-03B，binding-only 零事实写入归 MAC-07 + MAC-08B，框架进程内查找键归 MAC-13。

先前四仓 `--correctness-only true` 使用逐文件 SHA256 核对的字节副本，明确记 `BYTE_COPY_NOT_NATIVE`；不能证明原生 clone、物理 COW 或性能门。用户随后已授权在空闲主机继续性能验证。历史输入改用临时 index 与单次 `checkout-index` 导出，保持 checkout filters 和逐文件字节；同名方法筛选从已知 owner 前缀后比较成员名，避免每个调用点重复比较长路径。定向诊断不代替正式门；正常模式门、独立评审及实际收尾均通过后才提交。另三仓旧矩阵按产品与八档历史输入的等价证明复用，保留原候选身份，不宣称重新运行或通过性能门。

旧运行 `20261015T064909Z` 已按用户明确授权归档并清理清单中的 RAW/BULK 原件。归档保留 180 个原始证据文件，逐文件路径、大小和 SHA256 校验通过；摘要、归档、校验证据及历史 FAIL 均保留。本次运行同样按清单归档、逐文件物理校验并清理临时原件；实际退出、归档身份和残留计数见生成结果的 `closeout` 字段。
