# MAC-00：运行时冻结与旧路径诊断

状态：**MAC-00 / G00 PASS**。独立 reviewer 已核对测量及关账。该门证明的是旧实现的有限诊断 spike，不是新架构或性能收益验收。[完整聚合结果](task-result.json)。

- 冻结 Node 22.16.0 / SQLite 3.49.1、四仓指定提交和输入 hash；独立副本 status/fsck 通过，私有依赖与原依赖 hash 一致，隔离编译通过。
- 真实 lishu-v2 冷建正常完成：首轮进程墙钟约429 s，补测阶段 CPU 的第二轮约446 s；自然 READY，FAILED/RECOVERED均0，Java/XML census、integrity/FK通过，关闭后无WAL/SHM。
- tracked 输入为6160 Java/89 XML，旧索引器纳入5887 Java/4 XML；统计边界不同，未把它们强行判相等。原错误断言及修订记录保留。
- 0/20/200文件的A/B/C成本分支均有记录。新checkout的A实测重戳5887行；B20解析20、affected109，B200解析200、affected856。所有分支自然非recovering，无forced READY。
- SQL/函数耗时与CPU是包含调用的统计，不能相加当独占成本；探针墙钟包含完整性检查和收尾。C组合墙钟由实际stat/reconcile命令合计，丢失的组合CPU明确未测。
- 单轮共享卷数据没有受控空跑校正，物理比例为INVALID_EXPERIMENT；只有两轮不同计时协议的full，B_full保持未测。生产仅核对配置/二进制与关键源码，运行进程身份未验证。默认阈值未放宽。
- 42条记录的进程组均已退出。RAW归档129文件/28,885,873字节，解包路径集合、字节数、SHA-256一致后删除本次到期副本；INPUT/计划/本机审计归档按consumer保留。

源码与精确命令、原始样本、探针和逐文件hash均保存在结果引用的本机私有归档；公开目录只存聚合数据。未运行新架构、K、正式三仓、真实JDT、付费模型或部署验收。下一任务为MAC-01。
