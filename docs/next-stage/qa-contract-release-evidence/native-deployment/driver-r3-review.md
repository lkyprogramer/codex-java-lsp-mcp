# Native driver r3 review

**PASS。** 已关闭一个实际静态 blocker，未发现剩余阻断。最终 driver SHA-256：`3355ce18876a530c73787854ad4275f98d458cf66ab4d1913f028095a4425f18`。

首次 r3 SHA `06bfb4faca5858acf4fd52fb56394045f8fc5b3a0377b410e2a4f9262909902e` 将 launchd job 的 `target` 覆盖为 baseline 目录，cleanup 无法核查正确 job。已报告主代理并复核修复：该路径现命名 `baseline_target`，`target` 仍为 `gui/<uid>/<label>`。只修外部 driver，未改冻结源码或测试预算。

旧版本 baseline 取实际生产 current 指向的 deployed09 二进制，首先核对 current 与 preflight 一致。copytree 保留 symlink；启动前逐 regular file 比较原/clone SHA，逐 symlink 比较原目标并要求 clone resolve 仍在自身 release 内，检查 build stamp 09。这证明二进制克隆路径的静态校验设计，不是旧源码重建或旧 fullsuite PASS。

baseline 稳定入口脚本来自克隆。实际 deployed09 的 renderer CLI 与新调用参数顺序一致；其 daemonctl 以自身 runtime/显式 isolated runtime及 0600 daemon.env 为控制真源，校验 runtime 和 SID。r3 使用独立 runtime、job label、LaunchAgents、logs、cache、ownership、空 projects、SID、38561/38562 端口，state/plist 0600，并要求 baseline 实际 start、smoke、09 health 完成。

全文比较确认从 candidate installer 调用开始到 rollback、current/previous-current、09 health、stop、job 不存在和 ports free 的代码与 r2 逐字一致。候选 a77 installer 的完整 mandatory checks 未跳过。production block 唯一差异是读取 isolated-attempt-3 的 proof，仍要求 PASS 和 cleanup，原资格、源码 SHA/HEAD、生产 current/plist/projects nondrift和环境保护未改变。

新 output 按 mode 写入 isolated-attempt-3/production-attempt-3，exist_ok=False，不覆盖前两轮失败 raw。原 legacy 1207/1208 fullsuite FAIL 在 states 中明确保留；主代理报告的单失败 targeted 1/1 recheck 不替代旧全套结果。本次没有重跑或重新审计该套测试。

没有运行 installer、tests、models 或实际 clone。attempt3 是否成功须由实际新 proof 证明；当前 PASS 仅是上述 driver 设计与身份/边界静态复审。
