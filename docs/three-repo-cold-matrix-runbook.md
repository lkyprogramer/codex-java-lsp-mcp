# 三仓 cold-nolsp 配对矩阵运行规范

`scripts/run-three-repo-cold-matrix.mjs` 是 Task 30 及后续影响候选排序、ReadPlan 或框架证据改动的唯一正式三仓门禁入口。它运行 lishuedu、cipherlink、exam-parent-v3 的 AB/BA/AB 矩阵，并将 old/new 绑定到同一份冻结 golden 场景。

## 不变量

- 基线必须是已批准且为候选 `HEAD` 祖先的 Git SHA；候选是 `--candidate-root` 的 `HEAD + 全部已跟踪改动（含 staged/unstaged diff）+ runner 白名单内的未跟踪运行时输入`。这些未跟踪输入会复制到 `candidate-untracked/` 并绑定 SHA-256；白名单外未跟踪文件不会进入候选，也不能作为测试结论依据。
- 场景从候选 worktree 拷贝到产物目录的 `frozen-scenarios/`，old/new 都通过 `--scenarios <同一绝对路径>` 使用它。禁止依赖各 worktree 的默认 `golden/` 路径。
- 运行固定为 `cold-nolsp`、`impact`、`standard`、3 轮 AB/BA/AB、每 cell 5 runs。脚本拒绝非 5-run 的正式门禁。
- 所有编译、测试和 benchmark 都在临时 candidate/baseline worktree 执行，依赖先复制到私有 `node_modules` 并在运行前后核对内容摘要；强制 `JDTLS_BIN=/usr/bin/false`、`JAVA_LSP_SHADOW_RANKING=0`，并将 `JAVA_LSP_CACHE_ROOT` 指向临时目录；不会复用、停止或改写调用者正在运行的 LSP 或其缓存。
- 原始 18 份 JSON、每 cell stderr、候选 patch、场景 SHA-256、运行台账和汇总都保存在新建 output 目录。默认清理临时 worktree/cache；`--keep-worktrees` 仅用于调试。

## 前置条件

1. 当前候选根目录已有 `node_modules`。
2. 三个 golden 仓库可本地读取，且其提交在一次矩阵期间保持不变。
3. 选定的 `--baseline` 是本轮报告指定的 before，而不是随意的旧 SHA。
4. output 目录必须不存在，其直接父目录必须已存在，并且 canonical 路径必须位于 candidate checkout 外；脚本不会覆盖旧产物，也不会把验证产物写回在线源码 checkout。
5. **主机 load：1 分钟 load average < 20 必须开跑，不得因 load 拒绝。** 详见 `docs/phase-v4/three-repo-host-load-policy.md`。不要用 per-CPU 0.7 或“等主机安静”阻断本矩阵。`load >= 20` 只写入 `run-manifest.json` 的 `hostLoad`，脚本继续执行。

不要使用 `npm run build`、`npm test` 或裸 `node` 作为门禁证据。正式入口先通过
`scripts/run-isolated-node.sh` 清除宿主 Node loader/output 变量，再由 detached isolation broker
直接调用 `node_modules/.bin/tsc`、`node --test` 和 benchmark 入口。

## 日常使用规范

1. 每次影响候选排序、ReadPlan、框架 evidence 或 JavaIndex 路径的提交，先选择该提交前已批准的祖先 SHA 作为 `--baseline`；不要把不同分支或历史矩阵随意拼接。
2. 运行前执行 `git status --short`。允许本轮已跟踪的 staged/unstaged 改动，脚本会写入 `candidate.patch`；若有未跟踪的运行时输入，先纳入 Git 或移出输入目录。
3. 同一 output 目录只对应一次矩阵；修复后创建新的 output 目录重新跑完整 18 cells，不能将新旧 cell 混用。
4. 非零退出必须阻断“通过”结论：退出码 `1` 表示结构完整但至少一项质量/P95 门禁失败；退出码 `2` 表示前置条件、构建、测试、benchmark 或产物格式失败。
5. 只以该次 `matrix-summary.json`、`run-manifest.json` 和原始 cell JSON 作为报告证据。历史默认 golden 路径不一致的矩阵只可诊断，不可作为正式 gate。

## 正式运行示例

```zsh
cd /Users/luo/Documents/github/codex-java-lsp-mcp

sh scripts/run-isolated-node.sh scripts/run-three-repo-cold-matrix.mjs \
  --baseline 652e9765ff3691214116782b383ce9d3ffa7c6ef \
  --lishuedu /tmp/frozen-java-repos/lishuedu \
  --cipherlink /tmp/frozen-java-repos/cipherlink \
  --exam-parent-v3 /tmp/frozen-java-repos/exam-parent-v3 \
  --output-dir /tmp/codex-java-lsp-matrix-<run-id>
```

也可用环境变量缩短仓库参数（正式证据仍须经 shell bootstrap 启动 Node）：

```zsh
export LISHUEDU_ROOT=/tmp/frozen-java-repos/lishuedu
export CIPHERLINK_ROOT=/tmp/frozen-java-repos/cipherlink
export EXAM_PARENT_V3_ROOT=/tmp/frozen-java-repos/exam-parent-v3

sh scripts/run-isolated-node.sh scripts/run-three-repo-cold-matrix.mjs \
  --baseline 652e9765ff3691214116782b383ce9d3ffa7c6ef \
  --output-dir /tmp/codex-java-lsp-matrix-<run-id>
```

成功时输出目录包含：

```text
run-manifest.json
candidate.patch
candidate.patch.sha256
candidate-tests/dist.tap
candidate-tests/dist.stderr
candidate-tests/scripts.tap
candidate-tests/scripts.stderr
frozen-scenarios/<project>.scenarios.jsonl
frozen-scenarios.sha256
matrix/<project>-r<1|2|3>-<old|new>.json
matrix/<project>-r<1|2|3>-<old|new>.json.stderr
matrix-summary.json
```

## 复验已有矩阵

对已有矩阵只做结构和门禁复验，不重新执行仓库：

```zsh
sh scripts/run-isolated-node.sh scripts/verify-three-repo-cold-matrix.mjs \
  --matrix-dir /tmp/codex-java-lsp-matrix-<run-id>/matrix \
  --expected-runs 5 \
  --p95-limit 1.25
```

校验器要求完整 18 cells，并检查每个 cell 的 `projectId`、`cold-nolsp`、`impact`、`standard`、5 attempts/场景，以及同项目 old/new 的 `scenarioFile` 完全一致；同时校验 candidate TAP/stderr 的 bytes、SHA-256、测试/通过/失败/取消摘要，以及私有依赖树 inventory 合同。该复验验证已记录证据的完整性，不会重新执行测试或矩阵。

## 通过条件与失败处理

每个项目独立满足全部条件才算通过：

| 门禁 | 条件 |
|---|---|
| Must 读取 | 每个 candidate attempt 的 `R_read_must = 1.0000` |
| 候选质量 | candidate recall 不低于 old |
| 读取质量 | candidate `P_read` 不低于 old |
| 延迟 | `P95(candidate) <= max(1.25 × P95(old), P95(old) + 50ms)` |

P95 以每个项目三个 round 的所有 scenario attempts 汇合后，按 `ceil(n × 0.95) - 1` 计算。`50ms` 绝对 slack 避免极低基线被调度噪声放大；它不能替代比例门，也不能用总平均、单个 scenario、绝对 300ms 阈值或 shadow 数据代替正式 P95。

若脚本返回非零：保留 output 原始 JSON 和 `matrix-summary.json`，先检查 `goldenAttribution` 中的 `absent` / `readplan-full` 和相关 timing，再做通用事实、排序或预算修复。不得用仓库名、路径名、文件名或 golden 项添加定制规则；修复后必须重新运行完整矩阵。
