# 上线标准、受限试用与部署授权

## 1. 对 b9 的正式判断

- 完整原 v1 上线资格：**NO_GO**。
- 代码能否继续开发/隔离验证：可以；保留已有成果。
- 是否允许直接据当前M3报告默认启用dense：不允许，效果证据无效且实验缓存有缺陷。
- 是否已经获得生产部署授权：本轮没有；本包没有部署。

不是“repair恰好0成功所以自动禁止一切静态搜索”。原要求是QA floor、原K契约、实际repair测量、资源和release门禁联合成立；当前同时有可复现错误、无效测量和未执行契约，故不能完整签字。

## 2. 完整签字前的门

必须通过冻结数据/原12探针、新产品反例、最后模型payload sentinel、canonical scorer、准确candidate判定、macOS编译/全测、真实MCP/public工具、原K32、独立locked/公开full语料、有效LIVE两臂、性能和现有release gate。每个PASS指向相对路径raw及SHA，不允许只放机器上的个人路径。

原QA contract floor=0.8、correctness=1、新critical regression=0继续使用；改变门槛必须owner书面批准的独立协议，不由执行AI自改。原并未要求模型8个repair全部成功，不能临时添加100%repair成功率；要求8组**真实Agent候选**均被冻结judge测量。原8个reference oracle必须全部绿，且原有缺陷baseline需业务断言红。

原 `gate:release` 是工程gate，不自动包含全部新任务效果。它通过和完整v1不达标可同时成立。

## 3. 机器可读清单

将 `templates/release-evidence.json` 复制到**新的run目录**填实测值，然后：

```bash
python "$KIT/tools/verify_release.py" "$RUNS/release/release-evidence.json" \
  --evidence-root "$RUNS/release" --out "$RUNS/release/verdict.json"
```

空模板预期退出1/NO_GO。所有项满足时只得到 `ELIGIBLE_FOR_MANUAL_REVIEW`，不是自动安装。重复key、缺项、坏hash、路径越界、使用oracle替代真实Agent、缺K项、低QA、未测usage却宣称省token均不能通过。

**检查器的边界：**它检查清单、哈希与声明的状态，不会凭一个字符串证明昂贵实验确实执行；同权限人可以伪造清单与日志。独立review必须检查raw trajectory/candidate/judge；此工具不被称为安全认证、密码学执行证明或自动质量判官。test_release_verifier里的全PASS样例纯属检查器自测，不能作为产品报告。

## 4. 可选实验与core发布

R10/R11可以不进入静态core候选：把实验明确禁用/移出default依赖，旧结论标INVALID，不宣称vector收益。K27仍检查disabled/failure路径的安全行为，sourceHash规范仍适用于所有来源。若optionalExperimentEnabled=true则需要有效GO_OPTIONAL、同预算与冷热缓存证明以及真实实验报告。

不要为了避开K32而把仍公开的position/references称为“不适用”。真正要缩小发布范围，先提交新的接口和承诺、列出排除能力，由用户批准为**受限试用**，不是通过原v1全部门槛。本包默认不做这种范围豁免。

## 5. canary流程（未来经授权执行）

先在独立installroot和非生产loopback端口启动候选，验证tools/list五工具、static query零JDT、scope/errors、query→impact→read、真实JDT references与取消、query时编辑、静态负载与idle WAL。不能使用38456作为测试端口，不复制认证凭据。

canary前记录`current`和`previous-current` release指向；新release打包不可变，编译产物与candidateSha对应。模拟smoke失败后切回previous，验证原daemon可用，保存恢复耗时和前后PID/版本；演练只作用隔离目录。真实生产安装需用户明确批准，按仓库现行 `docs/phase-f/production-operations.md` 操作，不照抄旧cutover手册或修改全局MCP URL。

## 6. 回退触发

发生跨scope/跨worktree错误结果、stale locator冒充READY、来源不在授权root、JDT取消影响其他请求、未知schema导致完整缓存假阴性、WAL不收敛/队列失控时停止候选。先归档证据，再回退不可变release。schema不兼容缓存按已验证重建流程处理，不直接删除未确认归属的生产目录。
