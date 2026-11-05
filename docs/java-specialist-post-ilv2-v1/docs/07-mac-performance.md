# 07 Mac性能：优化实际等待，而不是重开底座工程

## 触发条件

Q09只在日常记录显示同一仓库重复等待，或新outline/evidence的source I/O成为明显瓶颈时启动。建议先记录至少10次真实使用，不要求采集完整源码；按任务和冷态分类保留wall time。若长等待只发生首次依赖下载，首选正确说明准备成本，不增加新常驻服务。

## 冷热状态必须拆开

| 状态 | Gradle/JDT状态 | 应报告 |
|---|---|---|
| C0 | 私有依赖home空；JDT workspace新 | 网络/依赖准备、项目导入、索引、首次语义分别记 |
| C1 | 必需依赖已准备；JDT workspace新 | 导入/索引冷成本，不能叫空缓存端到端 |
| C2 | 同root同工具链保留workspace；JDT进程重启 | workspace复用是否真减少导入/索引 |
| W | JDT READY，同一view新查询 | 首次后端miss与缓存hit分开 |

不共享不同worktree的可变JDT `.metadata`；模型/Git相同不代表classpath/路径/状态相同。已有只读JAR索引准备能力只在当前授权合同内使用，不另建全局JDT缓存平台。[S11]

## 当前时间合同

HEAD默认导入启动120000ms，导入后新建索引budget600000ms；调用方deadline独立。Q00先确认安装版本实际设置，Q09不可悄悄改回120秒总预算或通过延长上限宣称加速。`java.project.getAll`作为屏障依赖当前冻结JDT行为，不是任意未来版本都成立的LSP规范保证。

回归测试必须覆盖：索引超过import剩余预算但未超index budget的当前行为；caller超时后长caller继续；stop后的晚结果不READY；index超时回收与backoff；READY后新build/classpath变更不被旧结果误标完整。

## 测量协议

先用同一候选、同一仓库比较C1/C2，每个至少3次，只作诊断，不把3次当可靠p95。确有收益后再预注册足量样本（沿现有G12/G14有效样本规则），AB/BA交错。固定电源、睡眠状态、温度与load窗口；有效慢样本不删，host污染按事先规则单列。记录client wall、shared startup、import、index barrier、queue、first definition/references、cache hit、RSS和磁盘。

已有G12 D1-a口径保留：query paired p95≤max(1.1×baseline,baseline+10ms)。新outline初始目标warm p95≤100ms仅为筛选目标，Q00冻结后才执行；不达标先归因。现有K29/截止/公平性硬门不因新功能便利而取消。

## 可做的窄优化

1. 确认没有无必要清除同root可复用workspace。
2. 不变build/classpath/key下复用已有合法状态；变更后按既有失效规则处理。
3. source read/hash占比高时，做单请求内按path+hash的读取复用；末次anchor/变化保护不删。
4. 批量精确查询优先复用现有singleflight/已有batch接口，避免N次独立JDT启动等待。

## 明确不做

不全仓预热所有JDT；不关闭APT/Lombok换快；不关证书验证/代理隔离；不改成后台无deadline；不启用每5秒CPU profiler；不因一次慢样本重写scheduler；不自动删除workspace/Gradle缓存。Native owner/fd/PGID/TCC只跑受影响门，不加新的guardian或看门狗。

## 成功与停止

固定正确性下，真实重复等待明显下降，且稳定态RSS/延迟无退化，才接受。若复用收益小或需要扩大维护面，记录NOT_WORTH_COMPLEXITY；性能任务结束，不妨碍质量路线。
