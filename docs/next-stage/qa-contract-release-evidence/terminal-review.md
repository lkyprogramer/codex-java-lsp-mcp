# Terminal qualification review

**PASS — ELIGIBLE_FOR_MANUAL_REVIEW。** 未发现阻断。当前证据满足原有 15 门及 K01–K32 合同；本结论是资格评审，不是已安装、已回滚或已部署的证明。

只读核查归档 release-evidence.json、release-verdict.json、当前汇总文档与相关真源，复用已完成的工程、源码包、逐例结果和公私接口独立审计。116 个门、合同及源码身份直接证据引用均与实际 SHA-256 一致。原 verifier 的 exit 0 / ELIGIBLE_FOR_MANUAL_REVIEW 为主代理已执行结果；本次没有重新运行 verifier、模型、评分、judge、benchmark、tests、build 或 installer。

## 身份及原门

实际测量对应 611 个执行输入、源码摘要 `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`。measurement base 为 `04058e43b8b2658864d0de09c8d6024e9928dfc5`；私有源码包为 clean commit `a77b6428ca432259c4008ead6c5e58cdc5e53cef`、1843 文件、tree `0a962ef0bf631e9bb19c849d8ee18ca938774e02`。最终 source binding 和既有逐文件 HEAD/blob/SHA/mode 审计连接这些身份，未把打包提交冒充原测量提交。

原规则仍为 15 门、32 合同、QA floor 0.8、critical 0、8 组实际冻结修复及真实计划运行完整性。原 immutable 输入 293 项保留检查 PASS。1366 源码测试和 436 scripts 测试均为已执行、零 skip；HTTP 5 工具及 K26/K28 真实 JDT 与同一 6d 身份相连。canonical 56、probes 12、counterexamples 27、fault 2、oracle 8 仍保持各自实际验证层。

K29 保留默认单 worker、1000 文件、每步 100 samples、concurrency 1/5/20、20 次 metadata update @100ms，以及原 warm P95 150ms / event-loop P95 20ms 门。已归档最终 c20 P95 125.462ms、update P95 127.665ms、对应 event-loop P95 1.612/1.555ms；未用双 reader 或缩减负载替代默认容量门。

## 四组结果和失败

| 实际组 | 计划/收到 | Product | Control |
| --- | --- | --- | --- |
| 原 QA | 56/56 | QA 26/28 | QA 24/28 |
| 原 repair | 16/16 | repair 8/8 | repair 8/8 |
| full public | 72/72 | QA 26/28，repair 8/8 | QA 25/28，repair 8/8 |
| 新 locked | 24/24 | QA 9/9，repair 2/3 | QA 9/9，repair 2/3 |

168 仅表示计划运行完整性，不是 QA 成功率分母。FULL_PUBLIC 的 PASS 只证明全 corpus 实测完整性。其原 CLI qualification 两臂均为 QUALIFICATION_FAIL，Product integrity/anchors、Control anchors 失败及原 stdout/stderr/报告仍保留；这些诊断未被改写成全部任务通过。

新 locked 的 HLR-PARCEL-R1 两臂真实修复失败保留：整数上界触发 parcel 计算溢出，实际 judge compile 成功、business 失败。未新增不存在的 100% 新修复门，也未以旧 8/8 覆盖新 2/3。repair 辅助评分 post-write valid=false（20/24 blocks）和初始 NO_GOLD 标签仍保留，其最终成功率来自冻结 score/独立实际 judge。newCritical=0 仅涵盖冻结 24 次已观察产品/host/interface critical 范围。没有统计优越性、成本降低或生产全面正确性声明。

历史阶段 NO_GO、原历史 logs 和 copy-only package NO_GO 原样保留。当前 eligibility 来自新归档原门核查及后续 locked 证据，未把旧日志当作本轮执行，也未把 copier 的 copy 完成状态当成 locked/performance 或发布通过。未读取私有 holdout；复用了已完成 owner 独立审计的公开 redacted 证明。

## Native driver 静态边界

归档 native-deployment/run-install-proof.py SHA-256 为 `2c126e4eb97865dff7a5e75083f7b3501ba42c8c21464c666597030ccf9ccc63`。只读检查未发现实质隔离或生产保护缺陷。操作前要求本报告 PASS，并重新运行原 verifier、clean-source 校验、1843 文件 SHA 和包 HEAD 检查。隔离路径使用独立 runtime、LaunchAgents、logs、cache、ownership、空 projects、唯一 job label 和 38561/38562 端口；执行旧版本→候选→回滚，并要求停 job、job 不存在及端口释放。

生产路径要求隔离 proof PASS，原 current/plist/projects hash 精确未漂移，检查旧 38456 health/ready 与 canary 38457 空闲，保存 prior environment（除新实例 SID）、Label、RunAtLoad、项目配置、previous-current，并核对 installed 非 rsync-excluded 文件及实际 smoke。当前 plist 的 prior 环境键与 driver 传入的保留键覆盖一致，未观察到配置丢失。driver 尚未执行；隔离安装、回滚及生产替换全部 NOT_RUN，必须另记真实 proof。当前汇总文档对此表述准确。

## 非阻断限制

主 workspace 新归档使 Git untracked 文件列表超过 spawnSync 默认 buffer，当前 candidateIdentity helper 实际出现 ENOBUFS。按同一 executable 过滤与摘要规则、不受该 buffer 限制的独立复算仍为 611 文件及上述 6d 摘要；私有 clean a77 包未受归档影响。这是身份工具的已知局限，不是源码漂移；本次未修改冻结代码。

没有 blocking findings。资格 PASS 不替代尚未执行的 native 操作证明。
