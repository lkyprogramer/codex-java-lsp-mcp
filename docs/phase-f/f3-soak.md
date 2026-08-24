# F3 soak

状态：**F3_SOAK_STARTED**（2026-08-24）。合并 commit `e48a253`。24–48h 观察未完成，计划不得记 COMPLETE。

## 回滚

正确性回归（quality 漂移或 crash）→ `git revert -m 1 e48a253`（单点回滚 merge），记 `F3_ROLLBACK`，回 `codex/jin-main` 修复后重走 F1。

未 push，本地回滚也可用 `git reset --hard` 到 merge 前的 `main`（`48e665b`），但只在未分享该 merge 时使用。

## 观察

- nightly profile 一轮（F2 已跑过 `gate:nightly`；soak 期内再跑一次）
- 真实负载：2–3 项目并行 + worktree 的 RSS / 休眠 / BUILD_SLOT
- 残差：O1 child RSS、O2 lishuedu 冷建、cipherlink holdout 0.55（已立项，holdout 不入目）
