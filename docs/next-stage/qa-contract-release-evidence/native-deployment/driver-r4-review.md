# Native driver r4 review

**PASS。** r4 SHA-256：`a707a52f8fba0a05e86439b6324929bb5f7ec1a3f1d1b03d9c41971353e5ea35`。全文与 r3 的差异精确为三处：临时 root 创建后立即 resolve()；输出目录改 attempt-4；production 读取 isolated-attempt-4 proof。

root 在任何 runtime/state/env/plist/cache/ownership 路径派生前转为物理路径。macOS 的 /var→/private/var 别名因而在 baseline_target 与 clone.resolve() 两侧一致，不会把同一目录误判为越界。原 symlink target 相等及物理 containment 检查未删除，实际外部链接仍会被拒绝。label 来自未变的目录 basename；job target 仍为 gui/<uid>/<label>，没有再次覆盖。

资格、候选 installer mandatory checks、回滚身份断言、stop/job 不存在/端口释放及所有 production 保存保护逐字未变。production 仍要求对应 attempt-4 的隔离 PASS 和 cleanup，不会采用失败 attempt-3 proof。exist_ok=False 保留旧 attempt raw 并拒绝重写既有 attempt-4。

读取的 attempt-3 proof 实际为 FAIL、states 为空、cleanup NOT_RUN、productionDeploymentPerformed false。其 old root 实际 resolve 为 /private/var 对应路径，符合此次规范化原因。原失败 proof 未修改。本次没有复制、启动、运行 installer 或 tests，也未代替主代理执行现有 clone 的 corrected predicate 检查。r4 实际成功仍须新操作 proof。
