# V4-03 Sprint0' 测量手册

身份：合流提交 `4323b3cfead3a368b5a81c880176841d162ceced`，生产树 `1be810da3cc7a2895e143be204542174367e0b30`。  
产物：原始文件写到 checkout **之外**；git 只入 `docs/phase-v4/v4-sprint0-manifest.json` 与摘要 JSON。  
校验：`scripts/verify-v4-sprint0-baseline.mjs` 拒绝任何 0 字节或 SHA-256 漂移。

## 冻结仓

三仓 HEAD 必须等于 `golden/progressive-index-v1.json`：

| 仓 | commit |
|---|---|
| lishuedu | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` |
| cipherlink | `fa433982e92e52dd610650d1e79f2d041179b1d3` |
| exam-parent-v3 | `f90a0b475f7be2ed003703feecec8195bc7eb976` |

本机已发现的工作副本（2026-08-17 核查；**只有 HEAD 匹配才能用**）：

| 路径 | HEAD | 可用？ |
|---|---|---|
| `/Users/luo/Documents/program/lishu/lishuedu` | `70cb67c1…`（脏工作区） | 否，需 frozen worktree |
| `/Users/luo/Documents/program/cipherlink` | `fa433982…`（干净） | 是，仍建议拷到 `/tmp` |
| `/Users/luo/Documents/program/exam-parent-v3` | `ff18689e…` | 否，需 frozen worktree |

优先使用已存在且 HEAD 对齐的 `/tmp/codex-java-v3-golden-20260809/<project>`（2026-08-17 核实：三仓干净、commit 完全匹配）。`/tmp/frozen-java-repos/` 不必再建。只有这些 frozen checkout 消失时才：

```sh
export PATH="/opt/homebrew/bin:$PATH"
git -C /Users/luo/Documents/program/lishu/lishuedu worktree add /tmp/frozen-java-repos/lishuedu db63b1a7e393edd90449eb013d7d1c4d65c366f2
git -C /Users/luo/Documents/program/cipherlink worktree add /tmp/frozen-java-repos/cipherlink fa433982e92e52dd610650d1e79f2d041179b1d3
git -C /Users/luo/Documents/program/exam-parent-v3 worktree add /tmp/frozen-java-repos/exam-parent-v3 f90a0b475f7be2ed003703feecec8195bc7eb976
```

## 前置

1. 可用内存 ≥ 4 GiB（`vm_stat` 的 free+inactive+purgeable；可用 `JAVA_LSP_MIN_AVAILABLE_BYTES` 覆盖）。
2. **三仓测试：1 分钟 load < 20 必须执行，不得因 load 阻断。** `load >= 20` 只记录。真源见 `docs/phase-v4/three-repo-host-load-policy.md`。禁止再用 load/核数 ≤0.7 拒绝三仓。
3. first-touch 还要求机器上没有其它 `org.eclipse.jdt.ls.core.id1`。
4. 不要在活动 checkout 跑 `npm test` / `tsc` / 裸 `node`。

## 命令

先看计划（不跑测量）：

```sh
export PATH="/opt/homebrew/bin:$PATH"
sh scripts/run-isolated-node.sh scripts/run-v4-sprint0-baseline.mjs \
  --dry-run \
  --output-dir /tmp/codex-java-lsp-v4-sprint0
```

主机安静后按阶段跑。三仓 matrix 的 runs **不要并行**：

```sh
sh scripts/run-isolated-node.sh scripts/run-v4-sprint0-baseline.mjs \
  --stage all \
  --output-dir /tmp/codex-java-lsp-v4-sprint0
```

跑完后把摘要拷进 `docs/phase-v4/`，再用 verifier 卡住 0 字节回归：

```sh
sh scripts/run-isolated-node.sh scripts/verify-v4-sprint0-baseline.mjs \
  --manifest docs/phase-v4/v4-sprint0-manifest.json
```
