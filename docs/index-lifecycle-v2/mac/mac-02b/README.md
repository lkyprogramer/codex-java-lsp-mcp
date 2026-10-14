# MAC-02B：owner 锁与生命周期

状态：**PASS，G02B已通过；MAC-02C尚未实施，父G02未通过。** MAC-02A已提交`2c70544`。本卡不代表正式产品查询、transport、binding或GC恢复通过。

原生launcher在canonical cache root固定`.owner.lock`，monotonic等待最多5秒后直接exec冻结Node，锁映射fd4，IPC保留fd3。入口验证同OFD锁与runtime/native身份，builder、JDT和原生调用显式传递fd4。真实parser位于builder内部。native stdout/stderr分别限制64KiB字节；超时/超限SIGKILL后等待实际close。

JDT环境与preferences使用同一服务域私有Gradle home。清理阻止语义准入，先确认旧JDT/owner组退出，再逐冻结版本按明确home停止Gradle并核对实际退出。超时操作真实结束前保持single-flight；停止失败保留静态准入且拒绝新JDT。隔离runner重置嵌套state root。

最终37文件源码摘要`c04f2ae68c4476276d63ac9abe4988959599f8a7f4339dcd7fc223f7b4dc05cd`，执行tree`dc34aabf0ddc167860afcc563e1da9f1dc5184cb`，native SHA`c0e21377d559d9ae2db5387e3d30fefe4ab7737bee2439237ca97cfdcd062c6d`。最终受影响定向8/8及独立8/8均通过、零跳过，独立源码评审无未闭合finding。两组重叠检查不合并为一组16项PASS。

真实launchd的7个生命周期场景与2个配额测试在前候选e095通过：同root互斥、5秒锁等待/OWNER_BUSY重启、早期及稳定SIGKILL、后代持锁和真实builder。最终候选重新覆盖受影响的早期崩溃、builder、控制器两个登记窗口及配额反例。初始5887窗口2/2保留自身身份；所有样本不跨候选合并。控制器死亡后，外部预约仍阻止旧客户端DELETE与抢占，精确bootout并证明实际退出后才放槽。launchctl早期公布的PGID1不当作自有组。

冻结JDT1.56、TAPI8.9、JDK25.0.2、Gradle9.3.1。真实JDT完成initialize并用产品settings/env导入两个合成Gradle项目；JDT JVM同PGID并持fd4，Gradle daemon实际脱离且不持owner锁。活动BUSY导入故障后，两类旧进程从同一故障起点2156.013291ms退出；另一私有域存活，随后独立正常停止。重启后静态准入与RECOVERING语义状态分离，恢复前拒绝新JDT。实际daemon使用的两套私有distribution各308个jar与预先冻结工件逐hash一致。

Documents访问由用户明确允许；固定主体的系统请求94098.9实际返回authValue2。未授予Full Disk Access或辅助功能，未修改TCC数据库。此前两次JDT FAIL保留：组退出期间signal0返回EPERM，旧夹具立即抛错。定向RED后修复为EPERM继续视作未退出，在原期限内等待，只有ESRCH证明退出；持续EPERM必须超时。独立发现的清理证据丢失与非法组探测也已修复。

566个RAW文件、52648725字节已归档并实际解包逐路径/字节/hash核验，独立再次完整核验。RAW/tmp和上一轮固定权限主体的到期carry已删除；实际未登记路径、到期残留、关联进程和共享配额均为空。29个已记录标签（含未启动夹具）、52个PID、27个自有组均确认不存在；标签数不代表实际启动数。精确命令、hash、历史失败与独立结论见`task-result.json`。

未运行：MAC-02C真实FSEvents继承、G09完整查询恢复与恢复后JDT重新initialize、正式K/PR/release、业务仓矩阵、生产安装/调用。用户已确认FSEvents实测归入G02C；G02B通过后按顺序进入C。旧31文件18/18+独立4/4、旧35文件native8/8+独立2/2及4368.82ms直接TAPI证据保留旧身份，不替代本轮launchd/JDT结果。
