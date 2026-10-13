# Native driver r2 review

**PASS。** 未发现阻断。新旧 driver 的全文差异精确等于两处替换，原资格、源码身份、隔离及生产配置保护逻辑均未改变。

r2 driver SHA-256：`4d8a7b01dcdbecaf94549caa4747b29018e51b727daa5954d70aef6d0f7a3127`。原 driver SHA-256：`2c126e4eb97865dff7a5e75083f7b3501ba42c8c21464c666597030ccf9ccc63`。

输出按 mode 分别写入 `isolated-attempt-2/` 和 `production-attempt-2/`；`mkdir(exist_ok=False)` 在已有目录时拒绝执行，因此不会覆盖首轮 raw，也不会重用第二轮既有输出。production 只读取 `isolated-attempt-2/isolated-proof.json`，仍要求 status PASS 和 STOPPED_JOB_ABSENT_PORTS_FREE；不会采用首轮 FAIL proof。terminal PASS、原 verifier、clean source、1843 文件 SHA、HEAD 及生产 current/plist/projects 未漂移、环境保留等断言逐字未变。

首轮 isolated-proof.json 实际为 FAIL，states 为空、cleanup NOT_RUN、productionDeploymentPerformed false；错误为依赖链接 `.bin/fxparser` 越出 node_modules。原 proof SHA `2cb4781deaa1f1b28c4734ffdf3cc53a9f4d0e0bc78533421519e7bd3d335a4c`，原失败 log SHA `42f5760541897a9e24d6a35309cacb2ae7ac2410a5a0fb8eb6e5e560c72f8c80`，均保留。

本次仅静态读审，没有运行 model、test、npm ci 或 installer。依赖重建由主代理报告；第二轮安装及回滚是否成功须由新的实际 proof 证明。
