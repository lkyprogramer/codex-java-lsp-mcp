# Evidence copier 生成负向fixture窄复审 r3

结论：**PASS，已报告的负向fixture collect blocker已修复；无新具体finding。** 仅复核这次生成目录排除与新增proof，保留原REPAIR_REQUIRED、r2评审及原失败证据。

当前copier实际SHA256：`02a7d28bf6be1eb402f37184b48f8b1929bad195941634683856aa3be75f2b34`，与派发freeze一致。新增`package-evidence.fixture-green.tap`实际SHA256：`1dc52123e825a29878187e0e123c84a4bc6ffffcf473886d0031488606a45931`，与作者冻结值一致。

已观察修复：exclusion新增的匹配限定前三层为`p4-release/full-public-prep/offline-test-*`，reason为GENERATED_PUBLIC_PREP_NEGATIVE_FIXTURE。visit在进入子树前应用该排除，因此不需要读取或跟随其故意构造的Link.java。没有全局忽略symlink、没有按任意offline/cache源码包名排除。正式final-qa/final-repairs/full-public candidates与source-snapshots仍沿原visit路径，由选中symlink拒绝守卫处理。原credential、Git和已知生成物排除仍在。

新增fakefixture proof使用真实fs.symlinkSync构造负向Link.java；RED保留与父实际失败同类错误`selected evidence symlink rejected: p4-release/full-public-prep/offline-test-fixture/r2-bound-tree/Link.java`。GREEN为1test/pass1/fail0/skip0，并且同一用例明确断言：prep模块、offline-tests-final.stdout.log、正式raw-tool-results.jsonl仍selected；负向fixture子树未selected且过滤reason准确；向正式candidates插入symlink仍拒绝，随后向source-snapshots插入symlink亦拒绝。不是把symlink安全检查删掉后得到PASS。

本代理仅只读核对匹配规则、新增测试源码、已有RED/GREEN TAP与hash；只写本r3报告。未重跑旧4/4或新增测试，没有collect或扫描真实ROOT全树，没有复制实际目录，也没有运行模型、build、JDT或installer。

原r2的E01绑定关闭结论继续保留；本次新增proof仅补生成负向fixture边界，不冒充累计suite或真实打包成功。父代理可按既定copy-only流程重试真实打包；是否最终copiedSHA/mode完整及发布资格仍由实际收据与父release authority判定。脚本NO_GO/EVIDENCE_COPY_ONLY的边界未改变。
