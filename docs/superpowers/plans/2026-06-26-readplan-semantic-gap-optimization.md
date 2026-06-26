# readPlan 语义召回稳定与窄图优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 Task 实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 在不牺牲 `R_read_must=1.0` 和 cold path 延迟的前提下，先修复 warm-required 语义候选挤出 readPlan 基线邻居的问题，再用诊断结果决定是否落地窄版离线关系图。

**Architecture:** 保留现有 `java_impact` public contract 和 7 个 MCP tools，不新增 public API。第一阶段只调整 `AgentRouter` 内部 readPlan 选择策略：所有 LSP 语义召回（`semanticLocations`、`references`、`typeHierarchy`）之前的 non-LSP readPlan 基线候选在语义召回后仍有保底席位，LSP 新候选只能竞争剩余席位。第二阶段只在诊断证明必要时扩 `SourceIndex` 的高信噪比 facts：全量 `implements/extends` 反向索引、字段/方法签名类型引用；不做 method-call token 图。

**Tech Stack:** TypeScript ESM、`node:test`、JDT LS、ripgrep、现有 `benchmark-agent-impact.ts`。

**Input Evidence:**
- `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`
- `docs/superpowers/plans/2026-06-25-cold-path-ranking-precision.md`
- `docs/java-lsp-mcp-architecture-effectiveness-plan-2026-06-21.md`
- Review report: `/Users/luo/.codex/attachments/524e0ba6-4153-4992-a2fe-8e7d90ecebb7/pasted-text.txt`

---

## 0. Decision Record

本计划替代“继续 Batch C 调字符串权重”作为下一轮主线。

关键纠正：

1. `warm-auto` 零收益不是 `references` 无效。当前 `semanticVerify()` 已把 `references` / `typeHierarchy` 作为新候选 merge 入口；零收益的主因是 `auto` 下 S1 语义启用只覆盖 `service` profile，`port/repository/dto` 三个缺口没有触发。
2. `warm-required` 已证明语义召回有效：recall 可从 `0.7756` 抬到约 `0.8256`；但 `R_read_must` 掉到约 `0.70`，根因是高分语义候选在固定 readPlan 容量里挤掉原本 must-read 邻居。
3. 剩余缺口不是单一“缺一张大图”：至少包含 readPlan 挤出、接口实现未全量索引、类型引用边缺失、跨模块消费者压制、side SQL/test 证据五类。
4. `pre-semantic` 必须严格表示“所有 LSP 语义召回之前”，不是“`semanticVerify()` 之前”。`collectSemanticSeed()` 在 `required` 下同样会 merge 高分候选，必须纳入挤出诊断和保护边界。
5. readPlan 保护的目标是“保基线不被挤出”，不是“禁止 LSP 新候选进入 readPlan”。当 protected 数量少于 `maxItems` 时，剩余 slot 应允许高分 LSP 候选进入；当 protected 已占满 `maxItems` 时，LSP-only must-hit 可能只进入 `files` 而不进入 readPlan，这是稳定基线优先于新语义候选的有意取舍，必须由 Task 0/2 指标显式暴露。
6. 因此顺序是：诊断归因 -> 修 readPlan 保底 -> 复测 warm-required -> 只有证据需要时再做窄图。

Non-goals:

- 不做 Batch C 字符串权重下调。
- 不把 annotation/package/focus 重新纳入 L2 protected。
- 不新增 SQLite、daemon、外部 rules DSL。
- 不做 method-call token 图；它的噪声最高，第一版收益不可控。
- 不扩大默认 `candidateLimit` 掩盖召回缺口。

## 1. Success Gates

所有阶段共享硬门槛：

- `npm run build && npm test` 通过。
- 三项目 `cold-nolsp strategy=impact runs=5` 的 `R_read_must=1.0` 保持。
- lishuedu cold path recall 不低于 `0.7756`，precision 不低于 `0.4127`。
- 若启用 `warm-required` 验收：lishuedu recall 必须高于 `0.7756`，且 `R_read_must=1.0`。
- raw payload 不允许用大幅反弹换 recall；单项目 raw 反弹超过 `5%` 必须回滚或把策略改为非默认 mode。

Soft gates:

- `warm-auto` 对 `port/repository/dto` 的默认启用不在第一刀做；先让 `warm-required` 有可采纳净收益。
- side 类 golden（SQL/test/config）参与诊断和分项指标，但不作为 readPlan hard gate。

## 2. File Map

第一阶段必须修改：

- `src/agent-router/index.ts`
  - 在所有 LSP 语义召回前记录 non-LSP readPlan protected paths。
  - `finalizeRank()` 和 `buildReadPlan()` 接收 protected path set；protected 只保证入选，最终输出仍按 `priorityRank + score` 排序。
- `src/agent-router.test.ts`
  - 新增 warm-required 语义候选不能挤出 non-LSP readPlan 邻居的回归测试。

第一阶段可选修改：

- `src/benchmark-agent-impact.ts`
  - 只在需要输出 `must/should/side` 分项 recall 时修改；否则先用外部 Node 诊断脚本。
- `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`
  - 记录阶段 1 复测结果。

第二阶段条件触发修改：

- `src/source-index.ts`
  - 增加全量 implementer 索引入口和窄版 `referencedTypes` facts。
- `src/source-index.test.ts`
  - 覆盖 `implements/extends` 全量索引与字段/方法签名类型提取。
- `src/agent-router/index.ts`
  - 在 `collectTypeGraphCandidates()` 消费窄图候选。
- `src/agent-router.test.ts`
  - 覆盖 type reference 候选进入 files/readPlan。

## Task 0: Diagnostic Baseline Before Any Code

目标：先把 lishuedu 三个缺口归因到“候选未进入 / 进候选但被裁 / 进 files 但没进 readPlan / side 非 hard gate”，避免盲目上图。

**Files:**
- Read: `golden/lishuedu.scenarios.jsonl`
- Read: `src/benchmark-agent-impact.ts`
- Read: `src/agent-router/index.ts`
- No repo file changes.

- [ ] **Step 1: Build current dist**

Run:

```bash
npm run build
```

Expected: `tsc` 成功，`scripts/write-build-stamp.mjs` 成功。

- [ ] **Step 2: List lishuedu scenarios**

Run:

```bash
node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu \
  --list-scenarios
```

Expected: 输出包含 `StorageGateway#getSignedUrl`、`ReportBatchExportTaskRepository#findReusableReadyZip`、`ParentStudentBenefitItemResponse.productCode`。

- [ ] **Step 3: Capture cold/warm metrics**

Run:

```bash
node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu \
  --warm-state cold-nolsp \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > /tmp/lsp-lishuedu-cold-nolsp-diagnostic.json

node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu \
  --warm-state warm-auto \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > /tmp/lsp-lishuedu-warm-auto-diagnostic.json

node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu \
  --warm-state warm-required \
  --strategy impact \
  --runs 5 \
  --verbosity diagnostic \
  > /tmp/lsp-lishuedu-warm-required-diagnostic.json
```

Expected:

- cold-nolsp: `R_read_must=1.0`，recall 约 `0.7756`。
- warm-auto: 如果仍为零增益，确认是 semantic gate 未触发，而不是 references 无召回。
- warm-required: 若 recall 上升但 `R_read_must<1.0`，进入 Task 1。

- [ ] **Step 4: Produce semantic-source gap classification table**

Run this one-off diagnostic script. It uses `scoreBreakdown.source` and `verifiedBy` to distinguish `semantic-seed` (`definition` / `implementation`) from `semanticVerify` (`reference` / `typeHierarchy`). Do not commit the script.

```bash
cat > /tmp/diagnose-lishuedu-semantic-gaps.mjs <<'NODE'
import { readFileSync } from "node:fs";
import path from "node:path";
import { AgentRouter } from "./dist/agent-router/index.js";
import { JdtlsSession } from "./dist/jdtls-session.js";
import { SourceIndex } from "./dist/source-index.js";

const repoRoot = "/Users/luo/Documents/program/lishu/lishuedu";
const scenarioFile = "golden/lishuedu.scenarios.jsonl";
const scenarios = readFileSync(scenarioFile, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line))
  .filter(item => [
    "StorageGateway#getSignedUrl",
    "ReportBatchExportTaskRepository#findReusableReadyZip",
    "ParentStudentBenefitItemResponse.productCode"
  ].some(name => item.name.includes(name)));

const session = new JdtlsSession(repoRoot);
await session.ensureStarted();
for (const scenario of scenarios) {
  await session.documentSymbolsWithRetry(path.resolve(repoRoot, scenario.anchor.file), 45000);
}
const router = new AgentRouter(repoRoot, session, new SourceIndex(repoRoot));

function classify(file) {
  if (!file) {
    return "absent";
  }
  const verifiedBy = file.verifiedBy || [];
  const sources = (file.scoreBreakdown || []).map(item => item.source);
  if (verifiedBy.some(item => item === "reference" || item === "typeHierarchy")) {
    return "verify";
  }
  if (verifiedBy.some(item => item === "semantic-definition" || item === "semantic-implementation") || sources.includes("semantic-seed")) {
    return "seed";
  }
  if (verifiedBy.includes("typeGraph")) {
    return "typeGraph";
  }
  if (sources.includes("rg")) {
    return "rg";
  }
  return verifiedBy.join("+") || sources.join("+") || "unknown";
}

for (const scenario of scenarios) {
  const result = await router.impact({
    anchors: [scenario.anchor],
    mode: "balanced",
    profile: scenario.anchor.profile,
    semanticPolicy: "required",
    semanticTimeoutMs: 1500,
    testReadMode: "defer",
    focusModules: scenario.anchor.focusModules || [],
    excludeModules: [],
    taskKeywords: scenario.anchor.taskKeywords || [],
    crossModulePolicy: "auto",
    verbosity: "diagnostic"
  });
  const fileByPath = new Map(result.files.map(file => [String(file.path), file]));
  const pathById = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  const readSet = new Set(result.readPlan.map(item => pathById.get(item.fileId)).filter(Boolean));
  const all = [
    ...(scenario.golden?.mustHit || []).map(file => [file, "must"]),
    ...(scenario.golden?.shouldHit || []).map(file => [file, "should"]),
    ...(scenario.golden?.side || []).map(file => [file, "side"])
  ];
  console.log(`\n${scenario.name}\tsemantic.used=${result.metrics.semantic.used}\tverify.used=${result.metrics.semantic.verifyUsed}`);
  console.log("kind\tinFiles\tinReadPlan\tsource\tpath");
  for (const [file, kind] of all) {
    const candidate = fileByPath.get(file);
    console.log(`${kind}\t${Boolean(candidate)}\t${readSet.has(file)}\t${classify(candidate)}\t${file}`);
  }
}
await session.stop();
NODE
node /tmp/diagnose-lishuedu-semantic-gaps.mjs > /tmp/lsp-lishuedu-semantic-gap-table.tsv
cat /tmp/lsp-lishuedu-semantic-gap-table.tsv
```

Expected: 每个 golden 文件都有 `kind / inFiles / inReadPlan / source / path`。人工把每个缺口归入：

| Class | Meaning | First fix |
|---|---|---|
| A-seed | warm-required 中 non-LSP 邻居被 `collectSemanticSeed()` 候选挤出 readPlan | Task 1 |
| A-verify | warm-required 中 non-LSP 邻居被 `semanticVerify()` 候选挤出 readPlan | Task 1 |
| B | implementer 不在 SourceIndex cache，`findImplementers()` 查不到 | Task 3 |
| C | 字段/方法签名类型边缺失 | Task 4 |
| D-warm | warm path verified semantic consumer 被 `crossModulePolicy` 或 candidate limit 压制 | Task 5 |
| D-cold | cold path rg consumer 被 `crossModulePolicy` 或 candidate limit 压制 | 单列后续，不在 Task 5 默认修 |
| S | SQL/test/config side evidence | 不作为 hard gate |

- [ ] **Step 5: Commit nothing**

Task 0 不改仓库文件，不提交。

## Task 1: Protect Non-LSP readPlan Slots

目标：让 `semanticPolicy=required` 可以补召回，但不能把 non-LSP 基线里已经应该读的 core neighbors 挤出 readPlan。

**Files:**
- Modify: `src/agent-router/index.ts`
- Test: `src/agent-router.test.ts`

Design:

- 调整 `impact()` 阶段顺序：anchor -> typeGraph -> rg -> non-LSP readPlan baseline -> `collectSemanticSeed()` -> `semanticVerify()` -> final rank/readPlan。
- `collectSemanticSeed()` 不能出现在 baseline 前；它在 `required` 下会引入 `definition/implementation` 高分候选。
- `finalizeRank()` 必须把 non-LSP readPlan paths 并入 L2 protected 集，避免它们在 `truncateCandidateTail()` 阶段已经被裁掉。
- `buildReadPlan()` 用 protected paths 保证入选，但最终输出仍按 `(priorityRank, score)` 统一排序，不能把 P1 protected 整块排在 P0 semantic candidate 前面。
- protected 数量受 `maxItems` 限制，不扩大 readPlan 默认容量。
- 只保护 non-LSP readPlan，不保护全部 non-LSP candidates，避免把 token 优化吃回去。

- [ ] **Step 1: Add failing test**

Append to `src/agent-router.test.ts` before `readPlanPaths()` helper:

```ts
test("required semantic candidates do not evict non-LSP read plan neighbors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-readplan-protect-"));
  await mkdir(path.join(root, "modules", "integration", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "modules", "report", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageGateway.java"), [
    "package demo;",
    "public interface StorageGateway {",
    "  StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command);",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlCommand.java"), "package demo; public record StorageSignedUrlCommand(String key) {}\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlResult.java"), "package demo; public record StorageSignedUrlResult(String url) {}\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "AliyunOssGateway.java"), "package demo; public class AliyunOssGateway implements StorageGateway { public StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command) { return null; } }\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StubStorageGateway.java"), "package demo; public class StubStorageGateway implements StorageGateway { public StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command) { return null; } }\n");
  const referenceItems = [];
  const implementationItems = [];
  for (let index = 0; index < 8; index += 1) {
    const caller = path.join(root, "modules", "report", "src", "main", "java", "demo", `ReportStorageCaller${index}.java`);
    await writeFile(caller, `package demo; public class ReportStorageCaller${index} { public void call() {} }\n`);
    const location = {
      uri: pathToFileURL(caller).toString(),
      range: { start: { line: 0, character: 27 }, end: { line: 0, character: 47 } }
    };
    referenceItems.push(location);
    implementationItems.push(location);
  }
  const session = new FakeSemanticSession(referenceItems, [], implementationItems);

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "modules/integration/src/main/java/demo/StorageGateway.java", line: 3, column: 28 }],
    profile: "port",
    semanticPolicy: "required",
    readPlanMaxItems: 6,
    focusModules: ["integration"],
    taskKeywords: ["storage", "signed", "url", "report"]
  }));
  const readPaths = readPlanPaths(result);

  assert.equal(session.referencesCalls, 1);
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageGateway.java"));
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageSignedUrlCommand.java"));
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageSignedUrlResult.java"));
  assert.ok(readPaths.some(file => file.endsWith("AliyunOssGateway.java") || file.endsWith("StubStorageGateway.java")));
  // Semantic callers may fill spare slots; this test only guards baseline eviction.
});
```

Update `FakeSemanticSession` in the same file to accept semantic seed implementation locations:

```ts
  constructor(
    private readonly referenceItems: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> = [],
    private readonly typeHierarchyEdges: Array<{ depth: number; from: unknown; to: unknown }> = [],
    private readonly implementationItems: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> = []
  ) {}

  async semanticLocations(): Promise<{ definitions: []; implementations: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> }> {
    return { definitions: [], implementations: this.implementationItems };
  }
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm run build && node --test --test-name-pattern="required semantic candidates do not evict non-LSP read plan neighbors" "dist/**/*.test.js"
```

Expected before implementation: FAIL because high-score semantic seed / reference candidates can evict baseline neighbors from readPlan. Occupying a spare readPlan slot is allowed.

- [ ] **Step 3: Move LSP semantic collection after non-LSP baseline**

In `src/agent-router/index.ts`, change the main `impact()` flow from:

```ts
await this.collectSemanticSeed(candidates, anchors, options, semantic, phaseMs);
this.collectTypeGraphCandidates(candidates, anchors, options);

const rgExecution = await this.collectNamingRecall(candidates, anchors, options, phaseMs);
await this.semanticVerify(candidates, anchors, options, semantic, phaseMs);
```

to:

```ts
this.collectTypeGraphCandidates(candidates, anchors, options);
const rgExecution = await this.collectNamingRecall(candidates, anchors, options, phaseMs);
const nonLspReadPlanPaths = this.nonLspReadPlanPaths(candidates, anchors[0], options);

await this.collectSemanticSeed(candidates, anchors, options, semantic, phaseMs);
await this.semanticVerify(candidates, anchors, options, semantic, phaseMs);
```

Add helper methods inside `AgentRouter`:

```ts
  private nonLspReadPlanPaths(
    candidates: Map<string, CandidateFile>,
    anchor: ResolvedAnchor,
    options: ImpactOptions
  ): Set<string> {
    const suppressed = { deferredTests: 0, crossModuleConsumers: 0, excludedModules: 0 };
    const ranked = this.finalizeRank(candidates, anchor, options, suppressed);
    const maxItems = options.readPlanMaxItems ?? defaultReadPlanMax(options.mode);
    return new Set(
      this.selectReadPlanFiles(ranked, options, maxItems)
        .map(file => file.absolutePath)
    );
  }

  private selectReadPlanFiles(files: CandidateFile[], options: ImpactOptions, maxItems: number): CandidateFile[] {
    return files
      .map(file => ({ file, priority: readPriority(file, options) }))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
      .slice(0, maxItems)
      .map(entry => entry.file);
  }
```

Change final rank and build calls:

```ts
const ranked = this.finalizeRank(candidates, anchors[0], options, suppressed, nonLspReadPlanPaths);
const readPlan = this.buildReadPlan(ranked, idByPath, options, nonLspReadPlanPaths);
```

- [ ] **Step 4: Protect non-LSP paths during L2 truncation**

Change `finalizeRank()` signature:

```ts
  private finalizeRank(
    candidates: Map<string, CandidateFile>,
    anchor: ResolvedAnchor,
    options: ImpactOptions,
    suppressed: Record<string, number>,
    extraProtectedPaths = new Set<string>()
  ): CandidateFile[] {
```

After `readPlanCovered` is built, merge matching extra paths:

```ts
    for (const file of ranked) {
      if (extraProtectedPaths.has(file.absolutePath)) {
        readPlanCovered.add(file);
      }
    }
```

Keep the return line unchanged:

```ts
    return truncateCandidateTail(ranked, readPlanCovered, candidateLimit(options.mode, anchor.profile));
```

- [ ] **Step 5: Implement protected-aware readPlan selection**

Change `buildReadPlan()` signature and body:

```ts
  private buildReadPlan(
    files: CandidateFile[],
    ids: Map<string, string>,
    options: ImpactOptions,
    protectedPaths = new Set<string>()
  ): ReadPlanItem[] {
    const maxItems = options.readPlanMaxItems ?? defaultReadPlanMax(options.mode);
    return this.selectReadPlanFiles(files, options, maxItems, protectedPaths)
      .map(file => {
        const priority = readPriority(file, options);
        const planWindow = this.readWindow(file, priority);
        return {
          priority,
          fileId: ids.get(file.absolutePath) || "F?",
          startLine: planWindow.startLine,
          endLine: planWindow.endLine,
          reason: readReason(file, priority)
        };
      });
  }
```

Change `selectReadPlanFiles()` to guarantee protected files first for selection, then sort final selected files by normal readPlan order:

```ts
  private selectReadPlanFiles(
    files: CandidateFile[],
    options: ImpactOptions,
    maxItems: number,
    protectedPaths = new Set<string>()
  ): CandidateFile[] {
    const sorted = files
      .map(file => ({ file, priority: readPriority(file, options) }))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
      .map(entry => entry.file);
    const selected: CandidateFile[] = [];
    const selectedPaths = new Set<string>();
    for (const file of sorted) {
      if (selected.length >= maxItems) {
        break;
      }
      if (protectedPaths.has(file.absolutePath)) {
        selected.push(file);
        selectedPaths.add(file.absolutePath);
      }
    }
    for (const file of sorted) {
      if (selected.length >= maxItems) {
        break;
      }
      if (!selectedPaths.has(file.absolutePath)) {
        selected.push(file);
        selectedPaths.add(file.absolutePath);
      }
    }
    return selected
      .map(file => ({ file, priority: readPriority(file, options) }))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
      .map(entry => entry.file);
  }
```

This intentionally does not change `candidateLimit()` or `truncateCandidateTail()`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run build && node --test --test-name-pattern="required semantic candidates|semantic verify|port recall" "dist/**/*.test.js"
```

Expected: all selected tests PASS.

- [ ] **Step 7: Run full tests**

Run:

```bash
npm test
```

Expected: full suite PASS, skipped count unchanged unless local `LISHUEDU_ROOT` enables real-repo tests.

- [ ] **Step 8: Commit**

```bash
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "fix(router): protect readPlan baseline from semantic overflow"
```

## Task 2: Warm-required Acceptance Benchmark

目标：证明 Task 1 把 warm-required 从“recall 有效但不可采纳”变成“recall 上升且 `R_read_must=1.0`”。

**Files:**
- Modify: `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`

- [ ] **Step 1: Run lishuedu cold and warm-required**

Run:

```bash
npm run build

node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu \
  --warm-state cold-nolsp \
  --strategy impact \
  --runs 5 \
  > /tmp/lsp-lishuedu-after-readplan-cold.json

node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu \
  --warm-state warm-required \
  --strategy impact \
  --runs 5 \
  > /tmp/lsp-lishuedu-after-readplan-warm-required.json
```

Expected:

- cold `R_read_must=1.0`，recall 不低于 `0.7756`。
- warm-required `R_read_must=1.0`。
- warm-required recall 高于 cold baseline。
- cold `elapsedMs` 不应较 Batch 3 baseline 明显回升；若 P50/P95 上升，记录是双 finalize 的本地成本还是 JDT LS 状态波动。

- [ ] **Step 2: Run three-project cold regression**

Run:

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/lsp-lishuedu-readplan-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/lsp-cipherlink-readplan-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/lsp-exam-readplan-cold.json
```

Expected: all three projects `R_read_must=1.0`; lishuedu precision not below `0.4127`.

- [ ] **Step 3: Append benchmark note**

Generate the markdown rows from benchmark JSON:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

const inputs = [
  ["lishuedu", "cold-nolsp", "/tmp/lsp-lishuedu-after-readplan-cold.json"],
  ["lishuedu", "warm-required", "/tmp/lsp-lishuedu-after-readplan-warm-required.json"]
];

console.log("### readPlan semantic overflow 修复验证（2026-06-26）\n");
console.log("本轮验证目标：确认 `semanticPolicy=required` 引入 semanticLocations/references/typeHierarchy 候选后，不再挤出 non-LSP readPlan 邻居。\n");
console.log("| project | warmState | recall | precision | P_read | R_read_must | elapsedMs | total payload | estimatedTokens |");
console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|");
for (const [project, warmState, file] of inputs) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const t = data.totals;
  console.log(`| ${project} | ${warmState} | ${t.recall.toFixed(4)} | ${t.precision.toFixed(4)} | ${t.pRead.toFixed(4)} | ${t.rReadMust.toFixed(4)} | ${t.elapsedMs.toFixed(2)} ms | ${t.totalAgentVisiblePayload.toFixed(2)} B | ${t.estimatedTokens.toFixed(0)} |`);
}
console.log("\n结论：根据上表写一句接受或拒绝 warm-required 作为 precision/recall mode 可选增强的判断，并写清原因。");
NODE
```

Append that generated block to `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`.

Before commit, replace the generated final conclusion sentence with the actual decision from the measured numbers.

- [ ] **Step 4: Commit**

```bash
git add docs/java-lsp-mcp-benchmark-guide-2026-06-23.md
git commit -m "test(router): verify semantic readPlan overflow fix"
```

## Task 3: Conditional Full Implementer Index

Run this task only if Task 0 shows class B gaps are still material after Task 1.

目标：`findImplementers()` 不再只依赖“已经访问过的 SourceIndex cache”。第一版只解决 `implements/extends`，不解析 arbitrary call graph。

**Files:**
- Modify: `src/source-index.ts`
- Test: `src/source-index.test.ts`
- Modify: `src/agent-router/index.ts` only if call site needs explicit root warming.

- [ ] **Step 1: Add failing SourceIndex test**

Append to `src/source-index.test.ts`:

```ts
test("SourceIndex can scan repo sources before finding implementers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-index-implementers-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "PaymentGateway.java"), "package demo; public interface PaymentGateway { void pay(); }\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "StripeGateway.java"), "package demo; public class StripeGateway implements PaymentGateway { public void pay() {} }\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "OtherService.java"), "package demo; public class OtherService {}\n");

  const index = new SourceIndex(root);
  index.factsFor(path.join(root, "src", "main", "java", "demo", "PaymentGateway.java"));
  await index.indexRepoJavaSources();

  assert.deepEqual(index.findImplementers("PaymentGateway").map(item => item.typeName), ["StripeGateway"]);
});
```

- [ ] **Step 2: Implement minimal repo scan**

In `src/source-index.ts`, import async fs helpers:

```ts
import { readdir } from "node:fs/promises";
```

Add public method:

```ts
  async indexRepoJavaSources(maxFiles = 5000): Promise<number> {
    let indexed = 0;
    for (const file of await listJavaFiles(this.repoRoot, maxFiles)) {
      this.factsFor(file);
      indexed += 1;
    }
    return indexed;
  }
```

Add helpers near the bottom:

```ts
async function listJavaFiles(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles || ignoredDir(path.basename(dir))) {
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(".java")) {
        files.push(fullPath);
        if (files.length >= maxFiles) {
          return;
        }
      }
    }
  };
  await visit(root);
  return files;
}

async function safeReadDir(dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function ignoredDir(name: string): boolean {
  return new Set([".git", ".gradle", "build", "target", "node_modules", "dist", "out", "bin"]).has(name);
}
```

- [ ] **Step 3: Use it narrowly in router**

In `collectTypeGraphCandidates()`, do not scan for every request. Add a private boolean field:

```ts
private typeGraphRepoIndexed = false;
```

Make `collectTypeGraphCandidates()` async and index once only when type graph is relevant:

```ts
  private async collectTypeGraphCandidates(candidates: Map<string, CandidateFile>, anchors: ResolvedAnchor[], options: ImpactOptions): Promise<void> {
    if (!this.typeGraphRepoIndexed && anchors.some(shouldUseTypeGraph)) {
      await this.sourceIndex.indexRepoJavaSources();
      this.typeGraphRepoIndexed = true;
    }
    for (const anchor of anchors) {
      if (!shouldUseTypeGraph(anchor)) {
        continue;
      }
      const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
      for (const facts of this.sourceIndex.findImplementers(typeName).slice(0, 20)) {
        const candidate = candidateFromFacts(facts, scoreBase("semantic", facts, anchor, options) + 70, "typeGraph");
        mergeCandidate(candidates, candidate);
      }
    }
  }
```

Update call site:

```ts
await this.collectTypeGraphCandidates(candidates, anchors, options);
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run build && node --test --test-name-pattern="SourceIndex can scan repo sources|cached type graph|port recall" "dist/**/*.test.js"
npm test
```

Expected: PASS.

- [ ] **Step 5: Benchmark cold latency before accepting**

Run lishuedu cold benchmark:

```bash
node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu \
  --warm-state cold-nolsp \
  --strategy impact \
  --runs 5 \
  > /tmp/lsp-lishuedu-implementer-index.json
```

Accept only if all are true:

- `elapsedMs` and raw payload remain acceptable and `R_read_must=1.0`.
- The benchmark process reuses one `AgentRouter` across runs; otherwise each run may rescan and inflate P50. Current `benchmark-agent-impact.ts` creates `router` once before the run loop, but re-check this if the runner changes.
- `indexRepoJavaSources()` reports enough indexed files for the repo size. If `maxFiles` is hit, do not trust recall results until the cap is raised or source roots are narrowed.

If scanning causes unacceptable cold latency, revert Task 3 and keep it as a non-default warmup command in a later plan.

- [ ] **Step 6: Commit**

```bash
git add src/source-index.ts src/source-index.test.ts src/agent-router/index.ts
git commit -m "feat(source-index): scan implementers for cold type graph"
```

## Task 4: Conditional Signature Type Reference Facts

Run this task only if Task 0 shows class C gaps are still material after Tasks 1 and 3.

目标：补高信噪比字段/方法签名类型边，例如 DTO/view/command/result/DO/assembler 这种 Java 签名上明确出现的关系。不解析方法体调用。

**Files:**
- Modify: `src/source-index.ts`
- Test: `src/source-index.test.ts`
- Modify: `src/agent-router/index.ts`

- [ ] **Step 1: Extend facts type**

In `JavaSourceFacts`, add:

```ts
  referencedTypes: string[];
```

Construction/default requirements:

- `parseJavaSource()` must set `referencedTypes`.
- `upsertDocumentSymbols()` spreads `baseFacts`; keep that spread so `referencedTypes` is preserved.
- `loadSnapshot()` must default old snapshot records with `referencedTypes: facts.referencedTypes || []`.
- `findTypeReferences()` must also guard old in-memory data with `(facts.referencedTypes || [])`.
- Do not edit `persist()` only for serialization; it already spreads `fileFacts` into `FileRecord`.

Patch `loadSnapshot()` with the old-snapshot default:

```ts
facts: {
  ...facts,
  referencedTypes: facts.referencedTypes || [],
  methods: symbolsByFile.get(file.absolutePath) || []
}
```

- [ ] **Step 2: Add failing parser test**

Append to `src/source-index.test.ts`:

```ts
test("parseJavaSource extracts field and method signature referenced types", () => {
  const facts = parseJavaSource("/repo", "/repo/src/main/java/demo/ReportService.java", [
    "package demo;",
    "import demo.dto.ReportView;",
    "@Service",
    "public class ReportService {",
    "  private ReportRepository reportRepository;",
    "  public StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command, ReportView view) {",
    "    if (command != null) {",
    "      BodyOnlyBuilder builder = new BodyOnlyBuilder();",
    "      return null;",
    "    }",
    "    return null;",
    "  }",
    "}",
    ""
  ].join("\n"));

  assert.deepEqual(facts.referencedTypes.sort(), [
    "ReportRepository",
    "ReportView",
    "StorageSignedUrlCommand",
    "StorageSignedUrlResult"
  ]);
  assert.equal(facts.referencedTypes.includes("Service"), false);
  assert.equal(facts.referencedTypes.includes("BodyOnlyBuilder"), false);
});
```

- [ ] **Step 3: Implement narrow extraction**

In `parseJavaSource()`, compute:

```ts
const referencedTypes = parseSignatureReferencedTypes(content, typeMatch?.[2]);
```

Return it:

```ts
referencedTypes,
```

Add helper:

```ts
function parseSignatureReferencedTypes(content: string, ownType?: string): string[] {
  const signatures = classBodyTopLevelSignatures(content);
  const typeNames = new Set<string>();
  const typePattern = /\b([A-Z][A-Za-z0-9_]*(?:<[^;=(){}]*>)?)\b/g;
  for (const match of signatures.join("\n").matchAll(typePattern)) {
    const simple = match[1].replace(/<.*$/, "");
    if (!ownType || simple !== ownType) {
      typeNames.add(simple);
    }
  }
  for (const builtin of ["String", "Long", "Integer", "Boolean", "Double", "Float", "List", "Map", "Set", "Optional", "LocalDate", "LocalDateTime", "BigDecimal"]) {
    typeNames.delete(builtin);
  }
  return [...typeNames].sort();
}

function classBodyTopLevelSignatures(content: string): string[] {
  const signatures: string[] = [];
  let depth = 0;
  let current = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripLineComment(rawLine).trim();
    const beforeDepth = depth;
    if (beforeDepth === 1 && line && !line.startsWith("@")) {
      const signatureLine = line.includes("{") ? line.slice(0, line.indexOf("{") + 1) : line;
      const declarationOnly = signatureLine.includes("=") ? signatureLine.slice(0, signatureLine.indexOf("=")) : signatureLine;
      current = `${current} ${declarationOnly.replace(/@[A-Za-z0-9_.]+(?:\([^)]*\))?/g, "")}`.trim();
      if (line.includes(";") || line.includes("{")) {
        signatures.push(current);
        current = "";
      }
    }
    for (const char of line) {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
    if (beforeDepth <= 1 && depth < 1) {
      current = "";
    }
  }
  return signatures;
}
```

This helper is deliberately shallow. It reads only top-level class body declarations, truncates field initializer RHS at `=`, and stops at the opening `{` of a method, so nested method-body tokens do not enter `referencedTypes`.

Known noise boundary: `stripLineComment()` only strips `//`; block comments and Javadocs are not removed in the first version. If Task 4 benchmark shows raw payload rebound or unexpected type-reference candidates, add a comment stripper before broadening graph logic. Enum constants are acceptable first-version noise because the router only consumes `dto/port/repository`-style type-reference candidates.

- [ ] **Step 4: Add reverse lookup**

Add to `SourceIndex`:

```ts
  findTypeReferences(typeName: string): JavaSourceFacts[] {
    const simpleName = typeName.slice(typeName.lastIndexOf(".") + 1);
    return [...this.cache.values()]
      .map(entry => entry.facts)
      .filter(facts => facts.typeName !== simpleName && (facts.referencedTypes || []).some(type => sameSimpleType(type, simpleName)))
      .sort((left, right) => (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  }
```

- [ ] **Step 5: Consume in router for dto/port/repository only**

In `AgentRouter`, add after implementer graph candidates:

```ts
  private collectTypeReferenceCandidates(candidates: Map<string, CandidateFile>, anchors: ResolvedAnchor[], options: ImpactOptions): void {
    for (const anchor of anchors) {
      if (!new Set(["dto", "port", "repository"]).has(anchor.profile)) {
        continue;
      }
      const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
      for (const facts of this.sourceIndex.findTypeReferences(typeName).slice(0, 20)) {
        const candidate = candidateFromFacts(facts, scoreBase("semantic", facts, anchor, options) + 45, "typeReference");
        mergeCandidate(candidates, candidate);
      }
    }
  }
```

Call it immediately after `collectTypeGraphCandidates()`, before `collectNamingRecall()` and `nonLspReadPlanPaths()`, so type-reference neighbors participate in the non-LSP baseline protected set.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
npm run build && node --test --test-name-pattern="referenced types|typeReference|port recall|dto" "dist/**/*.test.js"
npm test
```

Expected: PASS.

- [ ] **Step 7: Benchmark**

Run lishuedu and three-project cold benchmark. Accept only if:

- lishuedu recall increases or readPlan quality improves for diagnosed class C gaps.
- `R_read_must=1.0` remains.
- raw payload does not rebound more than `5%`.

- [ ] **Step 8: Commit**

```bash
git add src/source-index.ts src/source-index.test.ts src/agent-router/index.ts src/agent-router.test.ts
git commit -m "feat(source-index): add signature type reference routing"
```

## Task 5: Warm Cross-module Strategy Experiment

Run this task only if Task 0 shows class D gaps dominate and Tasks 1/3/4 do not fix them.

目标：不要用图解决策略压制。第一版只处理 warm path 的 `D-warm`：对 high-confidence semantic references / typeHierarchy consumers 免除 cross-module penalty。cold path 的 `D-cold` 不在本 Task 修复；如果必须修，需要单列计划评估 token 反弹。

**Files:**
- Modify: `src/agent-router/index.ts`
- Test: `src/agent-router.test.ts`

- [ ] **Step 1: Add failing test**

Append to `src/agent-router.test.ts` before `readPlanPaths()` helper:

```ts
test("verified semantic references skip cross-module penalty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-cross-module-reference-"));
  await mkdir(path.join(root, "modules", "integration", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "modules", "report", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageGateway.java"), [
    "package demo;",
    "public interface StorageGateway {",
    "  StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command);",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlCommand.java"), "package demo; public record StorageSignedUrlCommand(String key) {}\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlResult.java"), "package demo; public record StorageSignedUrlResult(String url) {}\n");
  const consumer = path.join(root, "modules", "report", "src", "main", "java", "demo", "ReportStorageService.java");
  await writeFile(consumer, "package demo; public class ReportStorageService { public void createSignedUrl() {} }\n");
  const session = new FakeSemanticSession([{
    uri: pathToFileURL(consumer).toString(),
    range: { start: { line: 0, character: 27 }, end: { line: 0, character: 47 } }
  }]);

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "modules/integration/src/main/java/demo/StorageGateway.java", line: 3, column: 28 }],
    profile: "port",
    semanticPolicy: "required",
    focusModules: ["integration"],
    crossModulePolicy: "focused",
    verbosity: "diagnostic"
  }));

  const consumerFile = result.files.find(file => String(file.path).endsWith("ReportStorageService.java")) as Record<string, unknown> | undefined;
  assert.ok(consumerFile, "verified semantic reference should be returned");
  const breakdown = new Map(((consumerFile.scoreBreakdown as Array<{ id: string; delta: number }>) || []).map(item => [item.id, item.delta]));
  assert.equal(breakdown.has("finalize.cross-module"), false);
});
```

Expected before implementation: FAIL because `finalize.cross-module` applies a negative delta to the verified reference.

- [ ] **Step 2: Implement narrow penalty exemption**

In `finalizeScore()`, change the cross-module penalty branch to skip high-confidence references:

```ts
const verifiedReference = candidate.verifiedBy?.includes("reference") || candidate.verifiedBy?.includes("typeHierarchy");
if (candidate.module && candidate.module !== anchor.module && options.crossModulePolicy !== "all") {
  if (!verifiedReference && !options.focusModules.includes(candidate.module) && !(candidate.path && matchesAny(candidate.path, options.taskKeywords))) {
    score += addScoreDelta(scoreBreakdown, "finalize.cross-module", options.crossModulePolicy === "focused" ? -80 : -20, "cross module policy");
    suppressed.crossModuleConsumers += 1;
  }
}
```

- [ ] **Step 3: Run tests and benchmark**

Run:

```bash
npm run build && npm test
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 > /tmp/lsp-lishuedu-cross-module-warm-required.json
```

Accept only if warm-required recall improves and `R_read_must=1.0`.

- [ ] **Step 4: Commit**

```bash
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "feat(router): exempt verified semantic consumers from cross-module penalty"
```

## Task 6: Final Report and Install

目标：给后续步骤留下完整上下文，避免下一轮重新误读 warm-auto / warm-required。

**Files:**
- Modify: `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`
- Optional create: `docs/java-lsp-mcp-readplan-semantic-gap-report-2026-06-26.md`

- [ ] **Step 1: Run required validation**

Run:

```bash
npm run build && npm test
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/final-lishuedu-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 > /tmp/final-lishuedu-warm-required.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/final-cipherlink-cold.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/final-exam-cold.json
```

- [ ] **Step 2: Write final report**

Report must include:

- What changed.
- Which review claims were accepted.
- Which review claims were corrected.
- Exact commands run.
- Metrics table: cold lishuedu/cipherlink/exam and warm-required lishuedu.
- Gap classification before/after.
- Known limits: no method-call graph, no default warm-auto widening unless explicitly implemented, side SQL/test not hard gate.

- [ ] **Step 3: Install runtime only after validation**

Run:

```bash
./install-runtime.sh
./check-codex-mcp.sh --fast
```

Expected: install succeeds and fast check reports no errors.

- [ ] **Step 4: Commit report and installation-relevant files**

```bash
git add docs/java-lsp-mcp-benchmark-guide-2026-06-23.md docs/java-lsp-mcp-readplan-semantic-gap-report-2026-06-26.md
git commit -m "docs(router): report semantic readPlan optimization results"
```

## Rollback Plan

- Task 1 rollback: revert `buildReadPlan()` protected path changes and the new test.
- Task 3 rollback: remove `indexRepoJavaSources()` and restore cached-only `findImplementers()` behavior.
- Task 4 rollback: remove `referencedTypes`, `findTypeReferences()`, and `typeReference` router candidates.
- Task 5 rollback: restore cross-module penalty to current behavior.

Rollback command shape:

```bash
git log --oneline -5
git revert $(git log --format=%H -1)
npm run build && npm test
```

## Execution Recommendation

Execute only Tasks 0-2 first. Stop after Task 2 and review metrics.

If warm-required becomes `recall↑ + R_read_must=1.0`, do not build Tasks 3-5 unless cold path still needs recall without LSP latency. That is the cheapest path that works.
