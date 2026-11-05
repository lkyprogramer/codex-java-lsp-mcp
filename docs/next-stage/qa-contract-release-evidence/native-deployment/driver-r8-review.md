# Native driver r8 independent review

**PASS。** 无静态阻断，可继续已授权的新完整 installer attempt。Driver SHA `864c42cd2b5cfe7f9f222982070d53ebb10017720c92e1102db54b93f36c23dc`。本结论不表示attempt8已执行或部署成功。

实际读核production-path-diagnostic.json：保存的daemon PATH下 /bin/sh command-v lsof exit1；完整安装进程 BASEPATH 下exit0、解析为/usr/sbin/lsof。r7失败raw SHA与diagnostic一致；原1366源码测试为1364PASS、1FAIL、1SKIP，query-worker的openHandles使用execFileSync("lsof",...)。R09因不可用skip；P3 release/inode验证明确抛lsof required。原失败未被重标PASS，scripts/生产切换未完成。

现有production-path-failed-file-recheck.log明确隔离clone新8f/tree7d，完整query-worker18/18 PASS、0FAIL、0skip，涵盖上述两条lsof失败路径，足以验证本轮已观察前置缺失；不替代下一轮mandatory全套。原isolated6 upgrade/rollback/cleanup复核由已有native-isolated-recovery-review PASS覆盖，本次未重复运行。

全文r7→r8差异仅attempt8输出、独立review PASS+exactselfSHAguard、继承prior后仅追加installer进程PATH的/usr/sbin:/sbin，并assert lsof精确路径、proof追加安装进程与daemon前后PATH。原installer调用和测试没有skip或弱化。新输出exist_ok=False保留旧raw。

实际候选包install-runtime.sh与当前workspace字节相同。write_launch_agent:716–718独立构造daemon_path=NODE目录:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin；它不取安装进程PATH。因此修复为验证子进程提供/usr/sbin，不意图改变daemon PATH。r8安装后仍遍历prior环境（只除新SID）逐值比较actualenv，包含PATH，并记录三种PATH；若daemon环境意外变化则不能生成PASS。

原资格、clean-source、source/adoption/manifest/selection、已有隔离恢复proof hashguard、新包实际filesSHA/mode/HEAD，以及production current/plist/projects nondrift、health/SID、previous-current、pins/config/env/installedfiles检查均保留。无需为安装进程PATH修复重跑已通过且代码未变的模型或原业务门。

本次只读源码/现有raw和driver，没有执行tests、model、installer、daemonctl或production。下一轮必须实际完成原mandatory installer及全部postguard，结果另记attempt8 proof。

## 最终窄化绑定

主代理随后把安装进程PATH修正窄化为 `prior["PATH"]+":/usr/sbin:/sbin"`。重新全文对照确认只有该表达式变化；保留原所有entry（含/usr/local），不调整任何既有entry顺序。上文诊断的完整BASEPATH及18/18通过仍是已有实际证据，不被改写为新表达式执行过全套。

本review实际只读使用shutil.which对诊断中的prior及最小追加PATH解析：node/npm均保持原Node22.16目录，lsof由None变为/usr/sbin/lsof；没有启动这些程序或重跑test。因真正变化仅为恢复缺失lsof可达且Node/npm解析相同，既有完整文件18/18验证足够，不需要再重复该文件或模型。daemon独立PATH构造与postguard不变。

旧BASE覆盖版本的review已被最新SHA绑定替代，JSON保留supersededStaticReview身份记录；当前selfSHA guard只接受本报告绑定的新driver。
