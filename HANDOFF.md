# HANDOFF

## 当前任务

继续 Java-only LSP/MCP V3.2 优化的 Sprint3：把 JavaIndex 的渐进就绪、快照持久化、后台扫描优先级和前台闭包优化收束为可复现证据。用户的硬约束是：**任何测试、构建、benchmark 或验证都必须与正在使用的 LSP 隔离**，不能接触活动 checkout、LSP、JDT、JavaIndex 缓存或 `node_modules`。

当前分支是 `codex/java-intelligence-v3`，`HEAD=d7f23d5 feat(v32): batch java index request hot paths`。Sprint2 已提交；Sprint3 仍是未提交的 dirty worktree。

## 已完成

- 已落地并接入回归测试的 Sprint3 实现：
  - JavaIndex snapshot 状态（`EMPTY/PENDING/DURABLE/FAILED`）、单写者 tail、dirty/durable revision、防止旧 writer 覆盖新 revision、完整 Java + MyBatis manifest 校验、own-snapshot 代际重写。
  - `close()` 两阶段语义：2.5s 仅限制调用方等待；到期只 `unref()`，不终止仍在 native parse/fsync/atomic rename 的 worker；收到安全 ACK 或确定 exit 后才终止。
  - 仅 A1 主锚点可通过 `REFRESH.priority=ACTIVE_ANCHOR` 提升后台 sweep；watcher / A2 / 普通 refresh 不会抢占。每个 sweep 最多一个 active root、一个额外重排 epoch，且不抢占已开始的 chunk。
  - 前台 anchor closure：有限 direct imports、一个优先 interface、冷态 exact-FQN conventional-path refresh 和有界实现类 discovery；失败只 fail-soft，不能产生权威负结论。
  - progressive-index benchmark/runner/verifier、三仓 scenario lock 和严格 complete/durable predicate。
  - 删除已无入口的 `src/benchmark-lsp-performance.ts`、`src/document-symbol-limiter.ts`、`src/util/jsonl.ts`；将仅测试使用的 `src/test-support/*` 改为 `*.test.ts`。这部分是 LOC 偿还，其中 test-support 是统计重分类，报告中不得包装为生产算法优化。

- 当前集成树已实际运行且通过的隔离验证：

  ```sh
  sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- \
    node --test --test-concurrency=1 \
    dist/java-index/java-index-client.test.js \
    dist/java-index/worker-protocol.test.js \
    dist/java-index/java-index-worker.test.js \
    dist/java-index/manifest.test.js \
    dist/java-index/router-java-index.test.js \
    dist/agent-router/anchor.test.js \
    dist/benchmark/java-index-idle.test.js \
    dist/benchmark/progressive-index.test.js \
    scripts/run-progressive-index.test.mjs \
    scripts/run-progressive-index-three-repo.test.mjs \
    scripts/verify-progressive-index.test.mjs
  ```

  结果：detached clone、私有缓存、`JDTLS_BIN=/usr/bin/false`，`executableTree=5e6d9fc05db830b866dbb78458ae9c1d5374cbde`，122/122 PASS，0 fail，15.832s。

- 已实际执行：`git diff --check` 通过；`node --check scripts/run-progressive-index*.mjs scripts/verify-progressive-index.mjs` 通过。
- 已保存的 Sprint3 quiet progressive baseline（15 次）：
  `/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-kmFwCH/sprint3-progressive-baseline/progressive-manifest.json`
  - lishuedu P95：open 772.320ms、anchor 13009.798ms、module 41005.065ms、complete 46993.824ms、durable 62476.572ms。
  - cipherlink：94.076ms、2023.015ms、2885.670ms、3452.069ms、4783.928ms。
  - exam-parent-v3：111.567ms、4764.640ms、5785.149ms、6921.872ms、9944.624ms。
  - 全部 pre-complete negative 非权威、post-complete negative 权威，semantic digest 稳定。

## 当前状态 / 卡点

- 工作树尚未提交，包含 36 个 tracked 文件的变更/删除和 Sprint3 新增的 progressive 脚本、测试、scenario lock、test-support 重命名文件。当前生产 LOC：33,060；V3.2 固定 cycle baseline 31,638、硬上限 33,219，因此只剩 159 LOC 余量，距最终目标仍高 1,422 LOC。下一会话不要增加生产 LOC，除非先给出等量或更多偿还。
- 当前 `git diff --stat` 为 1,332 insertions / 851 deletions（仅 tracked 部分）。大量 `artifacts/`、`.workflow/`、`.task30-debug.mjs` 未跟踪，是既有/并行产物，不在 Sprint3 范围；不要删除、覆盖、暂存或把它们当作当前证据。
- 尚未跑完整受影响回归、完整 isolated suite、当前候选的三仓 progressive run，也尚未跑 storm/quiet 500-file gate。故 Sprint3 不能宣称完成或性能 gate PASS。
- `runProgressiveIndex` 的 `T_complete` 与 `T_snapshot_durable` 是外部可观察的阶段：worker 在最后 chunk 内部几乎连续 complete+flush，当前 API 不能量出其内部间隔。报告必须说明这一边界，不能声称测得 worker 内部 rename 时延。
- 曾有一次直接 `npx tsc --noEmit` 误操作；无输出且未启动 LSP/JDT/JavaIndex，但违反隔离流程。它不计入任何验证结论，也不要重复。
- 当前没有活跃子代理或未整合 review 结果。

## 下一步计划

1. 先静态复核当前 dirty diff，特别是 `java-index-client.ts`/`java-index-worker.ts` 的 delayed CLOSE、late ACK/exit、snapshot revision/hydration 和 XML resource 变更；发现问题必须先用隔离 RED 再修。
2. 在隔离 clone 中跑扩大后的受影响回归（至少 `repo-runtime-manager`、`repo-change-coordinator`、`worktree-storm`、`worktree-identity`、`worktree-snapshot-seeder`、`router-integration`、`type-reference`、`relationship-provider`、`request-budget`、`jdtls-session`、`semantic-gateway`）。不得在活动 checkout 直接运行。
3. 运行当前 candidate 的三仓 quiet progressive runner，并用已有 baseline 做 source-locked 对比。建议命令（未运行）：

  ```sh
  sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --keep --profile targeted -- \
    node scripts/run-progressive-index-three-repo.mjs \
    --candidate-root . \
    --output-dir '{state}/sprint3-progressive-candidate' \
    --lishuedu /tmp/codex-java-v3-golden-20260809/lishuedu \
    --cipherlink /tmp/codex-java-v3-golden-20260809/cipherlink \
    --exam-parent-v3 /tmp/codex-java-v3-golden-20260809/exam-parent-v3
  ```

  然后用 `scripts/verify-progressive-index.mjs` 比较 baseline/candidate。正式规则：semantic digest 精确相等；anchor P95（旧值 >2s 时）候选 <=2s，否则 <=旧值×0.8；module P95 严格改善；complete P95 <=旧值×1.10；不使用 slack。
4. quiet candidate 证据通过后，新增并运行独立的 storm gate，而不是修改既有 quiet verifier：3 仓 × quiet/storm ×10 次、每次独立 detached clone/private cache；真实 watcher 对 500 个既存 Java 文件做 identical-byte burst rewrite；必须观察单 batch `changeCount===500` 和 generation 仅 +1。每仓硬门：`stormAnchorP95/quietAnchorP95 <= 1.10`、`staleCount=0`、完整 generation/coverage/durable/negative truth、quiet/storm digest 精确相等。当前该 gate 是 UNMEASURED。
5. 生成 Sprint3 LOC ledger、报告和 artifact receipt；报告必须区分“已运行”“未运行”“外部可观察但不可细分”。完成完整隔离回归和三仓证据后，才向用户申请 commit 授权；不得自行 commit/push。

## 绝对不要再踩的坑

- 不要在活动 checkout 直接执行 `npm run build`、`node dist/...`、`npx tsc`、任何 `node --test` 或三仓 benchmark。所有会启动 Node worker/JDT/JavaIndex 的命令必须包在 `sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs` 中，并保持 `JDTLS_BIN=/usr/bin/false`。
- 不要运行旧的 `benchmark:lsp-performance` 入口；它已删除的实现曾使用全局 cache 并递归删除 workspace。不要从陈旧 `dist/benchmark-lsp-performance.js` 运行任何内容。
- 不要把 close 的 grace 恢复成 deadline 触发 `terminate()`；这会在 native parser 或原子写中杀 worker。超时只可 `unref()` 并保留 late ACK/exit cleanup。
- 不要将 watcher refresh、A2 anchor 或多文件 refresh 标为 `ACTIVE_ANCHOR`。只有 `AgentRouter` 的第一个 A1 anchor 且单 changed/no deleted 能升级 root priority。
- 不要让 foreground rg discovery 的正向候选变成 negative 结论；它只可补充候选，必须 exact typeId re-query 后使用，timeout/partial/failure 一律 fail-soft。
- 不要把 `isJavaIndexQuiescent()` 当作 `T_complete`；它允许部分 degraded 状态。progressive complete 必须用 `isJavaIndexCompleteAt()`，durable 必须再验证实际 snapshot readback 和完整 manifest。
- 不要改变、删除或暂存未跟踪的历史 artifacts、`.workflow/`、`.task30-debug.mjs`。它们与当前 dirty Sprint3 不是同一所有权。
- 不要把 test-support 重命名导致的 LOC 下降写成生产代码删除；明确这是测试专用文件的统计归类。

## 关键文件 / 命令 / 验证

- Sprint3 核心：
  - `src/java-index/java-index-client.ts`：CLOSE 的 unref/late-ACK 清理。
  - `src/java-index/java-index-worker.ts`：snapshot revision、own hydration、XML manifest、background sweep priority。
  - `src/java-index/index-types.ts`、`src/java-index/worker-protocol.ts`：snapshot status 与 `ACTIVE_ANCHOR` 协议。
  - `src/java-index/router-java-index.ts`、`src/agent-router/anchor.ts`、`src/agent-router/index.ts`：A1 priority 和前台 closure。
  - `src/benchmark/java-index-idle.ts`、`src/benchmark/progressive-index.ts`、`golden/progressive-index-v1.json`。
  - `scripts/run-progressive-index.mjs`、`scripts/run-progressive-index-three-repo.mjs`、`scripts/verify-progressive-index.mjs`。
- 计划真源：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md`（V3.2-16/17/18，约 584–608 与 850–878 行）。
- 关键已运行验证及结果在“已完成”部分；不要把它们扩大解释为 full suite 或三仓 candidate PASS。
- 当前静态状态：`git diff --check` PASS；生产 inventory 为 `120 files / 1,329,579 bytes / 33,060 LOC / f1e9fcc55b3660ac3e72310b72da4f50e398f457f83bf9f86cc13f8d0ca8af50`。

## 给下一会话的第一步

先读本文件，再在当前工作树执行只读检查：

```sh
git status --short
git diff --check
git diff -- src/java-index/java-index-client.ts src/java-index/java-index-worker.ts src/java-index/router-java-index.ts src/agent-router/anchor.ts
```

确认没有并发写入后，先跑“已完成”中的 122-case 隔离定向套件以验证树未漂移；若通过，再按“下一步计划”第 2 步扩大回归。任何失败先保留 raw 输出、建立隔离 RED，再改代码。
