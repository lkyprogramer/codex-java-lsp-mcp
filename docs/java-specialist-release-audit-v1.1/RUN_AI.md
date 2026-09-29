# 执行入口：从 b9c3cc3 到可审计的上线候选

你的角色是产品实现者，不是冻结标签维护者，也不是上线授权人。不要读完整历史方案后自行拼成另一条路线。

先阅读 `AGENTS.md` → `docs/01-audit-report.md` → `docs/02-requirements-matrix.md` → `docs/03-design-delta.md` → `docs/04-execution-master.md` → 当前任务卡。评测人员另读 `docs/05-test-protocol.md` 和原 `baseline-kit/docs/05-evaluation-protocol.md`。

## 第一次执行

```bash
export KIT=/absolute/java-specialist-release-audit-v1.1
export PROJECT=/absolute/codex-java-lsp-mcp
export RUNS=/absolute/java-specialist-audit-runs
mkdir -p "$RUNS"
cd "$KIT"
python tools/check_bundle.py
python -m unittest discover -s tests -v
python tools/run_audit.py --project "$PROJECT" --output "$RUNS/baseline-counterexamples"
```

b9c3cc3 最后一条预期 exit 1；记录 26 个反例失败，而不是删除测试。使用当前项目锁定 TypeScript，或显式 `TYPESCRIPT_JS=/absolute/typescript/lib/typescript.js`。本包使用 Python 标准库，不需要 pip；反例还需要 Node 22+，J01 需要 javac/java。环境缺失记 BLOCKED_ENV，不改测试预期。

在真实 git checkout 创建隔离 worktree/branch。不要 `npm ci` 正在被生产 release 使用的目录，不运行 install-runtime，不访问 38456 生产 MCP。若当前 HEAD 已变化，记录差异并重新跑反例；不要用 b9 行号直接 patch 新代码。没有业务仓库不阻塞本包独立数据测试。

## 每张任务卡的完成定义

保存当前源码失败证据 → 添加仓库内真实单测 → 修复最小根因 → 同输入 GREEN → 定向测试 → 原12探针/冻结自检 → 受影响运行态测试 → 生成任务报告 → 提交。一个 task 一个主机制，测试/文档随同提交。不得为了让 `M3=GO` 好看而调整原 0.8 QA floor、任务分母、gold 或换 locked 分组。

## 明确禁令

不把本文静态/离线反例说成真实模型 A/B；不把假模型 sentinel 当作产品效果；不把这份包内冻结修复 reference patch 用于被测 Agent。历史 raw 在本机目录但没有可交付文件时，状态为 SOURCE_REPORTED，不填 independently reproduced。

API key 存在不等于授权。真实付费或源码外发实验由用户再次明确其 provider、任务集、预算和权限后执行；无授权时提交 BLOCKED_AUTH 和可执行下一步，不虚构结果。关闭 optional experiment 不影响静态主产品的开发顺序。

最终必须提交 `templates/release-evidence.json` 的实测填充版，并运行 `tools/verify_release.py`。检查器只能判证据清单是否完整，不能证明一次模型运行真的发生；独立 reviewer 必须读原始轨迹。资格通过也不等于部署授权。
