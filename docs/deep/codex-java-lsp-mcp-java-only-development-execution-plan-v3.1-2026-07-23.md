# codex-java-lsp-mcp Java-only V3.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `codex-java-lsp-mcp` 改造成一个 Java-only、结果可信、增量新鲜、AST 驱动、JDT 精确增强、token-aware、支持同一 Git family 多 worktree 并发且可由真实 golden 持续验证的 Agent Code Intelligence 引擎。

**Architecture:** canonical worktree root 是正确性边界，每个 worktree 独立拥有 generation、watcher、JavaIndex worker、JDT workspace、query cache 和 semantic edges；Git common-dir family 只用于文件系统 lease、validated sibling snapshot seed 和 background sweep 节流。MCP 请求进入 RepoRuntime 时固定 generation、freshness policy 和绝对 deadline；Tree-sitter JavaIndex 提供静态事实，JDT LS 作为按需 exact semantic gateway；所有 provider 只产出 EvidenceSignal，随后经家族饱和排序与 byte/token 受限 readPlan planner 输出。

**Tech Stack:** Node.js >=22、TypeScript 5.x、MCP SDK、`tree-sitter@0.25.0`、`tree-sitter-java@0.23.5`、`chokidar@5.0.0`、`fast-xml-parser@5.10.1`、Eclipse JDT LS、Node built-in test runner。

> **V3.1 Review integration:** 本计划已直接吸收 `codex-java-lsp-mcp-v3-plans-review-2026-07-23.md` 中经核实成立的 A-1～A-5、E-1～E-6 与 W-1～W-6。Review 原始 W-1 的“枚举 lease 数后创建 repoHash 文件”存在跨进程 check-then-act 风险，本计划改为固定编号 global slot + same-worktree exclusive lease；W-2 增加 manifest-only 内容验证，禁止未验证 sibling facts 进入查询。

## Global Constraints

- 永久 Java-only；不得引入 language abstraction、language registry 或多语言插件接口。
- 项目仅支持 macOS；不增加 Linux/Windows CI。
- 允许破坏性重构；旧 cache schema、内部 API、MCP result schema 不需要 migration。
- 不引入 SQLite、DuckDB、Neo4j、向量数据库或远程服务。
- 不引入 embedding、LLM rerank、RL/在线学习或通用自然语言图查询。
- public MCP tools 不增加；工具合并只能在 Task 31 的 schema-token 数据支持后执行。
- 默认结果中不得出现 repo 外绝对路径、raw URI、raw JDT range 或 debug score dump。
- partial/timeout/cancelled 结果不得写入 complete cache。
- unknown/degraded index coverage 不得解释为“仓库中不存在”。
- 所有 repo-scoped cache 必须包含统一 generation 或等价依赖 fingerprint。
- canonical worktree root 是 facts/cache/JDT 正确性身份；`familyHash` 只用于 lease、seed discovery 和后台节流。
- 不共享 mutable JavaIndex、generation、negative cache、JDT workspace、open document 或 semantic in-flight。
- 跨进程协调只允许小型文件系统 lease；不得引入 daemon、socket service、数据库锁或共享内存索引。
- sibling snapshot 只有 `relativePath + contentHash` 完全匹配的 facts 可 seed；target coverage 在 reconcile 前保持 DEGRADED。
- machine-level JDT STARTING+READY 不能超过 `JAVA_LSP_MAX_ACTIVE_REPOS`，同 worktree 不能启动第二个 JDT child。
- `worktree-cache-cleanup.ts` 必须保留并升级；fast-only 活跃 runtime 不得被 janitor 删除。
- 每个任务必须先建立失败测试，再实施最小改动，再运行相关测试和全量测试。
- 每个任务独立 commit；一个 commit 只承载一个可审阅语义变更。
- 每个迭代结束生成 phase report，包含基线、命令、原始 JSON、结果、限制和最终决策。
- 任何真实仓库 benchmark 结论至少 runs=5，并报告 P50/P95。
- 三仓 `R_read_must=1.0000` 是不可牺牲的硬门槛。

---

# 1. 如何使用本计划

## 1.1 基线差异必须先处理

附件 Claude Review 核查的是本地 `main` HEAD `af51bc7`，并报告：

```text
npm run build    PASS
npm test         124 tests / 120 pass / 4 skipped / 0 fail
```

该 Review 还表明 phase 4～12 已包含 edge store、import graph、evidence budget、agent-router 拆分和 repo policy 拆分。

本次会话可读取的源码压缩包接近较早的 2026-07-02 版本，因此任何 Agent 开发前必须执行 Task 0。不得根据旧压缩包中 `agent-router/index.ts` 的结构，覆盖当前 HEAD 已拆分的实现。

## 1.2 执行单位

本计划分为五个可独立验收的功能迭代，以及一个只负责删除旧路径和最终验证的收敛迭代：

| 迭代 | 目标 | 可以单独发布 |
|---|---|---|
| A | 正确性封口 | 是 |
| B | 新鲜度、generation、跨进程 worktree lease、storm 与 janitor | 是 |
| C | JavaIndex V2、generation rebase 与 sibling snapshot seeding | 是，完成后删除 V1 |
| D | 识别与 token 优化 | 是 |
| E | warm-required 首触 | 是，也允许决定不默认化 |
| F | 删除迁移残留、全矩阵验证和最终报告 | 否；这是 V3 收敛门禁 |

不得并行实施存在依赖关系的迭代。迭代内部只有在任务明确声明“可并行”时才允许并行。

## 1.3 每个任务的固定执行循环

```text
阅读任务接口
→ 写失败测试
→ 运行并确认预期失败
→ 写最小实现
→ 运行定向测试
→ 运行 npm run build
→ 运行 npm test
→ 检查 git diff
→ commit
```

禁止在一个任务中顺手重构无关模块。

## 1.4 基准结果的比较规则

若当前业务 repo commit 与 Review 中 phase 12 相同，可用以下历史数值作为额外 gate：

```text
recall:  0.8456 / 0.8643 / 0.7350
P_read:  0.8667 / 0.7000 / 0.6333
```

若 commit 不同，则先重跑 Task 0 baseline，后续只比较同 commit、同 golden、同机器的 before/after。

---

# 2. 目标文件结构

Task 0 必须先映射当前 HEAD；如果当前已有同职责模块，使用 `git mv` 或直接替换，不得制造同义重复文件。最终目标结构如下：

```text
src/
├── server.ts
├── agent-types.ts                       # 迁移期；Task 31 后改为强类型导出入口
├── runtime/
│   ├── completion.ts                    # COMPLETE/PARTIAL/CANCELLED/FAILED
│   ├── deadline-budget.ts               # 请求级绝对 deadline
│   ├── intelligence-error.ts            # 错误分类
│   └── request-context.ts               # requestId/repo/generation/budget
├── repo-generation.ts                   # 单调 generation clock + snapshot rebase
├── repo-change-coordinator.ts            # JDT-independent watcher + pending/storm queue
├── worktree-identity.ts                  # canonical root / common-dir / familyHash
├── cross-process-lease.ts                # runtime/JDT/sweep filesystem leases
├── worktree-cache-cleanup.ts             # 保留；owner/runtime/JDT 活性保护
├── repo-runtime-manager.ts               # runtime 生命周期与进程内/跨进程 admission
├── repo-resolver.ts
├── alias-registry.ts
├── layout-probe.ts
├── search/
│   ├── search-types.ts
│   ├── rg-runner.ts                      # streaming rg --json
│   └── rg-cache.ts                       # complete-only generation cache
├── jdtls-transport.ts                    # child/JSON-RPC factory，便于故障注入
├── jdt-restart-backoff.ts                # lifecycle-owned retry cooldown/config block
├── jdtls-session.ts                      # 五态生命周期
├── semantic-gateway.ts                   # deadline/singleflight/normalization
├── semantic-edge-store.ts                # complete-only persisted JDT exact edges
├── document-lru.ts                       # didOpen/didChange/didClose
├── java-index/
│   ├── index-types.ts
│   ├── worker-protocol.ts
│   ├── java-index-client.ts
│   ├── java-index-worker.ts
│   ├── java-parser-backend.ts             # Task 14 只保留 native 或 WASM 单实现
│   ├── ast-extractor.ts
│   ├── name-resolver.ts
│   ├── edge-builder.ts
│   ├── index-store.ts
│   ├── manifest.ts
│   ├── stable-id.ts                      # root-independent file/type/method IDs
│   ├── parse-tree-cache.ts               # bounded incremental Tree-sitter LRU
│   ├── worktree-snapshot-seeder.ts       # manifest-validated sibling seed
│   ├── coverage.ts
│   └── snapshot.ts
├── agent-router/
│   ├── index.ts                          # 仅编排，不承载 provider 细节
│   ├── evidence.ts
│   ├── evidence-normalizer.ts
│   ├── family-ranker.ts
│   ├── reference-ranking.ts
│   ├── read-plan.ts
│   ├── output-v6.ts
│   ├── providers/
│   │   ├── static-provider.ts
│   │   ├── lexical-provider.ts
│   │   ├── semantic-provider.ts
│   │   └── support-provider.ts
│   └── framework/
│       ├── adapter.ts
│       ├── spring.ts
│       ├── mybatis.ts
│       ├── jpa.ts
│       ├── mapstruct.ts
│       └── lombok.ts
├── tools/
│   ├── impact.ts
│   ├── status.ts
│   ├── symbol.ts
│   ├── references.ts
│   ├── diagnostics.ts
│   ├── restart.ts
│   └── shutdown.ts
├── benchmark-agent-impact.ts
└── benchmark/
    ├── attribution-v3.ts
    ├── matrix-runner.ts
    └── phase-report.ts
```

测试文件与实现同目录，命名 `<name>.test.ts`。复杂 Java fixtures 放入：

```text
fixtures/java-index-v2/
fixtures/framework-spring/
fixtures/framework-mybatis/
fixtures/framework-jpa/
fixtures/framework-mapstruct/
fixtures/framework-lombok/
```

## 2.1 迁移后删除清单

完成 Iteration C 并通过 gate 后删除：

- 旧 regex `parseJavaSource` 主实现；
- `source-index.files.jsonl` / `source-index.symbols.jsonl` 持久化代码；
- 同步 compact；
- request-path `spawnSync("rg")` fallback；
- 与 JavaIndex V2 重复的旧 type lookup map；
- 旧 edge store snapshot schema（仅在 Task 33 已把 COMPLETE JDT exact edges 迁移到 `SemanticEdgeStoreV2` 后删除）；
- V1/V2 双写；
- 迁移开关。

regex 只允许保留为灾难降级下的最小 anchor token fallback，不再作为结构事实来源。

明确保留并升级：

- `worktree-cache-cleanup.ts`；
- per-worktree cacheRoot 布局；
- Git common-dir enablement 继承；
- 每 worktree 独立 JDT `-data` workspace。

---

# 3. 统一类型契约

后续任务必须复用以下名称，不得自行创建同义类型。

## 3.1 Completion

```ts
// src/runtime/completion.ts
export type Completion =
  | "COMPLETE"
  | "PARTIAL_TIMEOUT"
  | "PARTIAL_LIMIT"
  | "CANCELLED"
  | "FAILED";

export function isCacheableCompletion(value: Completion): boolean {
  return value === "COMPLETE";
}
```

## 3.2 JavaIntelligenceError

```ts
// src/runtime/intelligence-error.ts
export type JavaIntelligenceErrorCode =
  | "DEADLINE_EXCEEDED"
  | "CANCELLED"
  | "JDT_NOT_READY"
  | "JDT_BROKEN"
  | "JDT_BACKOFF"
  | "JDT_BUSY_OTHER_SESSION"
  | "JDT_ORPHANED"
  | "JDT_CONFIG_ERROR"
  | "LEASE_CONFIG_ERROR"
  | "JDT_SERVER_ERROR"
  | "SEARCH_TIMEOUT"
  | "SEARCH_FAILED"
  | "INDEX_PARTIAL"
  | "INDEX_CORRUPT"
  | "OUTSIDE_REPO"
  | "INVALID_INPUT";

export class JavaIntelligenceError extends Error {
  constructor(
    readonly code: JavaIntelligenceErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message, { cause });
    this.name = "JavaIntelligenceError";
  }
}
```

## 3.3 DeadlineBudget

```ts
// src/runtime/deadline-budget.ts
export type MonotonicNow = () => number;

export class DeadlineBudget {
  private constructor(
    readonly deadlineAtMs: number,
    private readonly now: MonotonicNow
  ) {}

  static fromTimeout(timeoutMs: number, now: MonotonicNow = () => performance.now()): DeadlineBudget {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new JavaIntelligenceError("INVALID_INPUT", "timeoutMs must be positive");
    }
    return new DeadlineBudget(now() + timeoutMs, now);
  }

  remainingMs(capMs = Number.MAX_SAFE_INTEGER): number {
    return Math.max(0, Math.min(capMs, Math.ceil(this.deadlineAtMs - this.now())));
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  throwIfExpired(stage: string): void {
    if (this.expired()) {
      throw new JavaIntelligenceError("DEADLINE_EXCEEDED", `Deadline exceeded before ${stage}`);
    }
  }
}
```

Task 1 会补齐 `race()` 和测试。

## 3.4 RequestContext

```ts
// src/runtime/request-context.ts
export type RequestFreshnessMode =
  | "NORMAL"
  | "WATCHER_NOT_READY"
  | "WATCHER_DEGRADED"
  | "RECONCILING";

export type RequestContext = {
  requestId: string;
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  generation: number;
  freshnessMode: RequestFreshnessMode;
  cacheReadAllowed: boolean;
  cacheWriteAllowed: boolean;
  negativeLookupAllowed: boolean;
  mode: "minimal" | "balanced" | "precision" | "recall";
  budget: DeadlineBudget;
  startedAtMs: number;
};
```

## 3.5 SourceRange

```ts
// src/runtime/source-range.ts
export type SourcePosition = { line: number; column: number };
export type SourceRange = { start: SourcePosition; end: SourcePosition };
```

所有持久化和跨模块 range 统一使用 **1-based line、1-based UTF-16 code-unit column、end exclusive**。Tree-sitter 的 UTF-8 byte offset/byte column 只存在于 worker 内部的 parser/edit 层，必须通过 `Utf8Source.positionAtByteOffset()` 转成该统一坐标后才能写入 facts。LSP 边界只做 `line - 1 / column - 1`；不得把 Tree-sitter byte column 直接传给 JDT LS。

---

# 4. Task 0：当前 HEAD 基线对齐

**Files:**
- Create: `docs/phase-v3/phase0-current-baseline.md`
- Create: `artifacts/v3-baseline/.gitkeep`
- Inspect: `src/**/*.ts`
- Inspect: `docs/**/*.md`
- Inspect: `golden/*.jsonl`
- Inspect: `package.json`

**Interfaces:**
- Consumes: 当前 checkout、真实业务 repo 路径、附件 Review 中的预期能力。
- Produces: 当前源码映射、测试基线、benchmark 原始 JSON、P0 复现清单，供所有后续任务使用。

- [ ] **Step 1: 确认工作区与 commit**

Run:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -20 --oneline
```

Expected:

- 工作区为空；若不为空，先提交、stash 或使用独立 worktree。
- 记录实际 HEAD；`af51bc7` 只是 Review 历史基线，不是强制值。

- [ ] **Step 2: 建立隔离分支或 worktree**

Run:

```bash
git switch -c codex/java-intelligence-v3
```

若分支已存在，使用新的 worktree 名称，不复用有未提交改动的目录。

- [ ] **Step 3: 安装并验证当前基线**

Run:

```bash
npm ci
npm run build
npm test
```

Expected:

- build exit 0；
- tests 0 fail；
- 将 tests/pass/skip/fail 数写入 phase0 report。

若当前基线失败，停止 V3 改造，先按系统化调试修复基线。不得把已有失败算到 V3 任务中。

- [ ] **Step 4: 映射 Review 提到的模块**

Run:

```bash
find src -maxdepth 4 -type f | sort > /tmp/v3-source-files.txt
rg -n "locationCandidate|semanticVerify|runRg|rgSummary|readPlan|Evidence|edge store|EdgeStore|generation|ensureStarted|initialize\(" src
```

在 `phase0-current-baseline.md` 中创建 `Current Source Map` 表。表的每一行必须引用上述 `rg` 输出中的实际文件、symbol 和行号，不允许照抄旧源码路径。搜索矩阵如下：

```markdown
| Concept | Required search expression |
|---|---|
| JDT lifecycle | `ensureStarted|startTransactional|initialize` |
| semantic provider | `semanticVerify|SemanticProvider|references` |
| rg executor/cache | `runRg|rgSummary|RgCache` |
| readPlan budget | `readPlan|evidence budget|ReadPlan` |
| edge store | `EdgeStore|persisted edge` |
| import graph | `ImportGraph|IMPORTS` |
| routing policy resolver | `resolveRoutingPolicy|RoutingPolicy` |
| repo watcher | `FileWatcher|RepoChangeCoordinator|watch\(` |
| worktree identity/cleanup | `git-common-dir|repoHash|repo-meta|worktree-cache-cleanup` |
| process-local admission | `maxActiveRepos|reserveLspSlot|lspReservation` |
```

For each concept, the report row has columns `Concept / Current file / Current symbol / Line / Review status`. If a concept is absent, write `ABSENT` and attach the exact no-match command; do not guess a replacement path.

- [ ] **Step 5: 逐条确认 P0 断言仍可复现**

使用源码阅读记录下列问题是否仍存在：

```text
C-01 initialize 前伪 READY
C-02 start failure 残留 process/connection
C-03 fast path 无统一 generation
C-04 timeout partial 被 cache
C-05 outside-repo location 输出
C-06 STARTING 不计 active slot
C-07 子阶段独立 timeout，无绝对 deadline
W-BASE cache/JDT workspace 是否按 worktree root 隔离、active limit 是否只在进程内、janitor 是否只看 jdtlsPid
```

每项记录 `confirmed / fixed / changed`，并附当前 symbol，不使用旧 line number。

- [ ] **Step 6: 运行真实仓库 cold baseline**

先设置：

```bash
export LISHUEDU_ROOT=/absolute/path/to/lishuedu
export CIPHERLINK_ROOT=/absolute/path/to/cipherlink
export EXAM_PARENT_ROOT=/absolute/path/to/exam-parent-v3
mkdir -p artifacts/v3-baseline/$(git rev-parse --short=12 HEAD)
```

对每仓 runs=5：

```bash
node dist/benchmark-agent-impact.js \
  --repo-root "$LISHUEDU_ROOT" \
  --project-id lishuedu \
  --warm-state cold-nolsp \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > "artifacts/v3-baseline/$(git rev-parse --short=12 HEAD)/lishuedu-cold.json"

node dist/benchmark-agent-impact.js \
  --repo-root "$CIPHERLINK_ROOT" \
  --project-id cipherlink \
  --warm-state cold-nolsp \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > "artifacts/v3-baseline/$(git rev-parse --short=12 HEAD)/cipherlink-cold.json"

node dist/benchmark-agent-impact.js \
  --repo-root "$EXAM_PARENT_ROOT" \
  --project-id exam-parent-v3 \
  --warm-state cold-nolsp \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > "artifacts/v3-baseline/$(git rev-parse --short=12 HEAD)/exam-cold.json"
```

Expected:

- 每条命令 exit 0；
- stderr 无未知错误；
- 每仓 `R_read_must=1.0000`；
- 报告实际 recall、P_read、payload、P50/P95。

真实仓库不可用时，在 report 中明确写“未执行”，后续所有质量 gate 只基于可执行的 fixture，禁止引用历史数字声称通过。

- [ ] **Step 7: 建立 phase0 report**

`docs/phase-v3/phase0-current-baseline.md` 必须包含：

```markdown
# V3 Phase 0 Current Baseline

## Runtime
- commit:
- branch:
- macOS:
- CPU/RAM:
- Node:
- Java:
- JDT LS:

## Build/Test

## Current Source Map

## P0 Recheck

## Cold Benchmark

## Existing Phase 4-12 Capabilities

## Baseline Limitations
```

- [ ] **Step 8: 提交纯基线产物**

Run:

```bash
git add docs/phase-v3/phase0-current-baseline.md artifacts/v3-baseline
git commit -m "docs(v3): freeze current architecture and benchmark baseline"
```

Expected: commit 只包含文档和 benchmark artifacts，不改生产代码。

---

# Iteration A：正确性封口

Iteration A 的所有任务完成前，不允许开始 AST 索引或 ranking 改造。


## Task 1：统一 Completion、DeadlineBudget 与错误分类

**Files:**
- Create: `src/runtime/completion.ts`
- Create: `src/runtime/deadline-budget.ts`
- Create: `src/runtime/intelligence-error.ts`
- Create: `src/runtime/request-context.ts`
- Create: `src/runtime/source-range.ts`
- Test: `src/runtime/completion.test.ts`
- Test: `src/runtime/deadline-budget.test.ts`
- Modify: `src/tools/impact.ts`
- Modify: `src/agent-types.ts`

**Interfaces:**
- Consumes: `performance.now()`、现有 tool handler。
- Produces:
  - `Completion`
  - `isCacheableCompletion(Completion): boolean`
  - `JavaIntelligenceError`
  - `DeadlineBudget.fromTimeout(timeoutMs, now?)`
  - `DeadlineBudget.remainingMs(capMs?)`
  - `DeadlineBudget.race(stage, operation, capMs?, onTimeout?)`
  - `RequestContext`

- [ ] **Step 1: 写 Completion 单元测试**

Create `src/runtime/completion.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isCacheableCompletion } from "./completion.js";

test("only COMPLETE results are cacheable", () => {
  assert.equal(isCacheableCompletion("COMPLETE"), true);
  assert.equal(isCacheableCompletion("PARTIAL_TIMEOUT"), false);
  assert.equal(isCacheableCompletion("PARTIAL_LIMIT"), false);
  assert.equal(isCacheableCompletion("CANCELLED"), false);
  assert.equal(isCacheableCompletion("FAILED"), false);
});
```

Run:

```bash
npm run build
```

Expected: FAIL because `completion.ts` does not exist.

- [ ] **Step 2: 实现 Completion**

Create `src/runtime/completion.ts` exactly as defined in §3.1.

Run:

```bash
npm run build && node --test dist/runtime/completion.test.js
```

Expected: PASS.

- [ ] **Step 3: 写 DeadlineBudget 失败测试**

Create `src/runtime/deadline-budget.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineBudget } from "./deadline-budget.js";
import { JavaIntelligenceError } from "./intelligence-error.js";

test("DeadlineBudget clamps each stage to the absolute remaining budget", () => {
  let now = 100;
  const budget = DeadlineBudget.fromTimeout(1000, () => now);
  assert.equal(budget.remainingMs(), 1000);
  assert.equal(budget.remainingMs(200), 200);
  now = 950;
  assert.equal(budget.remainingMs(), 150);
  assert.equal(budget.remainingMs(200), 150);
  now = 1100;
  assert.equal(budget.remainingMs(), 0);
  assert.equal(budget.expired(), true);
});

test("DeadlineBudget rejects expired stages with a classified error", () => {
  let now = 0;
  const budget = DeadlineBudget.fromTimeout(10, () => now);
  now = 11;
  assert.throws(
    () => budget.throwIfExpired("semantic.references"),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
      && /semantic\.references/.test(error.message)
  );
});

test("DeadlineBudget.race calls timeout cleanup", async () => {
  let cleaned = 0;
  const budget = DeadlineBudget.fromTimeout(10);
  await assert.rejects(
    () => budget.race(
      "slow-stage",
      new Promise<void>(() => undefined),
      1000,
      () => { cleaned += 1; }
    ),
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
  );
  assert.equal(cleaned, 1);
});
```

Run:

```bash
npm run build
```

Expected: FAIL due missing classes/methods.

- [ ] **Step 4: 实现 JavaIntelligenceError 与 DeadlineBudget**

Create `src/runtime/intelligence-error.ts` as defined in §3.2.

Create `src/runtime/deadline-budget.ts`:

```ts
import { performance } from "node:perf_hooks";
import { JavaIntelligenceError } from "./intelligence-error.js";

export type MonotonicNow = () => number;

export class DeadlineBudget {
  private constructor(
    readonly deadlineAtMs: number,
    private readonly now: MonotonicNow
  ) {}

  static fromTimeout(
    timeoutMs: number,
    now: MonotonicNow = () => performance.now()
  ): DeadlineBudget {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new JavaIntelligenceError("INVALID_INPUT", "timeoutMs must be positive");
    }
    return new DeadlineBudget(now() + timeoutMs, now);
  }

  remainingMs(capMs = Number.MAX_SAFE_INTEGER): number {
    return Math.max(0, Math.min(capMs, Math.ceil(this.deadlineAtMs - this.now())));
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  throwIfExpired(stage: string): void {
    if (this.expired()) {
      throw new JavaIntelligenceError(
        "DEADLINE_EXCEEDED",
        `Deadline exceeded before ${stage}`
      );
    }
  }

  async race<T>(
    stage: string,
    operation: Promise<T>,
    capMs = Number.MAX_SAFE_INTEGER,
    onTimeout?: () => void
  ): Promise<T> {
    const timeoutMs = this.remainingMs(capMs);
    if (timeoutMs <= 0) {
      onTimeout?.();
      throw new JavaIntelligenceError(
        "DEADLINE_EXCEEDED",
        `Deadline exceeded before ${stage}`
      );
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new JavaIntelligenceError(
          "DEADLINE_EXCEEDED",
          `Deadline exceeded during ${stage} after ${timeoutMs}ms`
        ));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 5: 创建 SourceRange、RequestContext 与 deadline default 函数**

Create `src/runtime/source-range.ts` exactly as defined in §3.5, then create `src/runtime/request-context.ts`:

```ts
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DeadlineBudget } from "./deadline-budget.js";

export type RequestMode = "minimal" | "balanced" | "precision" | "recall";
export type SemanticPolicy = "fast" | "auto" | "required";

export type RequestContext = {
  requestId: string;
  repoRoot: string;
  repoHash: string;
  generation: number;
  mode: RequestMode;
  budget: DeadlineBudget;
  startedAtMs: number;
};

export function defaultDeadlineMs(mode: RequestMode, policy: SemanticPolicy): number {
  if (policy === "required") return 5000;
  if (policy === "auto") return 3000;
  if (mode === "minimal") return 1500;
  return 2000;
}

export function createRequestContext(input: {
  repoRoot: string;
  repoHash: string;
  generation: number;
  mode: RequestMode;
  semanticPolicy: SemanticPolicy;
  deadlineMs?: number;
}): RequestContext {
  const deadlineMs = Math.min(
    15000,
    input.deadlineMs ?? defaultDeadlineMs(input.mode, input.semanticPolicy)
  );
  return {
    requestId: randomUUID(),
    repoRoot: input.repoRoot,
    repoHash: input.repoHash,
    generation: input.generation,
    mode: input.mode,
    budget: DeadlineBudget.fromTimeout(deadlineMs),
    startedAtMs: performance.now()
  };
}
```

- [ ] **Step 6: 把 `java_impact` schema 改为单一 deadline**

Modify `src/tools/impact.ts`:

- Add `deadlineMs: z.number().int().positive().max(15000).optional()`.
- Remove public `semanticTimeoutMs` from the V6 path.
- During Iteration A, keep the internal field only as `Math.min(1500, context.budget.remainingMs())` adapter until all JDT calls consume `DeadlineBudget`.
- Do not expose both timeout controls in returned options.

Add/modify test in `src/tools/impact.test.ts`:

```ts
test("impact accepts one absolute deadline and rejects values above 15 seconds", () => {
  const good = z.object(impactSchema).safeParse({
    file: "src/main/java/demo/Demo.java",
    line: 1,
    column: 1,
    deadlineMs: 5000
  });
  assert.equal(good.success, true);

  const bad = z.object(impactSchema).safeParse({
    file: "src/main/java/demo/Demo.java",
    line: 1,
    column: 1,
    deadlineMs: 15001
  });
  assert.equal(bad.success, false);
});
```

- [ ] **Step 7: 运行验证**

Run:

```bash
npm run build
node --test dist/runtime/completion.test.js dist/runtime/deadline-budget.test.js dist/tools/impact.test.js
npm test
```

Expected: all pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/runtime src/tools/impact.ts src/tools/impact.test.ts src/agent-types.ts
git commit -m "refactor(runtime): add absolute request deadline and completion types"
```

---

## Task 2：抽出可故障注入的 JDT transport

**Files:**
- Create: `src/jdtls-transport.ts`
- Test: `src/jdtls-transport.test.ts`
- Modify: `src/jdtls-session.ts`

**Interfaces:**
- Consumes: `vscode-jsonrpc`、Node child process。
- Produces:
  - `JdtlsConnection`
  - `JdtlsChild`
  - `JdtlsTransportAttempt`
  - `JdtlsTransportFactory.spawn(input)`
  - `defaultJdtlsTransportFactory`

- [ ] **Step 1: 定义最小 transport 接口**

Create `src/jdtls-transport.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type CancellationToken,
  type MessageConnection
} from "vscode-jsonrpc/node.js";

export interface JdtlsConnection {
  sendRequest<R>(method: string, params?: unknown, token?: CancellationToken): Promise<R>;
  sendNotification(method: string, params?: unknown): void;
  onRequest(method: string, handler: (...args: unknown[]) => unknown): void;
  onNotification(method: string, handler: (...args: unknown[]) => unknown): void;
  onError(handler: (error: unknown) => void): void;
  listen(): void;
  dispose(): void;
}

export interface JdtlsChild {
  readonly pid?: number;
  readonly killed: boolean; // diagnostic only; never use as proof that the OS process exited
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
}

export type JdtlsTransportAttempt = {
  child: JdtlsChild;
  connection: JdtlsConnection;
};

export type JdtlsSpawnInput = {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export interface JdtlsTransportFactory {
  spawn(input: JdtlsSpawnInput): JdtlsTransportAttempt;
}

export const defaultJdtlsTransportFactory: JdtlsTransportFactory = {
  spawn(input) {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin)
    ) as MessageConnection;
    return { child, connection };
  }
};
```

Keep `any` limited to transport callback boundaries; do not spread it into domain types.

- [ ] **Step 2: 写 fake transport 测试**

Create `src/jdtls-transport.test.ts` with a fake implementation that records `spawn()` calls and exposes deferred request responses:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type {
  JdtlsConnection,
  JdtlsTransportAttempt,
  JdtlsTransportFactory
} from "./jdtls-transport.js";

export class FakeJdtlsConnection implements JdtlsConnection {
  requests: string[] = [];
  notifications: string[] = [];
  responses = new Map<string, unknown>();
  disposed = false;

  async sendRequest<R>(method: string): Promise<R> {
    this.requests.push(method);
    if (!this.responses.has(method)) {
      throw new Error(`No fake response for ${method}`);
    }
    const value = this.responses.get(method);
    return await Promise.resolve(value as R);
  }
  sendNotification(method: string): void { this.notifications.push(method); }
  onRequest(): void {}
  onNotification(): void {}
  onError(): void {}
  listen(): void {}
  dispose(): void { this.disposed = true; }
}

test("fake transport exposes deterministic connection state", async () => {
  const connection = new FakeJdtlsConnection();
  connection.responses.set("initialize", { capabilities: {} });
  const result = await connection.sendRequest("initialize");
  assert.deepEqual(result, { capabilities: {} });
  assert.deepEqual(connection.requests, ["initialize"]);
});
```

Use a dedicated `src/test-support/fake-jdtls.ts` instead if equivalent fake support already exists in current HEAD. Do not maintain duplicate fakes.

- [ ] **Step 3: 注入 transport factory 到 JdtlsSession**

Modify constructor:

```ts
constructor(
  private readonly repoRoot: string,
  aliases: string[] = [],
  private readonly transportFactory: JdtlsTransportFactory = defaultJdtlsTransportFactory
) { /* existing initialization */ }
```

Replace direct `spawn()` and `createMessageConnection()` in `start()` with:

```ts
const attempt = this.transportFactory.spawn({
  binary: this.jdtlsBin,
  args,
  cwd: this.repoRoot,
  env: buildJdtlsEnv(this.jdtlsRuntimeJavaHome)
});
```

Behavior must remain unchanged in this task. The state machine arrives in Task 3.

- [ ] **Step 4: 验证无行为漂移**

Run:

```bash
npm run build
node --test dist/jdtls-transport.test.js
npm test
```

Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/jdtls-transport.ts src/jdtls-transport.test.ts src/jdtls-session.ts src/test-support
git commit -m "refactor(jdtls): inject transport for lifecycle testing"
```

---

## Task 3：实现 JDT 五态生命周期、start singleflight、事务清理和最小 restart backoff

**Files:**
- Modify: `src/jdtls-session.ts`
- Create: `src/jdt-restart-backoff.ts`
- Create or modify: `src/jdtls-session.test.ts`
- Create: `src/jdt-restart-backoff.test.ts`
- Reuse: `src/test-support/fake-jdtls.ts`

**Interfaces:**
- Consumes: `JdtlsTransportFactory`、`DeadlineBudget`。
- Produces:
  - `JdtlsLifecycleState`
  - `JdtlsSession.ensureStarted(budget?: DeadlineBudget): Promise<void>`
  - `JdtlsSession.onLifecycleChange(listener): () => void`
  - `JdtRestartBackoff`
  - `status().state`
  - `status().started === (state === "READY")`
  - `status().restartBackoff`

- [ ] **Step 1: 写并发启动失败测试**

Test must prove all four conditions:

1. two concurrent `ensureStarted()` calls spawn once；
2. initialize deferred 时 state 是 STARTING；
3. initialize resolve 前不允许 semantic request越过；
4. resolve 后两调用同时完成，state READY。

```ts
test("concurrent ensureStarted shares one transactional start", async () => {
  const initialize = deferred<unknown>();
  const factory = fakeTransportFactory({ initialize });
  const session = new JdtlsSession(root, [], factory);
  const budget = DeadlineBudget.fromTimeout(1000);

  const first = session.ensureStarted(budget);
  const second = session.ensureStarted(budget);

  assert.equal(factory.spawnCalls, 1);
  assert.equal(session.status().state, "STARTING");
  assert.equal(session.status().started, false);

  initialize.resolve({ capabilities: {} });
  await Promise.all([first, second]);

  assert.equal(session.status().state, "READY");
  assert.equal(session.status().started, true);
});

test("a short caller deadline does not cancel a shared JDT startup", async () => {
  const initialize = deferred<unknown>();
  const factory = fakeTransportFactory({ initialize });
  const session = new JdtlsSession(root, [], factory);

  const short = session.ensureStarted(DeadlineBudget.fromTimeout(10));
  const long = session.ensureStarted(DeadlineBudget.fromTimeout(1000));
  await assert.rejects(
    () => short,
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
  );
  assert.equal(session.status().state, "STARTING");
  assert.equal(factory.children[0].killCalls, 0);

  initialize.resolve({ capabilities: {} });
  await long;
  assert.equal(session.status().state, "READY");
  assert.equal(factory.spawnCalls, 1);
});
```

The start operation owns a separate internal hard cap. A caller deadline only stops that caller from waiting; it must not kill work shared with another caller.

Run:

```bash
npm run build && node --test --test-name-pattern="concurrent ensureStarted" dist/jdtls-session.test.js
```

Expected: FAIL because current `started` is process/connection based.

- [ ] **Step 2: 写 initialize 失败清理测试**

```ts
test("failed initialize disposes the attempt and permits a clean retry", async () => {
  const first = fakeTransportFactory({ initializeError: new Error("boom") });
  const session = new JdtlsSession(root, [], first);

  await assert.rejects(() => session.ensureStarted(DeadlineBudget.fromTimeout(1000)), /boom/);
  assert.equal(session.status().state, "BROKEN");
  assert.equal(session.status().started, false);
  assert.equal(first.children[0].killCalls > 0, true);
  assert.equal(first.connections[0].disposed, true);

  const second = fakeTransportFactory({ initializeResult: { capabilities: {} } });
  session.setTransportFactoryForTest(second);
  await session.ensureStarted(DeadlineBudget.fromTimeout(1000));
  assert.equal(session.status().state, "READY");
});
```

不要在生产 API 暴露 `setTransportFactoryForTest`。更好的实现是 fake factory 本身按调用序列返回失败/成功 attempt：

```ts
const factory = sequenceTransportFactory([
  failingAttempt,
  successfulAttempt
]);
```

- [ ] **Step 2a: 写 BROKEN restart backoff 失败测试**

```ts
import { JdtRestartBackoff } from "./jdt-restart-backoff.js";

test("retryable JDT failures back off and explicit reset clears the gate", () => {
  let now = 1_000;
  const backoff = new JdtRestartBackoff(() => now);

  backoff.recordFailure("JDT_SERVER_ERROR");
  assert.deepEqual(backoff.check(), {
    allowed: false,
    retryAfterMs: 500,
    blockedUntilExplicitReset: false
  });

  now += 499;
  assert.equal(backoff.check().allowed, false);
  now += 1;
  assert.equal(backoff.check().allowed, true);

  backoff.recordFailure("JDT_SERVER_ERROR");
  assert.equal(backoff.status().consecutiveFailures, 2);
  assert.equal(backoff.status().retryAfterMs, 1_000);

  backoff.reset();
  assert.equal(backoff.check().allowed, true);
});

test("JDT configuration failures require explicit reset", () => {
  const backoff = new JdtRestartBackoff(() => 10_000);
  backoff.recordFailure("JDT_CONFIG_ERROR");
  assert.equal(backoff.check().blockedUntilExplicitReset, true);
  assert.equal(backoff.check().allowed, false);
  backoff.reset();
  assert.equal(backoff.check().allowed, true);
});

test("caller deadlines and cancellation do not poison restart backoff", () => {
  const backoff = new JdtRestartBackoff(() => 10_000);
  backoff.recordFailure("DEADLINE_EXCEEDED");
  backoff.recordFailure("CANCELLED");
  assert.equal(backoff.status().consecutiveFailures, 0);
});

test("READY does not reset failures until the stability window completes", () => {
  const backoff = new JdtRestartBackoff(() => 10_000);
  backoff.recordFailure("JDT_SERVER_ERROR");
  backoff.recordReadyStarted();
  assert.equal(backoff.status().consecutiveFailures, 1);
  backoff.recordReadyStable();
  assert.equal(backoff.status().consecutiveFailures, 0);
});
```

Add session-level tests:

1. two requests during an active retry window do not spawn two more children; after the fake clock reaches `retryAfterMs`, exactly one shared retry starts；
2. `stop()` during STARTING rejects all startup waiters as `CANCELLED`, leaves lifecycle STOPPED, and does not increment backoff failures。

Run:

```bash
npm run build && node --test --test-name-pattern="restart backoff|configuration failures" dist/jdt-restart-backoff.test.js dist/jdtls-session.test.js
```

Expected: FAIL because Task 3 currently restarts BROKEN on every call.

- [ ] **Step 3: 增加生命周期类型和事件**

At top of `jdtls-session.ts`:

```ts
export type JdtlsLifecycleState =
  | "NEW"
  | "STARTING"
  | "READY"
  | "BROKEN"
  | "STOPPED";

type LifecycleListener = (state: JdtlsLifecycleState) => void;
```

Fields:

```ts
private lifecycleState: JdtlsLifecycleState = "NEW";
private startPromise?: Promise<void>;
private stopPromise?: Promise<void>;
private startAttempt?: JdtlsTransportAttempt;
private readonly lifecycleListeners = new Set<LifecycleListener>();
private readonly restartBackoff = new JdtRestartBackoff();
private readyStableTimer?: NodeJS.Timeout;
private readonly readyStabilityMs = positiveInteger(
  process.env.JDTLS_READY_STABILITY_MS,
  30_000
);
private readonly startHardCapMs = positiveInteger(
  process.env.JDTLS_START_TIMEOUT_MS,
  120_000
);
```

Helper:

```ts
private transition(next: JdtlsLifecycleState): void {
  if (this.lifecycleState === next) return;
  this.lifecycleState = next;
  for (const listener of this.lifecycleListeners) listener(next);
}

onLifecycleChange(listener: LifecycleListener): () => void {
  this.lifecycleListeners.add(listener);
  return () => this.lifecycleListeners.delete(listener);
}
```

- [ ] **Step 4: 重写 ensureStarted**

```ts
async ensureStarted(
  callerBudget = DeadlineBudget.fromTimeout(DEFAULT_LSP_REQUEST_TIMEOUT_MS)
): Promise<void> {
  if (this.stopPromise) {
    await callerBudget.race("jdtls.stop.wait", this.stopPromise);
  }
  if (this.lifecycleState === "READY") return;
  const gate = this.restartBackoff.check();
  if (!gate.allowed) {
    throw new JavaIntelligenceError(
      gate.blockedUntilExplicitReset ? "JDT_CONFIG_ERROR" : "JDT_BACKOFF",
      gate.blockedUntilExplicitReset
        ? "JDT start is blocked until configuration changes or java_restart"
        : `JDT restart is backing off for ${gate.retryAfterMs}ms`
    );
  }
  let sharedStart = this.startPromise;
  if (!sharedStart) {
    this.transition("STARTING");
    const startBudget = DeadlineBudget.fromTimeout(this.startHardCapMs);
    const created = this.startTransactional(startBudget)
      .catch(error => {
        const classified = classifyJdtStartError(error);
        if (this.lifecycleState !== "STOPPED") this.transition("BROKEN");
        this.restartBackoff.recordFailure(classified.code);
        throw classified;
      })
      .finally(() => {
        if (this.startPromise === created) this.startPromise = undefined;
      });
    this.startPromise = created;
    sharedStart = created;
  }
  return callerBudget.race("jdtls.start.wait", sharedStart);
}
```

`BROKEN` and `STOPPED` are restartable. The call creates a new attempt.

- [ ] **Step 4a: 实现 `JdtRestartBackoff`**

```ts
// src/jdt-restart-backoff.ts
import type { JavaIntelligenceErrorCode } from "./runtime/intelligence-error.js";

export type JdtRestartBackoffStatus = {
  consecutiveFailures: number;
  retryAfterMs?: number;
  blockedUntilExplicitReset: boolean;
  lastErrorCode?: JavaIntelligenceErrorCode;
};

const CONFIG_CODES = new Set<JavaIntelligenceErrorCode>(["JDT_CONFIG_ERROR"]);
const IGNORED_CODES = new Set<JavaIntelligenceErrorCode>([
  "DEADLINE_EXCEEDED",
  "CANCELLED"
]);

export class JdtRestartBackoff {
  private failures = 0;
  private nextRetryAtMs = 0;
  private blocked = false;
  private lastErrorCode?: JavaIntelligenceErrorCode;

  constructor(private readonly now: () => number = Date.now) {}

  check(): { allowed: boolean; retryAfterMs?: number; blockedUntilExplicitReset: boolean } {
    if (this.blocked) return { allowed: false, blockedUntilExplicitReset: true };
    const retryAfterMs = Math.max(0, this.nextRetryAtMs - this.now());
    return retryAfterMs > 0
      ? { allowed: false, retryAfterMs, blockedUntilExplicitReset: false }
      : { allowed: true, blockedUntilExplicitReset: false };
  }

  recordFailure(code: JavaIntelligenceErrorCode): void {
    if (IGNORED_CODES.has(code)) return;
    this.lastErrorCode = code;
    if (CONFIG_CODES.has(code)) {
      this.blocked = true;
      return;
    }
    this.failures += 1;
    const delayMs = Math.min(30_000, 500 * 2 ** Math.max(0, this.failures - 1));
    this.nextRetryAtMs = this.now() + delayMs;
  }

  recordReadyStarted(): void {
    // Lifecycle is READY, but failures remain until the stability window proves health.
  }

  recordReadyStable(): void { this.reset(); }

  reset(): void {
    this.failures = 0;
    this.nextRetryAtMs = 0;
    this.blocked = false;
    this.lastErrorCode = undefined;
  }

  status(): JdtRestartBackoffStatus {
    const retryAfterMs = Math.max(0, this.nextRetryAtMs - this.now());
    return {
      consecutiveFailures: this.failures,
      retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined,
      blockedUntilExplicitReset: this.blocked,
      lastErrorCode: this.lastErrorCode
    };
  }
}
```

`classifyJdtStartError()` maps missing binary and missing/ambiguous project JDK to `JDT_CONFIG_ERROR`; initialize protocol failures map to `JDT_SERVER_ERROR`; child exit/transport failure maps to `JDT_BROKEN`; caller budget/cancel preserves its original code.

- [ ] **Step 5: 实现 startTransactional**

Required shape:

```ts
private async startTransactional(budget: DeadlineBudget): Promise<void> {
  if (!this.jdtlsBin) {
    throw new JavaIntelligenceError("JDT_CONFIG_ERROR", "jdtls executable was not found");
  }

  await mkdir(this.dataDir, { recursive: true });
  await mkdir(this.logDir, { recursive: true });
  budget.throwIfExpired("jdtls.spawn");

  const attempt = this.transportFactory.spawn({
    binary: this.jdtlsBin,
    args: this.launchArgs(),
    cwd: this.repoRoot,
    env: buildJdtlsEnv(this.jdtlsRuntimeJavaHome)
  });
  this.startAttempt = attempt;
  this.registerClientHandlers(attempt.connection);
  attempt.connection.listen();
  this.attachAttemptLogging(attempt);

  try {
    const initializeResult = await budget.race(
      "jdtls.initialize",
      attempt.connection.sendRequest("initialize", this.initializeParams()),
      this.startHardCapMs,
      () => { void terminateChild(attempt.child, 200); }
    );
    if (!initializeResult) {
      throw new JavaIntelligenceError(
        "JDT_SERVER_ERROR",
        "JDT LS initialization returned an empty result"
      );
    }
    if (this.lifecycleState !== "STARTING" || this.startAttempt !== attempt) {
      throw new JavaIntelligenceError(
        "CANCELLED",
        "JDT LS startup was superseded or stopped before commit"
      );
    }
    attempt.connection.sendNotification("initialized", {});
    attempt.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: this.javaSettings()
    });

    this.process = attempt.child;
    this.connection = attempt.connection;
    this.startAttempt = undefined;
    this.startedAt = new Date();
    this.restartBackoff.recordReadyStarted();
    this.transition("READY");
    this.armReadyStabilityReset(attempt);
  } catch (error) {
    const stoppedOrSuperseded =
      this.lifecycleState === "STOPPED"
      || (this.startAttempt !== attempt
        && (this.lifecycleState === "STARTING" || this.lifecycleState === "READY"));
    await this.disposeAttempt(attempt);
    if (this.startAttempt === attempt) this.startAttempt = undefined;
    if (this.process === attempt.child) this.process = undefined;
    if (this.connection === attempt.connection) this.connection = undefined;
    this.startedAt = undefined;
    if (stoppedOrSuperseded) {
      throw new JavaIntelligenceError(
        "CANCELLED",
        "JDT LS startup was stopped or superseded",
        error
      );
    }
    throw error;
  }
}
```

`attachAttemptLogging()` 的 exit handler 必须区分：

- 当前 READY process 退出 → `BROKEN`；
- STARTING attempt 退出 → 让 start promise 失败；
- 已 stop 的旧 child 退出 → 不覆盖新 session state。

Use object identity checks. The exit callback must contain this complete guard:

```ts
const ownsReadyProcess = this.process === attempt.child;
const ownsStartingAttempt = this.startAttempt === attempt;
if (!ownsReadyProcess && !ownsStartingAttempt) {
  return;
}
this.process = undefined;
this.connection = undefined;
this.startAttempt = undefined;
this.startedAt = undefined;
if (this.lifecycleState !== "STOPPED") {
  this.transition("BROKEN");
}
```

The stability reset helper is attempt-identity guarded:

```ts
private armReadyStabilityReset(attempt: JdtlsTransportAttempt): void {
  if (this.readyStableTimer) clearTimeout(this.readyStableTimer);
  this.readyStableTimer = setTimeout(() => {
    if (this.lifecycleState === "READY" && this.process === attempt.child) {
      this.restartBackoff.recordReadyStable();
    }
  }, this.readyStabilityMs);
  this.readyStableTimer.unref?.();
}
```

The READY child exit handler clears this timer and records `JDT_BROKEN` before transitioning BROKEN. STARTING failures remain recorded by the shared start promise catch and must not be double-counted.

- [ ] **Step 6: 实现强制清理**

```ts
private async disposeAttempt(attempt: JdtlsTransportAttempt): Promise<void> {
  try { attempt.connection.dispose(); } catch {}
  await terminateChild(attempt.child, 200);
}

async function terminateChild(child: JdtlsChild, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  if (await settlesWithin(exited, graceMs)) return;
  child.kill("SIGKILL");
  await settlesWithin(exited, 1000);
}

function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    operation.then(() => {
      clearTimeout(timer);
      resolve(true);
    }, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
```

Never use `child.killed` to decide that termination completed: Node sets it when `kill()` is called, not when the OS process has exited.

`stop()` must:

- create/reuse one `stopPromise` and transition STOPPED before waiting；
- cancel/cleanup STARTING attempt；
- clear startPromise safely；
- shutdown READY connection best effort；
- clear `readyStableTimer`、documents/cache/diagnostics；
- release any JDT lease later attached by Task 12a；
- leave no process/connection references；
- clear `stopPromise` only after cleanup settles；a new `ensureStarted()` waits on it before starting a replacement attempt。

- [ ] **Step 7: 修正 status**

Patch the existing `status()` result so these lifecycle-derived fields are assigned exactly as follows:

```ts
const state = this.lifecycleState;
const started = state === "READY";
const pid = started ? this.process?.pid : undefined;
const startingPid = state === "STARTING" ? this.startAttempt?.child.pid : undefined;
```

Return `state`, `started`, `pid`, `startingPid` and `restartBackoff: this.restartBackoff.status()` alongside the existing cache/build/JDK/watcher fields. Remove every alternative `started` calculation based only on process/connection presence. `java_restart` and a relevant build/JDK configuration generation change call `restartBackoff.reset()`. Entering READY alone does not reset failures; only the guarded stability timer (default 30s) does.

- [ ] **Step 8: 运行定向和全量测试**

```bash
npm run build
node --test dist/jdtls-session.test.js dist/jdt-restart-backoff.test.js
npm test
```

Expected:

- concurrent start spawn=1；
- initialize failure cleanup；
- status only READY is started；
- existing symbol/reference tests pass。

- [ ] **Step 9: Commit**

```bash
git add src/jdtls-session.ts src/jdtls-session.test.ts src/jdt-restart-backoff.ts src/jdt-restart-backoff.test.ts src/test-support
git commit -m "fix(jdtls): make startup transactional with bounded restart backoff"
```

---

## Task 4：让 STARTING/READY 原子占用 active repo slot

**Files:**
- Modify: `src/repo-runtime-manager.ts`
- Modify: `src/repo-runtime-manager.test.ts`

**Interfaces:**
- Consumes: `JdtlsSession.onLifecycleChange()`。
- Produces:
  - `RuntimeEntry.lspReservation`
  - FIFO `slotWaiters`
  - active count includes STARTING and READY。

This task is deliberately **process-local**. Task 12a adds machine-level and same-worktree leases; do not claim Task 4 alone bounds multiple stdio MCP processes.

- [ ] **Step 1: 写并发 oversubscribe 失败测试**

Test two repo requests begin in same tick with `maxActiveRepos=1`. The first fake session stays STARTING; the second must not enter STARTING until first releases.

```ts
test("STARTING sessions count against the active repo limit", async () => {
  const gateA = deferred<void>();
  const enteredB = deferred<void>();
  const manager = managerWithLifecycleSessions({
    maxActiveRepos: 1,
    startGates: { "/repo-a": gateA }
  });

  const first = manager.withContext(
    { repoRoot: "/repo-a" },
    async context => context.session.ensureStarted(),
    { mayStartLsp: true }
  );

  await manager.sessions.get("/repo-a")!.startedStarting;

  const second = manager.withContext(
    { repoRoot: "/repo-b" },
    async context => {
      enteredB.resolve();
      await context.session.ensureStarted();
    },
    { mayStartLsp: true }
  );

  await delay(20);
  assert.equal(enteredB.settled, false);
  assert.equal(manager.reservedCount(), 1);

  gateA.resolve();
  await first;
  await manager.shutdown("/repo-a");
  await second;
});
```

Adapt helper syntax to current test support; preserve the invariant.

- [ ] **Step 2: 增加 reservation state**

```ts
type LspReservation = "NONE" | "STARTING" | "READY";

type RuntimeEntry = {
  context: ManagedToolContext;
  refCount: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  lspReservation: LspReservation;
  unsubscribeLifecycle?: () => void;
};
```

When entry is created, subscribe:

```ts
entry.unsubscribeLifecycle = entry.context.session.onLifecycleChange(state => {
  if (state === "STARTING") entry.lspReservation = "STARTING";
  if (state === "READY") entry.lspReservation = "READY";
  if (state === "BROKEN" || state === "STOPPED" || state === "NEW") {
    entry.lspReservation = "NONE";
    this.drainSlotWaiters();
  }
});
```

- [ ] **Step 3: 用 FIFO waiter 直接授予 reservation**

Define:

```ts
type SlotWaiter = {
  entry: RuntimeEntry;
  promise: Promise<void>;
  grant(): void;
  cancel(): void;
};

private readonly slotWaiters: SlotWaiter[] = [];
```

`reserveLspSlot(entry, budget)` must either mark immediately or enqueue. A waiter grant marks the target entry **before** resolving the promise:

```ts
private async reserveLspSlot(
  entry: RuntimeEntry,
  budget: DeadlineBudget
): Promise<void> {
  if (entry.lspReservation !== "NONE") return;
  const victim = this.oldestIdleReservedEntry(entry);
  if (this.reservedEntries().length >= this.options.maxActiveRepos && victim) {
    await this.stopEntry(victim);
  }
  if (this.reservedEntries().length < this.options.maxActiveRepos) {
    entry.lspReservation = "STARTING";
    return;
  }

  const waiter = this.createSlotWaiter(entry);
  this.slotWaiters.push(waiter);
  await budget.race(
    "runtime.lsp-slot",
    waiter.promise,
    undefined,
    () => {
      waiter.cancel();
      const index = this.slotWaiters.indexOf(waiter);
      if (index >= 0) this.slotWaiters.splice(index, 1);
    }
  );
}
```

`createSlotWaiter()` is idempotent on grant/cancel:

```ts
private createSlotWaiter(entry: RuntimeEntry): SlotWaiter {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return {
    entry,
    promise,
    grant: () => {
      if (settled) return;
      settled = true;
      entry.lspReservation = "STARTING";
      resolve();
    },
    cancel: () => { settled = true; }
  };
}
```

`drainSlotWaiters()` grants in FIFO order and accounts each grant synchronously:

```ts
private drainSlotWaiters(): void {
  while (
    this.slotWaiters.length > 0
    && this.reservedEntries().length < this.options.maxActiveRepos
  ) {
    const waiter = this.slotWaiters.shift()!;
    if (waiter.entry.lspReservation === "NONE") waiter.grant();
  }
}
```

Do not resolve a waiter and ask it to reserve later; that recreates the check-then-act window.

- [ ] **Step 4: 写 FIFO 与 waiter timeout 测试**

Add tests proving:

```text
repo A holds the only slot
repo B queues before repo C
release A grants B, not C
B caller deadline removes B cleanly when it expires before a grant
cancelled waiter never receives a later reservation
```

Use deterministic deferred promises; do not use polling as the behavior under test.

- [ ] **Step 5: 释放未使用 reservation**

`mayStartLsp=true` does not guarantee a semantic call. In `withContext` finally:

```ts
const state = entry.context.session.status().state;
if (entry.lspReservation === "STARTING" && state !== "STARTING" && state !== "READY") {
  entry.lspReservation = "NONE";
  this.drainSlotWaiters();
}
```

Do not release READY reservations until stop/eviction.

- [ ] **Step 6: 状态输出**

`activeRepos()` and `resourceStatus()` expose:

```ts
{
  lifecycleState,
  lspReservation,
  started: lifecycleState === "READY"
}
```

Standard status can summarize; diagnostic status returns all fields.

- [ ] **Step 7: Run**

```bash
npm run build
node --test dist/repo-runtime-manager.test.js
npm test
```

Expected: no oversubscribe, existing eviction behavior remains.

- [ ] **Step 8: Commit**

```bash
git add src/repo-runtime-manager.ts src/repo-runtime-manager.test.ts
git commit -m "fix(runtime): reserve JDT slots before asynchronous startup"
```

---

## Task 5：流式 `rg --json` 与 partial 禁 cache

**Files:**
- Create: `src/search/search-types.ts`
- Create: `src/search/rg-runner.ts`
- Create: `src/search/bounded-line-decoder.ts`
- Create: `src/search/rg-cache.ts`
- Test: `src/search/rg-runner.test.ts`
- Test: `src/search/bounded-line-decoder.test.ts`
- Test: `src/search/rg-cache.test.ts`
- Modify: current rg execution owner from Task 0 mapping
- Modify: current router rg cache owner from Task 0 mapping

**Interfaces:**
- Produces:
  - `RgRunner.run(query, budget): Promise<SearchResult>`
  - `GenerationRgCache.get/set`
  - only COMPLETE results are cacheable。

- [ ] **Step 1: 定义 search types**

Create `src/search/search-types.ts`:

```ts
import type { Completion } from "../runtime/completion.js";
import type { JavaIntelligenceErrorCode } from "../runtime/intelligence-error.js";

export type SearchPosition = { line: number; column: number };

export type SearchFileMatch = {
  absolutePath: string;
  matchCount: number;
  positions: SearchPosition[];
};

export type SearchResult = {
  files: SearchFileMatch[];
  completion: Completion;
  rawBytes: number;
  totalMatches: number;
  elapsedMs: number;
  stderrTail?: string;
  errorCode?: JavaIntelligenceErrorCode;
};

export type RgQuery = {
  pattern: string;
  roots: string[];
  globs: string[];
  cwd: string;
};
```

- [ ] **Step 2: 写 timeout partial 测试**

Use a temp Node script as fake binary. It prints one valid ripgrep JSON match line, flushes, then sleeps longer than budget.

```ts
test("rg timeout returns partial evidence but is not complete", async () => {
  const script = await writeFakeRgScript([
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "src/main/java/demo/A.java" },
        lines: { text: "class A {}\n" },
        line_number: 1,
        submatches: [{ start: 6, end: 7, match: { text: "A" } }]
      }
    }),
    "__SLEEP_200__"
  ]);
  const runner = new RgRunner({ binary: process.execPath, prefixArgs: [script] });
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(30));

  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.equal(result.files.length, 1);
  assert.equal(result.totalMatches, 1);
});
```

- [ ] **Step 3: 实现 bounded streaming runner**

First create `src/search/bounded-line-decoder.ts`. It keeps only the current line, caps a single JSON record, and decodes only after a complete newline so UTF-8 characters split across chunks remain correct:

```ts
export class BoundedLineDecoder {
  private pending = Buffer.alloc(0);

  constructor(private readonly maxLineBytes: number) {}

  push(chunk: Buffer): string[] {
    this.pending = this.pending.length === 0
      ? chunk
      : Buffer.concat([this.pending, chunk]);
    const lines: string[] = [];
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxLineBytes) {
        throw new Error(`rg JSON line exceeded ${this.maxLineBytes} bytes`);
      }
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      lines.push(line.subarray(0, line.at(-1) === 0x0d ? line.length - 1 : line.length).toString("utf8"));
    }
    if (this.pending.length > this.maxLineBytes) {
      throw new Error(`rg JSON line exceeded ${this.maxLineBytes} bytes`);
    }
    return lines;
  }

  finish(): string[] {
    if (this.pending.length === 0) return [];
    if (this.pending.length > this.maxLineBytes) {
      throw new Error(`rg JSON line exceeded ${this.maxLineBytes} bytes`);
    }
    const line = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    return [line];
  }
}
```

Tests cover split UTF-8, CRLF, multiple lines, and a record exceeding the cap.

Create `src/search/rg-runner.ts` with these resource defaults:

```ts
const DEFAULT_MAX_RAW_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MATCHES = 100_000;
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_KILL_GRACE_MS = 100;
```

Core runner shape:

```ts
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import type { Readable } from "node:stream";
import { isWithin } from "../path-utils.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import { BoundedLineDecoder } from "./bounded-line-decoder.js";
import type { RgQuery, SearchFileMatch, SearchResult } from "./search-types.js";

type RgChild = ChildProcessByStdio<null, Readable, Readable>;

export class RgRunner {
  constructor(private readonly options: {
    binary?: string;
    prefixArgs?: string[];
    maxPositionsPerFile?: number;
    maxRawBytes?: number;
    maxLineBytes?: number;
    maxMatches?: number;
    killGraceMs?: number;
  } = {}) {}

  async run(query: RgQuery, budget: DeadlineBudget): Promise<SearchResult> {
    const startedAt = performance.now();
    const files = new Map<string, SearchFileMatch>();
    const decoder = new BoundedLineDecoder(
      this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    );
    let rawBytes = 0;
    let totalMatches = 0;
    let timedOut = false;
    let limited = false;
    let parseFailed = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    let stderrTail = Buffer.alloc(0);

    const args = [
      ...(this.options.prefixArgs ?? []),
      "--json",
      "--line-number",
      "--color",
      "never",
      ...query.globs.flatMap(glob => ["-g", glob]),
      "-e",
      query.pattern,
      "--",
      ...query.roots
    ];
    const child = spawn(this.options.binary ?? "rg", args, {
      cwd: query.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));

    const consumeLine = (line: string): void => {
      const event = safeParseRgJson(line);
      if (event === "MALFORMED") {
        parseFailed = true;
        void terminateChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        return;
      }
      if (!event || event.type !== "match") return;
      const relative = event.data.path.text;
      const absolute = path.resolve(query.cwd, relative);
      if (!isWithin(query.cwd, absolute)) return;
      const existing = files.get(absolute) ?? {
        absolutePath: absolute,
        matchCount: 0,
        positions: []
      };
      existing.matchCount += 1;
      totalMatches += 1;
      const first = event.data.submatches?.[0];
      if (existing.positions.length < (this.options.maxPositionsPerFile ?? 4)) {
        existing.positions.push({
          line: event.data.line_number ?? 1,
          column: (first?.start ?? 0) + 1
        });
      }
      files.set(absolute, existing);
      if (totalMatches >= (this.options.maxMatches ?? DEFAULT_MAX_MATCHES)) {
        limited = true;
        void terminateChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      rawBytes += chunk.length;
      if (rawBytes > (this.options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES)) {
        limited = true;
        void terminateChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        return;
      }
      try {
        for (const line of decoder.push(chunk)) consumeLine(line);
      } catch {
        limited = true;
        void terminateChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-DEFAULT_STDERR_TAIL_BYTES);
    });
    child.once("error", error => { spawnError = error; });

    const timeoutMs = budget.remainingMs();
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateChild(child, this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    }, timeoutMs);
    timeout.unref?.();
    const status = await closed;
    clearTimeout(timeout);
    if (!timedOut && !limited && !parseFailed) {
      try {
        for (const line of decoder.finish()) consumeLine(line);
      } catch {
        parseFailed = true;
      }
    }

    const completion = spawnError || parseFailed || (!timedOut && !limited && status !== 0 && status !== 1)
      ? "FAILED"
      : timedOut
        ? "PARTIAL_TIMEOUT"
        : limited
          ? "PARTIAL_LIMIT"
          : "COMPLETE";
    return {
      files: [...files.values()],
      completion,
      rawBytes,
      totalMatches,
      elapsedMs: performance.now() - startedAt,
      stderrTail: stderrTail.toString("utf8") || undefined,
      errorCode: spawnError || parseFailed
        ? "SEARCH_FAILED"
        : timedOut
          ? "SEARCH_TIMEOUT"
          : undefined
    };
  }
}
```

Add an idempotent termination helper:

```ts
const terminating = new WeakMap<RgChild, Promise<void>>();

function terminateChild(
  child: RgChild,
  graceMs: number
): Promise<void> {
  const existing = terminating.get(child);
  if (existing) return existing;
  const operation = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.kill("SIGTERM");
    const hardKill = setTimeout(() => child.kill("SIGKILL"), graceMs);
    hardKill.unref?.();
    child.once("close", () => {
      clearTimeout(hardKill);
      resolve();
    });
  });
  terminating.set(child, operation);
  return operation;
}
```

`safeParseRgJson()` returns a typed event, `undefined` for valid non-match events, and the sentinel `"MALFORMED"` for an invalid record. A malformed record makes the result `FAILED`; an output/match/line cap makes it `PARTIAL_LIMIT`. Consume stderr so a noisy child cannot block on a full pipe. The request may exceed its deadline only by the configured kill grace; record this overshoot in the phase report.

Add tests for:

- timeout followed by SIGTERM/SIGKILL escalation；
- child that writes large stderr；
- malformed JSON；
- raw-byte, single-line and match-count caps；
- pattern beginning with `-` (the `-e` form must work)；
- outside-root/symlink-resolved match suppression；
- status 1 with no matches returns COMPLETE。

- [ ] **Step 4: 写 complete-only cache test**

```ts
test("generation rg cache rejects partial results", () => {
  const cache = new GenerationRgCache(300_000);
  cache.set("k", 7, completeResult());
  assert.ok(cache.get("k", 7));
  cache.set("partial", 7, { ...completeResult(), completion: "PARTIAL_TIMEOUT" });
  assert.equal(cache.get("partial", 7), undefined);
  assert.equal(cache.get("k", 8), undefined);
});
```

- [ ] **Step 5: 实现 rg cache**

```ts
export class GenerationRgCache {
  private readonly entries = new Map<string, { generation: number; expiresAt: number; result: SearchResult }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, generation: number): SearchResult | undefined {
    const item = this.entries.get(key);
    if (!item || item.generation !== generation || item.expiresAt <= Date.now()) {
      if (item) this.entries.delete(key);
      return undefined;
    }
    return item.result;
  }

  set(key: string, generation: number, result: SearchResult): void {
    if (!isCacheableCompletion(result.completion) || this.ttlMs <= 0) return;
    this.entries.set(key, {
      generation,
      expiresAt: Date.now() + this.ttlMs,
      result
    });
  }

  invalidateBefore(generation: number): void {
    for (const [key, value] of this.entries) {
      if (value.generation < generation) this.entries.delete(key);
    }
  }
}
```

- [ ] **Step 6: 替换现有 rg executor**

Current router owner discovered in Task 0 must:

- build `RgQuery`；
- call `RgRunner.run(query, requestContext.budget)`；
- map `SearchFileMatch` to lexical EvidenceSignal/candidate；
- attach completion to diagnostics；
- cache only via `GenerationRgCache`；
- remove full stdout string and `maxBuffer` code；
- preserve existing raw byte/match metrics。

- [ ] **Step 7: 添加回归测试：第二次 partial 仍执行**

Inject a fake runner with call counter:

```ts
assert.equal(await routeOnce().completion, "PARTIAL_TIMEOUT");
assert.equal(await routeOnce().completion, "PARTIAL_TIMEOUT");
assert.equal(fakeRunner.calls, 2);
```

- [ ] **Step 8: Run**

```bash
npm run build
node --test dist/search/rg-runner.test.js dist/search/rg-cache.test.js
npm test
```

- [ ] **Step 9: Commit**

```bash
git add src/search src/agent-router
git commit -m "fix(search): stream rg results and never cache partial output"
```

---

## Task 6：LSP location 仓库边界与 semantic error taxonomy

**Files:**
- Create: `src/semantic-location.ts`
- Test: `src/semantic-location.test.ts`
- Modify: current semantic owner from Task 0 mapping
- Modify: `src/jdtls-session.ts`
- Modify: `src/tools/symbol.ts`
- Modify: `src/tools/references.ts`
- Modify: `src/path-utils.ts`
- Test: `src/path-utils.test.ts`
- Modify/test: current semantic edge store if present at Task 0; otherwise Task 33 creates V2

**Interfaces:**
- Produces:
  - `normalizeRepoLocation(repoRoot, location): RepoLocation | undefined`
  - semantic error classification
  - suppressed external hit metrics。

- [ ] **Step 1: 写 outside-repo 失败测试**

```ts
test("semantic locations outside canonical repo root are rejected", () => {
  const repo = canonicalPath(root);
  const external = path.join(tmpdir(), "dependency", "Library.java");
  const value = normalizeRepoLocation(repo, {
    uri: pathToFileURL(external).toString(),
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 }
    }
  });
  assert.equal(value, undefined);
});

test("repo locations are returned as relative 1-based ranges", () => {
  const file = path.join(root, "src/main/java/demo/A.java");
  const value = normalizeRepoLocation(root, {
    uri: pathToFileURL(file).toString(),
    range: {
      start: { line: 4, character: 2 },
      end: { line: 4, character: 3 }
    }
  });
  assert.deepEqual(value, {
    absolutePath: file,
    relativePath: "src/main/java/demo/A.java",
    range: {
      start: { line: 5, column: 3 },
      end: { line: 5, column: 4 }
    }
  });
});
```

- [ ] **Step 2: 实现 symlink-safe potential path containment 和 normalizeRepoLocation**

Add to `src/path-utils.ts`:

```ts
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function canonicalPotentialPath(value: string): string {
  const resolved = path.resolve(value);
  if (existsSync(resolved)) return realpathSync.native(resolved);

  const suffix: string[] = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalAncestor = existsSync(cursor)
    ? realpathSync.native(cursor)
    : cursor;
  return path.join(canonicalAncestor, ...suffix);
}

export function isPotentiallyWithin(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalPotentialPath(root);
  const canonicalCandidate = canonicalPotentialPath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}
```

Add a test where `repo/link` is a symlink to an outside directory and the candidate `repo/link/Missing.java` does not exist. `isPotentiallyWithin(repo, candidate)` must be false. This closes the “nonexistent child under symlink” gap that a simple `path.resolve()` check misses.

Create `src/semantic-location.ts`:

```ts
import path from "node:path";
import { isPotentiallyWithin, canonicalPotentialPath } from "./path-utils.js";
import { fromFileUri } from "./repo-layout.js";
import type { LspLocation, LspLocationLink } from "./jdtls-session.js";
import type { SourceRange } from "./runtime/source-range.js";

export type RepoLocation = {
  absolutePath: string;
  relativePath: string;
  range: SourceRange;
};

export function normalizeRepoLocation(
  repoRoot: string,
  location: LspLocation | LspLocationLink
): RepoLocation | undefined {
  const uri = "targetUri" in location ? location.targetUri : location.uri;
  const rawRange = "targetSelectionRange" in location
    ? location.targetSelectionRange
    : location.range;
  let rawPath: string | undefined;
  try {
    rawPath = fromFileUri(uri);
  } catch {
    return undefined;
  }
  if (!rawPath || !isPotentiallyWithin(repoRoot, rawPath)) return undefined;
  const root = canonicalPotentialPath(repoRoot);
  const file = canonicalPotentialPath(rawPath);
  const relativePath = path.relative(root, file);
  if (!relativePath || relativePath === ".") return undefined;
  return {
    absolutePath: file,
    relativePath,
    range: {
      start: {
        line: rawRange.start.line + 1,
        column: rawRange.start.character + 1
      },
      end: {
        line: rawRange.end.line + 1,
        column: rawRange.end.character + 1
      }
    }
  };
}
```

`SourceRange` always comes from the single runtime definition; JavaIndex later re-exports the same type.

- [ ] **Step 3: 应用到所有 semantic candidate 入口**

Replace direct `fromFileUri()` in:

- definition/implementation candidate；
- references；
- type hierarchy；
- call hierarchy；
- workspace symbol location；
- public symbol/reference formatter。

When rejected:

```ts
metrics.semantic.externalLocationsSuppressed += 1;
```

No external absolute path may be retained in score breakdown or diagnostics. If the current HEAD already has a persisted semantic edge store, its write API must consume normalized `RepoLocation` values only; add a test proving an outside-repo raw LSP location cannot be persisted. If no edge store exists in the current source map, record that fact and leave creation to Task 33.

- [ ] **Step 4: 增加 error classifier**

In `src/runtime/intelligence-error.ts`:

```ts
export function classifySemanticError(error: unknown): JavaIntelligenceError {
  if (error instanceof JavaIntelligenceError) return error;
  const record = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; message?: unknown }
    : undefined;
  const name = typeof record?.name === "string" ? record.name : "";
  const code = typeof record?.code === "string" ? record.code : "";
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : String(error);

  if (name === "AbortError" || code === "ABORT_ERR" || code === "ERR_CANCELED") {
    return new JavaIntelligenceError("CANCELLED", message, error);
  }
  if (code === "ETIMEDOUT" || /timed out|deadline exceeded/i.test(message)) {
    return new JavaIntelligenceError("DEADLINE_EXCEEDED", message, error);
  }
  if (/not started|not ready/i.test(message)) {
    return new JavaIntelligenceError("JDT_NOT_READY", message, error);
  }
  if (/connection.*closed|process.*exit|broken pipe|EPIPE/i.test(message)) {
    return new JavaIntelligenceError("JDT_BROKEN", message, error);
  }
  return new JavaIntelligenceError("JDT_SERVER_ERROR", message, error);
}
```

Do not mark every caught error as timeout.

- [ ] **Step 5: 调整预期错误日志**

`requestSettled()` returns a typed outcome or throws classified error to gateway. Expected timeout/cancel uses debug metric, not `console.error` stack. Unknown JDT errors still log one concise line with requestId/method/code.

- [ ] **Step 6: 公共输出测试**

Add test to `src/tools/output-shape.test.ts`:

```ts
assert.equal(JSON.stringify(result).includes(tmpdir()), false);
assert.equal(JSON.stringify(result).includes(".m2/repository"), false);
assert.equal(JSON.stringify(result).includes("Library/Java/JavaVirtualMachines"), false);
```

- [ ] **Step 7: Run/Commit**

```bash
npm run build
node --test dist/semantic-location.test.js dist/tools/output-shape.test.js
npm test
git add src/semantic-location.ts src/semantic-location.test.ts src/path-utils.ts src/path-utils.test.ts src/runtime src/jdtls-session.ts src/agent-router src/tools
if [ -f src/semantic-edge-store.ts ]; then git add src/semantic-edge-store.ts; fi
if [ -f src/semantic-edge-store.test.ts ]; then git add src/semantic-edge-store.test.ts; fi
git commit -m "fix(semantic): contain locations to the active repository"
```

---

## Task 7：Hierarchy visited、显式预算与 cancellation 结算

**Files:**
- Modify: `src/jdtls-session.ts`
- Modify: `src/jdtls-session.test.ts`
- Modify: current semantic hierarchy provider

**Interfaces:**
- Consumes: `DeadlineBudget`。
- Produces:
  - `callHierarchy(file, line, column, direction, depth, limit, budget)`
  - `typeHierarchy(file, line, column, direction, depth, limit, budget)`
  - visited + request/edge/depth limits。

- [ ] **Step 1: 写 cycle 失败测试**

Fake hierarchy:

```text
A → B
B → A
```

Test:

```ts
test("type hierarchy stops on cycles and does not request the same item twice", async () => {
  const session = fakeReadySessionWithHierarchyCycle();
  const result = await session.typeHierarchy(
    file,
    1,
    1,
    "subtypes",
    10,
    100,
    DeadlineBudget.fromTimeout(1000)
  );
  assert.equal(result.edges.length, 2);
  assert.equal(session.fakeConnection.count("typeHierarchy/subtypes"), 2);
});
```

Expected current implementation may recurse repeatedly until depth.

- [ ] **Step 2: 修改 API**

```ts
async typeHierarchy(
  file: string,
  line: number,
  column: number,
  direction: "supertypes" | "subtypes",
  depth: number,
  limit: number,
  budget: DeadlineBudget
): Promise<HierarchyResult>
```

Same for call hierarchy.

Define the result contract:

```ts
export type HierarchyResult = {
  roots: unknown[];
  edges: HierarchyEdge[];
  completion: Completion;
  truncated: boolean;
  requests: number;
  visited: number;
  errorCode?: JavaIntelligenceErrorCode;
};
```

The initial `prepareTypeHierarchy/prepareCallHierarchy` request also consumes `budget.remainingMs(1000)`. If it times out, return an empty `PARTIAL_TIMEOUT` result; do not start traversal.

- [ ] **Step 3: 实现稳定 item key**

```ts
function hierarchyItemKey(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as Record<string, unknown>;
  const uri = typeof value.uri === "string" ? value.uri : "";
  const name = typeof value.name === "string" ? value.name : "";
  const range = isLspRange(value.selectionRange)
    ? value.selectionRange
    : isLspRange(value.range)
      ? value.range
      : undefined;
  if (!uri || !range) return undefined;
  return `${uri}:${range.start.line}:${range.start.character}:${name}`;
}
```

- [ ] **Step 4: 迭代遍历而非递归无限展开**

```ts
const queue = roots.map(item => ({ item, depth: 1 }));
const visited = new Set<string>();
let requests = 0;
const maxRequests = Math.min(limit, 64);

while (queue.length > 0 && edges.length < limit && requests < maxRequests) {
  budget.throwIfExpired(method);
  const current = queue.shift()!;
  if (current.depth > maxDepth) continue;
  const key = hierarchyItemKey(current.item);
  if (!key || visited.has(key)) continue;
  visited.add(key);
  requests += 1;
  const related = await this.request<unknown[]>(
    method,
    { item: current.item },
    budget.remainingMs(1500)
  );
  // append edges and unseen next items
}
```

Catch only classified deadline/cancellation around each request. Preserve collected edges and return `PARTIAL_TIMEOUT` or `CANCELLED`; unexpected JDT errors return `FAILED` with `JDT_SERVER_ERROR/JDT_BROKEN`. Reaching edge/request/depth caps returns `PARTIAL_LIMIT`. A normal exhausted queue returns `COMPLETE`. All locations pass through Task 6 containment before edge insertion.

- [ ] **Step 5: 记录 backend settlement**

When a request times out and sends cancellation, record two timestamps:

```ts
clientCompletedAt
backendPromiseSettledAt
```

Do not block the user response waiting indefinitely. In the low-level `request()` method, keep the raw `connection.sendRequest()` promise, attach a `.finally()` metric update to that raw promise, and separately race it against the client timeout. Do not use `requestSettled()` here because an `undefined` value loses timeout/cancel/server-error classification. Expose diagnostic metric:

```text
cancelBackendSettlementMs
```

- [ ] **Step 6: 更新 semantic provider**

All hierarchy calls pass the same request context budget. Remove any inner default 120000ms timeout.

- [ ] **Step 7: Run/Commit**

```bash
npm run build
node --test dist/jdtls-session.test.js
npm test
git add src/jdtls-session.ts src/jdtls-session.test.ts src/agent-router
git commit -m "fix(jdtls): bound hierarchy traversal by visited set and deadline"
```

---

## Task 8：Iteration A 验证与 phase report

**Files:**
- Create: `docs/phase-v3/phase1-correctness-report.md`
- Create: `artifacts/v3-phase1/`

**Interfaces:**
- Consumes: Tasks 1～7。
- Produces: 可发布的 correctness checkpoint。

- [ ] **Step 1: 全量验证**

```bash
npm run build
npm test
```

Expected: 0 fail.

- [ ] **Step 2: 运行定向故障测试**

```bash
node --test --test-name-pattern="concurrent ensureStarted|failed initialize|STARTING sessions|rg timeout|outside canonical repo|hierarchy stops" "dist/**/*.test.js"
```

Expected: all selected tests pass.

- [ ] **Step 3: 重跑三仓 cold benchmark**

Use Task 0 commands, output to:

```text
artifacts/v3-phase1/<commit>/
```

Expected:

- `R_read_must=1.0000` each repo；
- recall/P_read baseline-relative gate pass；
- no outside path；
- no new timeout stderr noise。

- [ ] **Step 4: 写 report**

Required tables:

```markdown
## Correctness Tests
| invariant | test | result |

## Before/After Quality
| project | recall before/after | P_read before/after | R_read_must |

## Before/After Latency
| project | P50 before/after | P95 before/after |

## Known Limits
```

- [ ] **Step 5: Commit**

```bash
git add docs/phase-v3/phase1-correctness-report.md artifacts/v3-phase1
git commit -m "docs(v3): validate correctness hardening"
```

Iteration A completion gate:

```text
all tests pass
no partial cache
no outside-repo output
no oversubscribe
no residual child after failed initialize
R_read_must=1.0000
```

---

# Iteration B：统一新鲜度与 generation


## Task 9：引入 JDT-independent RepoChangeCoordinator

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/repo-generation.ts`
- Test: `src/repo-generation.test.ts`
- Create: `src/worktree-identity.ts`
- Test: `src/worktree-identity.test.ts`
- Modify: `src/repo-resolver.ts`
- Modify: `src/repo-resolver.test.ts`
- Modify: `src/hooks/hook-gate.ts`
- Modify: `src/hooks/hook-gate.test.ts`
- Create: `src/repo-change-coordinator.ts`
- Test: `src/repo-change-coordinator.test.ts`
- Modify: `src/repo-runtime-manager.ts`
- Modify or delete after migration: `src/file-watcher.ts`

**Interfaces:**
- Consumes: current `layout-probe.ts` roots。
- Produces:
  - `GenerationClock`
  - `WorktreeIdentity` and `resolveWorktreeIdentity()`
  - `ResolvedRepo.worktree`
  - `RepoChangeBatch`
  - `RepoChangeCoordinator.start()/flushNow()/close()/status()`
  - change listeners independent from JDT session；
  - bounded watcher-ready preparation; Task 10 decides cache bypass/degraded policy。

- [ ] **Step 1: 添加 chokidar 并验证 v5 watcher 选项行为**

```bash
npm install --save-exact chokidar@5.0.0
node --input-type=module <<'NODE'
import chokidar from "chokidar";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("watch event timeout");
    await delay(20);
  }
};

const root = await mkdtemp(path.join(tmpdir(), "chokidar-v5-spike-"));
const file = path.join(root, "A.java");
const temp = path.join(root, "A.java.tmp");
const events = [];
const watcher = chokidar.watch(root, {
  ignoreInitial: true,
  ignored: candidate => candidate.endsWith(".tmp"),
  atomic: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 }
});
watcher.on("all", (event, changed) => events.push([event, path.basename(changed)]));
await new Promise((resolve, reject) => {
  watcher.once("ready", resolve);
  watcher.once("error", reject);
});

await writeFile(file, "class A {");
await delay(25);
await appendFile(file, "}\n");
await waitUntil(() => events.some(([event, name]) => event === "add" && name === "A.java"));
await delay(150);
const addEvents = events.filter(([, name]) => name === "A.java");
if (addEvents.length !== 1 || addEvents[0][0] !== "add") {
  throw new Error(`awaitWriteFinish did not coalesce writes: ${JSON.stringify(addEvents)}`);
}

events.length = 0;
await rename(file, temp);
await delay(20);
await rename(temp, file);
await waitUntil(() => events.some(([, name]) => name === "A.java"));
await delay(150);
if (events.some(([event, name]) => name === "A.java" && event === "unlink")) {
  throw new Error(`atomic rename surfaced unlink: ${JSON.stringify(events)}`);
}

await watcher.close();
await rm(root, { recursive: true, force: true });
console.log("CHOKIDAR_V5_OPTIONS_OK", JSON.stringify(events));
NODE
```

Expected: prints `CHOKIDAR_V5_OPTIONS_OK`; split writes produce one stable add, and the fast temp rename does not expose a final unlink for `A.java`. `package.json` and lockfile are updated and Node engine remains >=22. If chokidar v5 rejects an option or the measured macOS behavior does not satisfy these assertions, remove that option and rely on the coordinator's path merge/debounce; record the measured events in the phase report and do not add a v4/v5 compatibility branch.

- [ ] **Step 1a: 建立 WorktreeIdentity（后续所有 family 能力的唯一来源）**

Create `src/worktree-identity.ts`:

```ts
export type WorktreeIdentity = {
  repoRoot: string;
  repoHash: string;
  gitDir?: string;
  gitCommonDir?: string;
  familyHash?: string;
  isLinkedWorktree: boolean;
};

export async function resolveWorktreeIdentity(
  repoRoot: string
): Promise<WorktreeIdentity>;
```

Implementation uses canonical paths plus asynchronous `git -C <root> rev-parse` calls:

```text
repoRoot       = canonicalPath(input)
repoHash       = hashRepoPath(repoRoot)        // import repoHash as hashRepoPath
gitDir         = rev-parse --path-format=absolute --git-dir
gitCommonDir   = rev-parse --path-format=absolute --git-common-dir
familyHash     = hashRepoPath(gitCommonDir)
isLinked       = gitDir != gitCommonDir
```

Outside Git, return only repoRoot/repoHash and `isLinkedWorktree=false`. Do not throw merely because Git metadata is absent.

Use a real temporary Git repository and `git worktree add` test:

```ts
test("linked worktrees share familyHash but retain distinct repoHash", async () => {
  const fixture = await createGitWorktreeFamily();
  const primary = await resolveWorktreeIdentity(fixture.primary);
  const linked = await resolveWorktreeIdentity(fixture.linked);
  assert.notEqual(primary.repoHash, linked.repoHash);
  assert.equal(primary.familyHash, linked.familyHash);
  assert.equal(linked.isLinkedWorktree, true);
});
```

The helper `createGitWorktreeFamily()` is committed under `src/test-support/git-worktree.ts` and reused by Tasks 12a/12b/21a. It runs only local Git commands and configures fixture-local user.name/user.email.

Extend `ResolvedRepo` and resolve the identity once in `RepoResolver.resolve()`:

Add a small promise cache in `src/worktree-identity.ts` so repeated tool calls do not spawn Git repeatedly:

```ts
export class WorktreeIdentityCache {
  private readonly entries = new Map<string, Promise<WorktreeIdentity>>();

  resolve(inputRoot: string): Promise<WorktreeIdentity> {
    const root = canonicalPath(inputRoot);
    const existing = this.entries.get(root);
    if (existing) return existing;
    const operation = resolveWorktreeIdentity(root).catch(error => {
      if (this.entries.get(root) === operation) this.entries.delete(root);
      throw error;
    });
    this.entries.set(root, operation);
    return operation;
  }

  invalidate(inputRoot?: string): void {
    if (inputRoot) this.entries.delete(canonicalPath(inputRoot));
    else this.entries.clear();
  }
}
```

Extend `ResolvedRepo` and make the identity cache the single owner of Git common-dir discovery:

```ts
export type ResolvedRepo = {
  repoRoot: string;
  rootSource: RootSource;
  repoHash: string;
  aliases: string[];
  layoutProfile: "ddd-gradle" | "maven-reactor" | "generic-java";
  lsp: LspEnablement;
  worktree: WorktreeIdentity;
};

export class RepoResolver {
  constructor(
    private readonly registry: AliasRegistry,
    private readonly identities = new WorktreeIdentityCache()
  ) {}

  async resolve(selector: RepoSelector): Promise<ResolvedRepo> {
    await this.registry.reloadIfChanged();
    const resolvedRoot = this.resolveRoot(selector);
    const repoRoot = canonicalPath(resolvedRoot.repoRoot);
    const worktree = await this.identities.resolve(repoRoot);
    const matchingAliases = this.registry.aliases().filter(alias => alias.root === repoRoot);
    return {
      repoRoot,
      rootSource: resolvedRoot.source,
      repoHash: worktree.repoHash,
      aliases: matchingAliases.map(alias => alias.id),
      layoutProfile: matchingAliases[0]?.layoutProfile || inferLayoutProfile(repoRoot),
      lsp: await this.resolveEnablementFromIdentity(worktree),
      worktree
    };
  }

  async resolveEnablement(repoRoot: string): Promise<LspEnablement> {
    await this.registry.reloadIfChanged();
    return this.resolveEnablementFromIdentity(await this.identities.resolve(repoRoot));
  }

  private async resolveEnablementFromIdentity(identity: WorktreeIdentity): Promise<LspEnablement> {
    const repoRoot = identity.repoRoot;
    const enabledAliases = this.registry.aliases().filter(alias => alias.lspEnabled);
    const direct = deepestWithin(enabledAliases, repoRoot);
    if (direct) {
      return {
        enabled: true,
        matchedBy: "direct-root",
        configuredRoot: direct.root,
        effectiveRepoRoot: repoRoot
      };
    }

    if (identity.gitCommonDir) {
      const familyMatches: ProjectAliasConfig[] = [];
      for (const alias of enabledAliases) {
        const aliasIdentity = await this.identities.resolve(alias.root);
        if (aliasIdentity.gitCommonDir === identity.gitCommonDir) familyMatches.push(alias);
      }
      if (familyMatches.length === 1) {
        return {
          enabled: true,
          matchedBy: "git-worktree-family",
          configuredRoot: familyMatches[0]!.root,
          effectiveRepoRoot: repoRoot
        };
      }
      if (familyMatches.length > 1) {
        return {
          enabled: false,
          matchedBy: "conflict",
          effectiveRepoRoot: repoRoot,
          reason: "Multiple enabled aliases share this Git common-dir; configure this worktree explicitly."
        };
      }
    }

    const disabled = deepestWithin(this.registry.aliases().filter(alias => !alias.lspEnabled), repoRoot);
    return {
      enabled: false,
      matchedBy: disabled ? "disabled" : "unregistered",
      configuredRoot: disabled?.root,
      effectiveRepoRoot: repoRoot,
      reason: disabled ? "Project alias is registered with lspEnabled=false." : "Project root is not LSP-enabled.",
      enableHint: `./register-alias.sh --enable-lsp <id> ${repoRoot}`
    };
  }
}
```

Delete the old independent `gitWorktree()`/`spawnSync("git")` implementation. Convert hook call sites to await `resolveEnablement()` and retain the existing silent-pass/conflict semantics.

Add a resolver test proving `resolved.worktree.repoRoot === resolved.repoRoot`, `resolved.repoHash === resolved.worktree.repoHash`, and linked-family enablement still behaves exactly as before.

- [ ] **Step 2: 写 GenerationClock 测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { GenerationClock } from "./repo-generation.js";

test("generation advances monotonically and dirty clear is compare-and-set", () => {
  const clock = new GenerationClock();
  assert.deepEqual(clock.snapshot(), { value: 1, dirty: false });
  assert.equal(clock.rebaseAtLeast(41), 41);
  assert.equal(clock.rebaseAtLeast(3), 41);
  assert.equal(clock.advance("java change"), 42);
  assert.equal(clock.markDirty("watcher failure"), 43);
  assert.deepEqual(clock.snapshot(), { value: 43, dirty: true });
  clock.clearDirty(42);
  assert.equal(clock.snapshot().dirty, true);
  clock.clearDirty(43);
  assert.equal(clock.snapshot().dirty, false);
});
```

- [ ] **Step 3: 实现 GenerationClock**

```ts
export class GenerationClock {
  private value = 1;
  private dirty = false;
  private lastReason = "initial";
  private lastChangedAt = new Date();

  snapshot(): { value: number; dirty: boolean } {
    return { value: this.value, dirty: this.dirty };
  }

  rebaseAtLeast(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`invalid generation rebase: ${value}`);
    }
    this.value = Math.max(this.value, value);
    this.lastReason = "snapshot rebase";
    this.lastChangedAt = new Date();
    return this.value;
  }

  status(): { value: number; dirty: boolean; lastReason: string; lastChangedAt: string } {
    return {
      value: this.value,
      dirty: this.dirty,
      lastReason: this.lastReason,
      lastChangedAt: this.lastChangedAt.toISOString()
    };
  }

  advance(reason: string): number {
    this.value += 1;
    this.lastReason = reason;
    this.lastChangedAt = new Date();
    return this.value;
  }

  markDirty(reason: string): number {
    this.dirty = true;
    return this.advance(reason);
  }

  clearDirty(expectedGeneration: number): void {
    if (this.value === expectedGeneration) this.dirty = false;
  }
}
```

- [ ] **Step 4: 定义 change batch 与合并规则测试**

```ts
export type RepoChangeKind =
  | "JAVA_ADD"
  | "JAVA_CHANGE"
  | "JAVA_DELETE"
  | "RESOURCE_CHANGE"
  | "BUILD_CHANGE"
  | "WATCHER_DEGRADED";

export type RepoChange = {
  kind: RepoChangeKind;
  absolutePath: string;
};

export type RepoChangeBatch = {
  generation: number;
  observedAt: string;
  changes: RepoChange[];
};
```

Test merge table:

```ts
for (const [oldKind, newKind, expected] of [
  ["JAVA_ADD", "JAVA_CHANGE", "JAVA_ADD"],
  ["JAVA_CHANGE", "JAVA_DELETE", "JAVA_DELETE"],
  ["JAVA_DELETE", "JAVA_ADD", "JAVA_CHANGE"]
] as const) {
  assert.equal(mergeChangeKind(oldKind, newKind), expected);
}
assert.equal(mergeChangeKind("JAVA_ADD", "JAVA_DELETE"), undefined);
```

- [ ] **Step 5: 实现 coordinator**

Essential constructor:

```ts
export class RepoChangeCoordinator {
  private watcher?: FSWatcher;
  private readonly pending = new Map<string, RepoChangeKind>();
  private readonly listeners = new Set<(batch: RepoChangeBatch) => Promise<void> | void>();
  private flushTimer?: NodeJS.Timeout;
  private flushPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private ready = false;
  private lastError?: string;

  constructor(
    private readonly repoRoot: string,
    private readonly identity: WorktreeIdentity,
    private readonly cacheBase: string,
    private readonly clock: GenerationClock,
    private readonly layout: () => LayoutContext,
    private readonly debounceMs = 150
  ) {}
}
```

Build a typed watch plan before `start()`:

```ts
export type RepoWatchPlan = {
  sourceRoots: string[];
  resourceRoots: string[];
  generatedRoots: string[]; // only build-model/layout-probe allowlisted roots
  buildFiles: string[];
  targets: string[];
};

export function buildRepoWatchPlan(repoRoot: string, layout: LayoutContext): RepoWatchPlan;
```

`targets` is the unique union of existing source/resource/generated roots and exact build marker paths under the root/known modules:

```text
pom.xml
.mvn/jvm.config
build.gradle / build.gradle.kts
settings.gradle / settings.gradle.kts
gradle.properties
gradle/libs.versions.toml
.java-version
.sdkmanrc
```

Chokidar may watch a not-yet-existing exact build marker; BUILD_CHANGE causes Task 11 to reprobe layout and restart the watch plan. Do not recursively watch arbitrary docs/media directories.

`start()`:

```ts
const plan = buildRepoWatchPlan(this.repoRoot, this.layout());
this.watcher = chokidar.watch(plan.targets, {
  ignoreInitial: true,
  persistent: true,
  followSymlinks: false,
  atomic: true,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  ignored: candidate => isIgnoredRepoPath(
    candidate,
    this.identity,
    this.cacheBase,
    plan.generatedRoots
  )
});
this.watcher
  .on("add", file => this.queue(classifyAdd(file)))
  .on("change", file => this.queue(classifyChange(file)))
  .on("unlink", file => this.queue(classifyDelete(file)))
  .on("error", error => this.degrade(error));
```

`isIgnoredRepoPath()` is a required, tested contract:

```ts
export function isIgnoredRepoPath(
  candidate: string,
  identity: WorktreeIdentity,
  cacheBase: string,
  explicitGeneratedRoots: readonly string[]
): boolean {
  const absolute = path.resolve(candidate);
  if (absolute === path.join(identity.repoRoot, ".git")) return true; // linked-worktree file or normal directory
  if (identity.gitCommonDir && isWithin(identity.gitCommonDir, absolute)) return true;
  if (isWithin(cacheBase, absolute)) return true;
  if (explicitGeneratedRoots.some(root => isWithin(root, absolute) || isWithin(absolute, root))) {
    return false;
  }
  return path.normalize(absolute).split(path.sep).some(segment =>
    new Set([".git", ".gradle", "build", "target", "out", "bin", "node_modules", "dist"]).has(segment)
  );
}
```

The `isWithin(absolute, root)` half keeps chokidar from pruning an ancestor of an explicitly watched generated root. It is only allowed for roots supplied by layout/build detection; arbitrary output directories never bypass ignore.

Add tests for a linked-worktree root `.git` **file**, the resolved `gitCommonDir`, every generated/cache segment, and an allowlisted `target/generated-sources/annotations` root. Ignored paths may not queue a change or advance generation; the allowlisted generated Java file must queue one. Task 12b repeats the ignore invariant under a 500-file storm.

Add classification tests:

```text
.java under source/generated root   -> JAVA_ADD/JAVA_CHANGE/JAVA_DELETE
supported mapper XML under resource -> RESOURCE_CHANGE
exact build marker                  -> BUILD_CHANGE
all other watched events            -> ignored
```

`start()` is singleflight and resolves only after chokidar emits `ready`; set `ready=true` in that callback. `close()` may be called during startup and must settle `startPromise` without leaving a watcher. Runtime creation stores this promise; Task 10 waits for it only within `min(2s, request remaining budget)`. Before ready, requests may proceed DEGRADED but cannot read/write generation-scoped caches or answer negative lookups.

`queue()` merges by path and schedules flush. It does not advance generation repeatedly for every editor write. `flushNow()` cancels the debounce timer, awaits an active flush or starts one immediately, and is called before a request snapshots generation. This closes the stale window where an event is already queued but the 150ms debounce has not fired.

`flush()` uses a singleflight promise and a while loop so events arriving during listener execution remain pending:

```ts
private flush(): Promise<void> {
  if (this.flushPromise) return this.flushPromise;
  const operation = (async () => {
    while (this.pending.size > 0) {
      const changes = [...this.pending]
        .map(([absolutePath, kind]) => ({ absolutePath, kind }))
        .sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
      this.pending.clear();
      const generation = this.clock.advance(summarizeChanges(changes));
      const batch: RepoChangeBatch = {
        generation,
        observedAt: new Date().toISOString(),
        changes
      };
      for (const listener of this.listeners) {
        try {
          await listener(batch);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.clock.markDirty(`change listener failed at generation ${generation}`);
        }
      }
    }
  })().finally(() => {
    if (this.flushPromise === operation) this.flushPromise = undefined;
  });
  this.flushPromise = operation;
  return operation;
}

async flushNow(): Promise<void> {
  if (this.flushTimer) {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
  await this.flush();
}
```

`degrade(error)` calls `clock.markDirty` once, emits a `WATCHER_DEGRADED` batch at that returned generation without a second increment, records concise status, and closes the broken watcher. Listener failure also marks dirty but does not prevent remaining listeners from receiving the original batch. A dirty runtime is reconciled before cacheable use in Task 11.

- [ ] **Step 6: 写 watcher-independent runtime test**

The test creates a runtime with LSP disabled, starts coordinator, edits a Java file, and waits for generation > 1. It must not start JDT LS.

```ts
assert.equal(session.status().state, "NEW");
assert.ok(runtime.generation.status().value > 1);
```

Use a bounded `waitUntil()` helper with 2s timeout; do not use fixed long sleeps.

Add a deterministic queued-event test with an injected fake watcher or direct `queueForTest()` hook:

```ts
coordinator.queueForTest({ kind: "JAVA_CHANGE", absolutePath: file });
assert.equal(clock.snapshot().value, 1); // still debounced
await coordinator.flushNow();
assert.equal(clock.snapshot().value, 2);
assert.equal(listenerBatches, 1);
```

Also prove a listener exception marks the clock dirty and does not prevent a second listener from applying the batch.

- [ ] **Step 7: 在 RepoRuntime 创建时启动 coordinator**

`createRuntime(resolved)` constructs in this order:

```text
resolved.worktree (already canonical and family-aware)
GenerationClock
LayoutManager/current layout
RepoChangeCoordinator(resolved.worktree)
JavaIndex/old SourceIndex adapter
JdtlsSession
Router
```

Add `worktree: WorktreeIdentity` to `ManagedToolContext`. If the current runtime factory/get-or-create path is synchronous, convert it to an async creation singleflight:

```ts
private readonly creating = new Map<string, Promise<RuntimeEntry>>();

private async getOrCreate(resolved: ResolvedRepo): Promise<RuntimeEntry> {
  const existing = this.runtimes.get(resolved.repoRoot);
  if (existing) return existing;
  const pending = this.creating.get(resolved.repoRoot);
  if (pending) return pending;
  const operation = this.createEntry(resolved).finally(() => {
    if (this.creating.get(resolved.repoRoot) === operation) {
      this.creating.delete(resolved.repoRoot);
    }
  });
  this.creating.set(resolved.repoRoot, operation);
  return operation;
}
```

`createEntry()` registers coordinator listeners before `start()` so first event cannot be lost. Store `runtime.ready = coordinator.start()`, but **do not unconditionally await it in `contextFor()/withContext()`**. Task 10 adds `awaitReadyWithin(min(2s, request remaining budget))`; on timeout the request proceeds DEGRADED with query-cache/negative-cache/persistence disabled. Before a watcher-ready request creates `RequestContext`, call `await coordinator.flushNow()` so already-delivered events cannot remain hidden behind debounce.

Add a concurrency test proving two simultaneous `contextFor()` calls for the same repo share one runtime, one WorktreeIdentity resolution, one coordinator and one watcher.

JDT session no longer owns the only repo watcher. Task 9 may temporarily leave its own file watcher active, but the two systems must not both mutate generation. Task 10 removes JDT-owned invalidation ownership.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/repo-generation.test.js dist/worktree-identity.test.js dist/repo-resolver.test.js dist/hooks/hook-gate.test.js dist/repo-change-coordinator.test.js dist/repo-runtime-manager.test.js
npm test
git add package.json package-lock.json src/repo-generation.ts src/repo-generation.test.ts src/worktree-identity.ts src/worktree-identity.test.ts src/test-support/git-worktree.ts src/repo-resolver.ts src/repo-resolver.test.ts src/hooks/hook-gate.ts src/hooks/hook-gate.test.ts src/repo-change-coordinator.ts src/repo-change-coordinator.test.ts src/repo-runtime-manager.ts src/file-watcher.ts
git commit -m "feat(freshness): add repo-wide generation and independent watcher"
```

---

## Task 10：把统一 generation 接入 rg、SourceIndex、semantic cache 与 edge store

**Files:**
- Modify: `src/repo-runtime-manager.ts`
- Modify: `src/search/rg-cache.ts`
- Modify: current SourceIndex owner
- Modify: current edge store owner if present
- Modify: `src/jdtls-session.ts`
- Modify: current AgentRouter constructor/options
- Test: `src/freshness-integration.test.ts`

**Interfaces:**
- Consumes: `RepoChangeBatch`。
- Produces: one generation seen by every repo-scoped cache。

- [ ] **Step 1: 写 fast path cache invalidation 失败测试**

Fixture has `DemoController` and `FirstService`. First impact caches rg result. Edit controller/reference to `SecondService`, emit or observe change batch, run again.

Assertions:

```ts
assert.ok(first.files.some(file => pathEnds(file, "FirstService.java")));
assert.ok(second.files.some(file => pathEnds(file, "SecondService.java")));
assert.equal(second.files.some(file => pathEnds(file, "FirstService.java")), false);
assert.ok(second.metrics.freshness.requestGeneration > first.metrics.freshness.requestGeneration);
assert.equal(fakeJdtSession.ensureStartedCalls, 0);
```

Expected: current fast path may reuse old cache.

- [ ] **Step 2: 建立 request freshness barrier 并固定 RequestContext generation**

`RepoRuntimeManager.withContext()` must prepare freshness **before** taking the request snapshot:

```ts
const ready = await entry.coordinator.awaitReadyWithin(
  Math.min(2_000, requestBudget.remainingMs())
);

let freshnessMode: RequestFreshnessMode;
let cacheReadAllowed = false;
let cacheWriteAllowed = false;
let negativeLookupAllowed = false;

if (ready) {
  await entry.coordinator.flushNow();        // already-delivered debounced events
  await entry.reconcileIfDirty();            // Task 11 singleflight; no-op while clean
  await entry.coordinator.flushNow();        // events delivered during reconcile
  const clock = entry.generation.snapshot();
  freshnessMode = clock.dirty ? "WATCHER_DEGRADED" : "NORMAL";
  cacheReadAllowed = !clock.dirty;
  cacheWriteAllowed = !clock.dirty;
  negativeLookupAllowed = !clock.dirty && entry.sourceIndex.coverageCompleteAt(clock.value);
} else {
  // Large-repo initial scan or watcher failure must not block the whole request.
  freshnessMode = entry.generation.snapshot().dirty
    ? "WATCHER_DEGRADED"
    : "WATCHER_NOT_READY";
  // Positive anchor facts are refreshed directly; rg executes uncached.
  // No query-cache read/write, negative answer or semantic-edge persistence.
}

const generation = entry.generation.snapshot().value;
const request = createRequestContext({
  repoRoot: entry.context.repoRoot,
  repoHash: entry.context.repoHash,
  familyHash: entry.context.worktree.familyHash,
  generation,
  freshnessMode,
  cacheReadAllowed,
  cacheWriteAllowed,
  negativeLookupAllowed,
  mode: requestOptions.mode,
  semanticPolicy: requestOptions.semanticPolicy,
  deadlineMs: requestOptions.deadlineMs
});
```

`reconcileIfDirty()` may be introduced as a no-op shell in this task and completed in Task 11, but its call position is fixed here. A watcher-ready timeout is not an MCP failure: the request proceeds with foreground `ensureFresh(anchor)`, uncached `rg`, `coverage=DEGRADED`, `cacheReadAllowed=false`, `cacheWriteAllowed=false` and `negativeLookupAllowed=false`. It must not claim a complete negative result or persist semantic edges.

Pass `request` explicitly to tools/router rather than reading generation ad hoc midway. If changing all tool signatures in one task is too broad, add it to a **per-call** wrapper object returned by `prepareRequestContext()`; never store the active request on shared RepoRuntime state.

- [ ] **Step 3: Coordinator listener invalidation**

```ts
coordinator.onBatch(async batch => {
  runtime.router.invalidateGeneration(batch.generation);
  runtime.sourceIndex.applyChanges?.(batch);
  runtime.edgeStore?.invalidate(batch);
  runtime.session.invalidateForRepoChanges(batch);
  if (batch.changes.some(change => change.kind === "BUILD_CHANGE")) {
    runtime.layout.refresh();
  }
});
```

During pre-V2 SourceIndex, `applyChanges` must at least:

- evict changed/deleted cache entries；
- clear type lookup indexes for old facts；
- clear scan fallback cache；
- remove persisted records for deleted files or mark V1 snapshot invalid。

- [ ] **Step 4: rg cache uses request generation**

Remove any key generation derived from `session.cacheStatus().invalidations`. Use:

```ts
const cached = request.cacheReadAllowed
  ? rgCache.get(key, request.generation)
  : undefined;
if (cached) return cached;

const result = await executeSearch(query, request.budget);
if (request.cacheWriteAllowed && result.completion === "COMPLETE") {
  rgCache.set(key, request.generation, result);
}
return result;
```

- [ ] **Step 5: JDT cache generation/dependency invalidation**

For completed JDT cache entry:

```ts
type CacheEntry<T> = {
  value: T;
  createdAt: number;
  expiresAt: number;
  generation: number;
  dependencies: Map<string, string>;
};
```

Read requires:

```text
entry.generation === request.generation
and each dependency fingerprint unchanged
```

When change batch arrives, remove entries whose dependency file changed. Build change clears all JDT completed cache because classpath/import semantics may change.

- [ ] **Step 6: Edge store generation（本阶段采用全量失效）**

If Task 0 found a persisted semantic edge store, wire it to the unified generation, but keep Iteration B deliberately simple:

- every completed edge records the generation and dependency fingerprints available in the current implementation；
- **any** Java add/change/delete or build change clears the current semantic edge store；
- no old-generation promotion is implemented in Iteration B；
- Task 33 introduces dependency-selective `SemanticEdgeStoreV2` only after complete-only semantics and atomic persistence are tested。

This choice removes an entire class of stale-edge bugs while freshness is being established.

- [ ] **Step 7: changed-during-request marker**

Before output formatting:

```ts
const current = runtime.generation.snapshot().value;
result.freshness.changedDuringRequest = current !== request.generation;
```

No cache writes from the request are allowed if current generation differs from request generation.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/freshness-integration.test.js dist/search/rg-cache.test.js
npm test
git add src/repo-runtime-manager.ts src/search src/source-index.ts src/jdtls-session.ts src/agent-router src/freshness-integration.test.ts
git commit -m "fix(freshness): unify repo generation across routing caches"
```

---

## Task 11：delete/rename 驱逐、build change layout refresh 与 dirty reconcile

**Files:**
- Modify: `src/repo-change-coordinator.ts`
- Modify: `src/layout-probe.ts`
- Create: `src/layout-manager.ts`
- Test: `src/layout-manager.test.ts`
- Modify: current SourceIndex/edge store
- Test: `src/freshness-mutation.test.ts`

**Interfaces:**
- Produces:
  - `LayoutManager.current()/refresh()`
  - delete/rename stale-free behavior
  - dirty on-demand reconcile。

- [ ] **Step 1: 写 rename/delete 失败测试**

```ts
test("rename removes old facts, old edges, and old candidate paths", async () => {
  const oldFile = await writeJava("OldService.java", "public class OldService {}");
  await runtime.impact(anchor);
  await rename(oldFile, oldFile.replace("OldService", "NewService"));
  await runtime.coordinator.flushForTest();

  const result = await runtime.impact(anchor);
  assert.equal(JSON.stringify(result).includes("OldService.java"), false);
  assert.equal(runtime.sourceIndex.hasPath(oldFile), false);
  assert.equal(runtime.edgeStore?.hasDependency(oldFile) ?? false, false);
});
```

Add separate delete case.

- [ ] **Step 2: 建立 LayoutManager**

```ts
export class LayoutManager {
  private value: LayoutContext;
  private fingerprint: string;

  constructor(private readonly repoRoot: string) {
    this.value = probeLayout(repoRoot);
    this.fingerprint = layoutBuildFingerprint(repoRoot);
  }

  current(): LayoutContext { return this.value; }

  refresh(): { changed: boolean; layout: LayoutContext } {
    const nextFingerprint = layoutBuildFingerprint(this.repoRoot);
    if (nextFingerprint === this.fingerprint) {
      return { changed: false, layout: this.value };
    }
    this.value = probeLayout(this.repoRoot);
    this.fingerprint = nextFingerprint;
    return { changed: true, layout: this.value };
  }
}
```

Fingerprint includes existing root/module:

- `pom.xml`
- module `pom.xml`
- `settings.gradle(.kts)`
- `build.gradle(.kts)`
- `gradle.properties`
- `gradle/libs.versions.toml`

Use async hashing outside hot request path where possible. Initial V3 may use size/mtime fingerprint because build change also advances generation.

- [ ] **Step 3: build change reconfigure watcher roots**

When `LayoutManager.refresh().changed`:

1. compute next watch roots；
2. update chokidar with `add()` and `unwatch()`；
3. invalidate rg cache；
4. mark index coverage for removed/new roots UNKNOWN；
5. schedule reconcile。

- [ ] **Step 4: SourceIndex delete API**

Pre-V2 adapter must expose:

```ts
removeFiles(files: string[]): void;
invalidateFiles(files: string[]): void;
reconcile(layout: LayoutContext, generation: number): Promise<void>;
```

`removeFiles` must unindex type name, type refs, implementer edges and persisted records. It is not enough to remove only file cache entry.

- [ ] **Step 5: dirty reconcile singleflight**

Expose on the runtime:

```ts
async reconcileIfDirty(): Promise<void> {
  if (!this.generation.snapshot().dirty) return;
  if (!this.reconcilePromise) {
    this.reconcilePromise = (async () => {
      const generationAtStart = this.generation.snapshot().value;
      await this.sourceIndex.reconcile(this.layout.current(), generationAtStart);
      this.generation.clearDirty(generationAtStart);
    })().finally(() => {
      this.reconcilePromise = undefined;
    });
  }
  await this.reconcilePromise;
}
```

Only one reconcile runs per repo. `clearDirty(expectedGeneration)` is compare-and-set: an event arriving during reconcile advances generation, so dirty remains true and the next request reconciles again. If reconcile fails, dirty remains true, output coverage is DEGRADED, and bounded lexical fallback continues.

- [ ] **Step 6: Run/Commit**

```bash
npm run build
node --test dist/freshness-mutation.test.js dist/layout-manager.test.js
npm test
git add src/repo-change-coordinator.ts src/layout-manager.ts src/layout-manager.test.ts src/layout-probe.ts src/source-index.ts src/freshness-mutation.test.ts
git commit -m "fix(freshness): evict deleted files and refresh repository layout"
```

---

## Task 12：回收 stopped runtime 与 AliasRegistry last-known-good

**Files:**
- Modify: `src/repo-runtime-manager.ts`
- Modify: `src/repo-runtime-manager.test.ts`
- Modify: `src/alias-registry.ts`
- Modify: `src/alias-registry.test.ts` or create it

**Interfaces:**
- Produces:
  - stopped context bounded LRU/removal；
  - invalid config does not destroy last valid registry。

- [ ] **Step 1: 写 runtime eviction 失败测试**

```ts
test("fully stopped idle runtimes are removed from the runtime map", async () => {
  const manager = createManager({ maxRetainedStoppedRepos: 2 });
  for (const repo of ["/a", "/b", "/c"]) {
    await manager.withContext({ repoRoot: repo }, async () => undefined);
    await manager.shutdown(repo);
  }
  assert.equal(manager.activeRepos().length, 2);
  assert.equal(manager.hasRuntime("/a"), false);
});
```

- [ ] **Step 2: 实现 bounded retention**

Add option:

```ts
maxRetainedStoppedRepos: positiveInteger(
  process.env.JAVA_LSP_MAX_RETAINED_STOPPED_REPOS,
  2
)
```

After stop:

- close coordinator；
- flush/close index client when V2 exists；
- unsubscribe lifecycle；
- clear rg cache；
- mark stoppedAt；
- evict oldest stopped entries beyond limit。

A never-started but idle context also counts as retained stopped context.

- [ ] **Step 3: 写 invalid config fallback test**

```ts
test("AliasRegistry retains last known good config when a reload is invalid", async () => {
  await writeConfig(validConfig("repo-a"));
  const registry = new AliasRegistry(configPath);
  await registry.reloadIfChanged();
  assert.equal(registry.aliases()[0].id, "repo-a");

  await writeFile(configPath, "{broken");
  await registry.reloadIfChanged();

  assert.equal(registry.aliases()[0].id, "repo-a");
  assert.match(registry.status().lastReloadError ?? "", /JSON/);
});
```

- [ ] **Step 4: 实现 last-known-good**

`reloadIfChanged()` catches read/JSON/zod errors after one valid snapshot exists:

```ts
try {
  const next = await loadAndValidate();
  this.snapshot = next;
  this.lastReloadError = undefined;
} catch (error) {
  this.lastReloadError = errorMessage(error);
  this.lastReloadErrorAt = new Date();
  if (!this.snapshot.loadedOnce) throw error;
}
```

Status diagnostic exposes error; normal tool calls continue using previous config.

If config file is intentionally deleted, aliases become empty because deletion is a valid state, not parse failure.

- [ ] **Step 5: Run/Commit**

```bash
npm run build
node --test dist/repo-runtime-manager.test.js dist/alias-registry.test.js
npm test
git add src/repo-runtime-manager.ts src/repo-runtime-manager.test.ts src/alias-registry.ts src/alias-registry.test.ts
git commit -m "fix(runtime): bound stopped contexts and retain valid alias config"
```

---

## Task 12a：扩展 WorktreeIdentity 并实现跨进程 JDT/sweep 文件 lease

**Files:**
- Modify: `src/worktree-identity.ts`
- Modify: `src/worktree-identity.test.ts`
- Reuse: `src/test-support/git-worktree.ts`
- Create: `src/cross-process-lease.ts`
- Test: `src/cross-process-lease.test.ts`
- Modify: `src/repo-runtime-manager.ts`
- Modify: `src/repo-runtime-manager.test.ts`
- Modify: `src/server.ts`
- Modify: `src/jdtls-session.ts`
- Modify: `src/tools/impact.ts`
- Modify: `src/tools/symbol.ts`
- Modify: `src/tools/references.ts`
- Modify: `src/tools/status.ts`

**Interfaces:**
- Consumes: Task 9 `WorktreeIdentity`、process-local Task 4 reservation、`DeadlineBudget`、`repoCacheBase()`。
- Produces:
  - `leaseFamilyKey(identity)`
  - `CrossProcessLeaseStore`
  - machine-level fixed JDT/sweep slots
  - same-worktree exclusive JDT lease
  - typed `JDT_BUSY_OTHER_SESSION`

- [ ] **Step 1: 扩展 Task 9 worktree identity 测试供 lease 使用**

Reuse the real temporary Git repository with two linked worktrees:

```ts
test("linked worktrees share familyHash but keep distinct repoHash", async () => {
  const fixture = await createGitWorktreeFamily();
  const primary = await resolveWorktreeIdentity(fixture.primary);
  const linked = await resolveWorktreeIdentity(fixture.linked);

  assert.notEqual(primary.repoRoot, linked.repoRoot);
  assert.notEqual(primary.repoHash, linked.repoHash);
  assert.equal(primary.gitCommonDir, linked.gitCommonDir);
  assert.equal(primary.familyHash, linked.familyHash);
  assert.equal(linked.isLinkedWorktree, true);
});
```

`createGitWorktreeFamily()` runs only local `git init/add/commit/worktree add`; no network.

- [ ] **Step 2: 冻结 lease family key，而不改变 Task 9 identity 语义**

Add:

```ts
export function leaseFamilyKey(identity: WorktreeIdentity): string {
  return identity.familyHash ?? identity.repoHash;
}
```

Tests prove non-Git repos use repoHash while linked worktrees use the shared familyHash. `familyHash` remains forbidden in JavaIndex/query cache identity.

- [ ] **Step 3: 写 fixed-slot 与 same-worktree lease 失败测试**

Use two independent `CrossProcessLeaseStore` instances pointed at the same temp directory, with distinct owner tokens and injected PID liveness:

```ts
test("two processes cannot exceed one machine JDT slot", async () => {
  const shared = await tempLeaseRoot();
  const first = leaseStore(shared, { pid: 101, alive: new Set([101, 202]), jdtSlots: 1 });
  const second = leaseStore(shared, { pid: 202, alive: new Set([101, 202]), jdtSlots: 1 });

  const a = await first.acquireJdt(identity("/repo-a", "a"), budget());
  assert.equal(a.kind, "ACQUIRED");
  const b = await second.tryAcquireJdt(identity("/repo-b", "b"));
  assert.equal(b.kind, "NO_GLOBAL_SLOT");

  await a.lease.release();
  const b2 = await second.acquireJdt(identity("/repo-b", "b"), budget());
  assert.equal(b2.kind, "ACQUIRED");
  await b2.lease.release();
});

test("same worktree second process is rejected before a second JDT slot", async () => {
  const shared = await tempLeaseRoot();
  const first = leaseStore(shared, { pid: 101, alive: new Set([101, 202]), jdtSlots: 2 });
  const second = leaseStore(shared, { pid: 202, alive: new Set([101, 202]), jdtSlots: 2 });
  const id = identity("/same-worktree", "same");

  const a = await first.acquireJdt(id, budget());
  const b = await second.tryAcquireJdt(id);
  assert.equal(a.kind, "ACQUIRED");
  assert.equal(b.kind, "BUSY_SAME_WORKTREE");
  assert.equal(await countClaimedSlots(shared, "jdt-slots"), 1);
  await a.lease.release();
});
```

Also test:

1. a dead-PID worktree lease is reclaimed；
2. a dead owner with no live JDT child allows worktree/global slot reclaim；
3. a dead owner whose recorded `jdtlsPid` is still alive is reported as `ORPHAN_JDT` and is **not** reclaimed；after the child exits it becomes reclaimable；
4. a live PID with stale heartbeat is **not** stolen；
5. a directory created without metadata is reclaimed only after `orphanGraceMs`；
6. release with a different ownerToken cannot delete another owner’s lease；
7. timeout while waiting leaves no worktree lease behind；
8. two stores request different `jdtSlots` while one lease is live: both obey the persisted capacity and status reports the conflict；after all live leases release, the next opener may atomically replace capacity；
9. a dead owner or metadata-less expired `capacity.lock` is reclaimed, while a live lock owner is never stolen。

- [ ] **Step 4: 实现 atomic lease primitive**

```ts
export type LeaseOwner = {
  ownerToken: string;
  pid: number;
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  jdtlsPid?: number;
  acquiredAt: string;
  heartbeatAt: string;
};

export interface LeaseHandle {
  readonly kind: "RUNTIME" | "JDT_WORKTREE" | "JDT_SLOT" | "SWEEP_SLOT";
  readonly path: string;
  readonly owner: LeaseOwner;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export type JdtLeaseAcquireResult =
  | { kind: "ACQUIRED"; lease: CompositeJdtLease }
  | { kind: "BUSY_SAME_WORKTREE"; owner?: LeaseOwner }
  | { kind: "ORPHAN_JDT"; owner: LeaseOwner }
  | { kind: "NO_GLOBAL_SLOT" };

export type CrossProcessLeaseStatus = {
  opened: boolean;
  configuredJdtSlots: number;
  configuredSweepSlots: number;
  requestedJdtSlots: number;
  requestedSweepSlots: number;
  capacityConflict: boolean;
  runtimeLeases: number;
  jdtWorktreeLeases: number;
  claimedJdtSlots: number;
  claimedSweepSlots: number;
  staleLeaseReclaims: number;
  lastError?: string;
};

export interface CrossProcessLeaseStore {
  open(requested: { jdtSlots: number; sweepSlots: number }): Promise<void>;
  acquireRuntime(identity: WorktreeIdentity): Promise<LeaseHandle>;
  tryAcquireJdt(identity: WorktreeIdentity): Promise<JdtLeaseAcquireResult>;
  acquireJdt(identity: WorktreeIdentity, budget: DeadlineBudget): Promise<JdtLeaseAcquireResult>;
  acquireSweep(identity: WorktreeIdentity, budget: DeadlineBudget): Promise<LeaseHandle>;
  activeRuntimeCount(familyHash?: string): Promise<number>;
  status(): Promise<CrossProcessLeaseStatus>
}
```

Capacity negotiation runs before any lease acquisition:

```text
mkdir capacity.lock atomically; write lock owner metadata
EEXIST -> reclaim only when owner PID is dead, or metadata is absent beyond orphanGraceMs; otherwise retry under a short deadline
read/validate capacity.json if present
scan runtime/JDT/sweep leases and reclaim dead-PID owners
if any live lease exists:
  existing capacity is authoritative
  differing requested capacity -> status.capacityConflict=true, do not expose extra slots
else:
  atomically publish requested jdtSlots/sweepSlots to capacity.json
release capacity.lock in finally
```

`capacity.json` contains `schemaVersion`, `jdtSlots`, `sweepSlots`, `updatedAt` and the machine-derived defaults used. Corruption with live leases fails closed as `LEASE_CONFIG_ERROR`; corruption with no live leases is quarantined and rebuilt. Do not infer capacity independently in each MCP process after `open()`.

Runtime lease algorithm:

```text
familyKey = identity.familyHash ?? identity.repoHash
mkdir runtime/<familyKey>/<repoHash>/<pid>-<ownerToken> atomically
write metadata
heartbeat on request enter/exit
allow multiple runtime leases for the same worktree
```

Runtime leases are not JDT/worktree mutexes. They exist for active-runtime counting and janitor protection.

Atomic JDT ownership algorithm:

```text
acquire JDT:
  mkdir jdt-worktree/<repoHash> atomically
  if EEXIST:
    inspect metadata
    live owner PID -> BUSY_SAME_WORKTREE
    dead owner + live recorded jdtlsPid -> ORPHAN_JDT (fail closed)
    dead owner + no live child -> reclaim; metadata-less directory only after orphanGraceMs
  for slot in fixed [0..N-1]:
    mkdir jdt-slots/slot-N atomically
    write owner metadata with fsync/close
    first success -> ACQUIRED(worktree + slot)
  no slot -> release worktree lease -> NO_GLOBAL_SLOT
```

Do **not** implement `count(activeLeases) < max` followed by creating a repoHash file; two processes can both pass the count.

Use `ownerToken = randomUUID()`. A handle removes a directory only after rereading metadata and confirming its own token. Heartbeat is atomic temp-write + rename. Reclaim never steals from a live PID.

`acquireJdt()` retries `NO_GLOBAL_SLOT` with a 50ms bounded delay under the caller budget. `BUSY_SAME_WORKTREE` returns immediately because another session owns that Eclipse workspace.

- [ ] **Step 5: 初始化 shared capacity，再接入 process-local reservation 和 JDT lifecycle**

Add a server/runtime initialization boundary:

```ts
export class RepoRuntimeManager {
  private leaseReady?: Promise<void>;

  initialize(): Promise<void> {
    return this.leaseReady ??= this.leases.open({
      jdtSlots: this.options.maxActiveRepos,
      sweepSlots: positiveInteger(process.env.JAVA_LSP_MAX_BACKGROUND_SWEEPS, 1)
    });
  }
}
```

`main()` awaits `runtimes.initialize()` before `server.connect()`. The wait is local filesystem work under a short hard cap. On `LEASE_CONFIG_ERROR` or an unrecoverable capacity-lock timeout, log one concise startup degradation, keep the MCP/static JavaIndex/rg path available, and mark cross-process JDT admission unavailable; do **not** start JDT without a valid shared capacity. `java_status(detail=diagnostic)` exposes the lease error and requested/persisted capacities.

Add tests proving initialization is singleflight and a degraded lease store leaves fast `java_impact` usable while required/pure-JDT tools return `JDT_NOT_READY`/`LEASE_CONFIG_ERROR` without spawning a child.

Order for a JDT attempt is fixed:

```text
Task 4 process-local reservation
→ same-worktree lease
→ machine JDT slot
→ JdtlsSession STARTING
```

Release is reverse order on:

```text
start failure
BROKEN exit
STOPPED/shutdown
idle victim eviction
caller abandons before STARTING
```

Store the composite lease on `RuntimeEntry`, not in a global variable. After child spawn, atomically update both worktree/global-slot lease metadata with `jdtlsPid`; if either update fails, terminate the just-spawned child, wait for exit, release both leases and fail before lifecycle READY. Start failure clears/releases them in `finally`. Subscribe to lifecycle changes; READY/STARTING heartbeat every 30s and on every semantic request. `touchRepoCache(...jdtlsPid)` remains only after lifecycle commit to READY. A dead owner with a live recorded child returns `ORPHAN_JDT`; no automatic second spawn is allowed.

- [ ] **Step 6: 定义 MCP 降级行为**

```text
java_impact auto:
  BUSY_SAME_WORKTREE / ORPHAN_JDT / NO_GLOBAL_SLOT
  -> semantic provider skipped with typed degradation
  -> static JavaIndex + uncached/cached rg continues

java_impact required:
  -> return static result if available
  -> semantic.completion=FAILED
  -> semantic.errorCode=JDT_BUSY_OTHER_SESSION, JDT_ORPHANED or JDT_NOT_READY
  -> never claim exact semantics

java_symbol/java_references/java_diagnostics:
  -> return `JDT_BUSY_OTHER_SESSION`, `JDT_ORPHANED`, `JDT_NOT_READY` or `LEASE_CONFIG_ERROR`; no second child
```

Add handler tests asserting fast path remains usable and `factory.spawnCalls` stays zero in the second process. Add a transport test where lease metadata update fails after spawn: the child is killed, lifecycle never reaches READY, and both lease directories become reclaimable.

- [ ] **Step 7: Machine-level sweep slots**

Reuse the same fixed-slot primitive under `sweep-slots/`, default 1 and maximum configurable 2:

```text
JAVA_LSP_MAX_BACKGROUND_SWEEPS=1
```

Foreground `ensureFresh(anchor)` never acquires a sweep slot. Task 20 uses `acquireSweep()` for full/delta background work.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/worktree-identity.test.js dist/cross-process-lease.test.js dist/repo-runtime-manager.test.js dist/tools/impact.test.js
npm test
git add src/worktree-identity.ts src/worktree-identity.test.ts src/cross-process-lease.ts src/cross-process-lease.test.ts src/repo-runtime-manager.ts src/repo-runtime-manager.test.ts src/server.ts src/jdtls-session.ts src/tools/impact.ts src/tools/symbol.ts src/tools/references.ts src/tools/status.ts
git commit -m "fix(worktree): coordinate JDT and sweep capacity across MCP processes"
```

---

## Task 12b：治理 branch-switch/rebase watcher storm 与 ignore 语义

**Files:**
- Modify: `src/repo-change-coordinator.ts`
- Modify: `src/repo-change-coordinator.test.ts`
- Create: `src/worktree-storm.test.ts`
- Modify: current SourceIndex/JavaIndex refresh adapter
- Modify: `src/tools/status.ts`

**Interfaces:**
- Consumes: `WorktreeIdentity`、Task 9 pending queue、Task 10 freshness policy。
- Produces:
  - `RepoChangeBatch.storm`
  - `isStormBatch()`
  - exact ignore contract for `.git` file/common-dir/generated/cache paths
  - background reconcile without foreground queue flooding

- [ ] **Step 1: 扩展 batch contract 和纯函数测试**

```ts
export type RepoChangeBatch = {
  generation: number;
  observedAt: string;
  changes: RepoChange[];
  storm: boolean;
  affectedRoots: string[];
};

export function isStormBatch(changeCount: number, indexedJavaFiles: number): boolean {
  return changeCount >= 100
    || changeCount >= Math.max(20, Math.ceil(indexedJavaFiles * 0.10));
}
```

Tests:

```ts
assert.equal(isStormBatch(99, 5_000), false);
assert.equal(isStormBatch(100, 5_000), true);
assert.equal(isStormBatch(50, 400), true);
assert.equal(isStormBatch(19, 100), false);
```

- [ ] **Step 2: 写 500-file storm 失败测试**

Use an injected fake watcher or direct queue API; do not create 500 chokidar events with sleeps:

```ts
test("large change batch schedules one background reconcile", async () => {
  const fixture = coordinatorWithIndex({ indexedJavaFiles: 5_000 });
  for (let i = 0; i < 500; i += 1) {
    fixture.coordinator.queueForTest({
      kind: "JAVA_CHANGE",
      absolutePath: path.join(fixture.root, `src/main/java/p/C${i}.java`)
    });
  }
  await fixture.coordinator.flushNow();

  assert.equal(fixture.batches.length, 1);
  assert.equal(fixture.batches[0].storm, true);
  assert.equal(fixture.index.backgroundReconcileCalls, 1);
  assert.equal(fixture.index.priorityZeroParseCalls, 0);
});
```

Then issue an anchor request during the blocked background reconcile and assert its `ensureFresh(anchor)` completes before the background gate is released.

- [ ] **Step 3: 写 linked-worktree `.git` file ignore 测试**

```ts
test("linked worktree git metadata never advances Java generation", async () => {
  const fixture = await createGitWorktreeFamily();
  const identity = await resolveWorktreeIdentity(fixture.linked);
  const clock = new GenerationClock();
  const coordinator = createCoordinator(identity, clock);

  coordinator.queueFsPathForTest(path.join(identity.repoRoot, ".git"), "change");
  coordinator.queueFsPathForTest(identity.gitCommonDir!, "change");
  await coordinator.flushNow();

  assert.deepEqual(clock.snapshot(), { value: 1, dirty: false });
});
```

Repeat for `.gradle/build/target/out/bin/node_modules/dist` and the MCP cache base.

- [ ] **Step 4: 实现 storm routing**

At flush:

```text
normal batch:
  merge paths -> generation++ -> incremental listeners

storm batch:
  merge paths -> generation++ once
  derive affected source roots
  mark roots BUILDING/DEGRADED
  invalidate query caches
  submit one background manifest reconcile
  do not enqueue one foreground parse per path
```

Requests during storm:

```text
anchor ensureFresh             priority 0, not sweep-slotted
background delta/full reconcile priority 10, sweep-slotted
negative lookup                disabled until affected roots COMPLETE
freshness.storm                true
```

Do not include 500 paths in standard MCP output. Diagnostic status exposes counts and affected root IDs only.

- [ ] **Step 5: Run/Commit**

```bash
npm run build
node --test dist/repo-change-coordinator.test.js dist/worktree-storm.test.js
npm test
git add src/repo-change-coordinator.ts src/repo-change-coordinator.test.ts src/worktree-storm.test.ts src/source-index.ts src/tools/status.ts
git commit -m "fix(worktree): degrade change storms without blocking anchor refresh"
```

---

## Task 12c：保留并升级 worktree cache janitor 的多进程活性保护

**Files:**
- Modify: `src/worktree-cache-cleanup.ts`
- Modify: `src/worktree-cache-cleanup.test.ts`
- Modify: `src/repo-runtime-manager.ts`
- Modify: `src/jdtls-session.ts`
- Modify: `src/tools/status.ts`

**Interfaces:**
- Consumes: Task 12a runtime/JDT leases。
- Produces:
  - `RepoCacheMetaV2`
  - fast-only runtime cache protection
  - READY-only `jdtlsPid` metadata

- [ ] **Step 1: 写 fast-only active cache 误删失败测试**

```ts
test("janitor does not delete a stale-looking cache owned by a live fast-only runtime", async () => {
  const fixture = await cacheJanitorFixture({ updatedAtDaysAgo: 10 });
  const runtimeLease = await fixture.leases.acquireRuntime(fixture.identity);
  await fixture.writeMeta({ ownerPid: process.pid, ownerToken: runtimeLease.owner.ownerToken });

  const result = cleanupStaleWorktreeCaches({
    cacheBase: fixture.cacheBase,
    leaseBase: fixture.leaseBase,
    now: fixture.now,
    ttlDays: 2
  });

  assert.equal(result.removed, 0);
  assert.equal(existsSync(fixture.cacheRoot), true);
  await runtimeLease.release();
});
```

Also prove dead runtime/JDT leases and dead owner PID allow cleanup, while a READY JDT PID or workspace lock blocks cleanup.

- [ ] **Step 2: 升级 metadata schema**

```ts
export type RepoCacheMetaV2 = {
  schemaVersion: 2;
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  isGitWorktree: boolean;
  ownerPid?: number;
  ownerToken?: string;
  jdtlsPid?: number;
  lastRequestAt: string;
  updatedAt: string;
};
```

A runtime lease is the authoritative multi-owner signal. `ownerPid/ownerToken` in `repo-meta.json` are last-touch diagnostics/fallback, not a replacement for runtime lease enumeration.

- [ ] **Step 3: Touch and lifecycle rules**

```text
RepoRuntime creation          acquire runtime lease + write owner metadata
request enter/exit            heartbeat runtime lease + lastRequestAt
JDT STARTING                  do not write jdtlsPid
JDT READY commit              write jdtlsPid, heartbeat JDT lease
JDT BROKEN/STOPPED/fail start clear jdtlsPid
RepoRuntime disposal          release runtime lease
```

Move the existing `touchRepoCache(repoRoot, { jdtlsPid })` call to the transactional READY commit from Task 3. Object-identity guards prevent an old child exit from clearing a newer PID.

- [ ] **Step 4: Janitor decision order**

```text
not a linked worktree          skip
updated within TTL             skip
live runtime lease             skip
live ownerPid fallback         skip
live jdtlsPid                  skip
workspace .metadata/.lock      skip
otherwise                      delete per-worktree cacheRoot
```

The janitor never recursively deletes the global `leases/` base. Dead lease reclamation is owned by `CrossProcessLeaseStore`.

- [ ] **Step 5: Run/Commit**

```bash
npm run build
node --test dist/worktree-cache-cleanup.test.js dist/repo-runtime-manager.test.js dist/jdtls-session.test.js
npm test
git add src/worktree-cache-cleanup.ts src/worktree-cache-cleanup.test.ts src/repo-runtime-manager.ts src/jdtls-session.ts src/tools/status.ts
git commit -m "fix(worktree): protect active fast-only caches from janitor cleanup"
```

---

## Task 13：Iteration B 验证与 phase report

**Files:**
- Create: `docs/phase-v3/phase2-freshness-report.md`
- Create: `artifacts/v3-phase2/`

**Interfaces:**
- Consumes: Iteration B implementation、Task 0/Iteration A baseline artifacts、three real repo roots、Tasks 12a–12c worktree fixtures。
- Produces: mutation freshness evidence、edit-to-visible latency、cross-process lease/storm/janitor evidence、cold quality/latency comparison and the Iteration B release decision。

- [ ] **Step 1: 全量和 mutation 测试**

```bash
npm run build
npm test
node --test --test-name-pattern="fast path cache invalidation|rename removes|delete removes|build change|last known good|stopped idle|machine JDT slot|same worktree|large change batch|git metadata|fast-only runtime" "dist/**/*.test.js"
```

- [ ] **Step 2: 测 edit-to-visible**

Create/extend benchmark script to perform 30 edit cycles on fixture:

```text
write change
→ wait generation
→ java_impact fast
→ assert new collaborator visible
→ record elapsed
```

Report P50/P95. Initial gate:

```text
stale result count = 0
edit-to-visible P95 <= 500ms on reference machine
```

- [ ] **Step 2a: 多进程/worktree 专项验收**

Run deterministic tests plus one subprocess smoke that launches two Node processes against the same temporary lease directory. Record:

```text
machineJdtSlotsConfigured
maxObservedClaimedJdtSlots
sameWorktreeSecondSpawnCalls
staleLeaseReclaims
stormBatchCount
foregroundAnchorP50/P95DuringStorm
janitorLiveRuntimeSkips
```

Gate:

```text
maxObservedClaimedJdtSlots <= configured slots
sameWorktreeSecondSpawnCalls = 0
staleLeaseReclaims >= 1 in dead-owner fixture
500-file storm background reconcile count = 1
foreground anchor remains within reference P95 gate
live fast-only cache removed = 0
```

- [ ] **Step 3: 三仓 benchmark**

Same cold matrix. Gate:

```text
R_read_must=1.0000
recall/P_read baseline-relative pass
steady cold P95 <= Iteration A × 1.10
```

- [ ] **Step 4: Report/Commit**

```bash
git add docs/phase-v3/phase2-freshness-report.md artifacts/v3-phase2
git commit -m "docs(v3): validate unified repository freshness"
```

Iteration B report must include a dedicated `Worktree Concurrency` section with machine lease occupancy, same-worktree second-session behavior, storm foreground latency, stale lease reclamation and janitor decisions.

Iteration B completion gate:

```text
fast mode watcher active
all caches use one generation
rename/delete stale rate 0
build layout refresh verified
runtime memory retention bounded
alias config failure degrades safely
machine-level JDT/sweep slots never exceeded
same-worktree duplicate JDT spawn count 0
500-file storm schedules one reconcile
live fast-only worktree cache is not deleted
```

---

# Iteration C：JavaIndex V2（Tree-sitter Java）

Iteration C 是本方案唯一的 XL 改造。必须按 Task 14～23 顺序完成。Task 14 兼容性 spike 未通过时，不得继续写完整索引。


## Task 14：Tree-sitter Node 22 / macOS / Worker 兼容性 Spike

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/java-index/tree-sitter-smoke-worker.ts`
- Create: `src/java-index/tree-sitter-smoke.test.ts`
- Create: `src/java-index/java-parser-backend.ts`
- Test: `src/java-index/java-parser-backend.test.ts`
- Create only for WASM decision: `vendor/tree-sitter-java/tree-sitter-java-0.23.5.wasm`
- Create only for WASM decision: `vendor/tree-sitter-java/tree-sitter-java-0.23.5.wasm.sha256`
- Create: `docs/phase-v3/tree-sitter-compatibility-decision.md`

**Interfaces:**
- Produces: one selected parser backend. Native success keeps `tree-sitter`; native failure replaces it with `web-tree-sitter` and a pinned Java WASM artifact. No permanent dual path。

- [ ] **Step 1: 安装精确版本**

Run:

```bash
npm install --save-exact tree-sitter@0.25.0 tree-sitter-java@0.23.5
```

Expected: native package builds/installs under current Node 22 and macOS architecture.

- [ ] **Step 2: 创建 worker smoke implementation**

Create `src/java-index/tree-sitter-smoke-worker.ts`:

```ts
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import Parser from "tree-sitter";

const require = createRequire(import.meta.url);
const Java = require("tree-sitter-java");

function findFirst(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findFirst(child, type);
    if (found) return found;
  }
  return undefined;
}

try {
  const parser = new Parser();
  parser.setLanguage(Java);
  const source = [
    "package demo;",
    "public class Outer {",
    "  void packagePrivate() {",
    "    String text = \"{not a block}\";",
    "  }",
    "  record Inner(String id) {}",
    "}",
    ""
  ].join("\n");
  const tree = parser.parse(source);
  const oldToken = "String";
  const newToken = "Object";
  const charIndex = source.indexOf(oldToken);
  if (charIndex < 0) throw new Error("smoke edit token was not found");
  const startIndex = Buffer.byteLength(source.slice(0, charIndex));
  const oldEndIndex = startIndex + Buffer.byteLength(oldToken);
  const editedSource = `${source.slice(0, charIndex)}${newToken}${source.slice(charIndex + oldToken.length)}`;
  tree.edit({
    startIndex,
    oldEndIndex,
    newEndIndex: startIndex + Buffer.byteLength(newToken),
    startPosition: { row: 3, column: 4 },
    oldEndPosition: { row: 3, column: 10 },
    newEndPosition: { row: 3, column: 10 }
  });
  const updatedTree = parser.parse(editedSource, tree);
  const changedRanges = tree.getChangedRanges(updatedTree);
  const typeNode = findFirst(updatedTree.rootNode, "type_identifier");
  const editedBytes = Buffer.from(editedSource, "utf8");
  const incrementalTypeText = typeNode
    ? editedBytes.subarray(typeNode.startIndex, typeNode.endIndex).toString("utf8")
    : undefined;
  const supportsDelete = typeof tree.delete === "function"
    && typeof updatedTree.delete === "function";
  parentPort?.postMessage({
    ok: true,
    rootType: updatedTree.rootNode.type,
    hasError: updatedTree.rootNode.hasError,
    text: updatedTree.rootNode.toString(),
    changedRanges: changedRanges.length,
    incrementalTypeText,
    supportsDelete
  });
  tree.delete?.();
  updatedTree.delete?.();
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack : String(error)
  });
}
```

- [ ] **Step 3: 创建 worker smoke test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

function runWorker(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./tree-sitter-smoke-worker.js", import.meta.url)
    );
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

test("tree-sitter-java parses Java inside a worker thread", async () => {
  const result = await runWorker();
  assert.equal(result.ok, true, String(result.error ?? ""));
  assert.equal(result.rootType, "program");
  assert.equal(result.hasError, false);
  assert.match(String(result.text), /method_declaration/);
  assert.match(String(result.text), /record_declaration/);
  assert.ok(Number(result.changedRanges) >= 1);
  assert.equal(result.incrementalTypeText, "Object");
  assert.equal(result.supportsDelete, true);
});
```

- [ ] **Step 4: Run native spike**

```bash
npm run build
node --test dist/java-index/tree-sitter-smoke.test.js
node -p "process.version + ' ' + process.platform + ' ' + process.arch"
```

Expected: PASS on every supported local macOS architecture.

- [ ] **Step 5: 仅在 native 失败时执行 WASM 决策**

If failure is reproducible after clean install and is caused by native ABI/worker loading, execute the complete fallback path:

```bash
npm uninstall tree-sitter
npm install --save-exact web-tree-sitter@0.26.11
npm install --save-dev --save-exact tree-sitter-java@0.23.5 tree-sitter-cli@0.26.9
mkdir -p vendor/tree-sitter-java
npx tree-sitter build --wasm \
  --output vendor/tree-sitter-java/tree-sitter-java-0.23.5.wasm \
  node_modules/tree-sitter-java
shasum -a 256 vendor/tree-sitter-java/tree-sitter-java-0.23.5.wasm \
  > vendor/tree-sitter-java/tree-sitter-java-0.23.5.wasm.sha256
cp node_modules/tree-sitter-java/LICENSE vendor/tree-sitter-java/LICENSE-tree-sitter-java
```

The CLI may download its WASI SDK during this build; runtime must never download a grammar. Commit the WASM, checksum and grammar license. `tree-sitter-java` and `tree-sitter-cli` remain dev dependencies only; `web-tree-sitter` is the sole runtime parser binding.

Update the smoke worker to call `Parser.init()`, load the committed grammar through `Language.load()`, and verify its SHA-256 before loading. Do not use the stale `tree-sitter-wasm-prebuilt` package.

Do not switch to WASM for a transient compiler configuration problem until a clean Node 22 install has been tested.

- [ ] **Step 6: 固化唯一 Java parser facade**

Create `src/java-index/java-parser-backend.ts`. Later tasks import only these Java-specific structural types; they never import both native and WASM APIs:

```ts
export type JavaPoint = { row: number; column: number }; // Tree-sitter UTF-8 byte column

export type JavaInputEdit = {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: JavaPoint;
  oldEndPosition: JavaPoint;
  newEndPosition: JavaPoint;
};

export interface JavaSyntaxNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: JavaPoint;
  readonly endPosition: JavaPoint;
  readonly namedChildren: readonly JavaSyntaxNode[];
  readonly hasError: boolean;
  childForFieldName(name: string): JavaSyntaxNode | null;
  toString(): string;
}

export interface JavaSyntaxTree {
  readonly rootNode: JavaSyntaxNode;
  edit(edit: JavaInputEdit): void;
  getChangedRanges(other: JavaSyntaxTree): readonly unknown[];
  delete(): void;
}

export interface JavaParserBackend {
  parse(source: string, oldTree?: JavaSyntaxTree): JavaSyntaxTree;
}

export async function createJavaParserBackend(): Promise<JavaParserBackend>;
```

Commit exactly one implementation inside this file:

- native decision: adapt `tree-sitter@0.25.0` + `tree-sitter-java@0.23.5`；
- WASM decision: adapt `web-tree-sitter@0.26.11` + committed Java grammar。

A backend test repeats full parse, incremental edit, changed ranges and `delete()`. No `if (native)` runtime branch, optional dependency probing, or dual implementation remains after this task.

- [ ] **Step 7: 记录决定**

`docs/phase-v3/tree-sitter-compatibility-decision.md`:

```markdown
# Tree-sitter Compatibility Decision

- Node:
- macOS/arch:
- selected backend: native | wasm
- package versions:
- install command:
- worker smoke result:
- full parse result:
- incremental `Tree.edit` result:
- changed-ranges result:
- Tree resource release result:
- rejected backend and reason:
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/java-index/tree-sitter-smoke-worker.ts src/java-index/tree-sitter-smoke.test.ts src/java-index/java-parser-backend.ts src/java-index/java-parser-backend.test.ts docs/phase-v3/tree-sitter-compatibility-decision.md
if [ -d vendor/tree-sitter-java ]; then git add vendor/tree-sitter-java; fi
git commit -m "build(index): select Tree-sitter Java worker backend"
```

---

## Task 15：定义 JavaIndex V2 types、worker protocol 和 client skeleton

**Files:**
- Create: `src/java-index/index-types.ts`
- Create: `src/java-index/stable-id.ts`
- Test: `src/java-index/stable-id.test.ts`
- Create: `src/java-index/worker-protocol.ts`
- Create: `src/java-index/java-index-client.ts`
- Create: `src/java-index/java-index-worker.ts`
- Test: `src/java-index/java-index-client.test.ts`

**Interfaces:**
- Consumes: selected parser backend from Task 14。
- Produces:
  - normalized fact types；
  - root-independent stable ID factories with `STABLE_ID_VERSION`；
  - `JavaIndexClient` typed async API；
  - worker request/response correlation；
  - crash/restart/degraded behavior。

- [ ] **Step 1: 创建 index-types**

Create `src/java-index/index-types.ts` with these authoritative types:

```ts
import type { SourceRange } from "../runtime/source-range.js";
export type { SourcePosition, SourceRange } from "../runtime/source-range.js";

export type JavaSourceSet = "main" | "test" | "generated" | "unknown";
export type JavaParseState = "COMPLETE" | "RECOVERED" | "FAILED";
export type JavaTypeKind = "class" | "interface" | "record" | "enum" | "annotation";

export type JavaImportFact = {
  qualifiedName: string;
  wildcard: boolean;
  static: boolean;
  range: SourceRange;
};

export type JavaAnnotationFact = {
  name: string;
  qualifiedName?: string;
  argumentsText?: string;
  range: SourceRange;
};

export type TypeResolutionStrategy =
  | "QUALIFIED"
  | "EXPLICIT_IMPORT"
  | "ENCLOSING_TYPE"
  | "SAME_PACKAGE"
  | "JAVA_LANG"
  | "WILDCARD_IMPORT"
  | "REPO_UNIQUE_SIMPLE_NAME";

export type JavaTypeRef = {
  text: string;
  simpleName: string;
  qualifiedName?: string;
  typeArguments: JavaTypeRef[];
  arrayDepth: number;
  wildcard?: "extends" | "super" | "unbounded";
  resolution:
    | { state: "RESOLVED_REPO"; typeId: string; strategy: TypeResolutionStrategy }
    | { state: "EXTERNAL"; qualifiedName: string; strategy: "QUALIFIED" | "EXPLICIT_IMPORT" | "JAVA_LANG" }
    | { state: "TYPE_VARIABLE"; name: string }
    | { state: "AMBIGUOUS"; candidates: string[] }
    | { state: "UNRESOLVED" };
  range?: SourceRange;
};

export type JavaTypeParameterFact = {
  name: string;
  bounds: JavaTypeRef[];
  range: SourceRange;
};

export type JavaCallSiteKind =
  | "METHOD_INVOCATION"
  | "CONSTRUCTOR_INVOCATION"
  | "METHOD_REFERENCE";

export type JavaCallSiteFact = {
  kind: JavaCallSiteKind;
  name: string;
  receiverText?: string;
  receiverDeclaredType?: JavaTypeRef;
  arity: number;
  argumentTypeHints: JavaTypeRef[];
  range: SourceRange;
};

export type JavaFieldFacts = {
  fieldId: string;
  ownerTypeId: string;
  name: string;
  type: JavaTypeRef;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  range: SourceRange;
};

export type JavaMethodFacts = {
  methodId: string;
  ownerTypeId: string;
  name: string;
  constructor: boolean;
  signatureKey: string;
  range: SourceRange;
  bodyRange?: SourceRange;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  typeParameters: JavaTypeParameterFact[];
  returnType?: JavaTypeRef;
  parameters: Array<{ name: string; type: JavaTypeRef; varargs: boolean; range: SourceRange }>;
  throws: JavaTypeRef[];
  callSites: JavaCallSiteFact[];
  localTypes: JavaTypeRef[];
};

export type JavaTypeFacts = {
  typeId: string;
  fqn?: string;
  simpleName: string;
  kind: JavaTypeKind;
  fileId: string;
  enclosingTypeId?: string;
  range: SourceRange;
  modifiers: string[];
  annotations: JavaAnnotationFact[];
  typeParameters: JavaTypeParameterFact[];
  extends: JavaTypeRef[];
  implements: JavaTypeRef[];
  permits: JavaTypeRef[];
  fieldIds: string[];
  methodIds: string[];
  confidence: number;
};

export type JavaFileFacts = {
  fileId: string;
  relativePath: string;
  sourceRoot: string;
  module: string;
  sourceSet: JavaSourceSet;
  packageName: string;
  imports: JavaImportFact[];
  topLevelTypeIds: string[];
  allTypeIds: string[];
  contentHash: string;
  size: number;
  mtimeMs: number;
  parseState: JavaParseState;
  parseErrorCount: number;
  generation: number;
};

export type StaticEdgeResolutionKind =
  | "AST_EXPLICIT"
  | "TYPE_REFERENCE"
  | "SAME_OWNER_NAME_ARITY"
  | "DECLARED_RECEIVER_NAME_ARITY"
  | "SUPER_CHAIN_NAME_ARITY"
  | "CONSTRUCTOR_TYPE"
  | "METHOD_REFERENCE_OWNER";

export type StaticEdgeKind =
  | "DECLARES"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "PERMITS"
  | "IMPORTS"
  | "FIELD_TYPE"
  | "PARAM_TYPE"
  | "RETURN_TYPE"
  | "THROWS_TYPE"
  | "LOCAL_TYPE"
  | "CALLS"
  | "CONSTRUCTS"
  | "METHOD_REFERENCE"
  | "ANNOTATED_WITH";

export type StaticEdge = {
  edgeId: string;
  fromId: string;
  toId: string;
  kind: StaticEdgeKind;
  confidence: number;
  range?: SourceRange;
  sourceFile: string;
  generation: number;
  resolution: {
    kind: StaticEdgeResolutionKind;
    typeStrategy?: TypeResolutionStrategy;
  };
};

export type SourceRootCoverage = {
  root: string;
  generation: number;
  state: "UNKNOWN" | "BUILDING" | "COMPLETE" | "DEGRADED";
  discoveredFiles: number;
  indexedFiles: number;
  failedFiles: number;
  recoveredFiles: number;
  extractorVersion: string;
  completedAt?: string;
};

export type JavaIndexStatus = {
  state: "NEW" | "OPENING" | "READY" | "DEGRADED" | "CLOSED";
  indexedGeneration: number;
  files: number;
  types: number;
  methods: number;
  edges: number;
  snapshotBytes: number;
  pendingForeground: number;
  pendingBackground: number;
  coverage: SourceRootCoverage[];
  lastError?: string;
};

export type JavaTypeLookupResult =
  | { state: "RESOLVED"; type: JavaTypeFacts }
  | { state: "AMBIGUOUS"; candidates: JavaTypeFacts[] }
  | { state: "UNRESOLVED"; coverage: "COMPLETE" | "PARTIAL" | "DEGRADED" };

export type JavaFileBundle = {
  file: JavaFileFacts;
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
  edges: StaticEdge[];
};

export type AnchorFacts = {
  file: JavaFileFacts;
  symbolId: string;
  symbolKind: "TYPE" | "METHOD" | "CONSTRUCTOR" | "FIELD" | "FILE";
  symbolName: string;
  range: SourceRange;
  type?: JavaTypeFacts;
  method?: JavaMethodFacts;
  field?: JavaFieldFacts;
  coverage: SourceRootCoverage["state"];
  confidence: number;
};

export type IndexedReference = {
  sourceId: string;
  targetId: string;
  sourceFile: string;
  sourceModule: string;
  sourceSet: JavaSourceSet;
  kind: StaticEdgeKind;
  confidence: number;
  range?: SourceRange;
  generation: number;
};
```

`src/runtime/source-range.ts` remains the single definition. `index-types.ts` re-exports it for JavaIndex consumers; do not redeclare the shape.

- [ ] **Step 1a: 锁定 root-independent stable ID contract**

Create `src/java-index/stable-id.ts`:

```ts
import type { SourceRange } from "../runtime/source-range.js";

export const STABLE_ID_VERSION = 1;

export function normalizeStableRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`invalid repo-relative path: ${relativePath}`);
  }
  return normalized;
}

export function javaFileId(relativePath: string): string {
  return `file:${normalizeStableRelativePath(relativePath)}`;
}

export function javaTypeId(input: {
  fqn?: string;
  relativePath: string;
  range: SourceRange;
}): string {
  if (input.fqn) return `type:${input.fqn}`;
  const path = normalizeStableRelativePath(input.relativePath);
  return `type-local:${path}:${input.range.start.line}:${input.range.start.column}`;
}

export function javaMethodId(ownerTypeId: string, erasedSignature: string): string {
  if (!ownerTypeId.startsWith("type:" ) && !ownerTypeId.startsWith("type-local:")) {
    throw new Error(`invalid owner type id: ${ownerTypeId}`);
  }
  return `method:${ownerTypeId}#${erasedSignature}`;
}

export function javaFieldId(ownerTypeId: string, fieldName: string): string {
  return `field:${ownerTypeId}#${fieldName}`;
}

export function javaEdgeId(input: {
  kind: string;
  fromId: string;
  toId: string;
  range?: SourceRange;
}): string {
  const rangeKey = input.range
    ? `${input.range.start.line}:${input.range.start.column}-${input.range.end.line}:${input.range.end.column}`
    : "none";
  return `edge:${input.kind}:${input.fromId}:${input.toId}:${rangeKey}`;
}
```

Write tests proving:

```ts
test("stable IDs are independent of worktree absolute root", () => {
  const left = javaFileId("src/main/java/demo/A.java");
  const right = javaFileId("src\\main\\java\\demo\\A.java");
  assert.equal(left, right);
  assert.equal(left.includes("/Users/"), false);
});

test("local type IDs include relative path and source position", () => {
  assert.equal(javaTypeId({
    relativePath: "src/main/java/demo/A.java",
    range: { start: { line: 8, column: 3 }, end: { line: 9, column: 1 } }
  }), "type-local:src/main/java/demo/A.java:8:3");
});

test("method IDs use owner type and erased signature", () => {
  assert.equal(
    javaMethodId("type:demo.A", "save(java.lang.String,int)"),
    "method:type:demo.A#save(java.lang.String,int)"
  );
});

test("two call sites to the same target retain distinct root-independent edge IDs", () => {
  const first = javaEdgeId({
    kind: "CALLS",
    fromId: "method:type:demo.A#run()",
    toId: "method:type:demo.B#save()",
    range: { start: { line: 10, column: 3 }, end: { line: 10, column: 11 } }
  });
  const second = javaEdgeId({
    kind: "CALLS",
    fromId: "method:type:demo.A#run()",
    toId: "method:type:demo.B#save()",
    range: { start: { line: 12, column: 3 }, end: { line: 12, column: 11 } }
  });
  assert.notEqual(first, second);
  assert.equal(first.includes("/Users/"), false);
});
```

Extractor/store/snapshot/seeder code must call these factories. No AST extractor may concatenate `repoRoot`, absolute file path or platform separator into an ID. This is a correctness prerequisite for Task 21a sibling-worktree seeding.

- [ ] **Step 2: 定义 worker protocol**

```ts
export type JavaIndexRequest =
  | { id: number; type: "OPEN"; repoRoot: string; cacheDir: string; generation: number }
  | { id: number; type: "REFRESH"; generation: number; changed: string[]; deleted: string[] }
  | { id: number; type: "RECONCILE"; generation: number }
  | { id: number; type: "QUERY_ANCHOR"; file: string; line: number; column: number }
  | { id: number; type: "QUERY_TYPE"; typeText: string; scopeFile?: string }
  | { id: number; type: "QUERY_IMPLEMENTERS"; typeId: string; limit: number }
  | { id: number; type: "QUERY_TYPE_REFERENCERS"; typeId: string; edgeKinds: StaticEdgeKind[]; limit: number }
  | { id: number; type: "QUERY_CALLERS"; methodId: string; limit: number }
  | { id: number; type: "QUERY_CALLEES"; methodId: string; limit: number }
  | { id: number; type: "QUERY_FILES"; files: string[] }
  | { id: number; type: "STATUS" }
  | { id: number; type: "FLUSH" }
  | { id: number; type: "CLOSE" };

export type JavaIndexCommand = JavaIndexRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

export type JavaIndexResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string } };

export type JavaIndexValueValidator<T> = (value: unknown) => T;
```

Use the distributive `JavaIndexCommand` alias above. Plain `Omit<JavaIndexRequest, "id">` is not sufficient because it collapses a discriminated union to its common keys.

Add runtime guards:

```ts
export function isJavaIndexResponse(value: unknown): value is JavaIndexResponse;
export function validateJavaIndexStatus(value: unknown): JavaIndexStatus;
export function validateAnchorFacts(value: unknown): AnchorFacts | undefined;
export function validateTypeLookup(value: unknown): JavaTypeLookupResult;
export function validateTypeFactsArray(value: unknown): JavaTypeFacts[];
export function validateIndexedReferenceArray(value: unknown): IndexedReference[];
export function validateFileBundleArray(value: unknown): JavaFileBundle[];
```

The envelope guard verifies object/id/ok and required error fields. Command-specific validators verify payload fields before any value enters main-process state. Do not expose an unchecked generic cast at the worker boundary.

- [ ] **Step 3: 写 client correlation 失败测试**

Use an injectable `WorkerLike`:

```ts
export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}
```

Test two out-of-order responses resolve correct promises. Test a valid envelope with an invalid command payload is rejected by the command-specific validator and moves the client to DEGRADED. Test exit rejects all pending requests.

- [ ] **Step 4: 实现 JavaIndexClient**

Core fields:

```ts
private nextId = 1;
private worker?: WorkerLike;
private state: JavaIndexStatus["state"] = "NEW";
private readonly pending = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>();
private restartCount = 0;
```

`request<T>()`:

```ts
private request<T>(
  request: JavaIndexCommand,
  validate: JavaIndexValueValidator<T>
): Promise<T> {
  const worker = this.worker;
  if (!worker) {
    throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index worker is not open");
  }
  const id = this.nextId++;
  return new Promise<T>((resolve, reject) => {
    this.pending.set(id, {
      resolve: value => {
        try {
          resolve(validate(value));
        } catch (error) {
          this.markDegraded("invalid worker response", error);
          reject(new JavaIntelligenceError(
            "INDEX_CORRUPT",
            `Java index returned an invalid payload for ${request.type}`,
            error
          ));
        }
      },
      reject
    });
    worker.postMessage({ ...request, id });
  });
}
```

On exit:

- reject all pending；
- state DEGRADED；
- clear worker；
- automatic restart at most once per runtime and only on next request；
- no restart loop in exit callback。

- [ ] **Step 5: 创建 worker command skeleton**

`java-index-worker.ts` handles messages serially with a foreground queue. For this task, `OPEN`, `STATUS`, `CLOSE` work; all query commands return an empty typed result. Do not implement parser yet.

```ts
parentPort?.on("message", request => {
  commandQueue.push(request);
  void drain();
});
```

Only one `drain()` runs at a time.

- [ ] **Step 6: client opens real worker smoke**

Test:

```ts
const client = new JavaIndexClient(root, cacheDir);
await client.open(1);
assert.equal((await client.status()).state, "READY");
await client.close();
assert.equal(client.localStatus().state, "CLOSED");
```

- [ ] **Step 7: Run/Commit**

```bash
npm run build
node --test dist/java-index/java-index-client.test.js dist/java-index/tree-sitter-smoke.test.js
npm test
git add src/java-index
git commit -m "feat(index): add typed Java index protocol and stable identities"
```

---

## Task 16：实现 Tree-sitter Java AST extractor 核心事实

**Files:**
- Create: `src/java-index/ast-extractor.ts`
- Test: `src/java-index/ast-extractor.test.ts`
- Create: `src/java-index/utf8-source.ts`
- Test: `src/java-index/utf8-source.test.ts`
- Create: `src/java-index/parse-tree-cache.ts`
- Test: `src/java-index/parse-tree-cache.test.ts`
- Create: `fixtures/java-index-v2/src/main/java/demo/ComplexJava.java`
- Create: `fixtures/java-index-v2/src/main/java/demo/SecondTopLevel.java`
- Modify: `src/java-index/java-index-worker.ts`

**Interfaces:**
- Consumes: `createJavaParserBackend()` and `JavaSyntaxNode/JavaSyntaxTree` from Task 14。
- Produces:
  - `extractJavaFile(input): ExtractedJavaFile`
  - file/type/field/method/call facts with exact ranges。

- [ ] **Step 1: 创建复杂 Java fixture**

`ComplexJava.java` must include all cases in one valid compilation unit:

```java
package demo;

import java.util.List;
import java.util.Map;
import static java.util.Objects.requireNonNull;

@Deprecated
public sealed class ComplexJava<T extends Number>
    extends BaseType
    implements DemoPort
    permits ComplexJava.Child {

  private final DemoRepository repository;

  ComplexJava(DemoRepository repository) {
    this.repository = requireNonNull(repository);
  }

  Result packagePrivate(Command command) throws DomainException {
    String text = "{ this is not a block }";
    String json = """
        { "key": "value" }
        """;
    Helper helper = new Helper();
    return repository.save(command, helper);
  }

  public record Child(String id) implements DemoPort {}

  static class Helper {
    void run() {}
  }
}

class SecondTopLevel {
  void packagePrivateToo() {}
}
```

This fixture intentionally includes nested and second top-level types, package-private constructor/method, text block and call receiver declarations.

- [ ] **Step 2: 写 extractor assertions**

Test must assert:

```ts
assert.equal(result.file.packageName, "demo");
assert.deepEqual(result.file.imports.map(i => i.qualifiedName), [
  "java.util.List",
  "java.util.Map",
  "java.util.Objects.requireNonNull"
]);
assert.deepEqual(result.types.map(t => t.simpleName).sort(), [
  "Child", "ComplexJava", "Helper", "SecondTopLevel"
]);
assert.ok(result.methods.some(m => m.name === "packagePrivate"));
assert.ok(result.methods.some(m => m.name === "packagePrivateToo"));
assert.ok(result.methods.some(m => m.constructor && m.name === "ComplexJava"));
assert.ok(result.methods.find(m => m.name === "packagePrivate")!.bodyRange);
assert.deepEqual(
  result.methods.find(m => m.name === "packagePrivate")!.callSites.map(c => c.name).sort(),
  ["Helper", "save"]
);
assert.equal(result.file.parseState, "COMPLETE");
```

Also assert method end range is not affected by braces inside string/text block.

- [ ] **Step 3: 建立 parser facade**

```ts
export type ExtractJavaInput = {
  repoRoot: string;
  absolutePath: string;
  relativePath: string;
  sourceRoot: string;
  module: string;
  sourceSet: JavaSourceSet;
  content: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
  generation: number;
};

export type ExtractedJavaFile = {
  file: JavaFileFacts;
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
};
```

The worker creates one `JavaParserBackend` during `OPEN` and passes it to extraction. Do not instantiate a parser per file and do not import native/WASM packages outside `java-parser-backend.ts`.

- [ ] **Step 4: 实现 UTF-8 source facade 与 range conversion**

Tree-sitter `startIndex/endIndex` and point columns are UTF-8 byte offsets, while JavaScript `String.slice()` uses UTF-16 code units. Create one facade and prohibit direct string slicing with syntax-node byte offsets:

```ts
export class Utf8Source {
  readonly bytes: Buffer;
  private readonly lineStartBytes: number[];

  constructor(readonly text: string) {
    this.bytes = Buffer.from(text, "utf8");
    this.lineStartBytes = computeLineStartBytes(this.bytes);
  }

  textFor(node: JavaSyntaxNode): string {
    return this.textForByteRange(node.startIndex, node.endIndex);
  }

  textForByteRange(startByte: number, endByte: number): string {
    return this.bytes.subarray(startByte, endByte).toString("utf8");
  }

  positionAtByteOffset(byteOffset: number): SourcePosition {
    const lineIndex = upperBound(this.lineStartBytes, byteOffset) - 1;
    const lineStartByte = this.lineStartBytes[Math.max(0, lineIndex)]!;
    const utf16Prefix = this.bytes
      .subarray(lineStartByte, byteOffset)
      .toString("utf8");
    return {
      line: lineIndex + 1,
      column: utf16Prefix.length + 1
    };
  }

  rangeOf(node: JavaSyntaxNode): SourceRange {
    return {
      start: this.positionAtByteOffset(node.startIndex),
      end: this.positionAtByteOffset(node.endIndex)
    };
  }
}

function computeLineStartBytes(bytes: Buffer): number[] {
  const starts = [0];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) starts.push(index + 1);
  }
  return starts;
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}
```

Tests must include Chinese text and a surrogate-pair emoji before a type/method token, and prove both `textFor(node)` and `rangeOf(node)` are exact. Persisted `SourceRange.column` is 1-based UTF-16 code units; only Tree-sitter edit points remain UTF-8 byte columns. `toLspPosition()` therefore subtracts one from the unified line/column without reinterpreting bytes.

- [ ] **Step 5: 实现 compilation unit traversal**

Use a named-node DFS with explicit handlers. Do not use one giant regex or one giant switch over every node.

```ts
function visit(node: JavaSyntaxNode, context: ExtractContext): void {
  switch (node.type) {
    case "package_declaration": extractPackage(node, context); return;
    case "import_declaration": extractImport(node, context); return;
    case "class_declaration":
    case "interface_declaration":
    case "record_declaration":
    case "enum_declaration":
    case "annotation_type_declaration":
      extractType(node, context);
      return;
    default:
      for (const child of node.namedChildren) visit(child, context);
  }
}
```

`extractType()` recursively handles its body with an enclosing type stack and calls Task 15 factories:

```ts
const typeId = javaTypeId({
  fqn: stableFqnForMemberOrTopLevelType(context),
  relativePath: context.relativePath,
  range
});
```

Top-level/member type FQN uses `package.Outer$Inner`. Local/anonymous types pass no FQN, so the factory emits `type-local:<relativePath>:<startLine>:<startColumn>`. No extractor code constructs IDs from `repoRoot` or absolute paths.

- [ ] **Step 6: 实现 method/field facts**

Method/field IDs are created only through Task 15 factories:

```ts
const signatureKey = erasedSignatureKey({
  name: constructor ? "<init>" : methodName,
  parameterTypeTexts,
  varargs
});
const methodId = javaMethodId(ownerTypeId, signatureKey);
const fieldId = javaFieldId(ownerTypeId, fieldName);
```

`erasedSignatureKey()` removes generic arguments, normalizes arrays/varargs and whitespace, and uses source type text when FQN resolution is not yet available. Resolution may later enrich type refs, but it must not rename the method ID during the same snapshot schema. Constructors use `<init>(...)`. Do not include source range or absolute path in method/field IDs.

Package-private is represented by absence of access modifier; do not filter it.

- [ ] **Step 7: 实现直接 call-site extraction**

Within each method/constructor body collect:

- `method_invocation`；
- `object_creation_expression`；
- `method_reference`；
- local variable declarations to map identifier → declared type；
- fields/parameters to map receiver identifier → declared type。

Initial receiver typing does not evaluate arbitrary expressions. It records:

```ts
receiverDeclaredType?: JavaTypeRef
```

when receiver is `this`, `super`, a parameter, field, local variable or explicit type name.

- [ ] **Step 8: parse error behavior**

If `tree.rootNode.hasError`:

- still extract available facts；
- count `ERROR`/missing nodes；
- file parseState `RECOVERED` if at least one top-level type exists；
- `FAILED` only when no useful structural root can be obtained；
- recovered facts can support positive evidence；
- coverage task later prevents negative conclusions from recovered roots。

Add malformed fixture test.

- [ ] **Step 9: 实现 bounded incremental parse-tree cache**

Create `src/java-index/parse-tree-cache.ts`:

```ts
export type ParseTreeCacheOptions = {
  maxEntries: number;
  maxSourceBytes: number;
  maxSingleFileBytes: number;
  maxIncrementalChangeRatio: number;
};

export type CachedParseTree = {
  file: string;
  source: string;
  sourceBytes: number;
  tree: JavaSyntaxTree;
  lastUsedAt: number;
};
```

Defaults are `128 entries / 64MiB total source / 2MiB single file / 0.25 change ratio`.

Implement `computeSingleEdit(oldSource, newSource)` using UTF-8 byte prefix/suffix. It returns `undefined` for unchanged text, files above the single-file cap, or rewrites above the ratio. Point columns are UTF-8 byte columns required by Tree-sitter, not JavaScript UTF-16 code units.

Tests must cover:

```text
ASCII one-token edit
Chinese string before the edit point
insert/delete across line boundary
large rewrite full-parse fallback
LRU entry and byte-cap eviction
eviction calls Tree.delete()
incremental facts equal clean full-parse facts
```

Refresh algorithm:

```ts
const cached = treeCache.get(file);
const edit = cached ? computeSingleEdit(cached.source, content) : undefined;
let tree: JavaSyntaxTree;
if (cached && edit) {
  cached.tree.edit(edit);
  tree = parser.parse(content, cached.tree);
  metrics.incrementalParseHits += 1;
} else {
  tree = parser.parse(content);
  metrics.fullParseCount += 1;
}
const bundle = extractFromTree(repoRoot, file, content, tree, generation);
treeCache.replace(file, content, tree);
```

Do not persist source text or syntax trees in snapshot.

- [ ] **Step 10: worker REFRESH uses extractor**

For changed files:

1. read async in worker；
2. stat；
3. SHA-256 content；
4. use incremental tree when eligible, otherwise full parse；
5. extract facts from the resulting tree；
6. replace the file’s cached tree/facts atomically；
7. return/store facts in temporary map for now。

Delete removes the parse-tree LRU entry and calls `Tree.delete()`.

- [ ] **Step 11: Run/Commit**

```bash
npm run build
node --test dist/java-index/utf8-source.test.js dist/java-index/ast-extractor.test.js dist/java-index/parse-tree-cache.test.js
npm test
git add src/java-index fixtures/java-index-v2
git commit -m "feat(index): extract Java facts with incremental Tree-sitter parsing"
```


## Task 17：FQN/import/name resolver 与歧义安全

**Files:**
- Create: `src/java-index/name-resolver.ts`
- Test: `src/java-index/name-resolver.test.ts`
- Create: `fixtures/java-index-v2/src/main/java/a/User.java`
- Create: `fixtures/java-index-v2/src/main/java/b/User.java`
- Create: `fixtures/java-index-v2/src/main/java/use/ExplicitUserService.java`
- Create: `fixtures/java-index-v2/src/main/java/use/AmbiguousUserService.java`
- Modify: `src/java-index/index-types.ts`

**Interfaces:**
- Consumes: all parsed type declarations and per-file imports。
- Produces:
  - `JavaNameResolver.resolveTypeRef(ref, fileContext): JavaTypeRef`
  - deterministic resolution strategy；
  - explicit ambiguity, never arbitrary first match。

- [ ] **Step 1: 创建 collision fixtures**

`a/User.java`:

```java
package a;
public class User {}
```

`b/User.java`:

```java
package b;
public class User {}
```

`use/ExplicitUserService.java`:

```java
package use;
import a.User;
public class ExplicitUserService {
  User load() { return null; }
}
```

`use/AmbiguousUserService.java`:

```java
package use;
import a.*;
import b.*;
public class AmbiguousUserService {
  User load() { return null; }
}
```

- [ ] **Step 2: 写解析顺序测试**

```ts
test("explicit imports beat same simple-name candidates", () => {
  const resolved = resolver.resolveTypeText("User", explicitFileContext);
  assert.deepEqual(resolved.resolution, {
    state: "RESOLVED_REPO",
    typeId: "type:a.User",
    strategy: "EXPLICIT_IMPORT"
  });
});

test("multiple wildcard candidates remain ambiguous", () => {
  const resolved = resolver.resolveTypeText("User", ambiguousFileContext);
  assert.deepEqual(resolved.resolution, {
    state: "AMBIGUOUS",
    candidates: ["type:a.User", "type:b.User"]
  });
});

test("repo-unique simple name is a lower-priority fallback", () => {
  const resolved = resolver.resolveTypeText("OnlyOne", noImportContext);
  assert.equal(resolved.resolution.state, "RESOLVED_REPO");
  assert.equal(resolved.resolution.strategy, "REPO_UNIQUE_SIMPLE_NAME");
});
```

Add tests for same package, nested type and external types. `java.lang.String` must resolve as `EXTERNAL/java.lang.String`; `import org.springframework.stereotype.Service` must resolve as `EXTERNAL/org.springframework.stereotype.Service` even though no Spring source file exists in the repo.

- [ ] **Step 3: 建立 resolver indexes**

```ts
export type TypeRegistryView = {
  byId: ReadonlyMap<string, JavaTypeFacts>;
  byFqn: ReadonlyMap<string, string>;
  bySimpleName: ReadonlyMap<string, ReadonlySet<string>>;
  nestedByOwnerAndSimpleName: ReadonlyMap<string, string>;
};
```

- [ ] **Step 4: 实现 deterministic resolution**

```ts
resolveTypeText(text: string, context: JavaResolutionContext): JavaTypeRef {
  const parsed = parseTypeText(text);
  const candidates = this.resolveSimpleOrQualified(parsed.baseName, context);
  return {
    text,
    simpleName: simpleName(parsed.baseName),
    qualifiedName: candidates.kind === "repo"
      ? this.registry.byId.get(candidates.typeId)?.fqn
      : candidates.kind === "external"
        ? candidates.qualifiedName
        : undefined,
    typeArguments: parsed.typeArguments.map(arg => this.resolveTypeText(arg, context)),
    arrayDepth: parsed.arrayDepth,
    wildcard: parsed.wildcard,
    resolution: candidates.kind === "repo"
      ? { state: "RESOLVED_REPO", typeId: candidates.typeId, strategy: candidates.strategy }
      : candidates.kind === "external"
        ? { state: "EXTERNAL", qualifiedName: candidates.qualifiedName, strategy: candidates.strategy }
        : candidates.kind === "ambiguous"
          ? { state: "AMBIGUOUS", candidates: [...candidates.typeIds].sort() }
          : { state: "UNRESOLVED" }
  };
}
```

Resolution order must exactly match architecture V3 §9.8. Do not resolve wildcard imports by first match.

- [ ] **Step 5: Type text parser**

Implement a small token parser for:

```text
List<User>
Map<String, ? extends User>
User[]
Outer.Inner
T
```

Do not use `/\b[A-Z][A-Za-z0-9_]*\b/` token extraction. The parser only needs Java type syntax, not expressions. Type variables declared in method/type parameter scope resolve to the already-authoritative representation:

```ts
{ state: "TYPE_VARIABLE"; name: string }
```

An undeclared single-letter token is `UNRESOLVED`, not silently treated as a type variable. Add exhaustive-switch tests for all five resolution states.

- [ ] **Step 6: Resolve all extractor refs after registry build**

Pipeline per refresh batch:

```text
parse declarations
→ update type registry
→ resolve refs in affected files
→ rebuild affected edges
```

When a new type changes a previously unique simple name into a collision, files using `REPO_UNIQUE_SIMPLE_NAME` for that name must be re-resolved. Maintain reverse dependency:

```text
simpleName fallback → dependent file IDs
```

- [ ] **Step 7: Run/Commit**

```bash
npm run build
node --test dist/java-index/name-resolver.test.js dist/java-index/ast-extractor.test.js
npm test
git add src/java-index fixtures/java-index-v2
git commit -m "feat(index): resolve Java types with import-aware ambiguity handling"
```

---

## Task 18：构建静态 edge 与有界方法调用关系

**Files:**
- Create: `src/java-index/edge-builder.ts`
- Test: `src/java-index/edge-builder.test.ts`
- Modify: `src/java-index/index-types.ts`
- Modify: `src/java-index/java-index-worker.ts`

**Interfaces:**
- Consumes: resolved file/type/field/method/call facts。
- Produces:
  - `buildStaticEdges(fileBundle, registry): StaticEdge[]`
  - exact/ambiguous-safe static graph。

- [ ] **Step 1: 写 declaration/type edge 测试**

Fixture `PaymentGateway`, `AliyunGateway`, `PaymentService`:

```java
package demo;

record PaymentCommand(String id) {}
record PaymentResult(boolean accepted) {}

interface PaymentGateway {
  PaymentResult pay(PaymentCommand command);
}

final class AliyunGateway implements PaymentGateway {
  @Override
  public PaymentResult pay(PaymentCommand command) {
    return new PaymentResult(true);
  }
}

final class PaymentService {
  private final PaymentGateway gateway;

  PaymentService(PaymentGateway gateway) {
    this.gateway = gateway;
  }

  PaymentResult pay(PaymentCommand command) {
    return gateway.pay(command);
  }
}
```

Assertions:

```ts
assertEdge("type:demo.AliyunGateway", "type:demo.PaymentGateway", "IMPLEMENTS", 0.98);
assertEdge("field:demo.PaymentService#gateway", "type:demo.PaymentGateway", "FIELD_TYPE", 0.98);
assertEdge(paymentMethodId, "type:demo.PaymentResult", "RETURN_TYPE", 0.98);
assertEdge(paymentMethodId, "type:demo.PaymentCommand", "PARAM_TYPE", 0.98);
```

- [ ] **Step 2: 写 bounded call resolution 测试**

Assertions:

```ts
assertEdge(servicePayMethod, gatewayPayMethod, "CALLS", 0.90);
assertEdge(aliyunPayMethod, paymentResultTypeId, "CONSTRUCTS", 0.98);
```

Add overload fixture:

```java
void save(String value) {}
void save(Long value) {}
```

A call with unknown arg type and same arity must not choose one arbitrarily. It remains unresolved or ambiguous.

- [ ] **Step 3: 定义 edge identity**

```ts
function staticEdgeId(input: {
  fromId: string;
  toId: string;
  kind: StaticEdgeKind;
  sourceFile: string;
  range?: SourceRange;
}): string {
  return createHash("sha1")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 20);
}
```

IDs are deterministic across process restarts for unchanged source.

- [ ] **Step 4: 实现 direct edges**

Create edges for resolved refs:

```text
Type → super/interface/permitted type
File → imported type
Field → field type
Method → param/return/throws/local type
Type/Method → annotation type
```

Confidence:

```text
QUALIFIED/EXPLICIT_IMPORT/SAME_PACKAGE/ENCLOSING = 0.98
JAVA_LANG = 0.98
WILDCARD_IMPORT unique = 0.82
REPO_UNIQUE_SIMPLE_NAME = 0.75
EXTERNAL = metadata/external-node edge only, never a repo candidate
AMBIGUOUS/UNRESOLVED = no exact edge
```

Populate `StaticEdge.resolution` exactly:

```text
DECLARES / explicit import declaration / explicit annotation node -> AST_EXPLICIT
resolved extends/implements/permits/field/param/return/throws/local/annotation type -> TYPE_REFERENCE + original TypeResolutionStrategy
```

- [ ] **Step 5: 实现有界 call resolution**

Allowed static call resolution:

1. same owner unqualified call by name+arity；
2. `this`/`super` receiver；
3. explicit type receiver for static call；
4. parameter/field/local receiver with resolved declared type；
5. constructor resolved type；
6. method reference with resolved owner type。

Candidate selection:

```text
same name
→ same arity
→ visible in receiver type or super chain
→ unique candidate
```

Argument type compatibility may only break ties when direct declared hints exist. No arbitrary tie-breaking.

Confidence:

```text
unique same-owner call                  0.92
unique receiver declared type call      0.90
super-chain unique call                 0.85
wildcard/global-fallback receiver       resolution confidence × 0.90
```

Call-edge resolution values:

```text
unqualified unique owner method -> SAME_OWNER_NAME_ARITY
declared field/parameter/local or explicit type receiver -> DECLARED_RECEIVER_NAME_ARITY
unique inherited method -> SUPER_CHAIN_NAME_ARITY
new Type(...) -> CONSTRUCTOR_TYPE
Type::method / resolved expr::method -> METHOD_REFERENCE_OWNER
```

Add tests that the same graph relation built by two different strategies preserves the actual strategy in diagnostic facts.

- [ ] **Step 6: reverse indexes**

Worker store must be able to answer:

```text
outEdges[fromId]
inEdges[toId]
implementers[typeId]
callers[methodId]
callees[methodId]
typeReferencers[typeId by edge kind]
```

Do not scan all edges per query.

- [ ] **Step 7: 受影响文件重建**

On changed file:

1. remove old facts and old outgoing edges from that file；
2. update registry；
3. resolve/rebuild changed file；
4. identify dependent files by old/new simple names and FQNs；
5. re-resolve/rebuild those files；
6. update reverse indexes。

On delete, remove both outgoing and incoming edges whose source facts no longer exist. Incoming edges from other files become unresolved and those files enter dependency rebuild set.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/java-index/edge-builder.test.js dist/java-index/name-resolver.test.js
npm test
git add src/java-index
git commit -m "feat(index): build import-aware Java type and call edges"
```

---

## Task 19：实现 JavaIndexStore 与 O(1) 查询路径

**Files:**
- Create: `src/java-index/index-store.ts`
- Test: `src/java-index/index-store.test.ts`
- Modify: `src/java-index/java-index-worker.ts`
- Modify: `src/java-index/java-index-client.ts`

**Interfaces:**
- Consumes: `javaFileId/javaTypeId/javaMethodId/javaFieldId` and `STABLE_ID_VERSION` from Task 15。
- Produces:
  - normalized in-memory store；
  - foreground refresh；
  - typed query responses；
  - no full-store scans on normal queries。

- [ ] **Step 1: 写 store replace/delete 测试**

Create `src/java-index/index-store.test.ts` with complete fixture builders; do not use `as any`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { JavaIndexStore } from "./index-store.js";
import type {
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  SourceRange,
  StaticEdge,
  StaticEdgeResolutionKind
} from "./index-types.js";
import { javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";

const RANGE: SourceRange = {
  start: { line: 1, column: 1 },
  end: { line: 4, column: 2 }
};

function fileFacts(relativePath: string, generation = 1): JavaFileFacts {
  return {
    fileId: javaFileId(relativePath),
    relativePath,
    sourceRoot: "src/main/java",
    module: ".",
    sourceSet: "main",
    packageName: "demo",
    imports: [],
    topLevelTypeIds: [],
    allTypeIds: [],
    contentHash: `hash:${relativePath}:${generation}`,
    size: 100,
    mtimeMs: generation,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation
  };
}

function emptyBundle(relativePath: string, simpleName: string, generation = 1): JavaFileBundle {
  const file = fileFacts(relativePath, generation);
  const typeId = javaTypeId({
    fqn: `demo.${simpleName}`,
    relativePath,
    range: RANGE
  });
  const type: JavaTypeFacts = {
    typeId,
    fqn: `demo.${simpleName}`,
    simpleName,
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  return { file, types: [type], fields: [], methods: [], edges: [] };
}

function addMethod(bundle: JavaFileBundle, name: string): JavaMethodFacts {
  const owner = bundle.types[0]!;
  const methodId = javaMethodId(owner.typeId, `${name}()`);
  const method: JavaMethodFacts = {
    methodId,
    ownerTypeId: owner.typeId,
    name,
    constructor: false,
    signatureKey: `${name}()`,
    range: RANGE,
    bodyRange: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    callSites: [],
    localTypes: []
  };
  owner.methodIds.push(methodId);
  bundle.methods.push(method);
  return method;
}

// Import javaEdgeId from ./stable-id.js; never reconstruct edge IDs locally.
function addEdge(
  bundle: JavaFileBundle,
  edge: Omit<StaticEdge, "edgeId" | "sourceFile" | "generation" | "resolution"> & {
    resolutionKind?: StaticEdgeResolutionKind;
  }
): void {
  const { resolutionKind = "AST_EXPLICIT", ...base } = edge;
  bundle.edges.push({
    ...base,
    edgeId: javaEdgeId({
      kind: edge.kind,
      fromId: edge.fromId,
      toId: edge.toId,
      range: edge.range
    }),
    sourceFile: bundle.file.relativePath,
    generation: bundle.file.generation,
    resolution: { kind: resolutionKind }
  });
}

test("replacing a file removes all old facts and reverse edges", () => {
  const store = new JavaIndexStore();
  const target = emptyBundle("src/main/java/demo/Target.java", "Target");
  const targetMethod = addMethod(target, "run");

  const oldPath = "src/main/java/demo/Service.java";
  const oldBundle = emptyBundle(oldPath, "OldService");
  const caller = addMethod(oldBundle, "call");
  addEdge(oldBundle, {
    fromId: caller.methodId,
    toId: targetMethod.methodId,
    kind: "CALLS",
    confidence: 1,
    range: RANGE
  });

  store.replaceFile(target);
  store.replaceFile(oldBundle);
  assert.ok(store.typeByFqn("demo.OldService"));
  assert.equal(store.callers(targetMethod.methodId).length, 1);

  const newBundleForSamePath = emptyBundle(oldPath, "NewService", 2);
  store.replaceFile(newBundleForSamePath);
  assert.equal(store.typeByFqn("demo.OldService"), undefined);
  assert.equal(
    store.callers(targetMethod.methodId).some(item => item.sourceFile === oldPath),
    false
  );
});

test("deleting a file removes its facts and marks dependents", () => {
  const store = new JavaIndexStore();
  const repositoryPath = "src/main/java/demo/OrderRepository.java";
  const servicePath = "src/main/java/demo/OrderService.java";
  const repository = emptyBundle(repositoryPath, "OrderRepository");
  const service = emptyBundle(servicePath, "OrderService");
  addEdge(service, {
    fromId: service.types[0]!.typeId,
    toId: repository.types[0]!.typeId,
    kind: "FIELD_TYPE",
    confidence: 1,
    range: RANGE
  });

  store.replaceFile(repository);
  store.replaceFile(service);
  const dependents = store.removeFiles([repositoryPath]);
  assert.ok(dependents.includes(servicePath));
  assert.equal(store.file(repositoryPath), undefined);
});
```

Run:

```bash
npm run build && node --test --test-name-pattern="replacing a file|deleting a file" dist/java-index/index-store.test.js
```

Expected: FAIL until `JavaIndexStore` implements atomic replacement, reverse-edge cleanup and dependency tracking.

- [ ] **Step 1a: 写 stable ID 与 store validation 测试**

Add tests:

```ts
test("store rejects absolute-path-derived IDs", () => {
  const store = new JavaIndexStore();
  const bundle = emptyBundle("src/main/java/demo/A.java", "A");
  bundle.file.fileId = "file:/Users/me/repo/src/main/java/demo/A.java";
  assert.throws(() => store.replaceFile(bundle), /stable repo-relative id/);
});

test("same relative facts from sibling worktrees have identical IDs", () => {
  const left = emptyBundle("src/main/java/demo/A.java", "A");
  const right = emptyBundle("src/main/java/demo/A.java", "A");
  assert.deepEqual(left.file.fileId, right.file.fileId);
  assert.deepEqual(left.types[0]?.typeId, right.types[0]?.typeId);
});
```

`replaceFile()` validates every file/type/field/method/edge ID against the Task 15 factories or grammar before mutating maps. This prevents an extractor regression from producing snapshots that cannot be seeded across worktrees.

- [ ] **Step 2: 建立 store maps**

```ts
export class JavaIndexStore {
  readonly filesByPath = new Map<string, JavaFileFacts>();
  readonly typesById = new Map<string, JavaTypeFacts>();
  readonly typeIdByFqn = new Map<string, string>();
  readonly typeIdsBySimpleName = new Map<string, Set<string>>();
  readonly fieldsById = new Map<string, JavaFieldFacts>();
  readonly methodsById = new Map<string, JavaMethodFacts>();
  readonly methodIdsByOwnerAndName = new Map<string, Set<string>>();
  readonly edgesById = new Map<string, StaticEdge>();
  readonly outEdgeIdsByNode = new Map<string, Set<string>>();
  readonly inEdgeIdsByNode = new Map<string, Set<string>>();
  readonly fileOwnedNodeIds = new Map<string, Set<string>>();
  readonly fileOwnedEdgeIds = new Map<string, Set<string>>();
  readonly dependentFilesByTypeName = new Map<string, Set<string>>();
}
```

- [ ] **Step 3: replaceFile transaction**

Build a `JavaFileBundle` off-store first. Validate all IDs and paths, then apply:

```text
remove old bundle
→ insert file
→ insert types/fields/methods
→ update name indexes
→ insert edges/reverse indexes
→ update dependency indexes
```

If validation fails, leave old bundle intact. Implement by snapshotting old bundle and restoring on exception, or by ensuring all validation occurs before mutation.

- [ ] **Step 4: query interfaces**

`JavaIndexStore` exposes the mutation and lookup API used by the tests and worker:

```ts
replaceFile(bundle: JavaFileBundle): void;
removeFiles(relativePaths: string[]): string[]; // dependent relative paths
file(relativePath: string): JavaFileFacts | undefined;
typeByFqn(fqn: string): JavaTypeFacts | undefined;
anchor(file: string, line: number, column: number): AnchorFacts | undefined;
typeLookup(typeText: string, scopeFile?: string): JavaTypeLookupResult;
implementers(typeId: string, limit: number): JavaTypeFacts[];
typeReferencers(typeId: string, kinds: Set<StaticEdgeKind>, limit: number): IndexedReference[];
callers(methodId: string, limit: number): IndexedReference[];
callees(methodId: string, limit: number): IndexedReference[];
files(paths: string[]): JavaFileBundle[];
```

Ordering inside the context-free store is deterministic by `relativePath + range + nodeId`. Module/source/task value ordering belongs to AgentRouter, where anchor context exists; do not hide ranking policy inside the index. No query returns an absolute path or any path outside the repo.

- [ ] **Step 5: worker command implementation**

Implement all Task 15 query commands using store. Responses are compact DTOs, not Maps/Sets or syntax nodes.

- [ ] **Step 6: client typed methods**

```ts
queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined>;
queryType(typeText: string, scopeFile?: string): Promise<JavaTypeLookupResult>;
queryImplementers(typeId: string, limit = 40): Promise<JavaTypeFacts[]>;
queryTypeReferencers(typeId: string, edgeKinds: StaticEdgeKind[], limit = 80): Promise<IndexedReference[]>;
queryCallers(methodId: string, limit = 80): Promise<IndexedReference[]>;
queryCallees(methodId: string, limit = 80): Promise<IndexedReference[]>;
queryFiles(files: string[]): Promise<JavaFileBundle[]>;
```

- [ ] **Step 7: Performance assertion**

Create a synthetic store of 10,000 types/50,000 edges in test or microbenchmark. Query same type 1,000 times. Record, but avoid flaky nanosecond hard assertions in unit tests. Use a broad guard:

```ts
assert.ok(elapsedMs < 500, `indexed lookup took ${elapsedMs}ms`);
```

Detailed P50/P95 belongs in phase report.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/java-index/index-store.test.js dist/java-index/java-index-client.test.js
npm test
git add src/java-index
git commit -m "feat(index): add normalized Java fact and edge store"
```

---

## Task 20：Manifest、coverage、foreground refresh 与 background sweep

**Files:**
- Create: `src/java-index/manifest.ts`
- Test: `src/java-index/manifest.test.ts`
- Create: `src/java-index/coverage.ts`
- Test: `src/java-index/coverage.test.ts`
- Modify: `src/java-index/java-index-worker.ts`
- Modify: `src/java-index/java-index-worker.test.ts`
- Modify: `src/java-index/java-index-client.ts`
- Modify: `src/repo-runtime-manager.ts`
- Modify: `src/cross-process-lease.ts`
- Modify: `src/java-index/parse-tree-cache.ts`
- Modify: `src/java-index/parse-tree-cache.test.ts`

**Interfaces:**
- Consumes: Task 9 `GenerationClock.rebaseAtLeast()`、Task 12a `CrossProcessLeaseStore`、Task 12b storm batches。
- Produces:
  - complete file manifest；
  - per-source-root coverage；
  - foreground queue priority；
  - safe negative lookup API。

- [ ] **Step 1: Manifest test includes untracked files**

Use temp repo-like layout without relying on git:

```ts
test("manifest discovers tracked and untracked Java files under source roots", async () => {
  await write("src/main/java/demo/A.java", "class A {}");
  await write("module/src/test/java/demo/BTest.java", "class BTest {}");
  await write("target/generated/Ignore.java", "class Ignore {}");
  const files = await discoverJavaFiles(root, layout);
  assert.deepEqual(files.map(relative).sort(), [
    "module/src/test/java/demo/BTest.java",
    "src/main/java/demo/A.java"
  ]);
});
```

- [ ] **Step 2: 实现 async directory walk**

Use `fs.promises.opendir()` recursively per known source root. Do not use `git diff` or sync walk. Ignore:

```text
.git .gradle build target out bin node_modules dist
```

Generated source roots explicitly detected by layout may be indexed with sourceSet `generated`; random `target/` directories are ignored.

- [ ] **Step 3: Coverage state machine**

```ts
export class CoverageTracker {
  begin(root: string, generation: number, discoveredFiles: number): void;
  indexed(root: string): void;
  recovered(root: string, file: string, errorCount: number): void;
  failed(root: string, file: string, error: unknown): void;
  complete(root: string, generation: number): void;
  invalidate(root: string, generation: number): void;
  canAnswerNegative(root: string, generation: number): boolean;
  snapshot(): SourceRootCoverage[];
}
```

`canAnswerNegative` only returns true when:

```text
state COMPLETE
and coverage.generation === query generation
and failedFiles === 0
and recoveredFiles === 0
```

A reliable incremental batch does **not** force a full sweep after every editor save. If the previous root state was COMPLETE, the watcher was healthy, and all add/change/delete operations in that root applied successfully, advance that root directly to COMPLETE at the new generation while updating manifest counts. `BUILD_CHANGE`, watcher degradation, unknown roots, read failure, recovered parse, or missed-path suspicion invalidates completeness and schedules reconcile/full sweep. Any recovered parse makes the root DEGRADED for negative conclusions.

- [ ] **Step 4: Queue priorities**

Worker queue items:

```ts
type IndexJob = {
  priority: 0 | 1; // 0 foreground, 1 background
  kind: "REFRESH_FILES" | "RELINK_FILES" | "FULL_SWEEP" | "RECONCILE" | "FLUSH";
  generation: number;
  files?: string[];
};
```

Rules:

- request anchor refresh is priority 0；
- normal watcher changes priority 0；
- storm batches never enqueue one priority-0 job per path; they enqueue one background reconcile while request anchors still use priority 0；
- full/delta sweep and sibling-seed `RELINK_FILES` priority 1 and require a machine-level sweep lease；
- a foreground anchor whose bundle is waiting for relink may submit a priority-0 relink for that file；
- priority 0 inserted before remaining background files；
- one worker, no parallel mutation；
- process background in chunks of 50 files, yielding to message loop between chunks。

- [ ] **Step 4a: 接入 machine-level sweep lease 和动态 parse-tree LRU**

Background `FULL_SWEEP/RECONCILE/RELINK_FILES` acquires `CrossProcessLeaseStore.acquireSweep()` before parsing the first chunk and heartbeats after every chunk. Release in `finally` on success, failure, cancellation, worker close, or runtime shutdown. Foreground `ensureFresh(anchor)` and a foreground single-file relink never acquire or wait for this lease.

```ts
export function effectiveParseTreeSourceBudget(
  configuredBytes: number | undefined,
  activeMachineRuntimes: number
): number {
  if (configuredBytes) return configuredBytes;
  if (activeMachineRuntimes >= 3) return 24 * 1024 * 1024;
  if (activeMachineRuntimes >= 2) return 32 * 1024 * 1024;
  return 64 * 1024 * 1024;
}
```

The runtime obtains `activeMachineRuntimes` from Task 12a `activeRuntimeCount()` without a family filter; this also bounds unrelated repos opened by other MCP processes. It may expose family-local count separately for diagnostics. Refresh the cache budget before starting a background chunk, not on every parser callback. An explicit `JAVA_LSP_PARSE_TREE_SOURCE_BYTES` override wins unchanged.

Add a deterministic integration test with two JavaIndex worker clients sharing one lease root:

```ts
test("machine sweep slot serializes background work without blocking foreground refresh", async () => {
  const gate = deferred<void>();
  const first = await createWorkerHarness({ sweepSlots: 1, onBackgroundChunk: () => gate.promise });
  const second = await createWorkerHarness({ leaseRoot: first.leaseRoot, sweepSlots: 1 });

  const sweepA = first.client.reconcile(11);
  await first.waitUntilBackgroundChunkEntered();
  const sweepB = second.client.reconcile(12);
  const foreground = await second.client.ensureFresh([second.anchorFile], 12);

  assert.equal(foreground.completion, "COMPLETE");
  assert.equal(second.backgroundChunksStarted(), 0);
  gate.resolve();
  await sweepA;
  await sweepB;
  assert.equal(second.backgroundChunksStarted(), 1);
});
```

Also test the default parse-tree source budget at 1/2/3 active machine runtimes and explicit override behavior.

- [ ] **Step 5: OPEN/rebase contract**

Task 20 defines the load hooks; Task 21 implements the snapshot bytes:

```text
load own snapshot candidate
→ validate schema/extractor/stableId/build/canonical root
→ clock.rebaseAtLeast(snapshot.indexedGeneration)
→ install facts provisionally
→ run manifest-only verification
→ identical manifest: retain COMPLETE at rebased generation
→ differences: generation++, apply changed/deleted paths, affected roots DEGRADED
→ foreground refresh requested anchor files
→ acquire sweep lease and schedule only required delta/full reconcile
```

Before manifest verification completes, query-cache reads/writes and negative lookups remain disabled even when provisional positive facts are available. First `java_impact` must not wait for a full AST sweep; it may use verified/provisional positive facts plus rg fallback with truthful DEGRADED coverage.

- [ ] **Step 6: Negative cache test**

```ts
assert.equal(tracker.canAnswerNegative(root, generation), false); // BUILDING
tracker.complete(root, generation);
assert.equal(tracker.canAnswerNegative(root, generation), true);

tracker.begin(root, generation + 1, 1);
tracker.recovered(root, "src/main/java/demo/Broken.java", 2);
tracker.complete(root, generation + 1);
assert.equal(tracker.snapshot()[0]?.recoveredFiles, 1);
assert.equal(tracker.canAnswerNegative(root, generation + 1), false);

tracker.invalidate(root, generation + 2);
assert.equal(tracker.canAnswerNegative(root, generation + 2), false);
```

In name/type lookup, negative memo is keyed by:

```text
sourceRoot + generation + query kind + normalized query
```

- [ ] **Step 7: Integrate coordinator**

`RepoChangeBatch` becomes `JavaIndexClient.refresh(generation, changed, deleted)`. Build/root change calls `reconcile(generation)` and updates source roots.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/java-index/manifest.test.js dist/java-index/coverage.test.js dist/java-index/index-store.test.js dist/java-index/java-index-worker.test.js dist/java-index/parse-tree-cache.test.js dist/cross-process-lease.test.js
npm test
git add src/java-index src/repo-runtime-manager.ts src/cross-process-lease.ts
git commit -m "feat(index): add complete coverage and background Java sweep"
```

---

## Task 21：原子 gzip snapshot、extractor version 和 corruption recovery

**Files:**
- Create: `src/java-index/snapshot.ts`
- Test: `src/java-index/snapshot.test.ts`
- Create: `src/java-index/build-fingerprint.ts`
- Test: `src/java-index/build-fingerprint.test.ts`
- Modify: `src/java-index/index-store.ts`
- Modify: `src/java-index/java-index-worker.ts`
- Modify: `src/build-info.ts`

**Interfaces:**
- Produces:
  - `JavaIndexSnapshotV2`
  - snapshot `stableIdVersion` and `manifestFingerprint`
  - own-snapshot generation rebase/verification semantics
  - `loadSnapshot()`
  - `writeSnapshotAtomic()`
  - old schema invalidation without migration。

- [ ] **Step 1: 定义 snapshot envelope**

```ts
export type JavaIndexSnapshotV2 = {
  schemaVersion: 2;
  extractorVersion: string;
  stableIdVersion: number;
  canonicalRepoRoot: string;
  buildFingerprint: string;
  manifestFingerprint: string;
  indexedGeneration: number;
  createdAt: string;
  coverage: SourceRootCoverage[];
  files: JavaFileFacts[];
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
  edges: StaticEdge[];
};
```

`extractorVersion`:

```text
schema-2|tree-sitter-<version>|tree-sitter-java-<version>|extractor-code-<buildHash>
```

Use build stamp or a manually incremented extractor code version. Parser fixes must invalidate old AST cache. `stableIdVersion` is `STABLE_ID_VERSION` from Task 15. `manifestFingerprint` hashes the sorted target manifest entries `relativePath + contentHash + sourceRoot`; it is independent of absolute repoRoot.

Create `computeBuildFingerprint()`:

```ts
export async function computeBuildFingerprint(
  repoRoot: string,
  layout: LayoutContext
): Promise<string>;
```

It hashes sorted `relativePath + contentHash` entries for detected root/module build files and JDK markers, plus sorted source/resource roots and layout kind/profile. Include:

```text
pom.xml
settings.gradle / settings.gradle.kts
build.gradle / build.gradle.kts
gradle.properties
gradle/libs.versions.toml
.java-version
.sdkmanrc
.mvn/jvm.config
```

Tests prove:

- mtime-only change does not change fingerprint；
- content change does；
- module build file change does；
- source-root/layout change does；
- ordering of filesystem enumeration does not。

- [ ] **Step 2: 写 atomic crash test**

```ts
test("failed snapshot write leaves the previous snapshot readable", async () => {
  await writeSnapshotAtomic(path, firstSnapshot);
  await assert.rejects(() => writeSnapshotAtomic(path, secondSnapshot, {
    beforeRename: async () => { throw new Error("injected before rename"); }
  }));
  const loaded = await loadSnapshot(path, expectedIdentity);
  assert.equal(loaded?.indexedGeneration, firstSnapshot.indexedGeneration);
});
```

- [ ] **Step 3: 写 corruption/mismatch tests**

Cases:

- invalid gzip；
- valid gzip invalid JSON；
- schemaVersion 1；
- extractor mismatch；
- canonical repo mismatch in normal own-snapshot load；
- build fingerprint mismatch；
- stable ID version mismatch；
- manifest fingerprint mismatch after target verification。

All return a classified miss/degraded status and never crash MCP. The implementation **deletes** the corrupt snapshot after recording one concise diagnostic; it does not retain timestamped corrupt copies in this personal-project cache.

- [ ] **Step 4: 实现 async atomic write**

```ts
export type SnapshotWriteHooks = {
  beforeRename?: () => Promise<void>;
};

export async function writeSnapshotAtomic(
  target: string,
  value: JavaIndexSnapshotV2,
  hooks: SnapshotWriteHooks = {}
): Promise<number> {
  const directory = path.dirname(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const json = Buffer.from(JSON.stringify(value));
  const compressed = await gzipAsync(json, { level: 6 });
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(compressed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.beforeRename?.();
    await rename(tmp, target);
    await fsyncDirectoryBestEffort(directory);
    return compressed.length;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
```

Import `rm` from `node:fs/promises`, import callback `gzip` from `node:zlib`, and define `const gzipAsync = promisify(gzip)` using `node:util`. Implement `fsyncDirectoryBestEffort(directory)` by opening the directory and calling `sync()`; ignore only `EINVAL`, `ENOTSUP`, and `EPERM`, because directory fsync support varies while this file is a rebuildable cache. The `beforeRename` hook exists only for deterministic crash tests and must not be used by production callers.

All serialization/compression happens in worker, so JSON stringify does not block MCP main thread.

- [ ] **Step 5: Debounced flush**

- after foreground refresh: schedule snapshot flush in 1s；
- additional changes reset timer；
- `FLUSH` command forces immediate write；
- `CLOSE` flushes if dirty within a bounded 2s budget, otherwise closes and relies on next rebuild；
- full sweep completion forces flush。

- [ ] **Step 6: Store export/import**

`JavaIndexStore.toSnapshotData()` returns deterministic arrays sorted by ID/path, improving diff/debug reproducibility. `loadSnapshotData()` validates duplicate IDs and rebuilds reverse indexes; reverse maps are not persisted.

- [ ] **Step 6a: generation rebase、manifest verification 与 stale publish 拒绝**

Add deterministic tests:

```ts
test("own snapshot reload rebases clock and restores COMPLETE without reparsing", async () => {
  const written = snapshot({ indexedGeneration: 41, manifestFingerprint: "manifest-a" });
  await writeSnapshotAtomic(file, written);

  const clock = new GenerationClock();
  const parser = new CountingParser();
  const opened = await openOwnSnapshot({ file, repoRoot, clock, parser, manifest });

  assert.equal(clock.snapshot().value, 41);
  assert.equal(opened.coverage.every(item => item.state === "COMPLETE"), true);
  assert.equal(parser.parseCalls, 0);
  assert.equal(opened.negativeLookupAllowed, true);
});

test("changed manifest rebases then advances and degrades only affected roots", async () => {
  const opened = await openOwnSnapshot({
    file,
    repoRoot,
    clock,
    parser,
    manifest: changedManifest
  });
  assert.equal(clock.snapshot().value, 42);
  assert.equal(opened.negativeLookupAllowed, false);
  assert.deepEqual(opened.changed, ["src/main/java/demo/Changed.java"]);
});

test("snapshot candidate is not renamed after manifest changes during serialization", async () => {
  await assert.rejects(
    () => publishSnapshotIfCurrent(candidate, {
      currentManifestFingerprint: () => "newer-manifest"
    }),
    /manifest changed before publish/
  );
  assert.equal((await loadSnapshot(file, identity))?.manifestFingerprint, "previous");
});
```

Rules:

1. normal own-snapshot load validates canonical root, then calls `clock.rebaseAtLeast(indexedGeneration)`；
2. facts may be installed before verification only as positive provisional facts; cache/negative/persisted-edge writes remain disabled；
3. identical target manifest restores COMPLETE without AST parse；
4. differences advance generation exactly once and invalidate affected roots；
5. atomic rename is allowed only when the candidate manifest fingerprint still equals the latest target manifest fingerprint；
6. generation is not a cross-process truth token; content manifest is the cross-process safety proof。

- [ ] **Step 7: 删除旧 cache on V2 first open**

Within repo cache directory delete only SourceIndex V1 artifacts:

```text
source-index.files.jsonl
source-index.symbols.jsonl
source-index.meta.json
```

Do **not** delete the current persisted semantic-edge snapshot in this task. It contains JDT-verified knowledge and remains readable until Task 33 writes and validates `SemanticEdgeStoreV2`; only then may the legacy semantic-edge schema be removed.

Do not scan outside the repo cache directory. Write one one-time cleanup marker:

```text
java-index-v2.initialized
```

This is not a data migration; it prevents repeated cleanup.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/java-index/snapshot.test.js dist/java-index/build-fingerprint.test.js dist/java-index/manifest.test.js
npm test
git add src/java-index src/build-info.ts
git commit -m "feat(index): persist Java facts in an atomic versioned snapshot"
```

---

## Task 21a：实现兄弟 worktree validated snapshot seeding

**Files:**
- Create: `src/java-index/worktree-snapshot-seeder.ts`
- Test: `src/java-index/worktree-snapshot-seeder.test.ts`
- Modify: `src/java-index/snapshot.ts`
- Modify: `src/java-index/manifest.ts`
- Modify: `src/java-index/java-index-worker.ts`
- Modify: `src/java-index/java-index-client.ts`
- Modify: `src/worktree-identity.ts`
- Modify: `src/tools/status.ts`

**Interfaces:**
- Consumes: `WorktreeIdentity`、Task 15 stable IDs、Task 20 manifest/coverage、Task 21 snapshot loader。
- Produces:
  - `WorktreeSnapshotSeeder.findCandidate()`
  - `WorktreeSnapshotSeeder.seedValidatedFacts()`
  - target-owned DEGRADED seed result
  - delta reconcile inputs

- [ ] **Step 1: 写真实 Git worktree seed 失败测试**

Create a temporary repository with primary worktree A and linked worktree B. Build a COMPLETE snapshot for A, then modify one Java file and add/delete files in B before opening B:

```ts
test("sibling seed reuses only target-content-matching facts", async () => {
  const family = await createGitWorktreeFamilyWithJavaFiles();
  await writeCompleteSnapshotFor(family.primary, {
    files: ["Same.java", "Changed.java", "DeletedInB.java"]
  });
  await changeJava(family.linked, "Changed.java");
  await deleteJava(family.linked, "DeletedInB.java");
  await addJava(family.linked, "NewInB.java");

  const parser = new CountingParser();
  const result = await seedForTarget(family.linked, parser);

  assert.deepEqual(result.reusedPaths, ["src/main/java/demo/Same.java"]);
  assert.deepEqual(result.dirtyPaths.sort(), [
    "src/main/java/demo/Changed.java",
    "src/main/java/demo/NewInB.java"
  ]);
  assert.equal(result.reusedPaths.includes("src/main/java/demo/DeletedInB.java"), false);
  assert.equal(result.coverage, "DEGRADED");
  assert.equal(result.negativeLookupAllowed, false);
  assert.equal(parser.parseCalls, 0); // manifest verification, not AST parse
});
```

Then release the background reconcile gate and assert B becomes COMPLETE, changed/new files are parsed, deleted facts remain absent, and B writes its own snapshot under B’s repoHash.

- [ ] **Step 2: 定义 candidate and result contracts**

```ts
export type WorktreeSeedCandidate = {
  sourceRepoRoot: string;
  sourceRepoHash: string;
  sourceSnapshotPath: string;
  createdAt: string;
  indexedGeneration: number;
  buildFingerprint: string;
  manifestFingerprint: string;
};

export type WorktreeSeedResult = {
  sourceRepoHash: string;
  targetGeneration: number;
  reusedPaths: string[];
  dirtyPaths: string[];
  deletedSourcePaths: string[];
  relinkPaths: string[];
  droppedCrossFileEdges: number;
  manifestValidationMs: number;
  reusedFiles: number;
  coverage: "DEGRADED";
  negativeLookupAllowed: false;
};
```

- [ ] **Step 3: 选择候选**

```text
only when target has no valid own snapshot
same familyHash / same git common-dir
source cache meta points to an existing sibling worktree or retained cache
snapshot COMPLETE for every relevant root
schemaVersion/extractorVersion/stableIdVersion match
buildFingerprint match
deterministically choose newest createdAt, then sourceRepoHash
```

Never seed from the target itself, an active temp snapshot, a corrupt snapshot, a snapshot with recovered/failed files, or a source with mismatched build fingerprint.

- [ ] **Step 4: manifest-first validation**

Before any source fact becomes queryable:

1. record `validationGeneration = targetClock.snapshot().value` and enumerate target Java manifest asynchronously；
2. read every candidate target file through a stable-read helper: `open → fstat → hash bytes → fstat/restat`; if identity/size/mtime changes during the read, classify it dirty rather than reusable；
3. compare normalized `relativePath + contentHash + sourceRoot` against source snapshot file facts；
4. copy into a **fresh, not-yet-published** target store only file-local facts whose target source content matches exactly；
5. reuse a repo-internal resolved edge only when both endpoint owner files are in the exact-match set; otherwise drop the edge and enqueue the source file as `RELINK_ONLY`；
6. rewrite no symbol IDs—Task 15 IDs are already root-independent；
7. never carry source absolute paths, source generation, query caches or coverage COMPLETE state；
8. before publishing the fresh store, call `coordinator.flushNow()` and compare the current generation with `validationGeneration`; if changed, revalidate only reused paths touched by the intervening batches and remove any unstable bundle/edge；
9. atomically install the fresh target store inside the single JavaIndex worker mutation lane, mark roots DEGRADED/BUILDING, and schedule changed/new files plus dependency-invalidated/relink dependents；
10. source-only/deleted paths are not inserted。

A candidate whose snapshot includes an absolute-path-derived ID fails closed with `INDEX_CORRUPT` and is skipped.

- [ ] **Step 5: generation and publication rules**

Seed source `indexedGeneration` is ignored. The target uses its current `GenerationClock` value; reused bundles are stamped into that target generation. Negative lookup stays disabled until target reconcile validates all target files and promotes roots COMPLETE. Only then may Task 21 write the target-owned snapshot.

First version explicitly does **not** seed:

```text
JDT workspace
open documents
semantic completed-value cache
PersistedSemanticEdgeStore
rg query cache
negative memo
```

- [ ] **Step 6: fault and concurrency tests**

Add tests for:

1. corrupt newest candidate falls back to next valid candidate；
2. source snapshot disappears during read → target continues empty/degraded；
3. target file changes during manifest validation or after its hash but before store publication → `flushNow()`/generation recheck marks it dirty, never reused；
4. unchanged source file whose referenced target type changed/deleted reuses declarations but drops the old resolved edge and enters `RELINK_ONLY`；
5. source/target path separator differences do not change stable IDs；
6. two target processes seed concurrently but atomic target snapshot publication remains manifest-validated；
7. no own snapshot + no valid sibling → ordinary cold sweep path。

- [ ] **Step 7: status/metrics**

Diagnostic status:

```ts
worktreeSeed: {
  attempted: boolean;
  sourceRepoHash?: string;
  reusedFiles: number;
  dirtyFiles: number;
  relinkFiles: number;
  droppedCrossFileEdges: number;
  manifestValidationMs: number;
  deltaParsedFiles: number;
  completion: "NOT_ATTEMPTED" | "SEEDED_DEGRADED" | "RECONCILED_COMPLETE" | "NO_VALID_SOURCE" | "FAILED";
}
```

Standard output only exposes `worktreeSeed: "none" | "degraded" | "complete"` when it affects current freshness.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/java-index/worktree-snapshot-seeder.test.js dist/java-index/snapshot.test.js dist/worktree-identity.test.js
npm test
git add src/java-index/worktree-snapshot-seeder.ts src/java-index/worktree-snapshot-seeder.test.ts src/java-index/snapshot.ts src/java-index/manifest.ts src/java-index/java-index-worker.ts src/java-index/java-index-client.ts src/worktree-identity.ts src/tools/status.ts
git commit -m "perf(worktree): seed Java facts from validated sibling snapshots"
```

---

## Task 22：接入 AgentRouter，替换 SourceIndex V1 并删除同步热点

**Files:**
- Modify: `src/repo-runtime-manager.ts`
- Modify: `src/worktree-identity.ts`
- Modify: `src/java-index/worktree-snapshot-seeder.ts`
- Modify: `src/tools/context.ts`
- Modify: `src/agent-router/index.ts`
- Modify: current static/type/import/call providers
- Modify: `src/tools/status.ts`
- Modify: `src/server.ts`
- Delete after gate: `src/source-index.ts`
- Delete/replace tests: `src/source-index.test.ts`
- Create: `src/java-index/router-integration.test.ts`

**Interfaces:**
- Consumes: `JavaIndexClient`。
- Produces: router uses async V2 facts; runtime prefers own snapshot, then validated sibling seed, then cold sweep; old V1 is removed after benchmark parity。

- [ ] **Step 1: 建立 temporary V2 adapter interface**

Router should depend on:

```ts
export interface JavaIndexView {
  ensureFresh(files: string[], generation: number): Promise<void>;
  queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined>;
  queryType(typeText: string, scopeFile?: string): Promise<JavaTypeLookupResult>;
  queryImplementers(typeId: string, limit: number): Promise<JavaTypeFacts[]>;
  queryTypeReferencers(typeId: string, kinds: StaticEdgeKind[], limit: number): Promise<IndexedReference[]>;
  queryCallers(methodId: string, limit: number): Promise<IndexedReference[]>;
  queryCallees(methodId: string, limit: number): Promise<IndexedReference[]>;
  queryFiles(files: string[]): Promise<JavaFileBundle[]>;
  status(): Promise<JavaIndexStatus>;
}
```

Use `JavaIndexClient` directly if it already satisfies this interface.

- [ ] **Step 1a: 接入 OPEN source selection**

Runtime OPEN order is exact:

```text
valid own snapshot
→ else valid sibling seed (Task 21a)
→ else empty store + foreground anchor refresh + background sweep
```

The selected source must be captured in `RequestContext`/diagnostic metrics. A seed result is never treated as COMPLETE before target reconcile. Add an integration test where two linked worktrees differ in one service implementation: B’s first impact may use A’s matching DTO/repository facts, but must not return A’s old implementation as a target fact, and after B foreground refresh the B implementation is selected.

- [ ] **Step 2: 写 router integration test**

Test fixture must prove:

- package-private anchor method resolved；
- nested type appears；
- implements candidate found without rg；
- signature collaborator found without `spawnSync`；
- method call candidate found；
- coverage is reported。

Inject a fake `RgRunner` that throws if called for a query which complete JavaIndex should answer. Expected test still passes, proving no hidden scan fallback.

- [ ] **Step 3: AnchorResolver async migration**

Replace:

```text
sourceIndex.factsFor()
sourceIndex.methodAt()
token regex fallback
```

with:

```ts
await index.ensureFresh([anchor.file], request.generation);
const facts = await index.queryAnchor(anchor.file, anchor.line, anchor.column);
```

If index is degraded and no anchor facts, use minimal file/token fallback and mark coverage degraded; do not fail whole impact.

- [ ] **Step 4: Static providers migration**

Replace old static providers:

```text
findImplementers
findTypeReferences
findTypeDefinitions
import graph query
persisted static edge query
```

with V2 queries. Existing import/static-edge behavior is mapped into `StaticEdge` rather than duplicated. Existing persisted **JDT exact** edges remain in the current semantic edge store and are consumed through a temporary adapter until Task 33 introduces `SemanticEdgeStoreV2`; they are never converted into AST edges or silently discarded.

- [ ] **Step 5: Read window migration**

Use AST method/type ranges from `JavaIndex` for readPlan. Remove regex brace scan from normal path. Keep fixed radius fallback only when parseState FAILED.

- [ ] **Step 6: Status/output**

`java_status` diagnostic includes:

```ts
javaIndex: {
  state,
  indexedGeneration,
  files,
  types,
  methods,
  edges,
  snapshotBytes,
  pendingForeground,
  pendingBackground,
  coverage,
  lastError
}
```

Standard summary:

```ts
javaIndex: {
  state,
  files,
  coverage: "complete" | "partial" | "degraded"
}
```

- [ ] **Step 7: Benchmark challenger before delete**

For one commit only, support benchmark env:

```text
JAVA_LSP_INDEX_BACKEND=v1|v2
```

This is the only permitted migration flag. Run both backends against same business repo commits and write results.

Gate:

```text
V2 R_read_must = 1.0000
V2 recall/P_read no lower than V1 baseline-relative gate
V2 steady P95 <= V1 × 1.10
V2 output bytes <= V1 × 1.05
```

- [ ] **Step 8: 删除 V1 与 flag**

After gate passes in same branch:

- delete `source-index.ts` and V1 tests；
- remove `JAVA_LSP_INDEX_BACKEND`；
- rename V2 status to normal `sourceIndex` only if public naming is valuable; recommended output name is `javaIndex`；
- remove old JSONL cleanup code after one release cycle is unnecessary because no compatibility is required; keep one-time deletion in V2 open for existing local caches。

- [ ] **Step 9: 验证没有同步 rg fallback**

Run:

```bash
rg -n "spawnSync\(\"rg\"|appendFileSync|source-index\.files\.jsonl|source-index\.symbols\.jsonl" src
```

Expected:

- no request-path `spawnSync("rg")`；
- no old append/compact；
- old cache filenames only appear in one-time cleanup test/code。

- [ ] **Step 10: Run/Commit**

```bash
npm run build
node --test dist/java-index/router-integration.test.js
npm test
git add -A src
git commit -m "refactor(index): replace regex SourceIndex with JavaIndex V2"
```

---

## Task 23：Iteration C 性能、质量和快照验证报告

**Files:**
- Create: `src/benchmark/java-index-benchmark.ts`
- Create: `docs/phase-v3/phase3-java-index-v2-report.md`
- Create: `artifacts/v3-phase3/`

**Interfaces:**
- Consumes: completed JavaIndex V2、Task 0/Phase 2 baselines、three real repo roots。
- Produces: index microbenchmarks、snapshot/freshness evidence、new-worktree seed before/after evidence、real-repo quality comparison and the Iteration C release decision。

- [ ] **Step 1: 建立 index microbenchmark**

Measure separately:

```text
fresh full sweep
snapshot load
single-file full-parse refresh
single-file incremental refresh
incremental/full fact equivalence
type lookup
implementer lookup
caller lookup
main event-loop delay during sweep
snapshot bytes
```

Use `monitorEventLoopDelay()` from `node:perf_hooks` in main process while worker indexes fixture copies.

- [ ] **Step 2: 运行复杂 fixture tests**

```bash
npm run build
node --test "dist/java-index/**/*.test.js"
npm test
```

Expected:

- package-private/nested/multiple top-level/text block/generic/record/sealed/collision/malformed all pass。

- [ ] **Step 3: 三仓 benchmark**

Run cold matrix twice:

1. fresh V2 snapshot removed；
2. snapshot hit/coverage complete。

Do not mix initial full sweep time into steady `java_impact` P95; report both separately.

- [ ] **Step 3a: 新 worktree cold-start seeding A/B**

For at least one real repo and one large synthetic fixture:

```text
A: create linked worktree, clear target cache, disable seeding, run first impact + reconcile
B: create equivalent linked worktree, clear target cache, enable seeding, run same first impact + reconcile
```

Record separately:

```text
firstImpactElapsedMs
firstImpactJavaIndexCoverage
firstImpactCandidateSourceDistribution
manifestValidationMs
reusedFiles
deltaParsedFiles
fullParsedFiles
reconcileElapsedMs
snapshotBytes
mainEventLoopDelayP99
```

Correctness gate:

```text
modified target files reused = 0
deleted source-only facts visible = 0
negative lookup before target COMPLETE = 0
post-reconcile target facts equal a clean target full sweep
```

Efficiency target—not a correctness hard gate until measured on the fixed machine:

```text
seeded deltaParsedFiles <= no-seed fullParsedFiles * 0.20 for a near-identical worktree
seeded first impact has no lower R_read_must/R_task_blocking than no-seed
```

- [ ] **Step 4: Mutation matrix**

For each operation:

```text
change method signature
add new implementer
rename type
move package
delete type
change pom module
```

Assert stale rate 0 and record edit-to-visible.

- [ ] **Step 5: Gate**

```text
build/test 0 fail
R_read_must 1.0000
recall/P_read no regression
steady cold P95 <= previous phase ×1.10
snapshot-hit load P95 <= 500ms on reference machine
single-file refresh P95 <= 50ms
indexed query P95 <= 5ms
main event-loop delay P99 <= 20ms during worker sweep
outside path 0
negative-cache false miss 0
worktree seed modified-file false reuse 0
worktree seeded post-reconcile equivalence 100%
machine background sweep concurrency <= configured slots
```

Absolute performance gates may be marked machine-specific failure without blocking correctness; if missed, fix before Iteration D rather than weakening silently.

- [ ] **Step 6: Report/Commit**

```bash
git add src/benchmark/java-index-benchmark.ts docs/phase-v3/phase3-java-index-v2-report.md artifacts/v3-phase3
git commit -m "docs(v3): validate Tree-sitter JavaIndex V2"
```

Iteration C completion gate:

```text
Tree-sitter is primary fact source
coverage is explicit
old V1 removed
no sync index IO on MCP thread
atomic snapshot verified
own-snapshot generation rebase verified
validated sibling-worktree seeding verified
all quality hard gates pass
```

---

# Iteration D：Evidence、框架关系与 token 极致化


## Task 24：统一 EvidenceSignal、ProviderOutcome 与 CandidateEvidence

**Files:**
- Create: `src/agent-router/evidence.ts`
- Create: `src/agent-router/evidence-normalizer.ts`
- Test: `src/agent-router/evidence-normalizer.test.ts`
- Create: `src/agent-router/providers/static-provider.ts`
- Create: `src/agent-router/providers/lexical-provider.ts`
- Create: `src/agent-router/providers/semantic-provider.ts`
- Create: `src/agent-router/providers/support-provider.ts`
- Modify: `src/agent-router/index.ts`
- Modify: `src/agent-types.ts`
- Modify: current semantic edge store adapter from Task 0 mapping

**Interfaces:**
- Consumes: JavaIndex queries、RgRunner、SemanticGateway/current semantic adapter。
- Produces: all candidate sources return `ProviderOutcome`; no provider directly mutates final score。

- [ ] **Step 1: 定义 authoritative evidence types**

Create `src/agent-router/evidence.ts`:

```ts
import type { Completion } from "../runtime/completion.js";
import type { SourceRange } from "../java-index/index-types.js";

export type EvidenceProvenance =
  | "AST_EXACT"
  | "AST_RESOLVED"
  | "FRAMEWORK_INFERRED"
  | "LEXICAL_RG"
  | "JDT_EXACT"
  | "PERSISTED_JDT";

export type EvidenceFamily =
  | "EXACT_SEMANTIC"
  | "STATIC_STRUCTURE"
  | "FRAMEWORK"
  | "LEXICAL"
  | "TASK_CONTEXT"
  | "SUPPORT";

export type EvidenceCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type EvidenceSignal = {
  signalId: string;
  candidateFile: string;
  candidateNodeId?: string;
  anchorId: string;
  kind: string;
  family: EvidenceFamily;
  provenance: EvidenceProvenance;
  confidence: number;
  completeness: EvidenceCompleteness;
  weight: number;
  sourceFile: string;
  sourceRange?: SourceRange;
  positions: Array<{ line: number; column: number }>;
  providerId: string;
  providerVersion: string;
  generation: number;
  detail?: string;
};

export type ProviderOutcome = {
  providerId: string;
  providerVersion: string;
  evidence: EvidenceSignal[];
  completion: Completion;
  elapsedMs: number;
  degradation?: string;
};

export interface CandidateProvider {
  readonly id: string;
  readonly version: string;
  collect(input: ProviderInput): Promise<ProviderOutcome>;
}

export type CandidateEvidence = {
  file: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  signals: EvidenceSignal[];
  familyScores: Partial<Record<EvidenceFamily, number>>;
  finalScore: number;
  confidence: "high" | "medium" | "low";
  degradation: string[];
};
```

Add `ProviderInput` containing request context, anchors, options, JavaIndex view, layout, and previously collected core paths. It must not expose a mutable candidate map.

- [ ] **Step 2: 写 normalizer duplicate test**

```ts
test("normalizer deduplicates the same underlying evidence", () => {
  const duplicate = signal({
    candidateFile: "A.java",
    kind: "IMPLEMENTS",
    providerId: "static",
    sourceFile: "A.java",
    sourceRange: range(2, 1, 2, 20)
  });
  const result = normalizeEvidence([duplicate, { ...duplicate, signalId: "other" }]);
  assert.equal(result.get("A.java")!.signals.length, 1);
});

test("normalizer preserves independent evidence families", () => {
  const result = normalizeEvidence([
    signal({ candidateFile: "A.java", family: "STATIC_STRUCTURE", kind: "IMPLEMENTS" }),
    signal({ candidateFile: "A.java", family: "EXACT_SEMANTIC", kind: "REFERENCE" })
  ]);
  assert.equal(result.get("A.java")!.signals.length, 2);
});
```

- [ ] **Step 3: 实现 canonical evidence key**

```ts
function evidenceIdentity(signal: EvidenceSignal): string {
  return JSON.stringify({
    candidateFile: signal.candidateFile,
    candidateNodeId: signal.candidateNodeId,
    kind: signal.kind,
    family: signal.family,
    provenance: signal.provenance,
    sourceFile: signal.sourceFile,
    sourceRange: signal.sourceRange,
    providerId: signal.providerId
  });
}
```

For the same identity keep the signal with:

1. higher confidence；
2. COMPLETE over PARTIAL over UNKNOWN；
3. higher weight；
4. deterministic signalId tie-break。

- [ ] **Step 4: 实现 confidence/completeness validation**

`normalizeEvidence()` rejects or clamps invalid provider output:

```ts
if (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1) {
  throw new JavaIntelligenceError(
    "INVALID_INPUT",
    `Evidence ${signal.signalId} has invalid confidence ${String(signal.confidence)}`
  );
}
```

Provider bugs must fail tests; do not silently convert NaN to zero.

- [ ] **Step 5: 迁移 static provider**

`static-provider.ts` queries:

- implementers；
- type/signature referencers；
- callers/callees；
- import relationships；
- direct type definitions。

Map to signals:

| Static edge | family | provenance | initial confidence |
|---|---|---|---:|
| IMPLEMENTS/EXTENDS | STATIC_STRUCTURE | AST_RESOLVED | edge confidence |
| FIELD/PARAM/RETURN | STATIC_STRUCTURE | AST_RESOLVED | edge confidence |
| CALLS | STATIC_STRUCTURE | AST_RESOLVED | edge confidence |
| IMPORTS only | STATIC_STRUCTURE | AST_EXACT | 0.55 |
| direct declaration | STATIC_STRUCTURE | AST_EXACT | 0.98 |

Provider weights come from one policy object but are not added to candidate directly.

- [ ] **Step 6: 迁移 lexical provider**

`lexical-provider.ts` wraps existing profile-specific rg plans. Every result gets:

```ts
family: "LEXICAL"
provenance: "LEXICAL_RG"
completeness: search completion === "COMPLETE" ? "COMPLETE" : "PARTIAL"
confidence: lexicalConfidence(match, profile)
```

Existing lishuedu-specific policy may remain in repo policy pack, but generic provider has no business names.

- [ ] **Step 7: 迁移 semantic/support providers**

- semantic provider emits EXACT_SEMANTIC/JDT_EXACT from live gateway and PERSISTED_JDT from the current semantic edge store adapter；
- persisted edges retain dependency/generation validation and are never relabeled as AST evidence；
- tests/config/SQL/XML support emits SUPPORT；
- focus module/task keywords emit TASK_CONTEXT signals from a tiny context provider, not direct score mutation。

- [ ] **Step 8: 重写 router orchestration**

Target shape:

```ts
const outcomes = await runProviders(providerPlan, input);
const normalized = normalizeEvidence(outcomes.flatMap(item => item.evidence));
const ranked = rankCandidates(normalized, rankContext);
const readPlan = planReadContext(ranked, planContext);
return formatImpactV6({
  request: input.request,
  target: input.anchors[0],
  providerOutcomes: outcomes,
  ranked,
  readPlan
});
```

During this task `rankCandidates` may adapt old scoring. Task 25 replaces it.

- [ ] **Step 9: Run/Commit**

```bash
npm run build
node --test dist/agent-router/evidence-normalizer.test.js dist/agent-router.test.js
npm test
git add src/agent-router src/agent-types.ts
git commit -m "refactor(router): normalize all candidate sources as evidence"
```

---

## Task 25：实现证据家族饱和 Ranker，替换裸加法

**Files:**
- Create: `src/agent-router/family-ranker.ts`
- Test: `src/agent-router/family-ranker.test.ts`
- Modify: `src/routing-policy.ts`
- Modify or delete after parity: old score merge helpers
- Modify: current ranking tests

**Interfaces:**
- Consumes: normalized `CandidateEvidence`。
- Produces:
  - `rankCandidates()` pure deterministic function；
  - family contribution diagnostics；
  - no repeated full-score accumulation。

- [ ] **Step 1: 写 duplicate amplification 失败测试**

```ts
test("three duplicate lexical providers cannot outrank one exact semantic edge", () => {
  const exact = candidate("Exact.java", [
    signal({
      family: "EXACT_SEMANTIC",
      kind: "REFERENCE",
      weight: 100,
      confidence: 1
    })
  ]);
  const duplicated = candidate("Duplicated.java", [
    signal({ family: "LEXICAL", kind: "NAME_MATCH", weight: 60, confidence: 0.7, providerId: "rg-a" }),
    signal({ family: "LEXICAL", kind: "NAME_MATCH", weight: 60, confidence: 0.7, providerId: "rg-b" }),
    signal({ family: "LEXICAL", kind: "NAME_MATCH", weight: 60, confidence: 0.7, providerId: "rg-c" })
  ]);
  const ranked = rankCandidates([duplicated, exact], context());
  assert.equal(ranked[0].file, "Exact.java");
});
```

- [ ] **Step 2: 写 independent-family bonus test**

```ts
test("independent structure and framework evidence can combine", () => {
  const oneFamily = candidate("One.java", [
    signal({ family: "STATIC_STRUCTURE", kind: "PARAM_TYPE", weight: 80, confidence: 0.9 })
  ]);
  const twoFamilies = candidate("Two.java", [
    signal({ family: "STATIC_STRUCTURE", kind: "PARAM_TYPE", weight: 70, confidence: 0.9 }),
    signal({ family: "FRAMEWORK", kind: "SPRING_INJECTION", weight: 65, confidence: 0.95 })
  ]);
  assert.equal(rankCandidates([oneFamily, twoFamilies], context())[0].file, "Two.java");
});
```

- [ ] **Step 3: 定义 policy contract**

```ts
export type FamilyRankPolicy = {
  baseScore: number;
  familyCaps: Record<EvidenceFamily, number>;
  diversityBonus: Record<EvidenceFamily, number>;
  completenessFactor: Record<EvidenceCompleteness, number>;
  sourceSetDelta: Record<string, number>;
  sameModuleDelta: number;
  crossModulePenalty: number;
  testDeferPenalty: number;
};
```

Generic initial policy:

```ts
export const genericFamilyRankPolicy: FamilyRankPolicy = {
  baseScore: 1,
  familyCaps: {
    EXACT_SEMANTIC: 150,
    STATIC_STRUCTURE: 130,
    FRAMEWORK: 120,
    LEXICAL: 70,
    TASK_CONTEXT: 50,
    SUPPORT: 45
  },
  diversityBonus: {
    EXACT_SEMANTIC: 8,
    STATIC_STRUCTURE: 10,
    FRAMEWORK: 8,
    LEXICAL: 4,
    TASK_CONTEXT: 3,
    SUPPORT: 3
  },
  completenessFactor: {
    COMPLETE: 1,
    PARTIAL: 0.55,
    UNKNOWN: 0.35
  },
  sourceSetDelta: { main: 15, test: 0, generated: -5, unknown: 0 },
  sameModuleDelta: 24,
  crossModulePenalty: -18,
  testDeferPenalty: -12
};
```

This is an initial deterministic policy, not a probability model.

- [ ] **Step 4: 实现 family contribution**

```ts
function familyContribution(
  signals: EvidenceSignal[],
  family: EvidenceFamily,
  policy: FamilyRankPolicy
): number {
  const selected = signals.filter(signal => signal.family === family);
  if (selected.length === 0) return 0;
  const weighted = selected.map(signal =>
    signal.weight
    * signal.confidence
    * policy.completenessFactor[signal.completeness]
  );
  const max = Math.max(...weighted);
  const independentKinds = new Set(selected.map(signal => signal.kind)).size;
  const diversity = policy.diversityBonus[family] * Math.log2(1 + independentKinds);
  return Math.min(policy.familyCaps[family], max + diversity);
}
```

Provider count alone does not increase independentKinds.

- [ ] **Step 5: 实现 final ranking**

```ts
score = base
      + sum(family contributions)
      + sourceSet delta
      + same-module prior
      + cross-module/test penalties
```

`focusModules` and `taskKeywords` contribute only through `TASK_CONTEXT` signals produced in Task 24. They must not be applied again as direct deltas.

Tie-break:

1. higher exact semantic contribution；
2. higher static+framework contribution；
3. higher confidence；
4. repo-relative path lexical order。

- [ ] **Step 6: confidence label**

```text
high   if exact semantic >=80 or complete static/framework >=100
medium if total non-lexical >=60
low    otherwise
```

Do not let three lexical matches produce high confidence.

- [ ] **Step 7: 迁移现有 policy**

- `routing-policy.ts` resolves generic or lishuedu pack；
- convert old category/rule deltas into provider signal weights or context deltas；
- remove dead `maven-reactor`/`ddd-gradle` policy IDs if no constructor uses them；
- keep business-specific regex only in explicit lishuedu policy pack；
- no public per-repo rules DSL。

- [ ] **Step 8: Counterfactual benchmark attribution**

Diagnostic attempt records:

```ts
familyScores
rankWithoutEachFamily
selectedByReadPlan
```

`rankWithoutEachFamily` may be benchmark-only to avoid runtime payload cost. It identifies whether a family actually changed top-N selection.

- [ ] **Step 9: Run/Commit**

```bash
npm run build
node --test dist/agent-router/family-ranker.test.js dist/routing-policy.test.js dist/ranking-signals.test.js
npm test
git add src/agent-router src/routing-policy.ts src/routing-policy.test.ts src/ranking-signals.test.ts
git commit -m "refactor(ranking): saturate duplicate evidence by family"
```

---

## Task 26：References 先 containment、按文件 collapse 和价值排序，再截断

**Files:**
- Create: `src/agent-router/reference-ranking.ts`
- Test: `src/agent-router/reference-ranking.test.ts`
- Modify: `src/agent-router/providers/semantic-provider.ts`

**Interfaces:**
- Consumes: normalized repo-contained JDT locations。
- Produces:
  - `rankReferenceFiles()`
  - top files based on Agent value rather than server order。

- [ ] **Step 1: 写 server-order 反例测试**

Input first 40 references are tests/low-value module; the 41st is same-module main service. Expected ranked top includes main service.

```ts
test("reference ranking selects valuable files before truncation", () => {
  const refs = [
    ...Array.from({ length: 40 }, (_, i) => ref(`module-x/src/test/java/T${i}.java`, 1)),
    ref("module-a/src/main/java/demo/OrderService.java", 80)
  ];
  const ranked = rankReferenceFiles(refs, {
    anchorModule: "module-a",
    focusModules: [],
    taskKeywords: ["order"],
    testReadMode: "defer",
    limitFiles: 20
  });
  assert.ok(ranked.some(item => item.path.endsWith("OrderService.java")));
});
```

- [ ] **Step 2: collapse by file**

```ts
export type CollapsedReferenceFile = {
  path: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  totalReferences: number;
  positions: Array<{ line: number; column: number }>;
  valueScore: number;
};
```

Every file retains up to 3 representative positions:

- first method-body position；
- first type-level position；
- first remaining position。

Use JavaIndex range lookup where available.

- [ ] **Step 3: value score**

```ts
value = 0
  + mainSource ? 35 : 0
  + sameModule ? 30 : 0
  + focusModule ? 25 : 0
  + taskKeyword ? 20 : 0
  + frameworkMainRole ? 20 : 0
  + Math.min(15, Math.log2(1 + totalReferences) * 4)
  - deferredTest ? 25 : 0
  - generated ? 10 : 0;
```

Reference count is capped; 1,000 references cannot dominate structural value.

- [ ] **Step 4: order and truncate**

```text
collapse all contained locations
→ enrich file context from JavaIndex/layout
→ compute value
→ sort
→ take limitFiles
→ emit one semantic signal per file
```

Default `limitFiles`:

```text
minimal 12
balanced 24
precision 40
recall 60
```

Before collapse, normalize at most `maxRawLocations=5000` repo-contained locations. If JDT returns more, process the first 5000 only, return `completion=PARTIAL_LIMIT`, and prohibit complete-cache/persisted-edge writes for that outcome. This cap is a resource guard, not the final value ranking. The readPlan still selects far fewer files.

- [ ] **Step 5: semantic provider metrics**

Diagnostic metrics:

```text
rawReferenceLocations
externalSuppressed
collapsedFiles
returnedFiles
truncatedFiles
referenceRankingMs
```

- [ ] **Step 6: Run/Commit**

```bash
npm run build
node --test dist/agent-router/reference-ranking.test.js dist/agent-router.test.js
npm test
git add src/agent-router/reference-ranking.ts src/agent-router/reference-ranking.test.ts src/agent-router/providers/semantic-provider.ts
git commit -m "feat(semantic): rank reference files before truncation"
```


## Task 27：Spring Framework Adapter Pack

**Files:**
- Create: `src/agent-router/framework/adapter.ts`
- Create: `src/agent-router/framework/spring.ts`
- Test: `src/agent-router/framework/spring.test.ts`
- Create: `fixtures/framework-spring/pom.xml`
- Create: `fixtures/framework-spring/src/main/java/demo/OrderController.java`
- Create: `fixtures/framework-spring/src/main/java/demo/OrderService.java`
- Create: `fixtures/framework-spring/src/main/java/demo/OrderRepository.java`
- Create: `fixtures/framework-spring/src/main/java/demo/Order.java`
- Create: `fixtures/framework-spring/src/main/java/demo/OrderRequest.java`
- Create: `fixtures/framework-spring/src/main/java/demo/OrderResponse.java`
- Create: `fixtures/framework-spring/src/main/java/demo/OrderCreated.java`
- Create: `fixtures/framework-spring/src/main/java/demo/OrderListener.java`
- Modify: `src/agent-router/index.ts`

**Interfaces:**
- Consumes: JavaIndex facts/edges and repo build/import facts。
- Produces: explicit Spring EvidenceSignal; no class-name-only call inference。

- [ ] **Step 1: 定义 adapter contract**

```ts
export type FrameworkDetection = {
  active: boolean;
  reasons: string[];
};

export interface JavaFrameworkAdapter {
  readonly id: string;
  readonly version: string;
  detect(input: FrameworkDetectInput): FrameworkDetection;
  collect(input: FrameworkCollectInput): Promise<ProviderOutcome>;
}
```

`FrameworkCollectInput` includes request, anchors, JavaIndex view and already normalized static evidence. It does not include mutable rank scores.

- [ ] **Step 2: 创建 Spring fixture**

Fixture must include:

```java
@RestController
@RequestMapping("/orders")
class OrderController {
  private final OrderService service;
  OrderController(OrderService service) { this.service = service; }

  @PostMapping
  OrderResponse create(@RequestBody OrderRequest request) {
    return service.create(request);
  }
}

@Service
class OrderService {
  private final OrderRepository repository;
  private final ApplicationEventPublisher publisher;

  @Transactional
  OrderResponse create(OrderRequest request) {
    Order order = repository.save(request.toOrder());
    publisher.publishEvent(new OrderCreated(order.id()));
    return OrderResponse.from(order);
  }
}

@Component
class OrderListener {
  @EventListener
  void on(OrderCreated event) {}
}
```

- [ ] **Step 3: 写 detection tests**

Activate when any is true:

- build dependency contains Spring；
- import prefix `org.springframework.`；
- resolved annotation FQN under `org.springframework.`。

Do not activate solely because a class ends with `Service`.

- [ ] **Step 4: 写 explicit edge tests**

Expected evidence:

```text
OrderController → OrderService        SPRING_INJECTION
OrderController.create → OrderService.create  SPRING_CALL_PATH (only because AST call resolves)
OrderService → OrderRepository        SPRING_INJECTION
OrderService.create → transaction metadata
OrderService.create → OrderCreated    SPRING_PUBLISHES_EVENT
OrderListener.on → OrderCreated       SPRING_CONSUMES_EVENT
OrderController.create → OrderRequest SPRING_REQUEST_BODY
OrderController.create → OrderResponse SPRING_RESPONSE_TYPE
```

Do not create Controller→Repository direct edge unless source actually injects/calls it.

- [ ] **Step 5: annotation normalizer**

Support short/FQN annotations through resolved annotation type or explicit imports. Initial recognized set:

```ts
const SPRING_ANNOTATIONS = new Set([
  "org.springframework.stereotype.Component",
  "org.springframework.stereotype.Service",
  "org.springframework.stereotype.Repository",
  "org.springframework.stereotype.Controller",
  "org.springframework.web.bind.annotation.RestController",
  "org.springframework.web.bind.annotation.RequestMapping",
  "org.springframework.web.bind.annotation.GetMapping",
  "org.springframework.web.bind.annotation.PostMapping",
  "org.springframework.web.bind.annotation.PutMapping",
  "org.springframework.web.bind.annotation.DeleteMapping",
  "org.springframework.web.bind.annotation.PatchMapping",
  "org.springframework.web.bind.annotation.RequestBody",
  "org.springframework.context.event.EventListener",
  "org.springframework.context.annotation.Bean",
  "org.springframework.transaction.annotation.Transactional",
  "org.springframework.beans.factory.annotation.Autowired"
]);
```

Meta-annotation discovery is excluded from initial task. Add only after a real golden requires custom composed annotations.

- [ ] **Step 6: injection rules**

Create `SPRING_INJECTION` only for:

- constructor parameter in a stereotype component；
- field annotated `@Autowired`；
- single constructor even without `@Autowired`；
- `@Bean` method parameters may create configuration dependency evidence。

Confidence:

```text
resolved constructor parameter   0.97
resolved @Autowired field        0.95
wildcard/global fallback type    resolution confidence × 0.95
ambiguous                        no exact framework signal
```

- [ ] **Step 7: endpoint metadata**

Parse mapping annotation argument text conservatively:

```ts
export type SpringEndpointFact = {
  methodId: string;
  httpMethods: string[];
  paths: string[];
};
```

Handle string literal and array literal values. Unknown expression remains `paths: []`, but endpoint role still exists.

- [ ] **Step 8: event and bean rules**

- `@EventListener` first resolved parameter type → consumes event；
- `publishEvent(new OrderCreatedEvent(orderId))` → publishes `OrderCreatedEvent`；
- `@Bean` method → produces return type；
- `@Transactional` is metadata signal on method/type, not a candidate file by itself。

- [ ] **Step 9: provider integration**

Spring adapter runs after static provider. It may reuse resolved call edge to emit `SPRING_CALL_PATH`; it must not parse source again.

Initial weights:

```text
SPRING_INJECTION       90
SPRING_CALL_PATH       100
SPRING_REQUEST_BODY    70
SPRING_RESPONSE_TYPE   70
SPRING_PUBLISHES_EVENT 85
SPRING_CONSUMES_EVENT  85
SPRING_BEAN_PRODUCES   75
```

Family `FRAMEWORK`, provenance `FRAMEWORK_INFERRED`, completeness follows index coverage.

- [ ] **Step 10: Run/Commit**

```bash
npm run build
node --test dist/agent-router/framework/spring.test.js
npm test
git add src/agent-router/framework fixtures/framework-spring src/agent-router/index.ts
git commit -m "feat(framework): add Spring impact evidence pack"
```

---

## Task 28：MyBatis Java ↔ XML Adapter Pack

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/java-index/mybatis-types.ts`
- Create: `src/java-index/mybatis-xml-extractor.ts`
- Test: `src/java-index/mybatis-xml-extractor.test.ts`
- Modify: `src/java-index/worker-protocol.ts`
- Modify: `src/java-index/java-index-worker.ts`
- Modify: `src/java-index/index-store.ts`
- Modify: `src/java-index/snapshot.ts`
- Modify: `src/java-index/manifest.ts`
- Modify: `src/java-index/coverage.ts`
- Modify: `src/java-index/worktree-snapshot-seeder.ts`
- Modify: `src/java-index/worktree-snapshot-seeder.test.ts`
- Create: `src/agent-router/framework/mybatis.ts`
- Test: `src/agent-router/framework/mybatis.test.ts`
- Create: `fixtures/framework-mybatis/pom.xml`
- Create: `fixtures/framework-mybatis/src/main/java/demo/OrderMapper.java`
- Create: `fixtures/framework-mybatis/src/main/java/demo/OrderEntity.java`
- Create: `fixtures/framework-mybatis/src/main/resources/mapper/OrderMapper.xml`

**Interfaces:**
- Produces:
  - indexed MyBatis XML facts in JavaIndex worker；
  - namespace+statement exact links；
  - Java type links for parameter/result/resultMap。

- [ ] **Step 1: 安装 pure JS XML parser**

```bash
npm install --save-exact fast-xml-parser@5.10.1
```

Parser runs in JavaIndex worker, not MCP main thread.

- [ ] **Step 2: 定义 MyBatis facts**

```ts
export type MyBatisStatementKind = "select" | "insert" | "update" | "delete";

export type MyBatisStatementFact = {
  statementId: string;
  namespace: string;
  id: string;
  kind: MyBatisStatementKind;
  parameterType?: string;
  resultType?: string;
  resultMap?: string;
  range?: SourceRange;
};

export type MyBatisResultMapFact = {
  resultMapId: string;
  namespace: string;
  id: string;
  type?: string;
};

export type MyBatisMapperResourceFacts = {
  resourceId: string;
  relativePath: string;
  namespace: string;
  statements: MyBatisStatementFact[];
  resultMaps: MyBatisResultMapFact[];
  includes: Array<{ fromStatementId: string; refid: string }>;
  contentHash: string;
  generation: number;
  parseState: "COMPLETE" | "FAILED";
};
```

`range` is populated when a unique source element can be located. The XML object parser does not provide offsets, so this task also implements a small source locator over the original UTF-8 text. Duplicate `(tag, id)` matches are marked ambiguous and leave `range` undefined; they are never assigned a guessed range.

- [ ] **Step 3: 创建 fixture XML**

```xml
<mapper namespace="demo.OrderMapper">
  <resultMap id="OrderMap" type="demo.OrderEntity">
    <id property="id" column="id"/>
  </resultMap>
  <select id="findById" parameterType="java.lang.Long" resultMap="OrderMap">
    select id from orders where id = #{id}
  </select>
  <insert id="insert" parameterType="demo.OrderEntity">
    insert into orders(id) values(#{id})
  </insert>
</mapper>
```

Java interface has methods `findById(Long)` and `insert(OrderEntity)`.

- [ ] **Step 4: 写 extractor test**

Assertions:

```ts
assert.equal(facts.namespace, "demo.OrderMapper");
assert.deepEqual(facts.statements.map(x => `${x.kind}:${x.id}`), [
  "select:findById",
  "insert:insert"
]);
assert.equal(facts.resultMaps[0].type, "demo.OrderEntity");
assert.equal(facts.parseState, "COMPLETE");
```

Malformed XML returns FAILED and never throws across worker protocol.

- [ ] **Step 5: 实现 XML parser options**

```ts
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: name => ["select", "insert", "update", "delete", "resultMap", "include"].includes(name)
});
```

Only accept root `mapper` with non-empty namespace. Unknown tags are ignored.

In the same extractor, add a source locator that works on the original XML text rather than the parsed object:

```ts
export function locateMapperElementRange(
  xml: string,
  tag: MyBatisStatementKind | "resultMap",
  id: string
): SourceRange | undefined;
```

Rules:

- scan XML tokens while respecting quoted attribute values and comments；
- match an exact opening tag name and exact `id` attribute；
- require exactly one match；
- for self-closing elements, range is the opening tag；
- otherwise end at the corresponding closing tag of the same element, accounting for nested tags；
- convert offsets to 1-based UTF-16 line/column via the shared range helper；
- malformed or duplicate matches return `undefined`, never a guessed range。

Extend the extractor test:

```ts
assert.deepEqual(facts.statements.find(x => x.id === "findById")?.range, {
  start: { line: 6, column: 3 },
  end: { line: 8, column: 12 }
});
assert.ok(facts.resultMaps[0]?.range);
```

- [ ] **Step 6: 扩展 manifest/worker/store/snapshot**

Resource discovery includes:

```text
src/main/resources/**/*.xml
```

but extractor only stores files whose root is `<mapper>`. Add:

```ts
myBatisResourcesByPath
myBatisStatementsByQualifiedId  // namespace + "." + id
myBatisResourcesByNamespace
```

The final snapshot becomes `JavaIndexSnapshotV3` and gains:

```ts
schemaVersion: 3;
myBatisResources: MyBatisMapperResourceFacts[];
resourceCoverage: Array<{
  root: string;
  generation: number;
  state: "UNKNOWN" | "BUILDING" | "COMPLETE" | "DEGRADED";
  discoveredFiles: number;
  indexedFiles: number;
  failedFiles: number;
}>;
```

`manifestFingerprint` in schema 3 is computed over a typed manifest entry stream covering both Java and supported mapper resources:

```ts
type SnapshotManifestEntry = {
  kind: "JAVA" | "MYBATIS_XML";
  relativePath: string;
  contentHash: string;
  sourceRoot: string;
};
```

There is no migration from the Task 21/22 schema-2 development snapshot: schema mismatch deletes it and rebuilds. Update extractor version, snapshot tests and status in the same commit.

Update `WorktreeSnapshotSeeder` in the same task. For schema 3 it must stable-read/hash target mapper XML before any resource fact is queryable. Reuse a MyBatis resource only when its typed manifest entry exact-matches. Reuse a resolved Java↔XML link only when **both** the Java owner file and XML resource exact-match; otherwise drop the link and enqueue the Java mapper/resource for framework relink. A changed XML file must not prevent unrelated exact-matching Java declarations from being seeded.

Add a linked-worktree test: Java mapper is unchanged, B changes `OrderMapper.xml`; B reuses Java facts but not the resource/statement links, remains DEGRADED, then rebuilds only the XML/framework link and reaches COMPLETE.

Extend diagnostic seed metrics with `reusedResources`, `dirtyResources` and `droppedFrameworkEdges`; standard output still exposes only the aggregate `worktreeSeed` freshness state.

- [ ] **Step 7: build exact links**

Adapter detection:

- build/import contains MyBatis；
- or indexed mapper resource exists；
- or Java type has `@Mapper` from MyBatis/Spring mapper package。

Links:

```text
resource namespace → Java type FQN exact
statement id → method same name exact
parameterType → resolved Java type
resultType/resultMap type → resolved Java type
```

If overloaded mapper methods share same XML id, mark AMBIGUOUS and do not choose one exact method.

- [ ] **Step 8: EvidenceSignal mapping**

```text
MYBATIS_NAMESPACE        confidence 0.98 weight 100
MYBATIS_STATEMENT_METHOD confidence 0.98 weight 110
MYBATIS_PARAMETER_TYPE   confidence 0.95 weight 75
MYBATIS_RESULT_TYPE      confidence 0.95 weight 80
MYBATIS_RESULT_MAP       confidence 0.95 weight 85
```

Family `FRAMEWORK`, source file is Java or XML as appropriate.

- [ ] **Step 9: Resource invalidation**

`RESOURCE_CHANGE` for mapper XML advances generation and refreshes only changed resource. Delete removes namespace/statement indexes. Java mapper signature change rebuilds adapter evidence on next request via generation.

- [ ] **Step 10: Run/Commit**

```bash
npm run build
node --test dist/java-index/mybatis-xml-extractor.test.js dist/java-index/worktree-snapshot-seeder.test.js dist/agent-router/framework/mybatis.test.js
npm test
git add package.json package-lock.json src/java-index src/agent-router/framework fixtures/framework-mybatis
git commit -m "feat(framework): connect MyBatis mapper interfaces and XML statements"
```

---

## Task 29：JPA、MapStruct 与 Lombok completeness adapters

**Files:**
- Create: `src/agent-router/framework/jpa.ts`
- Test: `src/agent-router/framework/jpa.test.ts`
- Create: `src/agent-router/framework/mapstruct.ts`
- Test: `src/agent-router/framework/mapstruct.test.ts`
- Create: `src/agent-router/framework/lombok.ts`
- Test: `src/agent-router/framework/lombok.test.ts`
- Create: `fixtures/framework-jpa/pom.xml`
- Create: `fixtures/framework-jpa/src/main/java/demo/OrderEntity.java`
- Create: `fixtures/framework-jpa/src/main/java/demo/CustomerEntity.java`
- Create: `fixtures/framework-jpa/src/main/java/demo/OrderRepository.java`
- Create: `fixtures/framework-mapstruct/pom.xml`
- Create: `fixtures/framework-mapstruct/src/main/java/demo/OrderMapper.java`
- Create: `fixtures/framework-mapstruct/src/main/java/demo/AddressMapper.java`
- Create: `fixtures/framework-mapstruct/src/main/java/demo/OrderEntity.java`
- Create: `fixtures/framework-mapstruct/src/main/java/demo/OrderResponse.java`
- Create: `fixtures/framework-lombok/pom.xml`
- Create: `fixtures/framework-lombok/src/main/java/demo/LombokOrder.java`
- Modify: `src/generated-code.ts`
- Modify: `src/agent-router/index.ts`

**Interfaces:**
- Produces: JPA entity/repository/relation evidence, MapStruct mapping evidence, Lombok semantic completeness gap。

- [ ] **Step 1: JPA fixture and tests**

Fixture:

```java
@Entity
class OrderEntity {
  @ManyToOne CustomerEntity customer;
}

interface OrderRepository extends JpaRepository<OrderEntity, Long> {
  List<OrderEntity> findByCustomerId(Long customerId);
}
```

Expected evidence:

```text
OrderRepository → OrderEntity JPA_REPOSITORY_ENTITY
OrderRepository → Long JPA_REPOSITORY_ID_TYPE (external type not returned as repo file)
OrderEntity → CustomerEntity JPA_ENTITY_RELATION
findByCustomerId → OrderEntity JPA_DERIVED_QUERY_OWNER
```

- [ ] **Step 2: JPA exact rules**

Recognized annotations FQN:

```text
jakarta.persistence.*
javax.persistence.*
```

Repository bases:

```text
org.springframework.data.jpa.repository.JpaRepository
org.springframework.data.repository.CrudRepository
org.springframework.data.repository.PagingAndSortingRepository
```

Generic entity type must be resolved. Ambiguous generic produces no exact repository edge.

Derived query parsing is conservative: split known prefixes (`find`, `get`, `read`, `exists`, `count`, `delete`) and `By`; tokens are metadata only. Do not attempt full Spring Data grammar in this task.

- [ ] **Step 3: MapStruct fixture and rules**

```java
@Mapper(uses = AddressMapper.class)
interface OrderMapper {
  OrderResponse toResponse(OrderEntity source);
}
```

Evidence:

```text
OrderMapper → OrderEntity MAPSTRUCT_SOURCE
OrderMapper → OrderResponse MAPSTRUCT_TARGET
OrderMapper → AddressMapper MAPSTRUCT_USES
```

All from method param/return or annotation class literals; no name inference.

- [ ] **Step 4: Lombok completeness**

Adapter does not generate synthetic methods. It emits no candidate edge solely from Lombok annotation. It updates result-level gap when:

```text
Lombok detected
and JDT javaagent missing/disabled
and task requires generated member binding
```

Expose:

```ts
generatedSemantics: "OK" | "INCOMPLETE" | "NOT_DETECTED";
```

Add tests for detected/missing agent status.

- [ ] **Step 5: Weights**

```text
JPA_REPOSITORY_ENTITY 100 @0.98
JPA_ENTITY_RELATION   85  @0.95
JPA_DERIVED_QUERY     55  @0.70
MAPSTRUCT_SOURCE      75  @0.95
MAPSTRUCT_TARGET      80  @0.95
MAPSTRUCT_USES        70  @0.95
```

- [ ] **Step 6: Run/Commit**

```bash
npm run build
node --test dist/agent-router/framework/jpa.test.js dist/agent-router/framework/mapstruct.test.js dist/agent-router/framework/lombok.test.js
npm test
git add src/agent-router/framework src/generated-code.ts fixtures/framework-jpa fixtures/framework-mapstruct fixtures/framework-lombok
git commit -m "feat(framework): add JPA, MapStruct, and Lombok evidence packs"
```


## Task 30：Token-aware、多 range ReadPlan Planner

**Files:**
- Create or replace: `src/agent-router/read-plan.ts`
- Test: `src/agent-router/read-plan.test.ts`
- Modify: current `read-plan-budget.ts` if present
- Modify: `src/agent-types.ts`
- Modify: `src/benchmark-agent-impact.ts`

**Interfaces:**
- Consumes: ranked `CandidateEvidence`、JavaIndex AST ranges、mode/test policy。
- Produces:
  - `ReadPlanItemV6[]`
  - max files + max bytes hard budget；
  - multiple non-contiguous ranges per file；
  - marginal utility diagnostics。

- [ ] **Step 1: 定义 plan types**

```ts
export type ReadPriority = "P0" | "P1" | "P2";

export type ReadRange = {
  startLine: number;
  endLine: number;
  reason: string;
  estimatedBytes: number;
};

export type ReadPlanItemV6 = {
  priority: ReadPriority;
  fileId: string;
  ranges: ReadRange[];
  reason: string;
  expectedEvidence: string[];
  estimatedBytes: number;
};

export type ReadPlanBudget = {
  maxFiles: number;
  maxReadBytes: number;
};
```

Default:

```ts
export const READ_PLAN_BUDGETS = {
  minimal: { maxFiles: 4, maxReadBytes: 6 * 1024 },
  balanced: { maxFiles: 6, maxReadBytes: 14 * 1024 },
  precision: { maxFiles: 8, maxReadBytes: 20 * 1024 },
  recall: { maxFiles: 12, maxReadBytes: 32 * 1024 }
} as const;
```

- [ ] **Step 2: 写 byte hard-budget 失败测试**

```ts
test("balanced read plan respects byte budget instead of filling all slots", async () => {
  const result = await planReadContext({
    candidates: expensiveCandidates(),
    budget: { maxFiles: 6, maxReadBytes: 14 * 1024 },
    anchorFile: "Anchor.java",
    ...context
  });
  assert.ok(result.totalBytes <= 14 * 1024 || result.budgetExceededByAnchor);
  assert.ok(result.items.length <= 6);
});
```

- [ ] **Step 3: 写 marginal utility/diversity test**

Three near-duplicate lexical files and one framework collaborator. The planner must select the framework collaborator before the third duplicate, even if duplicate raw score is slightly higher.

```ts
assert.ok(paths.includes("OrderRepository.java"));
assert.equal(paths.filter(path => path.includes("OrderNameVariant")).length <= 2, true);
```

- [ ] **Step 4: AST ranges provider**

For each candidate request ranges in this order:

1. evidence source method ranges；
2. candidate target method range；
3. owner type header + fields/method signatures；
4. MyBatis XML statement/resultMap locator range；
5. fixed line radius fallback。

Add a batched API on JavaIndex:

```ts
queryReadRanges(
  requests: Array<{
    file: string;
    positions: Array<{ line: number; column: number }>;
  }>
): Promise<Array<{ file: string; ranges: IndexedReadRange[] }>>;
```

`IndexedReadRange` includes method/type kind, exact AST line range and exact UTF-8 byte count. First shortlist at most `maxFiles * 4` candidates using rank/evidence diversity, then make one worker round-trip for range/byte data. Do not read every returned candidate file merely to estimate a six-file plan.

- [ ] **Step 5: range merge**

```ts
function mergeRanges(ranges: ReadRange[], maxGapLines = 3): ReadRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: ReadRange[] = [];
  for (const current of sorted) {
    const previous = merged.at(-1);
    if (previous && current.startLine <= previous.endLine + maxGapLines + 1) {
      previous.endLine = Math.max(previous.endLine, current.endLine);
      previous.reason = uniqueText([previous.reason, current.reason]).join("; ");
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}
```

Recompute exact byte size after merge in the JavaIndex worker using the file bytes already loaded for the batched shortlist. Do not estimate solely from line count when making the hard budget decision, and do not perform synchronous file reads on the MCP thread.

- [ ] **Step 6: protected core selection**

Always select anchor. Protected core candidates are limited to evidence signals matching:

```text
JDT definition/implementation
AST IMPLEMENTS/EXTENDS direct
AST PARAM/RETURN direct collaborator
resolved CALLS on anchor method path
SPRING_INJECTION/SPRING_CALL_PATH
MYBATIS_STATEMENT_METHOD
JPA_REPOSITORY_ENTITY
```

Protected core is ordered by family score/byte ratio. It is not allowed to exceed maxFiles except anchor. If protected candidates exceed budget, planner selects the highest utility set and emits:

```text
evidenceGaps += "Protected core exceeded read budget; lower-value core files were omitted."
```

Benchmark proves must-hit protection remains adequate; runtime does not know golden.

- [ ] **Step 7: marginal utility**

```ts
function marginalUtility(
  candidate: CandidateEvidence,
  selected: CandidateEvidence[],
  bytes: number,
  context: PlanContext
): number {
  const uncoveredFamilies = uncoveredFamilyValue(candidate, selected);
  const moduleDiversity = selected.some(item => item.module === candidate.module) ? 0 : 8;
  const layerDiversity = selected.some(item => item.layer === candidate.layer) ? 0 : 6;
  const overlap = maxEvidenceOverlap(candidate, selected) * 35;
  const supportValue = supportModeValue(candidate, context);
  const bytePenalty = Math.log2(1 + Math.max(1, bytes)) * 3;
  return candidate.finalScore
    + uncoveredFamilies
    + moduleDiversity
    + layerDiversity
    + supportValue
    - overlap
    - bytePenalty;
}
```

Select by `marginalUtility / Math.max(256, bytes)`.

Evidence overlap uses signal family+kind+source target, not filename similarity alone.

- [ ] **Step 8: quota integration**

Retain the current evidence budget concept if present, but express as min/max bucket rules:

```ts
const bucketRules = {
  anchor: { min: 1, max: 1 },
  core: { min: 2, max: 4 },
  framework: { min: 0, max: 2 },
  support: { min: 0, max: 1 },
  lexical: { min: 0, max: 1 }
};
```

Missing bucket releases capacity. No bucket forces a low-value candidate.

- [ ] **Step 9: Anchor over-budget behavior**

If anchor selected range alone exceeds budget:

- include anchor range；
- set `budgetExceededByAnchor=true`；
- select no additional file unless remaining bytes positive；
- do not truncate method body in a way that breaks syntax unless method itself is extremely large；
- for an extremely large method, take method signature + first/last bounded body windows and emit gap。

Define extreme as >300 lines initially.

- [ ] **Step 10: Benchmark metrics**

Add:

```text
readPlanBytes
readPlanFiles
readPlanRanges
budgetUtilization
budgetExceededByAnchor
marginalUtilityBySelectedFile (diagnostic only)
```

Existing `readPlanMaxItems` benchmark experiment remains available through equivalent `maxFiles`; add `--read-plan-max-bytes` benchmark-only flag.

- [ ] **Step 11: Run/Commit**

```bash
npm run build
node --test dist/agent-router/read-plan.test.js dist/benchmark-agent-impact.test.js
npm test
git add src/agent-router/read-plan.ts src/agent-router/read-plan.test.ts src/agent-types.ts src/benchmark-agent-impact.ts src/benchmark-agent-impact.test.ts
git commit -m "feat(readplan): optimize Java context under byte and evidence budgets"
```

---

## Task 31：ImpactResultV6 强类型、默认压缩与工具 schema 成本测量

**Files:**
- Create: `src/agent-router/output-v6.ts`
- Test: `src/agent-router/output-v6.test.ts`
- Modify: `src/agent-types.ts`
- Modify: `src/tools/impact.ts`
- Modify: `src/tools/output-shape.test.ts`
- Modify: `src/server.ts`
- Create: `scripts/measure-tool-schema.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `ImpactResultV6`
  - no `Record<string, unknown>` in core impact contract；
  - compact/standard/diagnostic output policy；
  - measured decision on 7 vs 5 tools。

- [ ] **Step 1: 定义 ImpactResultV6**

Use architecture V3 §15 authoritative shape. Add exact types:

```ts
export type ImpactFileV6 = {
  id: string;
  path: string;
  role: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  locations: Array<{ line: number; column: number }>;
};

export type ImpactFreshnessV6 = {
  requestGeneration: number;
  indexedGeneration: number;
  coverage: "COMPLETE" | "PARTIAL" | "DEGRADED";
  changedDuringRequest: boolean;
};

export type ImpactResultV6 = {
  version: 6;
  target: ImpactTargetV6;
  freshness: ImpactFreshnessV6;
  semantic: ImpactSemanticV6;
  files: ImpactFileV6[];
  readPlan: ReadPlanItemV6[];
  evidenceGaps: string[];
  cost: ImpactCostV6;
  metrics?: ImpactDiagnosticMetrics;
};
```

Remove generic `Record<string, unknown>` from these core types. Diagnostic extensibility uses explicit nested types, not arbitrary records.

- [ ] **Step 2: 写 standard output shape test**

Assert absent:

```text
score
scoreBreakdown
phaseMs
cache before/after
rawUri
absolutePath
repoRoot
.m2 path
JDK path
rg section candidate lists
```

Assert present:

```text
version target freshness semantic files readPlan evidenceGaps cost
```

- [ ] **Step 3: Evidence summary compression**

Map detailed signals to concise stable phrases, maximum 4 per file:

```text
"implements PaymentGateway"
"called by OrderService#create"
"Spring constructor injection"
"MyBatis statement OrderMapper.findById"
"JDT reference verified"
"name/task match"
```

Avoid provider internals in standard mode.

- [ ] **Step 4: Cost calculation**

After final formatting iterate until stable JSON byte count as current code does, but fields are:

```ts
cost: {
  resultBytes,
  readBytes,
  estimatedTokens: Math.ceil((resultBytes + readBytes) / 4),
  suppressedRawBytes
}
```

Because `resultBytes` includes itself, compute up to 3 iterations and assert convergence in test. `estimatedTokens` is the documented UTF-8-bytes/4 proxy, not an exact model tokenizer result. Every gate also compares `resultBytes` and `readBytes`; when a target client exposes real prompt usage, store it separately as benchmark-only `observedPromptTokens`.

- [ ] **Step 5: Diagnostic output**

Only diagnostic adds:

- phaseMs；
- provider completion/cost；
- familyScores；
- selected marginal utility；
- cache hit/miss；
- JavaIndex coverage details；
- JDT lifecycle/readiness；
- suppressed external locations。

Compact mode limits files/evidence gaps further but never removes readPlan or freshness.

- [ ] **Step 6: Tool schema measurement script**

`scripts/measure-tool-schema.mjs` imports/constructs tool metadata or calls the built MCP `tools/list`, then records:

```json
{
  "tools": 7,
  "jsonBytes": 0,
  "estimatedTokens": 0,
  "perTool": []
}
```

Add:

```json
"measure:tool-schema": "node scripts/measure-tool-schema.mjs"
```

Run current 7-tool schema.

- [ ] **Step 7: 7→5 decision**

Prototype a JSON-only alternative metadata representation without changing production tools:

```text
java_references folded into java_symbol(operation="references")
java_restart/java_shutdown folded into java_runtime(action="restart"|"shutdown")
```

Measure estimated schema token savings. Execute production merge only when:

```text
savedTokens >= 200
or existing agent traces show repeated tool mis-selection
```

If gate fails, document “keep 7” and delete prototype. No compatibility requirement means merge is allowed, but data decides whether it is useful.

- [ ] **Step 8: Run output benchmark**

Compare standard JSON bytes and total Agent-visible bytes before/after on three repos. Gate:

```text
standard resultBytes <= previous phase
estimatedTokens <= previous phase +5%
R_read_must=1.0000
```

- [ ] **Step 9: Run/Commit**

```bash
npm run build
node --test dist/agent-router/output-v6.test.js dist/tools/output-shape.test.js
npm run measure:tool-schema
npm test
git add src/agent-router/output-v6.ts src/agent-router/output-v6.test.ts src/agent-types.ts src/tools src/server.ts scripts/measure-tool-schema.mjs package.json
git commit -m "refactor(output): publish a compact strongly typed impact contract"
```

---

## Task 32：Attribution V3、质量场景扩充与 Iteration D 报告

**Files:**
- Create: `src/benchmark/attribution-v3.ts`
- Test: `src/benchmark/attribution-v3.test.ts`
- Create: `src/benchmark/matrix-runner.ts`
- Test: `src/benchmark/matrix-runner.test.ts`
- Create: `src/benchmark/phase-report.ts`
- Test: `src/benchmark/phase-report.test.ts`
- Modify: `src/benchmark-agent-impact.ts`
- Modify: `golden/*.scenarios.jsonl`
- Create: `golden/java-index-v2.scenarios.jsonl`
- Create: `docs/phase-v3/phase4-evidence-framework-token-report.md`
- Create: `artifacts/v3-phase4/`

**Interfaces:**
- Produces:
  - first-class taskBlocking set；
  - evidence-family attribution；
  - provider counterfactual；
  - token efficiency report。

- [ ] **Step 1: Golden schema V3**

Upgrade loader to accept:

```ts
golden: {
  mustHit: string[];
  taskBlocking: string[];
  shouldHit: string[];
  support: string[];
  mustReadRanges?: Record<string, Array<{ startLine: number; endLine: number }>>;
}
```

During schema reset, convert existing `shouldBlocksTask=true` entries into `taskBlocking`. Do not maintain dual schema indefinitely. One-time loader script may rewrite JSONL; commit final V3 only.

- [ ] **Step 2: Attribution row**

```ts
export type GoldenAttributionV3 = {
  scenarioId: string;
  file: string;
  kind: "must" | "taskBlocking" | "should" | "support";
  inCandidates: boolean;
  inReadPlan: boolean;
  firstRank?: number;
  sourceFamilies: EvidenceFamily[];
  providers: string[];
  blockedBy: "hit" | "readplan-budget" | "candidate-limit" | "absent";
  absentReason?:
    | "not-indexed"
    | "coverage-partial"
    | "ambiguous-type"
    | "no-static-edge"
    | "framework-not-detected"
    | "lexical-miss"
    | "semantic-not-used"
    | "semantic-timeout"
    | "golden-stale-or-low-value";
};
```

Reasons must derive from actual provider/index diagnostics, not reread files with regex guesses as V2 attribution did.

- [ ] **Step 3: Counterfactual family attribution**

Benchmark-only reruns ranking/readPlan in memory with each family removed, without repeating I/O/provider calls:

```ts
counterfactual: {
  withoutExactSemantic: CounterfactualResult;
  withoutStaticStructure: CounterfactualResult;
  withoutFramework: CounterfactualResult;
  withoutLexical: CounterfactualResult;
  withoutTaskContext: CounterfactualResult;
  withoutSupport: CounterfactualResult;
}
```

Record whether family changed candidate hit or readPlan hit. This prevents celebrating providers that add candidates but never improve task output.

- [ ] **Step 4: Expand synthetic scenarios**

`golden/java-index-v2.scenarios.jsonl` includes at least:

1. package-private method；
2. nested record；
3. two `User` simple-name collision；
4. direct interface implementer；
5. signature type collaborator；
6. local receiver call；
7. Spring controller chain；
8. Spring event chain；
9. MyBatis mapper/XML；
10. JPA repository/entity；
11. MapStruct source/target；
12. malformed Java partial coverage。

These are correctness scenarios, not substitutes for real repos.

- [ ] **Step 5: Expand real scenarios toward 24～36 total**

Add only scenarios with a concrete developer task and verified files. Each new scenario records repo commit and rationale. Prioritize current phase 12 gaps:

- exam service/controller/type-edge gaps；
- cipherlink readPlan-full port/dto/repository；
- lishuedu framework/zero-added precision case。

Do not invent parser scenarios solely to balance profile counts.

- [ ] **Step 6: Matrix runner 与确定性 phase report renderer**

`src/benchmark/matrix-runner.ts` accepts env roots and runs:

```text
cold-nolsp runs=5 diagnostic
warm-auto runs=5 diagnostic
warm-required only when requested
```

It outputs all raw JSON under a commit-stamped directory and builds a typed summary:

```ts
export type MatrixRunSummary = {
  generatedAt: string;
  runtimeCommit: string;
  projects: ProjectMatrixSummary[];
  hardGateFailures: string[];
  artifactFiles: string[];
};

export async function runMatrix(options: MatrixRunOptions): Promise<MatrixRunSummary>;
```

`src/benchmark/phase-report.ts` is pure rendering only:

```ts
export function renderPhaseReport(
  title: string,
  decision: "KEEP" | "REJECT" | "MODIFY" | "FAIL",
  summary: MatrixRunSummary,
  providerRows: ProviderValueRow[],
  knownLimits: string[]
): string;
```

Tests provide a fixed summary and assert deterministic heading order, every raw artifact path appears, all hard-gate failures appear verbatim, and JSON key order does not change the Markdown output. `matrix-runner.test.ts` injects a fake command runner; no real business repo or JDT is required.

The CLI preserves a nonzero exit if any hard gate fails. It writes the Markdown from `renderPhaseReport()` and a machine-readable summary JSON; it never hides a failing command behind a successful renderer.

- [ ] **Step 7: Metrics**

Add:

```text
R_task_blocking
NDCG_read@6
firstTaskBlockingRank
readPlanRangeRecall
readPlanBytes
estimatedTokens
evidencePerKiB
taskBlockingHitsPerKiB
providerAddedCandidates
providerSelectedFiles
providerCounterfactualGain
```

- [ ] **Step 8: Iteration D gate**

```text
build/test 0 fail
R_read_must=1.0000 each repo
R_task_blocking each repo >= Phase 3
P_read each repo >= Phase 3 - 0.02
recall each repo >= Phase 3
standard estimatedTokens <= Phase 3 +5%
outside path 0
framework provider must produce at least one real-repo counterfactual gain before being considered successful
```

A framework adapter that only improves synthetic fixtures is retained only if it replaces brittle lexical logic or fixes a known correctness gap; otherwise remove it.

- [ ] **Step 9: Report**

`phase4-evidence-framework-token-report.md` must include per-provider:

```markdown
| provider | added | selected | golden hits | counterfactual gain | P50/P95 cost | decision |
```

Explicitly list rejected rules and why.

- [ ] **Step 10: Commit**

```bash
git add src/benchmark src/benchmark-agent-impact.ts src/benchmark-agent-impact.test.ts golden docs/phase-v3/phase4-evidence-framework-token-report.md artifacts/v3-phase4
git commit -m "test(v3): validate evidence, framework, and token gains"
```

Iteration D completion gate:

```text
evidence normalized
additive duplication removed
references value-ranked
framework packs have measured value
token-aware multi-range readPlan active
ImpactResultV6 compact and strongly typed
quality/token gates pass
```

---

# Iteration E：warm-required 首触治理（数据驱动，可决定不默认化）


## Task 33：SemanticGateway same-key singleflight、complete-only cache 与 lifecycle backoff 复用

**Files:**
- Create: `src/semantic-gateway.ts`
- Test: `src/semantic-gateway.test.ts`
- Create: `src/test-support/deferred.ts`
- Create or replace: `src/semantic-edge-store.ts`
- Test: `src/semantic-edge-store.test.ts`
- Modify: `src/agent-router/providers/semantic-provider.ts`
- Modify: `src/jdtls-session.ts`
- Modify: `src/tools/symbol.ts`
- Modify: `src/tools/references.ts`

**Interfaces:**
- Consumes: `RequestContext`、`Completion`、`JavaIntelligenceError`、`JdtlsSession`。
- Produces:
  - `SemanticOperation`
  - `SemanticOutcome<T>`
  - `SemanticGateway.execute<T>()`
  - same-key in-flight singleflight；
  - completed-at TTL cache；
  - only `COMPLETE` cacheability；
  - `SemanticEdgeStoreV2` for repo-contained COMPLETE JDT edges；
  - typed reuse of Task 3 lifecycle backoff/busy outcomes, with no second failure counter。

- [ ] **Step 1: 写 singleflight 失败测试**

Create `src/semantic-gateway.test.ts` with a controllable executor:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import {
  SemanticGateway,
  type SemanticBackendResult,
  type SemanticCacheKey,
  type SemanticValueMap
} from "./semantic-gateway.js";
import { deferred } from "./test-support/deferred.js";

test("identical concurrent semantic requests share one backend call", async () => {
  const pending = deferred<SemanticBackendResult<SemanticValueMap["references"]>>();
  let backendCalls = 0;
  const gateway = new SemanticGateway({
    async execute() {
      backendCalls += 1;
      return pending.promise;
    }
  }, {
    now: () => 100,
    ttlMs: 5000,
    absoluteCapMs: 1500
  });

  const input: SemanticCacheKey<"references"> = {
    repoHash: "repo",
    generation: 7,
    operation: "references",
    file: "/repo/A.java",
    fileFingerprint: "12:1000",
    line: 9,
    column: 4,
    optionsKey: "includeDeclaration=false"
  };

  const first = gateway.execute(input, DeadlineBudget.fromTimeout(1000), 1500);
  const second = gateway.execute(input, DeadlineBudget.fromTimeout(1000), 1500);

  assert.equal(backendCalls, 1);
  pending.resolve({ completion: "COMPLETE", value: [reference("A"), reference("B")] });
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left.value.map(item => item.uri), ["file:///repo/A.java", "file:///repo/B.java"]);
  assert.deepEqual(right.value.map(item => item.uri), ["file:///repo/A.java", "file:///repo/B.java"]);
  assert.equal(left.completion, "COMPLETE");
  assert.equal(right.shared, true);
  assert.equal(backendCalls, 1);
});
```

Create `src/test-support/deferred.ts`:

```ts
export type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
```

Run:

```bash
npm run build && node --test --test-name-pattern="share one backend call" dist/semantic-gateway.test.js
```

Expected: FAIL because no shared in-flight map exists.

- [ ] **Step 2: 写 completion 和 TTL 起点测试**

Add these complete tests below the singleflight test:

```ts
function reference(name: string): SemanticValueMap["references"][number] {
  return {
    uri: `file:///repo/${name}.java`,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

const baseKey: SemanticCacheKey<"references"> = {
  repoHash: "repo",
  generation: 1,
  operation: "references",
  file: "/repo/A.java",
  fileFingerprint: "10:1",
  line: 3,
  column: 7,
  optionsKey: "includeDeclaration=false"
};

test("partial and failed outcomes are never cached", async () => {
  let calls = 0;
  const responses: Array<SemanticBackendResult<SemanticValueMap["references"]>> = [
    { completion: "PARTIAL_TIMEOUT", value: [reference("partial")], errorCode: "DEADLINE_EXCEEDED" },
    { completion: "FAILED", value: [], errorCode: "JDT_SERVER_ERROR" },
    { completion: "COMPLETE", value: [reference("complete")] }
  ];
  const gateway = new SemanticGateway({
    async execute() {
      const response = responses[calls];
      calls += 1;
      if (!response) throw new Error("unexpected backend call");
      return response;
    }
  }, { ttlMs: 1000, absoluteCapMs: 1000 });

  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).completion, "PARTIAL_TIMEOUT");
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).completion, "FAILED");
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).completion, "COMPLETE");
  const cached = await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000);
  assert.equal(cached.cacheHit, true);
  assert.deepEqual(cached.value.map(item => item.uri), ["file:///repo/complete.java"]);
  assert.equal(calls, 3);
});

test("completed cache TTL starts after backend completion", async () => {
  let now = 0;
  let calls = 0;
  const gateway = new SemanticGateway({
    async execute() {
      calls += 1;
      now = 1000;
      return { completion: "COMPLETE", value: [reference(`call-${calls}`)] };
    }
  }, { now: () => now, ttlMs: 100, absoluteCapMs: 1000 });

  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).value[0]?.uri, "file:///repo/call-1.java");
  now = 1099;
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).cacheHit, true);
  now = 1101;
  assert.equal((await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000)).value[0]?.uri, "file:///repo/call-2.java");
  assert.equal(calls, 2);
});

test("generation and fingerprint are part of the cache key", async () => {
  let calls = 0;
  const gateway = new SemanticGateway({
    async execute() {
      calls += 1;
      return { completion: "COMPLETE", value: [reference(`call-${calls}`)] };
    }
  }, { ttlMs: 1000, absoluteCapMs: 1000 });

  await gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000);
  await gateway.execute({ ...baseKey, generation: 2 }, DeadlineBudget.fromTimeout(1000), 1000);
  await gateway.execute({ ...baseKey, fileFingerprint: "11:2" }, DeadlineBudget.fromTimeout(1000), 1000);
  assert.equal(calls, 3);
});

test("one caller deadline does not cancel another caller sharing backend work", async () => {
  const pending = deferred<SemanticBackendResult<SemanticValueMap["references"]>>();
  let backendSignal: AbortSignal | undefined;
  const gateway = new SemanticGateway({
    async execute(_key, _timeoutMs, signal) {
      backendSignal = signal;
      return pending.promise;
    }
  }, { ttlMs: 1000, absoluteCapMs: 1000 });

  const short = gateway.execute(baseKey, DeadlineBudget.fromTimeout(10), 1000);
  const long = gateway.execute(baseKey, DeadlineBudget.fromTimeout(1000), 1000);
  await assert.rejects(
    () => short,
    (error: unknown) => error instanceof JavaIntelligenceError
      && error.code === "DEADLINE_EXCEEDED"
  );
  assert.equal(backendSignal?.aborted, false);
  pending.resolve({ completion: "COMPLETE", value: [reference("survived")] });
  assert.deepEqual((await long).value.map(item => item.uri), ["file:///repo/survived.java"]);
  assert.equal(backendSignal?.aborted, false);
});
```

Caller A uses a 10ms budget and caller B a 1000ms budget. The shared backend operation continues for B after A stops waiting. Transport cancellation occurs only when **all** waiters have abandoned it or the backend’s own hard cap expires.

- [ ] **Step 3: 定义 semantic contracts**

Create `src/semantic-gateway.ts`:

```ts
import type { Completion } from "./runtime/completion.js";
import type { DeadlineBudget } from "./runtime/deadline-budget.js";
import type { JavaIntelligenceErrorCode } from "./runtime/intelligence-error.js";
import type {
  HierarchyEdge,
  LspDocumentSymbol,
  LspLocation,
  LspLocationLink
} from "./jdtls-session.js";

export type SemanticOperation =
  | "hover"
  | "definition"
  | "implementation"
  | "references"
  | "documentSymbol"
  | "typeHierarchy"
  | "callHierarchy";

export type SemanticCacheKey<Operation extends SemanticOperation = SemanticOperation> = {
  repoHash: string;
  generation: number;
  operation: Operation;
  file: string;
  fileFingerprint: string;
  line?: number;
  column?: number;
  optionsKey: string;
};

export type SemanticOutcome<T> = {
  completion: Completion;
  value: T;
  elapsedMs: number;
  cacheHit: boolean;
  shared: boolean;
  errorCode?: JavaIntelligenceErrorCode;
};

export type SemanticBackendResult<T> = {
  completion: Completion;
  value: T;
  errorCode?: JavaIntelligenceErrorCode;
};

export type SemanticLocation = LspLocation | LspLocationLink;
export type SemanticHover = { contents: unknown; range?: LspLocation["range"] } | null;
export type SemanticHierarchy = {
  roots: readonly unknown[];
  edges: readonly HierarchyEdge[];
  truncated: boolean;
};

export type SemanticValueMap = {
  hover: SemanticHover;
  definition: readonly SemanticLocation[];
  implementation: readonly SemanticLocation[];
  references: readonly LspLocation[];
  documentSymbol: readonly LspDocumentSymbol[];
  typeHierarchy: SemanticHierarchy;
  callHierarchy: SemanticHierarchy;
};

export type SemanticBackendValue = SemanticValueMap[SemanticOperation];

export type SemanticBackend = {
  execute(
    key: SemanticCacheKey,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<SemanticBackendResult<SemanticBackendValue>>;
};

export type SemanticGatewayOptions = {
  ttlMs?: number;
  absoluteCapMs?: number;
  now?: () => number;
};

export type SemanticGatewayStatus = {
  inflight: number;
  completedEntries: number;
  cacheHits: number;
  cacheMisses: number;
  sharedJoins: number;
  abortedNoWaiters: number;
  completeWrites: number;
  rejectedWrites: number;
  lifecycleBackoffSkips: number;
  busyOtherSessionSkips: number;
};

export interface SemanticGatewayApi {
  execute<Operation extends SemanticOperation>(
    key: SemanticCacheKey<Operation>,
    callerBudget: DeadlineBudget,
    operationCapMs: number
  ): Promise<SemanticOutcome<SemanticValueMap[Operation]>>;
  status(): SemanticGatewayStatus;
}
```

`SemanticGateway` implements this exact public interface in Step 4. `JdtlsSemanticBackend` uses an exhaustive `switch (key.operation)` and validates/normalizes the operation-specific value before it enters the gateway cache; the single backend union is never blindly cast from arbitrary plugin data. Do not accept arbitrary `unknown[]` key parts; every cache dimension is named and reviewable.

- [ ] **Step 4: 实现 in-flight entry 和 waiter accounting**

Use:

```ts
type BackendSettled<T> = {
  completion: Completion;
  value: T;
  elapsedMs: number;
  errorCode?: JavaIntelligenceErrorCode;
};

type InflightEntry = {
  controller: AbortController;
  promise: Promise<BackendSettled<SemanticBackendValue>>;
  waiters: number;
};

type CompletedEntry = {
  settled: BackendSettled<SemanticBackendValue>;
  expiresAtMs: number;
};
```

`execute()` flow:

1. serialize stable key；
2. return valid complete cache hit；
3. join existing in-flight and increment waiters；
4. otherwise create backend request with an internal hard cap；
5. each caller races its own `DeadlineBudget` against the shared **backend-settled** promise；
6. wrap the settled value into a per-caller `SemanticOutcome`, so `shared` and `cacheHit` are accurate for that caller rather than stored on the shared promise；
7. decrement waiter in `finally`；
8. abort backend only when waiter count reaches zero；
9. write cache only after the backend-settled result is `COMPLETE`；
10. set `expiresAtMs = nowAfterCompletion + ttlMs`。

The internal backend hard cap is:

```ts
Math.max(1, Math.min(requestedOperationCapMs, gatewayAbsoluteCapMs))
```

It is not inherited from the first caller’s shorter local wait budget.

- [ ] **Step 5: Completion/error mapping**

Map only:

```text
normal result                  -> COMPLETE
server returned bounded subset -> PARTIAL_LIMIT
DeadlineBudget expired         -> PARTIAL_TIMEOUT or DEADLINE_EXCEEDED
all waiters abandoned          -> CANCELLED
JDT process/server failure     -> FAILED
```

Never map every exception to timeout. Preserve `JavaIntelligenceError.code`.

- [ ] **Step 6: 复用 Task 3 lifecycle backoff 与 Task 12a busy outcome**

SemanticGateway does not own restart state. Before creating a backend operation it reads `JdtlsSession.lifecycleStatus()` and the runtime admission outcome:

```text
JDT_BACKOFF / JDT_CONFIG_ERROR
  -> completion FAILED
  -> preserve exact error code and retryAfterMs in diagnostic degradation
  -> lifecycleBackoffSkips++
  -> no backend request and no cache write

JDT_BUSY_OTHER_SESSION / no global slot
  -> completion FAILED
  -> errorCode JDT_BUSY_OTHER_SESSION or JDT_NOT_READY
  -> busyOtherSessionSkips++
  -> no attempt to spawn a second JDT

READY
  -> execute normally
```

Caller timeout/cancel remains local to the gateway waiter and never modifies Task 3 failure counters. `java_restart` talks to `JdtlsSession` to clear lifecycle backoff; it does not call a gateway reset method. Add tests proving five gateway calls during an active Task 3 backoff cause zero backend calls and do not extend/change the retry deadline.

- [ ] **Step 7: 把 JdtlsSession 原始方法收敛到 gateway backend**

`SemanticGateway` is the only production caller of expensive JDT methods used by `java_impact`. `java_symbol` and `java_references` also call the gateway so they receive the same lifecycle, deadline, cache and error semantics.

Keep low-level `JdtlsSession` request methods package-internal where possible. Do not duplicate caches in both layers. Recommended split:

```text
JdtlsSession: transport + open document + raw normalized protocol result
SemanticGateway: keying + deadline + singleflight + complete cache + error policy
```

Delete or disable the old generic completed-value cache for operations now owned by `SemanticGateway`; otherwise two TTL layers hide invalidation bugs.

- [ ] **Step 8: 收敛 persisted JDT exact edges**

Create or replace `src/semantic-edge-store.ts` with:

```ts
import type { RepoChangeBatch } from "./repo-change-coordinator.js";
import type { SourceRange } from "./java-index/index-types.js";

export type PersistedSemanticEdge = {
  edgeId: string;
  sourceSymbolId: string;
  targetSymbolId: string;
  sourceFile: string;
  targetFile: string;
  relation: "JDT_DEFINITION" | "JDT_IMPLEMENTATION" | "JDT_REFERENCE" | "JDT_TYPE_HIERARCHY";
  sourceRange?: SourceRange;
  targetRanges: SourceRange[];
  provenance: "PERSISTED_JDT";
  confidence: 1;
  completion: "COMPLETE";
  dependencies: Array<{ file: string; fingerprint: string }>;
  buildFingerprint: string;
  validatedGeneration: number;
  createdAt: string;
};

export type SemanticEdgeStoreStatus = {
  entries: number;
  snapshotBytes: number;
  generation: number;
  buildFingerprint: string;
  hits: number;
  misses: number;
  invalidations: number;
  promoted: number;
  completeWrites: number;
  rejectedWrites: number;
  lastError?: string;
};
```

Before `putComplete`, map source and target locations through `JavaIndex.queryAnchor()`/stable symbol lookup. If either side has no stable repo symbol ID, use the edge only for the current request and skip persistence.

Store API:

```ts
export interface SemanticEdgeStoreV2 {
  findFrom(sourceSymbolId: string, generation: number): readonly PersistedSemanticEdge[];
  putComplete(edges: readonly PersistedSemanticEdge[], generation: number): Promise<void>;
  applyChanges(batch: RepoChangeBatch): void;
  clearForBuildChange(generation: number): void;
  flush(): Promise<void>;
  status(): SemanticEdgeStoreStatus;
}
```

Write tests proving:

1. COMPLETE repo-contained edge whose source and target both map to stable JavaIndex symbol IDs persists and reloads；
2. a location that cannot map to a stable JavaIndex symbol ID is not persisted；
3. PARTIAL/FAILED outcome cannot call `putComplete`；
4. changed/deleted dependency removes the edge；
5. build fingerprint change clears the store；
6. unaffected edge is promoted to the current generation only after dependency fingerprints are revalidated；
7. outside-repo source/target is rejected；
8. failed atomic write leaves the previous snapshot readable。

Use a separate small atomic snapshot such as `semantic-edges-v2.json.gz`. Do not merge it into the JavaIndex static snapshot and do not introduce a database.

When the V2 tests and one cold benchmark confirm persisted-edge hits are preserved, delete the legacy semantic-edge snapshot reader/writer identified in Task 0. No dual-write remains after this task.

- [ ] **Step 9: Metrics**

Expose in diagnostic status:

```ts
{
  inflight: number;
  completedEntries: number;
  cacheHits: number;
  cacheMisses: number;
  sharedJoins: number;
  abortedNoWaiters: number;
  completeWrites: number;
  rejectedWrites: number;
  lifecycleBackoffSkips: number;
  busyOtherSessionSkips: number;
}
```

No per-query file path is included in standard output.

- [ ] **Step 10: Run/Commit**

```bash
npm run build
node --test dist/semantic-gateway.test.js dist/semantic-edge-store.test.js dist/jdtls-session.test.js
npm test
git add src/semantic-gateway.ts src/semantic-gateway.test.ts src/test-support/deferred.ts src/semantic-edge-store.ts src/semantic-edge-store.test.ts src/jdtls-session.ts src/agent-router/providers/semantic-provider.ts src/tools/symbol.ts src/tools/references.ts
git commit -m "perf(semantic): singleflight exact Java requests and cache only complete results"
```

---

## Task 34：Open-document LRU、pinning 与 `didClose`

**Files:**
- Create: `src/document-lru.ts`
- Test: `src/document-lru.test.ts`
- Modify: `src/jdtls-session.ts`
- Modify: `src/file-watcher.ts` or current RepoChangeCoordinator integration

**Interfaces:**
- Consumes: JDT connection notification sink、canonical repo-contained files。
- Produces:
  - `DocumentLease`
  - `DocumentLru.acquire(file, text): Promise<DocumentLease>`
  - `DocumentLru.has(file): boolean`
  - `DocumentLru.delete(file): void`
  - `DocumentLru.closeAll(): void`
  - maximum 64 open documents by default；
  - pinned/in-flight documents are not evicted；
  - eviction sends `textDocument/didClose`；
  - delete closes immediately。

- [ ] **Step 1: 写 LRU eviction 测试**

Create `src/document-lru.test.ts` with these imports before the tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DocumentLru } from "./document-lru.js";
```

Then add:

```ts
test("opening the sixty-fifth idle document closes the least recently used document", async () => {
  const notifications: Array<{ method: string; uri: string }> = [];
  const lru = new DocumentLru({
    maxOpen: 64,
    notify(method, params) {
      notifications.push({ method, uri: params.textDocument.uri });
    }
  });

  for (let index = 0; index < 65; index += 1) {
    const lease = await lru.acquire(`/repo/F${index}.java`, `text-${index}`);
    lease.release();
  }

  assert.equal(lru.status().open, 64);
  assert.deepEqual(
    notifications.filter(item => item.method === "textDocument/didClose").map(item => item.uri),
    ["file:///repo/F0.java"]
  );
});
```

Run and confirm FAIL.

- [ ] **Step 2: 写 pinning、delete、change 和 close-all 测试**

Add these complete tests:

```ts
function recordingLru(maxOpen: number): {
  lru: DocumentLru;
  notifications: Array<{ method: string; uri: string; version?: number }>;
} {
  const notifications: Array<{ method: string; uri: string; version?: number }> = [];
  const lru = new DocumentLru({
    maxOpen,
    notify(method, params) {
      notifications.push({
        method,
        uri: params.textDocument.uri,
        version: "version" in params.textDocument
          ? params.textDocument.version
          : undefined
      });
    }
  });
  return { lru, notifications };
}

test("an in-flight pinned document is not evicted", async () => {
  const { lru, notifications } = recordingLru(2);
  const pinned = await lru.acquire("/repo/A.java", "class A {}");
  const idle = await lru.acquire("/repo/B.java", "class B {}");
  idle.release();
  const newest = await lru.acquire("/repo/C.java", "class C {}");
  newest.release();

  const closes = notifications
    .filter(item => item.method === "textDocument/didClose")
    .map(item => item.uri);
  assert.deepEqual(closes, ["file:///repo/B.java"]);
  assert.equal(lru.has("/repo/A.java"), true);
  pinned.release();
});

test("delete sends didClose and removes cached text", async () => {
  const { lru, notifications } = recordingLru(2);
  const lease = await lru.acquire("/repo/A.java", "class A {}");
  lease.release();
  lru.delete("/repo/A.java");

  assert.equal(lru.has("/repo/A.java"), false);
  assert.equal(lru.status().retainedTextBytes, 0);
  assert.equal(
    notifications.filter(item => item.method === "textDocument/didClose").length,
    1
  );
});

test("changed text sends one monotonically versioned didChange", async () => {
  const { lru, notifications } = recordingLru(2);
  const first = await lru.acquire("/repo/A.java", "class A {}");
  first.release();
  const second = await lru.acquire("/repo/A.java", "class A { int value; }");
  second.release();
  const third = await lru.acquire("/repo/A.java", "class A { int value; }");
  third.release();

  const changes = notifications.filter(item => item.method === "textDocument/didChange");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].version, 2);
});

test("closeAll sends didClose for every open document and clears state", async () => {
  const { lru, notifications } = recordingLru(3);
  for (const file of ["A.java", "B.java", "C.java"]) {
    const lease = await lru.acquire(`/repo/${file}`, `class ${file[0]} {}`);
    lease.release();
  }
  lru.closeAll();

  assert.equal(lru.status().open, 0);
  assert.equal(lru.status().retainedTextBytes, 0);
  assert.equal(
    notifications.filter(item => item.method === "textDocument/didClose").length,
    3
  );
});
```

- [ ] **Step 3: 定义 lease**

```ts
export type DocumentLease = {
  uri: string;
  version: number;
  release(): void;
};

type OpenDocumentEntry = {
  file: string;
  uri: string;
  version: number;
  text: string;
  pins: number;
  lastUsedAt: number;
};
```

`release()` is idempotent. A request acquires before building LSP params and releases after backend request settles.

- [ ] **Step 4: 实现 eviction**

When `open > maxOpen`:

1. sort or scan for lowest `lastUsedAt` with `pins===0`；
2. send `didClose`；
3. remove entry；
4. if every document is pinned, temporarily exceed the cap and record `evictionDeferred`；
5. retry eviction on next release。

A 64-entry linear scan is simpler and sufficient; do not add a heap.

- [ ] **Step 5: 接入 JdtlsSession**

Replace `openDocuments Map` ownership with `DocumentLru`. `textDocumentPositionParams` becomes:

```ts
private async withDocumentPosition<T>(
  file: string,
  line: number,
  column: number,
  action: (params: TextDocumentPositionParams) => Promise<T>
): Promise<T> {
  const text = await readFile(file, "utf8");
  const lease = await this.documents.acquire(file, text);
  try {
    return await action({
      textDocument: { uri: lease.uri },
      position: toLspPosition(line, column)
    });
  } finally {
    lease.release();
  }
}
```

Do not return params whose document lease is already released before the request is sent.

- [ ] **Step 6: Change/delete integration**

Repo change events:

```text
MODIFIED -> update only if document is currently open
DELETED  -> close immediately
RENAMED  -> close old; new path opens lazily
```

`DocumentLru` does not own repo watching. It consumes normalized events from `RepoChangeCoordinator`.

- [ ] **Step 7: Status and memory test**

Status:

```ts
{
  maxOpen: 64,
  open: number,
  pinned: number,
  evictions: number,
  evictionDeferred: number,
  closes: number,
  retainedTextBytes: number
}
```

Add a test with 100 files each containing a 1MiB string and `maxOpen=8`; after releasing all, retained text bytes must be bounded by the last eight files plus small overhead. Do not assert exact process RSS.

- [ ] **Step 8: Run/Commit**

```bash
npm run build
node --test dist/document-lru.test.js dist/jdtls-session.test.js
npm test
git add src/document-lru.ts src/document-lru.test.ts src/jdtls-session.ts src/file-watcher.ts src/repo-change-coordinator.ts
git commit -m "perf(jdtls): bound open Java documents and send didClose on eviction"
```

---

## Task 35：首触实验矩阵、默认化判定与最小 warm policy

**Files:**
- Create: `src/benchmark/semantic-first-touch.ts`
- Test: `src/benchmark/semantic-first-touch.test.ts`
- Modify: `package.json`
- Create: `docs/phase-v3/phase5-semantic-first-touch-decision.md`
- Create: `artifacts/v3-phase5/`
- Modify only if gate passes: `src/agent-router/providers/semantic-provider.ts`
- Modify only if gate passes: `src/tools/impact.ts`

**Interfaces:**
- Consumes: completed Iterations A–D、three real repo roots、JDT LS runtime。
- Produces: reproducible first-touch matrix and one explicit decision:
  - `KEEP_EXPLICIT`
  - `DEFAULT_FOR_SELECTED_PROFILE`
  - `DEFAULT_REQUIRED`

- [ ] **Step 1: 写 benchmark CLI parser test**

CLI:

```text
--repo-root <path>
--project-id <id>
--workspace-state fresh|reused
--prepare none|progress-idle|document-symbol
--operation definition|implementation|references|type-hierarchy
--runs <n>
--timeout-ms <n>
--output <file>
```

Parser rejects invalid combinations and defaults `runs=10` for latency experiments.

- [ ] **Step 2: 定义 attempt record**

```ts
export type SemanticFirstTouchAttempt = {
  projectId: string;
  repoCommit: string;
  workspaceState: "fresh" | "reused";
  prepare: "none" | "progress-idle" | "document-symbol";
  operation: "definition" | "implementation" | "references" | "type-hierarchy";
  scenarioId: string;
  ensureStartedMs: number;
  prepareMs: number;
  requestMs: number;
  totalMs: number;
  completion: Completion;
  resultFiles: number;
  repoContainedFiles: number;
  cacheHit: boolean;
  shared: boolean;
  errorCode?: JavaIntelligenceErrorCode;
  sessionPhaseMs: Record<string, number>;
};
```

The summary reports P50/P95 per exact matrix cell. Never mix fresh and reused workspace attempts into one percentile.

- [ ] **Step 3: Fresh workspace isolation**

For `workspace-state=fresh`:

```text
create a temporary JDTLS_DATA_DIR
create a temporary JDTLS_LOG_DIR
run one matrix cell
stop session
retain logs under artifacts only when failure/timeout occurs
remove temporary workspace otherwise
```

For `reused`, use a dedicated benchmark workspace, not the user’s normal active cache. Record its fingerprint and clear it at the start of the full experiment suite.

- [ ] **Step 4: Run the minimum useful matrix**

For each real repo, select one representative scenario per operation/profile supported by existing golden. Run:

```text
fresh  × none            × definition       × 10
fresh  × none            × references       × 10
fresh  × progress-idle   × references       × 10
fresh  × document-symbol × references       × 10
reused × none            × definition       × 10
reused × none            × references       × 10
reused × none            × type-hierarchy   × 10 where applicable
```

Do not run every profile/operation Cartesian product. This is a decision experiment, not a benchmark product.

- [ ] **Step 5: Measure backend settlement after caller timeout**

When caller budget expires, record whether JDT backend settles within:

```text
250ms
1s
5s
never before session stop
```

This is diagnostic only. Do not promise that `$/cancelRequest` immediately stops JDT work.

- [ ] **Step 6: Re-run quality matrix with warm-required**

Run existing 3-repo golden matrix with:

```text
cold-nolsp runs=5 diagnostic
warm-auto runs=5 diagnostic
warm-required runs=5 diagnostic
```

Use Iteration D output schema and metrics. Compare:

```text
R_read_must
R_task_blocking
recall
P_read
NDCG_read@6
estimatedTokens
P50/P95
semantic complete/partial/failed counts
```

A latency improvement without task-level quality gain is not sufficient for defaulting required semantics.

- [ ] **Step 7: Apply decision gates**

`DEFAULT_REQUIRED` requires all of:

```text
all repos R_read_must = 1.0000
all repos R_task_blocking >= cold
all repos recall >= cold
all repos P_read >= cold - 0.02
warm-required fresh first-touch P95 <= 800ms
warm-required reused cache-hit P50 <= 100ms
semantic FAILED = 0
outside-repo files = 0
standard estimatedTokens <= cold +5%
```

`DEFAULT_FOR_SELECTED_PROFILE` requires the same gates for a profile-specific subset and at least one material counterfactual gain in that subset. The policy must be hard-coded as a small explicit function with a report-backed reason; no per-repo DSL.

Otherwise choose `KEEP_EXPLICIT`.

Historical reports already showed references first-touch near 1.5s or worse. The default expectation is therefore `KEEP_EXPLICIT` unless new architecture materially changes the measured result.

- [ ] **Step 8: Implement only the chosen policy**

If `KEEP_EXPLICIT`:

```text
semanticPolicy=auto never runs expensive references merely because JDT is READY
semanticPolicy=required and precision/recall modes may run it within deadline
java_status exposes why auto skipped
```

If a default gate passes, implement the smallest profile rule in `semantic-provider.ts`. Do not add a scheduler queue, aging, bulkhead hierarchy or profile configuration language.

- [ ] **Step 9: Write the decision report**

Required sections:

```markdown
# Phase 5 Semantic First-Touch Decision

## Environment
## Runtime/JDT Versions
## Matrix
## Quality Delta
## Timeout and Cancellation Settlement
## Decision
## Policy Patch, If Any
## Rejected Alternatives
## Known Limits
## Reproduction Commands
```

The `Decision` section must be one of the three exact enum values.

- [ ] **Step 10: Run/Commit**

```bash
npm run build
node --test dist/benchmark/semantic-first-touch.test.js
npm test
npm run benchmark:semantic-first-touch -- --help
# Run the real matrix commands recorded by the report.
git add src/benchmark/semantic-first-touch.ts src/benchmark/semantic-first-touch.test.ts package.json docs/phase-v3/phase5-semantic-first-touch-decision.md artifacts/v3-phase5 src/agent-router/providers/semantic-provider.ts src/tools/impact.ts
git commit -m "test(semantic): decide Java warm defaults from first-touch evidence"
```

Iteration E completion gate:

```text
same-key singleflight active
complete-only semantic cache active
open documents bounded and closed
first-touch matrix reproducible
quality and latency decision explicit
warm-required may remain explicit without counting as failure
```

---

# Iteration F：最终收敛、删除旧路径与发布级验证

Iteration F is not a new feature stage. It removes migration debris, verifies that the V3 architecture is the only active path, and produces the final implementation evidence.

## Task 36：删除旧实现、全矩阵验证、文档收敛与最终报告

**Files:**
- Delete: V1 source-index JSONL/compact implementation after confirmed unused
- Delete: legacy edge-store snapshot implementation after `SemanticEdgeStoreV2` parity is confirmed
- Delete: duplicate router/provider/ranker code paths
- Delete: temporary compatibility spike artifacts and feature switches
- Modify: `README.md`
- Modify: `src/README.md`
- Modify: `package.json`
- Create: `docs/phase-v3/final-java-intelligence-v3-report.md`
- Create: `artifacts/v3-final/`

**Interfaces:**
- Consumes: all prior phase reports and raw artifacts。
- Produces: one buildable, testable V3 implementation with no compatibility branch and a final evidence report。

- [ ] **Step 1: Static dead-path scan**

Run:

```bash
rg -n "parseJavaSource|source-index\.files\.jsonl|source-index\.symbols\.jsonl|appendFileSync|spawnSync\(\"rg\"|AGENT_RG_CACHE_TTL_MS|routingVersion:\s*5|ImpactResultV5|INDEX_V2|legacy edge" src scripts package.json
```

For every match, classify in the final report:

```text
DELETE
KEEP_TEST_FIXTURE
KEEP_NON_REQUEST_PATH_WITH_REASON
```

No unclassified match is allowed.

- [ ] **Step 2: Remove migration switches**

After Iteration C/D gates pass, remove:

```text
INDEX_V2 / dual-read / dual-write flags
legacy snapshot schema readers
fallback to V1 index
V5/V6 output toggles
temporary comparator-only code
```

Cache schema mismatch simply deletes/rebuilds the cache. Do not retain compatibility migration code.

- [ ] **Step 3: Package dependency audit**

Run:

```bash
npm ls --all
npm outdated || true
npm audit --omit=dev
```

Review direct dependencies. Final expected new direct dependencies are only those actually selected:

```text
tree-sitter OR web-tree-sitter
corresponding Java grammar
chokidar
fast-xml-parser
```

Do not ship both native and WASM Tree-sitter. Remove abandoned spike packages and unused type packages.

- [ ] **Step 4: Determinism test**

Run the same cold scenario 20 times without edits. Assert identical:

```text
candidate path order
readPlan file/range order
family scores rounded to serialized precision
completion/freshness fields
```

Latency and cache-hit counters may differ and remain diagnostic-only. Add a test or script that fails on semantic output drift.

- [ ] **Step 5: Mutation freshness suite**

Against a fixture repo, execute the following without restarting MCP:

1. modify method body；
2. add package-private method；
3. add nested record；
4. rename Java type/file；
5. delete Java file；
6. change import from one duplicate simple name to another；
7. change `pom.xml` module；
8. change MyBatis XML statement；
9. create malformed temporary Java then repair it。

After watcher quiescence, every query must reflect the latest generation. Gate:

```text
mutation stale rate = 0/9
old renamed/deleted paths = 0
changedDuringRequest is truthful when mutation overlaps request
```

- [ ] **Step 6: Fault injection suite**

Run automated tests for:

```text
concurrent JDT start
initialize timeout
child exits during initialize
child exits after READY
rg timeout with partial stdout
rg ENOBUFS/limit
JavaIndex worker crash
snapshot corruption
watcher error/dirty reconcile
outside-repo LSP result
semantic timeout while another waiter remains
all waiters cancel
```

Expected:

```text
no false READY
no complete cache write from incomplete result
no stale path leak
next request can recover where specified
all degraded states exposed in diagnostic status
```

- [ ] **Step 6a: 多进程/worktree final suite**

Run deterministic two-process/subprocess tests for:

```text
machine-level JDT slots across independent MCP processes
same-worktree second JDT rejection
machine-level background sweep slots
dead lease reclamation and live-PID non-steal
fast-only active cache janitor protection
linked-worktree .git/common-dir ignore
500-file storm degradation + foreground anchor refresh
own snapshot generation rebase
sibling seed matching/changed/new/deleted/concurrent-change cases
seed reconcile equivalence with clean full sweep
```

Expected:

```text
observed JDT/sweep concurrency never exceeds configured slots
same-worktree duplicate child spawn count = 0
live fast-only cache removal count = 0
storm advances generation once and schedules one reconcile
source-branch stale fact leak count = 0
seeded target negative answer before COMPLETE count = 0
```

- [ ] **Step 7: Full local verification**

```bash
rm -rf dist
npm ci
npm run build
npm test
npm run smoke
./check-codex-mcp.sh --fast
```

If smoke command differs at current HEAD, use Task 0 mapped command and record it.

- [ ] **Step 8: Three-repo final matrix**

For each configured real repo at a recorded commit:

```bash
node dist/benchmark-agent-impact.js \
  --repo-root "$REPO_ROOT" \
  --project-id "$PROJECT_ID" \
  --warm-state cold-nolsp \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > "artifacts/v3-final/${PROJECT_ID}-cold.json"

node dist/benchmark-agent-impact.js \
  --repo-root "$REPO_ROOT" \
  --project-id "$PROJECT_ID" \
  --warm-state warm-auto \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > "artifacts/v3-final/${PROJECT_ID}-warm-auto.json"
```

Run warm-required only as decided by Phase 5; if explicit-only, still run the validation matrix but do not change default behavior.

- [ ] **Step 9: End-to-end Agent trace comparison**

For at least six representative tasks, capture:

```text
MCP calls made
MCP schema prompt tokens
java_impact result tokens
readPlan bytes/tokens
follow-up file reads
whether taskBlocking files were read
wall-clock to first useful context
```

Compare V3 with Task 0 baseline under the same prompt and model/client when feasible. This is observational evidence; do not mix it into deterministic hard gates.

- [ ] **Step 10: Final hard gates**

All must pass:

```text
npm build/test/smoke: 0 fail
R_read_must: 1.0000 each real repo
R_task_blocking: >= Phase 0 each repo
recall: >= Phase 0 each repo
P_read: >= Phase 0 - 0.02 each repo
cold P95: <= max(Phase 0 * 1.25, Phase 0 + 50ms)
standard estimatedTokens: <= Phase 0
outside-repo output: 0
mutation stale rate: 0
partial cache writes: 0
false READY reproductions: 0
unbounded open documents: 0
JavaIndex COMPLETE roots may use negative cache; other roots may not
machine JDT/sweep concurrency <= configured fixed slots
same-worktree duplicate JDT spawn count = 0
worktree seed stale fact leak count = 0
worktree seed post-reconcile equivalence = 100%
```

A quality gain may justify a documented cold P95 exception only when all are true:

```text
material R_task_blocking gain >= 0.05 on at least one weak repo
absolute cold P95 remains <= 300ms
other repos do not regress quality
provider counterfactual proves the added cost caused the gain
```

The exception must be written in the final report. Silent relaxation is forbidden.

- [ ] **Step 11: README rewrite**

README product claim becomes:

```text
Java-only local code intelligence for coding agents:
Tree-sitter incremental facts + bounded JDT exact semantics + task-oriented token-aware readPlan.
```

Document:

- five core architecture layers；
- default cold/auto/required behavior；
- cache rebuild semantics；
- status/freshness/completeness；
- benchmark commands；
- explicit non-goals；
- macOS/Node/JDT requirements。

Do not advertise unverified speedup percentages.

- [ ] **Step 12: Final report**

`docs/phase-v3/final-java-intelligence-v3-report.md` must contain:

```markdown
# Java Intelligence V3 Final Report

## Scope and Non-goals
## Exact Commit and Environment
## Architecture Delivered
## Files Added/Deleted
## Correctness and Fault-Injection Results
## Freshness Mutation Results
## JavaIndex Coverage and Snapshot Results
## Worktree Lease, Storm, Janitor and Snapshot Seed Results
## Per-Provider Quality/Cost Attribution
## Three-Repo Cold Matrix
## Warm Decision
## Token and Agent Trace Results
## Rejected Designs
## Remaining Known Limits
## Reproduction Commands
## Final Decision
```

`Final Decision` is `ACCEPT`, `ACCEPT_WITH_DOCUMENTED_EXCEPTION`, or `REJECT_AND_REVERT`.

- [ ] **Step 13: Final commit**

```bash
git add -A
git commit -m "refactor(java): complete the Java intelligence V3 architecture"
```

Do not squash prior task commits until review is complete; their before/after boundaries are part of the debugging and rollback story.

---

# 5. 全局测试矩阵

The following matrix is mandatory across the plan. A task may run a subset, but its iteration report must show all rows relevant to that iteration.

| Layer | Test class | Required cases | Hard assertion |
|---|---|---|---|
| Runtime | unit | deadline, completion, error mapping | deterministic codes/completion |
| JDT lifecycle | concurrency/fault | concurrent start, initialize fail, exit | no false READY; clean retry |
| Admission | concurrency | two repos starting at cap | process-local STARTING+READY never exceeds cap |
| Cross-process lease | multiprocess/fault | machine slots, same worktree, dead/live owners | no duplicate JDT; no global oversubscription |
| Worktree storm | mutation/concurrency | 500-file batch, linked `.git`, foreground anchor | one reconcile; bounded foreground; no false generation |
| Worktree seed | persistence/mutation | matching/changed/new/deleted/racing target files | only exact facts reused; target DEGRADED until reconcile |
| Worktree janitor | multiprocess | active fast-only/JDT/dead cache | live cache retained; dead stale cache removed |
| Search | unit/fault | complete, timeout partial, maxBuffer | only COMPLETE cached |
| Containment | security/correctness | dependency/JDK/outside URI | suppressed, never serialized |
| Generation | mutation | edit/add/delete/rename/build change | next request observes change |
| Snapshot | persistence | save/load/version/corruption/rebase/stale publish | atomic recovery, no partial state, no full reparse on unchanged reload |
| AST | fixture | nested/package-private/record/generics | exact facts/ranges |
| Name resolution | fixture | imports/wildcards/duplicate simple names | no arbitrary binding |
| Calls | fixture | local/field/static/constructor/lambda bound | bounded confidence/provenance |
| Framework | fixture + real | Spring/MyBatis/JPA/MapStruct/Lombok | measured candidate/readPlan gain |
| Ranker | pure unit | duplicate family signals | saturation, no full double count |
| References | unit | collapse/rank/truncate | valuable repo files retained |
| ReadPlan | pure + golden | byte/range/family budgets | must preserved, bytes bounded |
| Output | shape | compact/standard/diagnostic | no absolute/debug leak |
| Golden | real repos | cold/auto/required | hard gates and attribution |
| Agent trace | observational | six task prompts | token/tool/read efficiency |

## 5.1 Required fixture conventions

Every fixture:

- is self-contained；
- uses realistic Java syntax；
- contains line assertions for ranges；
- has an explicit expected node/edge list；
- avoids project-specific names unless testing a framework adapter；
- is destroyed or uses `tmpdir` when mutated；
- never depends on network access。

## 5.2 Required fault test implementation style

Do not use sleep-heavy integration tests when a fake clock/transport can deterministically advance state. Use real child/JDT only for protocol smoke tests and first-touch benchmarks.

Every timeout test must assert both:

1. caller-visible completion/error；
2. whether the underlying work was cached, cancelled, settled or cleaned up。

---

# 6. Benchmark 与验收口径

## 6.1 Canonical real-repo matrix

The authoritative default matrix is:

```text
3–5 repos
24–36 real task scenarios target
runs=5 for regular quality/latency reports
cold-nolsp and warm-auto always
warm-required according to Phase 5 decision
same machine, repo commit, runtime build and golden revision
```

At minimum preserve the existing three repositories used by project reports. A fourth/fifth repo is added only when it introduces a materially different Java shape such as plain Maven, classic layered Spring, JPA-heavy or annotation-processing-heavy code.

## 6.2 Quality metrics

```text
R_read_must
R_task_blocking
candidate recall
candidate precision
P_read
NDCG_read@6
firstTaskBlockingRank
readPlanRangeRecall
providerCounterfactualGain
```

`R_read_must=1.0` is hard. `R_task_blocking` is the primary optimization metric after must safety. Candidate precision alone cannot approve a change.

## 6.3 Cost metrics

```text
elapsed P50/P95
phase P50/P95
resultBytes
readPlanBytes
estimatedTokens
evidencePerKiB
taskBlockingHitsPerKiB
rg raw bytes suppressed
JavaIndex foreground refresh time
JavaIndex background sweep time
snapshot load/save time
JDT process RSS where observable
```

Do not compare average-only latency. Do not compare output size while changing golden or repo commit without separating those effects.

## 6.4 Freshness metrics

```text
requestGeneration
indexedGeneration
changedDuringRequest
coverage state by source root
pending change count
last reconciled generation
mutation stale rate
```

A result may be useful while partial, but its freshness/completeness must be truthful.

## 6.4.1 Worktree-family metrics

Every phase that changes worktree behavior records:

```text
activeRuntimeLeases
claimedJdtSlots / configuredJdtSlots
claimedSweepSlots / configuredSweepSlots
sameWorktreeBusyCount
staleLeaseReclaims
stormBatches
foregroundAnchorP50/P95DuringStorm
seedAttempts
seedSourceRepoHash (diagnostic artifact only)
seedReusedFiles
seedDirtyFiles
seedRelinkFiles
seedDroppedCrossFileEdges
seedManifestValidationMs
seedDeltaParsedFiles
seedReconcileElapsedMs
seedStaleFactLeaks
janitorLiveRuntimeSkips
```

No absolute sibling worktree path is serialized in standard MCP output.

## 6.5 Provider value metrics

For every provider/family:

```text
attempts
complete/partial/failed
addedCandidates
selectedCandidates
readPlanSelections
goldenHits
taskBlockingHits
counterfactualCandidateGain
counterfactualReadPlanGain
elapsed P50/P95
bytes or token impact
```

A provider that adds many candidates with zero selection/golden gain is a cost defect, not a feature.

---

# 7. Phase report template

Every iteration report uses the following exact structure:

```markdown
# Phase N — <Name> Report

## 1. Decision
One paragraph: keep/reject/modify and why.

## 2. Baseline
- codex-java-lsp-mcp commit
- runtime build stamp
- Node/JDK/JDT/ripgrep versions
- macOS/CPU/RAM
- real repo commits
- golden revision

## 3. Scope
### Changed
### Explicitly unchanged

## 4. Tests
| command | result | notes |

## 5. Correctness/Fault Results

## 6. Benchmark Matrix
| repo | state | quality | P50/P95 | bytes/tokens |

## 7. Attribution
| provider/family | cost | selected | golden gain | decision |

## 8. Rejected Alternatives

## 9. Known Limits

## 10. Reproduction Commands

## 11. Gate Result
PASS / FAIL with every gate enumerated.
```

A report cannot say “PASS” without linking or naming the raw JSON artifacts that support it.

---

# 8. Commit 与执行顺序

Recommended commit sequence:

```text
Task 0  docs: capture current V3 baseline
Task 1  refactor(runtime): define completion/deadline/error contracts
Task 2  refactor(jdtls): inject transport
Task 3  fix(jdtls): transactional lifecycle and restart backoff
Task 4  fix(runtime): atomic JDT admission
Task 5  fix(search): stream rg and reject partial cache
Task 6  fix(semantic): enforce repo containment and typed errors
Task 7  fix(semantic): bound hierarchy traversal
Task 8  test(v3): phase 1 report
Task 9  feat(freshness): independent watcher/generation
Task 10 refactor(cache): generation-aware caches
Task 11 fix(index): delete/rename/layout invalidation
Task 12 fix(runtime): context cleanup and config LKG
Task 12a fix(worktree): cross-process JDT/sweep leases
Task 12b fix(worktree): storm degradation and git metadata ignores
Task 12c fix(worktree): multi-process-safe cache janitor
Task 13 test(v3): phase 2 report
Task 14 build(index): choose Tree-sitter runtime
Task 15 feat(index): worker protocol/client
Task 16 feat(index): AST facts
Task 17 feat(index): FQN/import resolution
Task 18 feat(index): static Java edges/calls
Task 19 feat(index): query store
Task 20 feat(index): manifest/coverage/sweep
Task 21 feat(index): atomic snapshot and generation rebase
Task 21a perf(worktree): validated sibling snapshot seeding
Task 22 refactor(router): replace V1 index
Task 23 test(v3): phase 3 report
Task 24 refactor(router): normalized evidence
Task 25 refactor(ranking): family saturation
Task 26 perf(semantic): reference value ranking
Task 27 feat(framework): Spring pack
Task 28 feat(framework): MyBatis pack
Task 29 feat(framework): JPA/MapStruct/Lombok pack
Task 30 feat(readplan): token/range planner
Task 31 refactor(output): ImpactResultV6
Task 32 test(v3): phase 4 report
Task 33 perf(semantic): singleflight/complete cache/lifecycle backoff reuse
Task 34 perf(jdtls): document LRU
Task 35 test(semantic): first-touch decision
Task 36 refactor(java): final V3 cleanup/report
```

Do not combine framework adapters into one commit if one adapter can be rejected while another is retained.

## 8.1 Review 问题到任务的追踪矩阵

| Review ID / 对比启示 | 实施任务 | 验收证据 |
|---|---|---|
| A-1 产品/架构缺少 worktree family | 架构 V3.1 §2.1D、§8.7–8.12；Task 9、12a–12c、21a | per-worktree isolation、family lease/seed/storm/janitor 测试与 phase report |
| C-01 伪 READY、C-02 启动失败残留 | Task 2–3 | 并发 start、initialize timeout、failed-start retry 测试 |
| A-2 DeadlineBudget 签名不一致 | Task 1 | four-argument `race()` compile/unit tests |
| A-3/E-2 watcher ready barrier 过强 | Task 9–10 | 2s bounded barrier + DEGRADED cache bypass test |
| A-4/E-1 backoff 时序错误 | Task 3、33 | lifecycle-owned backoff; gateway five-call zero-backend test |
| A-5 STOPPED cleanup 语义 | Task 3 | stopPromise/attempt identity concurrency test |
| C-03 无统一 generation | Task 9–11 | fast 模式 edit/add/delete/rename/build-change mutation suite |
| C-04 partial `rg` 被缓存 | Task 5 | fake timeout partial、cache write rejection、下一次完整查询 |
| C-05 repo 外 location | Task 6 | outside-repo URI/absolute-path suppression 测试 |
| C-06 active slot check-then-act | Task 4 | 两 repo 并发启动且 STARTING+READY 不超过上限 |
| C-07 无绝对 deadline | Task 1、7、33 | request budget、hierarchy remaining budget、shared semantic waiter 测试 |
| P-01 同步热点 | Task 14、19–22 | 请求路径无 `spawnSync`/append compact；event-loop lag 基准 |
| P-02 coverage 未知 | Task 16–21 | per-root COMPLETE/DEGRADED 与 safe negative lookup 测试 |
| P-03 `rg` 全量缓冲 | Task 5 | streaming JSON parser、max record/partial handling 测试 |
| P-04 semantic 无 singleflight | Task 33 | identical concurrent request only one backend call |
| P-05 open document 无上限 | Task 34 | 64-entry LRU、pin、delete、didClose、memory-bound 测试 |
| P-06 hierarchy 无 visited | Task 7 | cycle、depth、fanout、deadline fault tests |
| Q-01 simple-name collision | Task 17、19 | explicit import/FQN/ambiguous collision fixtures |
| Q-02 regex parser 上限 | Task 14–16 | package-private、nested/local、record、string brace fixtures |
| Q-03 policy 通用性残留 | Task 0、24、36 | current policy map、generic core audit、dead variant deletion |
| Q-04 重复证据裸加法 | Task 24–25 | same-family duplicate saturation/counterfactual benchmark |
| Q-05 references server 前 40 | Task 26 | collapse/value-sort before limit、real-repo attribution |
| Q-06 readPlan 仅文件槽 | Task 30 | byte/token/file caps、multi-range、must protection |
| M-03 缺并发/故障测试 | Task 2–7、9–12c、21–21a、33–34 | deterministic transport/watcher/fs fault suite |
| O-01 stopped context 常驻、O-02 config 无 LKG | Task 12 | runtime eviction、parse-failure last-known-good tests |
| W-1 跨进程 JDT admission / same-worktree workspace lock | Task 12a | fixed-slot multiprocess tests; duplicate spawn count 0 |
| W-2 新 worktree 全量重建 | Task 15、19、21a、23 | root-independent IDs; validated seed A/B; delta parse count |
| W-3 branch-switch/rebase storm | Task 12b、13 | 500-file batch; one reconcile; bounded anchor refresh |
| W-4 family/global background resource multiplication | Task 12a、20 | sweep fixed slots + dynamic parse-tree budget |
| E-3/W-5 snapshot generation rebase | Task 9、20–21 | reload at generation 41; manifest verify; zero reparse unchanged |
| W-6 janitor multi-process safety | Task 12c | live fast-only cache retained; dead stale cache removed |
| E-4 Task 4 步骤编号乱序 | V3.1 文档修订 | Task 4 Step 1–8 单调且无重复；文档自检脚本通过 |
| E-5 linked worktree `.git` ignore | Task 9、12b | `.git` file/common-dir do not advance generation |
| E-6 chokidar v5 option behavior | Task 9 | native spike records accepted/removed options |
| Tree-sitter AST 行业底线 | Task 14–23 | Tree-sitter worker, full sweep, atomic snapshot, V1 deletion |
| edge provenance/confidence | Task 24 | normalized `EvidenceSignal` and output provenance |
| watcher/增量新鲜度 | Task 9–11、20 | independent watcher + foreground/background refresh |
| sealed registry 后负缓存 | Task 20 | COMPLETE-only negative cache and generation invalidation |
| 原子/versioned cache | Task 21、33 | corrupt/write-failure recovery for static and semantic snapshots |

Every row is closed only by the named tests/artifacts, not by code review alone.

---

# 9. AI 执行规则

An AI agent implementing this plan must follow these rules:

1. **Task 0 is mandatory.** Current HEAD paths override this plan’s path guesses.
2. **Do not infer success.** Run commands and quote exact result counts in phase reports.
3. **Stop on a hard gate failure.** Diagnose or revert before starting the next task.
4. **Do not preserve compatibility by default.** Delete old cache/output paths after the replacement gate passes.
5. **Do not invent abstractions.** Java-only means no `LanguageAdapter`, `ParserRegistry` or generic `CodeGraph` framework.
6. **Do not add a provider without attribution.** Every new signal must expose completion, provenance, cost and counterfactual value.
7. **Do not treat partial as absence.** Unknown coverage remains unknown.
8. **Do not tune against one scenario.** A ranking change runs all real repos before acceptance.
9. **Do not hide latency in preparation.** Report startup, preparation and request time separately.
10. **Do not force warm defaulting.** `KEEP_EXPLICIT` is a valid Phase 5 success.
11. **Keep output Agent-oriented.** Do not turn the MCP into a graph exploration toolkit.
12. **Prefer deletion after replacement.** The project is allowed to break compatibility; use that to reduce long-term complexity.
13. **Never share mutable index state across worktrees.** Family-level reuse is limited to leases, budgets and manifest-validated immutable seed facts.
14. **Never make seeded facts queryable before target content verification.** Build fingerprint alone is insufficient.
15. **Never implement lease capacity with count-then-create.** Use fixed numbered atomic slots and owner-token-checked release.
16. **Do not duplicate restart backoff.** Task 3/JdtlsSession is the sole owner; gateway/provider layers only consume typed state.

For each task, the implementing agent should end its response with:

```text
Task: <number/name>
Commit: <sha>
Tests: <commands and exact pass/fail>
Benchmarks: <artifact paths or not applicable>
Gate: PASS/FAIL
Known limits: <concise>
Next task allowed: yes/no
```

---

# 10. Definition of Done

The V3 program is done only when all conditions hold:

- [ ] JDT lifecycle has no false-ready or failed-start residue。
- [ ] active repo admission counts STARTING and READY atomically。
- [ ] machine-level fixed JDT/sweep leases bound independent MCP processes, and same-worktree duplicate JDT spawn count is zero。
- [ ] dead leases are reclaimable while live-PID leases are never stolen solely for stale heartbeat。
- [ ] every expensive operation consumes one request-level absolute deadline。
- [ ] `rg` and semantic partial outcomes are never stored as complete cache entries。
- [ ] repo-external JDT locations never enter candidate/output paths。
- [ ] fast mode uses an independent watcher and monotonic generation。
- [ ] edit/add/delete/rename/build-file changes invalidate all relevant layers。
- [ ] Tree-sitter JavaIndex V2 is the sole structural fact source。
- [ ] package-private and nested Java declarations are indexed correctly。
- [ ] FQN/import-aware resolution prevents arbitrary simple-name binding。
- [ ] coverage is explicit and negative lookup is allowed only under COMPLETE coverage。
- [ ] foreground request paths no longer use synchronous `rg` or append/compact persistence。
- [ ] snapshot writes are versioned, atomic and recover from corruption。
- [ ] own snapshot reload rebases generation and restores unchanged COMPLETE coverage without a full AST reparse。
- [ ] sibling worktree seeding reuses only target-content-matching root-independent facts and remains DEGRADED until target reconcile。
- [ ] branch-switch/rebase storms schedule one background reconcile while foreground anchor refresh remains available。
- [ ] worktree cache janitor preserves live fast-only runtimes and removes only dead stale caches。
- [ ] evidence carries provider, family, provenance, confidence and completion。
- [ ] duplicate evidence families saturate instead of adding full score repeatedly。
- [ ] references are collapsed and value-ranked before truncation。
- [ ] Spring/MyBatis/JPA adapters have measured real-repo value or are removed。
- [ ] readPlan supports multiple ranges and enforces file/byte/token budgets。
- [ ] ImpactResultV6 is strongly typed and standard output exposes no debug/private path data。
- [ ] Attribution V3 derives absence reasons from actual diagnostics, not regex guesses。
- [ ] semantic same-key singleflight、complete-only persisted JDT edge store and bounded document LRU are active。
- [ ] Phase 5 records an explicit warm policy decision。
- [ ] build, test, smoke, mutation and fault suites pass。
- [ ] every real repo keeps `R_read_must=1.0000` and meets final gates。
- [ ] standard estimated token cost does not regress from Task 0 baseline。
- [ ] all old migration/cache/output branches are deleted。
- [ ] final report is reproducible from committed commands and raw artifacts。

---

# 11. Execution handoff

This document is intentionally a master implementation plan. Execute it one task at a time with one of these modes:

1. **Subagent-driven development — recommended**: one fresh agent per task, with a correctness review and a plan-conformance review before the next task.
2. **Inline executing-plans**: execute a small batch, stop at each iteration gate, review phase artifacts, then continue.

Do not dispatch Iterations A–E as parallel agents. Their data contracts and acceptance baselines are sequential dependencies.

The first implementation action is Task 0, not Tree-sitter installation and not ranking work.
