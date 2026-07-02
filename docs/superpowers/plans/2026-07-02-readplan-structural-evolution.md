# readPlan Structural Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 import 边召回（Phase 1）、证据类配额 readPlan（Phase 2）、持久语义边表（Phase 3）和 routing policy 去 lishuedu 化（卫生项），结构性地解决 `shouldBlocksTask absent` 与 `readplan-full` 两类缺口，同时保持三仓 `R_read_must=1.0000` 硬门槛。

**Architecture:** 三个阶段各自独立可交付：Phase 1 给 `SourceIndex` 增加 import 事实与反向索引，router 新增 `importGraph` 召回 phase；Phase 2 把 readPlan 的"(priority, score) 排序取 N"替换为按证据类（anchor/verified/structural/naming/support）配额的选择器，使 must 保护由构造保证；Phase 3 新增 `EdgeStore` 把 warm LSP verify 的结果持久化为边，cold 查询直接消费，LSP 成本移出交互路径。卫生项把 `legacyRoutingPolicy` 中 lishuedu 专有规则拆出，按 repo 选择 policy。

**Tech Stack:** TypeScript (ESM, Node 20+)、node:test、rg、JDT LS（仅 Phase 3 写回路径涉及，测试用现有 `FakeSemanticSession` stub）。

---

## 背景与硬约束（执行者必读）

当前瓶颈由以下实测报告确立，实现中任何取舍冲突时以这些结论为准：

- `docs/java-lsp-mcp-readplan-full-capacity-report-2026-07-02.md`：扩容 readPlan slot 与 P1 内重排均被实测否决；默认 `readPlanMaxItems=6` 不可改；benchmark-only `--read-plan-max-items` 是唯一容量实验入口。
- `docs/java-lsp-mcp-readplan-platform-proof-2026-07-01.md`：exam-parent-v3 有 material `shouldBlocksTask absent`；warm-required P95 超 800ms SLO，不得默认化。
- `docs/java-lsp-mcp-readplan-next-stage-decision-2026-06-26.md`：一切召回扩张必须由 attribution 证据触发；不做全局字符串权重调整。

**硬门槛（每个 gate 任务必须复核）：**

1. 三仓 cold `R_read_must = 1.0000`，任何回退立即停止并回滚该任务。
2. MCP public tools 的入参/出参 schema 不变。
3. 默认 `readPlanMaxItems=6` 不变；`defaultReadPlanMax` 函数不改。
4. 不引入 warm 调度、profile-aware warm 默认化、timeout-degrade。

**真实仓库路径（gate 任务用）：**

- lishuedu: `/Users/luo/Documents/program/lishu/lishuedu`
- cipherlink: `/Users/luo/Documents/program/cipherlink`
- exam-parent-v3: `/Users/luo/Documents/program/exam-parent-v3`

**通用命令：**

```bash
npm run build   # tsc, 必须退出 0
npm test        # node:test, 基线为 77 tests / 73 pass / 0 fail / 4 skipped（本计划会新增测试，pass 数随任务递增）
```

带 `{ skip: !hasLishueduFixture }` 的测试在本机默认跳过，不影响判定。

## 文件结构总览

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/source-index.ts` | 修改 | Phase 1: import 解析、`importedTypeIndex`、`findImporters`；Phase 3: 导出 `readJsonLines` |
| `src/source-index.test.ts` | 修改 | Phase 1 新增测试 |
| `src/agent-router/index.ts` | 修改 | Phase 1: `importGraph` phase；Phase 2: 接入配额选择器；Phase 3: `EdgeStore` 注入、写回、persisted 召回；卫生项: policy 线程化 |
| `src/agent-router/read-plan-budget.ts` | 新建 | Phase 2: 证据分类 + 配额选择器（纯函数） |
| `src/read-plan-budget.test.ts` | 新建 | Phase 2 单元测试 |
| `src/agent-router.test.ts` | 修改 | Phase 1/2/3 集成测试 |
| `src/edge-store.ts` | 新建 | Phase 3: 持久语义边表 |
| `src/edge-store.test.ts` | 新建 | Phase 3 单元测试 |
| `src/benchmark-agent-impact.ts` | 修改 | Phase 1: `importGraph` timing 透传与 source 归因 |
| `src/benchmark-agent-impact.test.ts` | 修改 | Phase 1: timing 透传断言 |
| `src/routing-policy.ts` | 修改 | 卫生项: 规则拆分 + `resolveRoutingPolicy` |
| `src/routing-policy.test.ts` | 修改 | 卫生项测试 |
| `src/ranking-signals.test.ts` | 修改 | Phase 1: facts 字面量补 `imports: []`（编译修复） |

任务顺序：Task 1→11 严格串行。Task 4/7/10/11 是真实仓库 gate，不通过则不得进入下一 Phase。

---

## Phase 1: import 边召回（Task 1–4）

### Task 1: SourceIndex 解析 import 声明

**Files:**
- Modify: `src/source-index.ts`（`JavaSourceFacts` 类型、`parseJavaSource`、`loadSnapshot`）
- Modify: `src/source-index.test.ts`
- Modify: `src/ranking-signals.test.ts`（facts 字面量编译修复）

**背景**：`parseJavaSource` 目前只提取签名级 `referencedTypes`（depth==1 的字段/方法签名），方法体局部变量使用的类型不可见。import 声明是文件级编译期依赖，覆盖方法体 builder 局部变量等场景（exam-parent-v3 `CebPayServiceImpl` 类缺口）。

- [ ] **Step 1: 写失败测试（parse import）**

在 `src/source-index.test.ts` 的 `parseJavaSource extracts signature referenced types` 测试之后新增：

```ts
test("parseJavaSource extracts import declarations as dependency facts", () => {
  const facts = parseJavaSource(repoRoot, path.join(repoRoot, "modules/sample/src/main/java/demo/ApplyInfoServiceImpl.java"), `
package demo;

import com.demo.dto.ApplyInfoUpdateDTO;
import static com.demo.util.Checks.requireNonBlank;
import java.util.List;
import com.demo.legacy.*;

public class ApplyInfoServiceImpl {
  public void save() {
    ApplyInfoUpdateDTO dto = null;
  }
}
`);
  assert.deepEqual(facts.imports, [
    "com.demo.dto.ApplyInfoUpdateDTO",
    "com.demo.util.Checks",
    "java.util.List"
  ]);
});
```

断言点：static import 归一为类型 FQN（去掉成员名）；通配符 import 被忽略；结果去重排序。

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test dist/source-index.test.js 2>&1 | tail -20`

Expected: 编译失败（`imports` 不在 `JavaSourceFacts` 上）或断言失败。注意本项目测试跑的是 `dist/` 编译产物，改代码后必须先 `npm run build`。

- [ ] **Step 3: 实现**

`src/source-index.ts` 三处改动。

(a) `JavaSourceFacts` 增加字段（放在 `referencedTypes` 之后）：

```ts
  referencedTypes: string[];
  imports: string[];
```

(b) `parseJavaSource` 中，在 `const referencedTypes = ...` 之后加：

```ts
  const imports = parseImports(lines);
```

并在返回对象里 `referencedTypes,` 之后加 `imports,`。文件底部（`parseSignatureReferencedTypes` 附近）新增：

```ts
function parseImports(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^\s*import\s+(static\s+)?([A-Za-z0-9_.]+)\s*;/);
    if (!match) {
      continue;
    }
    const fqn = match[1] ? match[2].slice(0, match[2].lastIndexOf(".")) : match[2];
    if (fqn.includes(".")) {
      found.add(fqn);
    }
  }
  return [...found].sort();
}
```

说明：`import com.foo.*;` 因正则不匹配 `*;` 自然跳过；static import 去掉最后一段成员名得到类型 FQN；单段 import（无包名）丢弃。

(c) `loadSnapshot` 中旧 snapshot 兼容判断（现有 `referencedTypes` 检查处）扩展为：

```ts
        if (!Array.isArray((record as { referencedTypes?: unknown }).referencedTypes)
          || !Array.isArray((record as { imports?: unknown }).imports)) {
          continue;
        }
```

- [ ] **Step 4: 修复编译报错的 facts 字面量**

`npm run build` 会在 `src/ranking-signals.test.ts` 的 `facts()` helper 报缺字段。在其默认对象（现有 `implementsTypes: [], referencedTypes: [],` 处）加一行 `imports: [],`。如编译器再报其他字面量位置，同样补 `imports: []`，不做其他改动。

- [ ] **Step 5: 写失败测试（旧 snapshot 跳过）**

在 `src/source-index.test.ts` 的 `SourceIndex skips legacy snapshots without referenced types` 之后新增（结构照抄该测试，仅 record 内容不同——含 `referencedTypes` 但缺 `imports`）：

```ts
test("SourceIndex skips legacy snapshots without imports", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-legacy-imports-"));
  const file = path.join(root, "src/main/java/demo/Legacy.java");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    "package demo;",
    "import demo.dto.LegacyDTO;",
    "public class Legacy {",
    "}",
    ""
  ].join("\n"));

  const cacheDir = repoCacheRoot(root);
  await mkdir(cacheDir, { recursive: true });
  const stat = statSync(file);
  writeFileSync(path.join(cacheDir, "source-index.files.jsonl"), `${JSON.stringify({
    absolutePath: file,
    path: "src/main/java/demo/Legacy.java",
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    packageName: "demo",
    typeName: "Legacy",
    kind: "class",
    implementsTypes: [],
    referencedTypes: [],
    annotations: [],
    factSource: "regex",
    batchId: "legacy"
  })}\n`);
  writeFileSync(path.join(cacheDir, "source-index.symbols.jsonl"), "");

  const index = new SourceIndex(root);
  assert.equal(index.status().entries, 0);
  assert.deepEqual(index.factsFor(file).imports, ["demo.dto.LegacyDTO"]);
});
```

- [ ] **Step 6: 运行全部测试确认通过**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail，新增 2 个 pass。

- [ ] **Step 7: Commit**

```bash
git add src/source-index.ts src/source-index.test.ts src/ranking-signals.test.ts
git commit -m "feat(source-index): parse import declarations as dependency facts"
```

### Task 2: importedTypeIndex 与 findImporters

**Files:**
- Modify: `src/source-index.ts`（`SourceIndex` 类）
- Modify: `src/source-index.test.ts`

**背景**：与现有 `referencedTypeIndex`/`findTypeReferences` 完全同构：已加载 facts 走内存索引 O(1)，未加载走 `rg -l` fallback（复用 `cachedAndScannedFacts` 与 TTL scan cache）。

- [ ] **Step 1: 写失败测试（索引命中）**

在 `src/source-index.test.ts` 的 `SourceIndex answers loaded type lookups without rg scans` 之后新增：

```ts
test("SourceIndex finds importers via the imported type index", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-importers-"));
  const dto = path.join(root, "src/main/java/demo/dto/ApplyInfoUpdateDTO.java");
  const importer = path.join(root, "src/main/java/demo/application/ApplyInfoServiceImpl.java");
  const unrelated = path.join(root, "src/main/java/demo/Other.java");
  await mkdir(path.dirname(dto), { recursive: true });
  await mkdir(path.dirname(importer), { recursive: true });
  await writeFile(dto, "package demo.dto;\npublic class ApplyInfoUpdateDTO {}\n");
  await writeFile(importer, [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "  public void save() { ApplyInfoUpdateDTO dto = null; }",
    "}",
    ""
  ].join("\n"));
  await writeFile(unrelated, "package demo;\npublic class Other {}\n");

  const index = new SourceIndex(root);
  index.factsFor(dto);
  index.factsFor(importer);
  index.factsFor(unrelated);

  assert.deepEqual(index.findImporters("ApplyInfoUpdateDTO").map(item => item.typeName), ["ApplyInfoServiceImpl"]);
  const status = index.status();
  assert.equal(status.typeLookupIndexHits, 1);
  assert.equal(status.scanCacheMisses, 0);
});

test("SourceIndex falls back to rg scan for importers not yet cached", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-source-importers-scan-"));
  const importer = path.join(root, "src/main/java/demo/application/ApplyInfoServiceImpl.java");
  await mkdir(path.dirname(importer), { recursive: true });
  await writeFile(importer, [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "}",
    ""
  ].join("\n"));

  const index = new SourceIndex(root);
  assert.deepEqual(index.findImporters("ApplyInfoUpdateDTO").map(item => item.typeName), ["ApplyInfoServiceImpl"]);
  assert.equal(index.status().typeLookupIndexMisses, 1);
  assert.equal(index.status().scanCacheMisses, 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build 2>&1 | tail -5`

Expected: 编译失败（`findImporters` 不存在）。

- [ ] **Step 3: 实现**

`src/source-index.ts` 四处改动。

(a) 类字段（`referencedTypeIndex` 声明处之后）：

```ts
  private readonly importedTypeIndex = new Map<string, Set<string>>();
```

(b) `findImporters` 方法（放在 `findTypeReferences` 之后）：

```ts
  findImporters(typeName: string): JavaSourceFacts[] {
    const simpleName = typeName.slice(typeName.lastIndexOf(".") + 1);
    const indexed = this.importedTypeIndex.get(simpleName);
    if (indexed && indexed.size > 0) {
      this.typeLookupIndexHits += 1;
      return this.factsForIndexedPaths(indexed)
        .filter(facts => facts.typeName !== simpleName)
        .sort(compareFactsByPath);
    }
    this.typeLookupIndexMisses += 1;
    return this.cachedAndScannedFacts(String.raw`^\s*import\s+(static\s+)?[A-Za-z0-9_.]+\.${escapeRegex(simpleName)}\s*;`)
      .filter(facts => facts.typeName !== simpleName && facts.imports.some(type => sameSimpleType(type, simpleName)))
      .sort(compareFactsByPath);
  }
```

(c) `indexFacts` / `unindexFacts` 末尾各加一段（与 `referencedTypes` 循环同形）：

```ts
    for (const type of facts.imports) {
      addIndexPath(this.importedTypeIndex, simpleTypeName(type), facts.absolutePath);
    }
```

```ts
    for (const type of facts.imports) {
      removeIndexPath(this.importedTypeIndex, simpleTypeName(type), facts.absolutePath);
    }
```

(d) `rebuildLookupIndexes` 开头加 `this.importedTypeIndex.clear();`；`status()` 的 `typeLookupIndexEntries` 改为三个索引之和：

```ts
      typeLookupIndexEntries: this.typeNameIndex.size + this.referencedTypeIndex.size + this.importedTypeIndex.size
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail，新增 2 个 pass。

- [ ] **Step 5: Commit**

```bash
git add src/source-index.ts src/source-index.test.ts
git commit -m "feat(source-index): reverse importer lookup with indexed fast path"
```

**已知限制（写进代码注释不需要，记录在验收报告即可）**：rg fallback 的正则不匹配 static import 行（`.member;` 结尾），未缓存的纯 static importer 会漏；已缓存的仍由 facts 过滤兜住。

### Task 3: Router importGraph 召回 phase

**Files:**
- Modify: `src/agent-router/index.ts`
- Modify: `src/agent-router.test.ts`

**背景**：双向召回。正向——anchor 文件 import 的项目内类型（用现有 `findTypeDefinitions`），覆盖"anchor 依赖谁"；反向——import 了 anchor 类型的文件（用 Task 2 的 `findImporters`），覆盖"谁依赖 anchor"，重点是 rg roots 之外的跨模块消费者。纯 importGraph 候选与纯 typeReference 一样降为 P2，防止挤占既有主链路（Phase 2 配额制才给结构类正式席位）。

- [ ] **Step 1: 写失败测试（正向：方法体协作者）**

在 `src/agent-router.test.ts` 的 `pure type references do not evict graph candidates from read plan` 测试之后新增：

```ts
test("import graph recalls method-body collaborators invisible to signature scan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-forward-"));
  await mkdir(path.join(root, "src", "main", "java", "demo", "application"), { recursive: true });
  await mkdir(path.join(root, "src", "main", "java", "demo", "dto"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "application", "ApplyInfoServiceImpl.java"), [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "  public void save() {",
    "    ApplyInfoUpdateDTO dto = null;",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"), "package demo.dto;\npublic class ApplyInfoUpdateDTO {}\n");
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/application/ApplyInfoServiceImpl.java", line: 3, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const dto = result.files.find(file => String(file.path).endsWith("ApplyInfoUpdateDTO.java")) as Record<string, unknown> | undefined;
  assert.ok((dto?.verifiedBy as string[] | undefined)?.includes("importGraph"));
});

test("import graph recalls cross-module importers outside rg roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-reverse-"));
  await mkdir(path.join(root, "modules", "core", "src", "main", "java", "demo", "core"), { recursive: true });
  await mkdir(path.join(root, "modules", "flow", "src", "main", "java", "demo", "flow"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "core", "src", "main", "java", "demo", "core", "PositionQuery.java"), "package demo.core;\npublic class PositionQuery {}\n");
  await writeFile(path.join(root, "modules", "flow", "src", "main", "java", "demo", "flow", "SubmitFlowHandler.java"), [
    "package demo.flow;",
    "import demo.core.PositionQuery;",
    "public class SubmitFlowHandler {",
    "  public void handle() { PositionQuery query = null; }",
    "}",
    ""
  ].join("\n"));
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "modules", "flow", "src", "main", "java", "demo", "flow", "SubmitFlowHandler.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "modules/core/src/main/java/demo/core/PositionQuery.java", line: 2, column: 15 }],
    profile: "dto",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const handler = result.files.find(file => String(file.path).endsWith("SubmitFlowHandler.java")) as Record<string, unknown> | undefined;
  assert.ok((handler?.verifiedBy as string[] | undefined)?.includes("importGraph"));
});

test("required semantic policy skips import graph expansion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-required-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderQuery.java"), "package demo;\npublic class OrderQuery {}\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderFlow.java"), [
    "package demo;",
    "import demo.OrderQuery;",
    "public class OrderFlow {}",
    ""
  ].join("\n"));

  const session = new FakeSemanticSession();
  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/OrderQuery.java", line: 2, column: 15 }],
    profile: "dto",
    semanticPolicy: "required",
    verbosity: "diagnostic"
  }));

  assert.equal(result.files.some(file => ((file as Record<string, unknown>).verifiedBy as string[] | undefined)?.includes("importGraph")), false);
});

test("import graph diagnostics report scanned and added candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-metrics-"));
  await mkdir(path.join(root, "src", "main", "java", "demo", "application"), { recursive: true });
  await mkdir(path.join(root, "src", "main", "java", "demo", "dto"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "application", "ApplyInfoServiceImpl.java"), [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"), "package demo.dto;\npublic class ApplyInfoUpdateDTO {}\n");
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/application/ApplyInfoServiceImpl.java", line: 3, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const metrics = result.metrics.importGraph as Record<string, unknown> | undefined;
  assert.equal(metrics?.scannedAnchors, 1);
  assert.ok(Number(metrics?.addedCandidates) >= 1);
  assert.equal(typeof metrics?.elapsedMs, "number");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test dist/agent-router.test.js 2>&1 | tail -20`

Expected: 4 个新测试失败（无 `importGraph` verifiedBy / metrics）。

- [ ] **Step 3: 实现 router phase**

`src/agent-router/index.ts` 改动如下。

(a) 在 `TypeReferenceMetrics` 类型之后新增：

```ts
type ImportGraphMetrics = {
  scannedAnchors: number;
  addedCandidates: number;
  skippedExisting: number;
  elapsedMs: number;
};
```

(b) `impact()` 中，在 `typeReference` 指标初始化之后新增初始化，并在 `collectTypeGraphCandidates` 调用行之后插入 phase 调用：

```ts
    const importGraph: ImportGraphMetrics = {
      scannedAnchors: 0,
      addedCandidates: 0,
      skippedExisting: 0,
      elapsedMs: 0
    };
```

```ts
    await timed(phaseMs, "typeGraph", async () => this.collectTypeGraphCandidates(candidates, anchors, options));
    await timed(phaseMs, "importGraph", async () => this.collectImportGraphCandidates(candidates, anchors, options, importGraph));
```

在 `typeReference.elapsedMs = phaseMs.typeReference || 0;` 之后加：

```ts
    importGraph.elapsedMs = phaseMs.importGraph || 0;
```

payload 的 `metrics` 对象中 `typeReference,` 之后加 `importGraph,`。

(c) 新增方法（放在 `collectTypeReferenceCandidates` 之后）：

```ts
  private collectImportGraphCandidates(
    candidates: Map<string, CandidateFile>,
    anchors: ResolvedAnchor[],
    options: ImpactOptions,
    metrics: ImportGraphMetrics
  ): void {
    if (options.semanticPolicy === "required") {
      return;
    }
    for (const anchor of anchors) {
      let anchorFacts: JavaSourceFacts;
      try {
        anchorFacts = this.sourceIndex.factsFor(anchor.absolutePath);
      } catch {
        continue;
      }
      metrics.scannedAnchors += 1;
      const localImports = projectLocalImports(anchorFacts.imports, anchorFacts.packageName);
      for (const facts of this.sourceIndex.findTypeDefinitions(localImports).slice(0, 20)) {
        if (facts.absolutePath === anchor.absolutePath) {
          continue;
        }
        if (candidates.has(facts.absolutePath)) {
          metrics.skippedExisting += 1;
          continue;
        }
        mergeCandidate(candidates, candidateFromFacts(facts, scoreBase("semantic", facts, anchor, options) + 65, "importGraph"));
        metrics.addedCandidates += 1;
      }
      const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
      for (const facts of this.sourceIndex.findImporters(typeName).slice(0, 20)) {
        if (facts.absolutePath === anchor.absolutePath) {
          continue;
        }
        if (candidates.has(facts.absolutePath)) {
          metrics.skippedExisting += 1;
          continue;
        }
        mergeCandidate(candidates, candidateFromFacts(facts, scoreBase("semantic", facts, anchor, options) + 60, "importGraph"));
        metrics.addedCandidates += 1;
      }
    }
  }
```

(d) 模块级函数（放在 `shouldUseTypeReference` 之后）：

```ts
function projectLocalImports(imports: string[], packageName: string | undefined): string[] {
  if (!packageName) {
    return [];
  }
  const segments = packageName.split(".");
  const prefixLength = segments.length >= 3 ? 2 : 1;
  const prefix = segments.slice(0, prefixLength).join(".");
  return imports.filter(value => value.startsWith(`${prefix}.`));
}
```

(e) `readPriority` 的纯索引召回降级泛化——把现有 `isPureTypeReference` 函数替换为：

```ts
const INDEX_RECALL_REASONS = new Set(["typeReference", "importGraph"]);

function isPureIndexRecall(file: CandidateFile): boolean {
  return file.reasons.length > 0 && file.reasons.every(reason => INDEX_RECALL_REASONS.has(reason));
}
```

并把 `readPriority` 中的调用点 `if (isPureTypeReference(file))` 改为 `if (isPureIndexRecall(file))`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail，新增 4 个 pass；既有 typeReference 相关测试不回退。

- [ ] **Step 5: Commit**

```bash
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "feat(router): import graph recall phase for cold candidates"
```

**设计说明**：正向 +65 / 反向 +60 介于 typeGraph(+70) 与 typeReference(+60/+55) 之间——import 是编译期真依赖但方向性弱于 implements。`projectLocalImports` 用 anchor 包名前缀（≥3 段取前 2 段，否则取 1 段）过滤项目外 import，零硬编码；`org.*` 开头的项目会把框架 import 误判为项目内，代价只是一次 TTL 缓存兜底的 `findTypeDefinitions` 空查，不产生候选。

### Task 4: benchmark 透传 + Phase 1 真实仓库 gate

**Files:**
- Modify: `src/benchmark-agent-impact.ts`（`GoldenSource`、`goldenSource()`、`timingPayload()`）
- Modify: `src/benchmark-agent-impact.test.ts`

- [ ] **Step 1: 写失败测试（timing 透传）**

在 `src/benchmark-agent-impact.test.ts` 的 `impact benchmark exposes timing diagnostics` 测试末尾（`typeReference.cacheMisses` 断言之后）追加：

```ts
  assert.equal(typeof timing.importGraph, "object");
  assert.equal(typeof timing.importGraph.elapsedMs, "number");
  assert.equal(typeof timing.importGraph.scannedAnchors, "number");
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test dist/benchmark-agent-impact.test.js 2>&1 | tail -10`

Expected: `timing.importGraph` 为 undefined，断言失败。

- [ ] **Step 3: 实现透传与归因**

`src/benchmark-agent-impact.ts` 三处：

(a) `GoldenSource` 联合类型加 `"importGraph"`：

```ts
type GoldenSource = "rg" | "typeGraph" | "importGraph" | "seed" | "reference" | "typeHierarchy" | "typeReference" | "no-lsp" | "absent" | "unknown";
```

(b) `goldenSource()` 中，在 `typeReference` 分支之后、`semantic-definition` 分支之前插入：

```ts
  if (verifiedBy.includes("importGraph")) {
    return "importGraph";
  }
```

(c) `timingPayload()` 的返回对象中 `typeReference: metrics.typeReference` 之后加：

```ts
    importGraph: metrics.importGraph
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail。

- [ ] **Step 5: Commit**

```bash
git add src/benchmark-agent-impact.ts src/benchmark-agent-impact.test.ts
git commit -m "feat(benchmark): attribute and time import graph recall"
```

- [ ] **Step 6: 真实仓库 gate（Phase 1 验收）**

先重跑基线快照确认 repo 未漂移，再跑三仓 cold：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p1-lishuedu.json 2> /tmp/rp-p1-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p1-cipherlink.json 2> /tmp/rp-p1-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p1-exam.json 2> /tmp/rp-p1-exam.err
```

按 scenario 首个 attempt 去重统计 `shouldBlocksTask` 缺口（与 2026-07-02 报告口径一致）：

```bash
for p in lishuedu cipherlink exam; do
  echo "== $p =="
  jq '[.rows[] | .attempts[0].goldenAttribution[] | select(.shouldBlocksTask == true)] | group_by(.blockedBy) | map({key: .[0].blockedBy, count: length})' /tmp/rp-p1-$p.json
  jq '[.rows[] | .attempts[0].goldenAttribution[] | select(.shouldBlocksTask == true and .blockedBy == "absent")] | group_by(.absentReason) | map({key: .[0].absentReason, count: length})' /tmp/rp-p1-$p.json
  jq '{recall: .totals.recall, precision: .totals.precision, rReadMust: .totals.rReadMust}' /tmp/rp-p1-$p.json
done
```

注：如 `.totals` 字段名与实际 schema 不符，用 `jq 'keys' /tmp/rp-p1-lishuedu.json` 查顶层结构后取对应聚合字段；判定以下方标准为准，不以 jq 表达式字面为准。

**PASS 标准（全部满足才进入 Phase 2）：**

| 指标 | 标准 | 基线（2026-07-01/02 报告） |
|---|---|---|
| 三仓 `R_read_must` | = 1.0000 | 1.0000 |
| exam `shouldBlocksTask absent` 中 `no-type-edge` | ≤ 2 | 5 |
| exam recall | ≥ 0.6300（预期上升） | 0.6300 |
| lishuedu / cipherlink recall | ≥ 0.7756 / ≥ 0.8357 | 0.7756 / 0.8357 |
| 三仓 elapsed P95 | ≤ 基线 × 1.2 | 277 / 113 / 158 ms（task4 报告续跑口径） |
| stderr | 全空 | — |

**FAIL 处理**：若 must 回退→回滚 Task 3 的 phase 调用（保留 SourceIndex 能力），重新审视反向召回的 slice 上限；若 elapsed 超线→先把反向 `findImporters` 的 slice 从 20 收到 10 重测。

- [ ] **Step 7: 写 Phase 1 验收报告**

新建 `docs/java-lsp-mcp-readplan-importgraph-report-<当天日期>.md`，按 `docs/java-lsp-mcp-readplan-full-capacity-report-2026-07-02.md` 的结构记录：实现范围、benchmark 命令、结果表、判定、Final Test Report。报告写完 commit：

```bash
git add docs/java-lsp-mcp-readplan-importgraph-report-*.md
git commit -m "docs(readplan): import graph phase 1 verification report"
```

---

## Phase 2: 证据类配额 readPlan（Task 5–7）

### Task 5: read-plan-budget 纯函数模块

**Files:**
- Create: `src/agent-router/read-plan-budget.ts`
- Create: `src/read-plan-budget.test.ts`

**背景**：这是 Phase 2 的核心。把"证据类"显式化为五类：`anchor`（target 本身）、`verified`（LSP 证明）、`structural`（typeGraph/importGraph/typeReference 索引证明）、`naming`（rg 命名召回）、`support`（test/config/persistence）。选择器三遍扫描：protected 全进 → 按类配额进 → 剩余 slot 按全局顺序回填。must 保护由 pass 0 的 protected 机制构造性保证，类间不再互相竞争——这直接消除 2026-07-02 报告中"结构重排挤掉 must"的失败模式。

- [ ] **Step 1: 写失败测试**

新建 `src/read-plan-budget.test.ts`：

```ts
// input: Hand-built candidate files with mixed evidence classes.
// output: Assertions for evidence classification and budgeted selection.
// pos: Node test coverage for the read plan evidence budget.
import assert from "node:assert/strict";
import test from "node:test";
import { evidenceClassOf, selectWithEvidenceBudget } from "./agent-router/read-plan-budget.js";
import type { CandidateFile } from "./agent-types.js";

function candidate(overrides: Partial<CandidateFile> & { absolutePath: string }): CandidateFile {
  return {
    path: overrides.absolutePath.replace(/^\//, ""),
    module: "demo",
    layer: "application",
    sourceSet: "main",
    score: 100,
    matchCount: 0,
    positions: [{ line: 1, column: 1 }],
    categories: ["java"],
    reasons: ["rg:java"],
    verifiedBy: ["rg"],
    ...overrides
  };
}

test("evidenceClassOf classifies anchor, verified, structural, naming, and support", () => {
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/a", reasons: ["target"], verifiedBy: ["anchor"] })), "anchor");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/b", reasons: ["reference"], verifiedBy: ["reference"] })), "verified");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/c", reasons: ["persisted-reference"], verifiedBy: ["persisted-reference"] })), "verified");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/d", reasons: ["importGraph"], verifiedBy: ["importGraph"], categories: ["semantic"] })), "structural");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/e" })), "naming");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/f", sourceSet: "test" })), "support");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/g", categories: ["persistence"] })), "support");
  assert.equal(evidenceClassOf(candidate({ absolutePath: "/h", sourceSet: "test", verifiedBy: ["reference"] })), "support");
});

test("protected paths always enter the plan regardless of quota", () => {
  const naming = Array.from({ length: 6 }, (_, i) => candidate({ absolutePath: `/naming-${i}`, score: 500 - i }));
  const protectedFile = candidate({ absolutePath: "/protected-structural", verifiedBy: ["typeGraph"], reasons: ["typeGraph"], categories: ["semantic"], score: 10 });
  const sorted = [...naming, protectedFile];
  const selected = selectWithEvidenceBudget(sorted, 4, new Set(["/protected-structural"]));
  assert.ok(selected.some(file => file.absolutePath === "/protected-structural"));
  assert.equal(selected.length, 4);
});

test("structural candidates keep quota slots under naming flood", () => {
  const anchor = candidate({ absolutePath: "/anchor", reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });
  const naming = Array.from({ length: 5 }, (_, i) => candidate({ absolutePath: `/naming-${i}`, score: 500 - i }));
  const structural = candidate({ absolutePath: "/structural", verifiedBy: ["typeReference"], reasons: ["typeReference"], categories: ["semantic"], score: 50 });
  const sorted = [anchor, ...naming, structural];
  const selected = selectWithEvidenceBudget(sorted, 4, new Set<string>());
  const paths = selected.map(file => file.absolutePath);
  assert.ok(paths.includes("/anchor"));
  assert.ok(paths.includes("/structural"));
  assert.equal(paths.filter(item => item.startsWith("/naming-")).length, 2);
});

test("unused quota backfills by sorted order", () => {
  const anchor = candidate({ absolutePath: "/anchor", reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });
  const naming = Array.from({ length: 6 }, (_, i) => candidate({ absolutePath: `/naming-${i}`, score: 500 - i }));
  const selected = selectWithEvidenceBudget([anchor, ...naming], 6, new Set<string>());
  assert.equal(selected.length, 6);
  assert.deepEqual(
    selected.map(file => file.absolutePath),
    ["/anchor", "/naming-0", "/naming-1", "/naming-2", "/naming-3", "/naming-4"]
  );
});

test("maxItems=1 keeps only the first sorted candidate", () => {
  const anchor = candidate({ absolutePath: "/anchor", reasons: ["target"], verifiedBy: ["anchor"], score: 1000 });
  const other = candidate({ absolutePath: "/other" });
  assert.deepEqual(
    selectWithEvidenceBudget([anchor, other], 1, new Set<string>()).map(file => file.absolutePath),
    ["/anchor"]
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build 2>&1 | tail -5`

Expected: 编译失败（模块不存在）。

- [ ] **Step 3: 实现**

新建 `src/agent-router/read-plan-budget.ts`：

```ts
// input: Priority-sorted candidate files with reasons/verifiedBy evidence.
// output: Read plan selection honoring per-evidence-class slot budgets.
// pos: Evidence-class quota allocator used by AgentRouter read plan selection.
import type { CandidateFile } from "../agent-types.js";

export type EvidenceClass = "anchor" | "verified" | "structural" | "naming" | "support";

const VERIFIED_EVIDENCE = new Set([
  "reference",
  "typeHierarchy",
  "semantic-definition",
  "semantic-implementation",
  "persisted-reference",
  "persisted-implementation",
  "persisted-typeHierarchy"
]);

const STRUCTURAL_EVIDENCE = new Set(["typeGraph", "importGraph", "typeReference"]);

const SUPPORT_CATEGORIES = new Set(["config", "persistence", "nonJava"]);

export function evidenceClassOf(file: CandidateFile): EvidenceClass {
  if (file.reasons.includes("target")) {
    return "anchor";
  }
  if (file.sourceSet === "test" || file.categories.some(category => SUPPORT_CATEGORIES.has(category))) {
    return "support";
  }
  const verifiedBy = file.verifiedBy || [];
  if (verifiedBy.some(item => VERIFIED_EVIDENCE.has(item))) {
    return "verified";
  }
  if (verifiedBy.some(item => STRUCTURAL_EVIDENCE.has(item))) {
    return "structural";
  }
  return "naming";
}

export function classQuotas(maxItems: number): Record<Exclude<EvidenceClass, "anchor">, number> {
  return {
    verified: Math.max(1, Math.ceil(maxItems / 3)),
    structural: Math.max(1, Math.floor(maxItems / 3)),
    naming: Math.max(1, Math.floor(maxItems / 3)),
    support: Math.max(1, Math.floor(maxItems / 6))
  };
}

export function selectWithEvidenceBudget(
  sorted: CandidateFile[],
  maxItems: number,
  protectedPaths: Set<string>
): CandidateFile[] {
  const quotas = classQuotas(maxItems);
  const used: Record<EvidenceClass, number> = { anchor: 0, verified: 0, structural: 0, naming: 0, support: 0 };
  const selected: CandidateFile[] = [];
  const selectedPaths = new Set<string>();
  const take = (file: CandidateFile) => {
    selected.push(file);
    selectedPaths.add(file.absolutePath);
    used[evidenceClassOf(file)] += 1;
  };
  for (const file of sorted) {
    if (selected.length >= maxItems) {
      break;
    }
    if (protectedPaths.has(file.absolutePath) && !selectedPaths.has(file.absolutePath)) {
      take(file);
    }
  }
  for (const file of sorted) {
    if (selected.length >= maxItems) {
      break;
    }
    if (selectedPaths.has(file.absolutePath)) {
      continue;
    }
    const evidenceClass = evidenceClassOf(file);
    if (evidenceClass === "anchor" || used[evidenceClass] < quotas[evidenceClass]) {
      take(file);
    }
  }
  for (const file of sorted) {
    if (selected.length >= maxItems) {
      break;
    }
    if (!selectedPaths.has(file.absolutePath)) {
      take(file);
    }
  }
  return selected;
}
```

配额取值（maxItems=6 时 verified 2 / structural 2 / naming 2 / support 1，总和 7 > 6 由填充顺序裁决）是第一版先验，Task 7 gate 用实测校准；不加环境变量配置项。

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && node --test dist/read-plan-budget.test.js 2>&1 | tail -5`

Expected: 5 pass, 0 fail。

- [ ] **Step 5: Commit**

```bash
git add src/agent-router/read-plan-budget.ts src/read-plan-budget.test.ts
git commit -m "feat(router): evidence-class quota allocator for read plan"
```

### Task 6: 配额选择器接入 AgentRouter

**Files:**
- Modify: `src/agent-router/index.ts`（`selectReadPlanFiles`、`finalizeRank`）
- Modify: `src/agent-router.test.ts`

**背景**：两处消费点必须同步替换，保证 tail truncation 的保护集与最终 readPlan 一致：`selectReadPlanFiles`（buildReadPlan 与 nonLspReadPlanPaths 共用）和 `finalizeRank` 内的 `readPlanCovered` 计算。排序键不变（priorityRank, score），只改"取哪 N 个"。

- [ ] **Step 1: 写失败集成测试**

在 `src/agent-router.test.ts` 中 Task 3 新增测试之后追加：

```ts
test("evidence budget keeps structural collaborator under naming flood", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-budget-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderService.java"), [
    "package demo;",
    "public class OrderService {",
    "  private OrderPolicy policy;",
    "  public void submitOrder() {",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderPolicy.java"), "package demo;\npublic interface OrderPolicy {}\n");
  const flood = "// OrderService OrderService OrderService OrderService OrderService\n".repeat(12);
  for (const name of ["OrderHelperA", "OrderHelperB", "OrderHelperC", "OrderHelperD", "OrderHelperE"]) {
    await writeFile(path.join(root, "src", "main", "java", "demo", `${name}.java`), `package demo;\n${flood}public class ${name} {}\n`);
  }
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "OrderPolicy.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/OrderService.java", line: 2, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    readPlanMaxItems: 4,
    verbosity: "diagnostic"
  }));

  const readPaths = readPlanPaths(result);
  assert.ok(readPaths.includes("src/main/java/demo/OrderPolicy.java"));
  assert.ok(readPaths.includes("src/main/java/demo/OrderService.java"));
});
```

说明：`OrderPolicy` 是签名引用，由 typeReference/importGraph 召回为纯结构候选（P2）；5 个 helper 文件靠 `OrderService` 文本命中 rg（P1 naming，matchCount 高）。旧逻辑下 4 个 slot = anchor + 3 helper，`OrderPolicy` 必然出局；配额制下 naming 类被限 2 席，`OrderPolicy` 以 structural 类入选。

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test dist/agent-router.test.js 2>&1 | tail -10`

Expected: 新测试 FAIL（`OrderPolicy.java` 不在 readPlan）。

- [ ] **Step 3: 实现接入**

`src/agent-router/index.ts`：

(a) import 区新增：

```ts
import { selectWithEvidenceBudget } from "./read-plan-budget.js";
```

(b) `selectReadPlanFiles` 整个方法体替换为：

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
    return selectWithEvidenceBudget(sorted, maxItems, protectedPaths)
      .map(file => ({ file, priority: readPriority(file, options) }))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
      .map(entry => entry.file);
  }
```

(c) `finalizeRank` 中 `readPlanCovered` 的计算替换为同一选择器（保持与最终 readPlan 一致）：

```ts
    const sortedForPlan = [...ranked]
      .map(file => ({ file, priority: readPriority(file, options) }))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
      .map(entry => entry.file);
    const readPlanCovered = new Set(selectWithEvidenceBudget(sortedForPlan, maxItems, new Set<string>()));
```

（`extraProtectedPaths` 的后续 for 循环保持不变。）

- [ ] **Step 4: 运行全量测试确认通过且无回退**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail。重点回归项：`pure type references do not evict graph candidates from read plan`、`testReadMode defer keeps tests out of priority read slots`、`readPlanMaxItems and excludeModules are honored`。若某个既有测试失败，先读失败输出定位是配额边界还是保护语义问题，禁止直接改旧测试断言来过关。

- [ ] **Step 5: Commit**

```bash
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "feat(router): budgeted read plan selection by evidence class"
```

### Task 7: Phase 2 真实仓库 gate（slot 6/8/10 对照）

**Files:** 无代码改动；产出验收报告。

**背景**：2026-07-02 报告的固定要求——任何 readPlan priority patch 必须与 slot=6/8/10 对照。配额制的成功判据是：**slot 固定 6 时拿到扩容实验的主要收益，而不付出扩容的 P_read/payload 代价**。

- [ ] **Step 1: 跑三仓 × slot 6/8/10 矩阵**

```bash
npm run build
for p in "lishuedu /Users/luo/Documents/program/lishu/lishuedu" "cipherlink /Users/luo/Documents/program/cipherlink" "exam-parent-v3 /Users/luo/Documents/program/exam-parent-v3"; do
  set -- $p
  for slots in 6 8 10; do
    node dist/benchmark-agent-impact.js --repo-root "$2" --project-id "$1" --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items $slots > /tmp/rp-p2-$1-$slots.json 2> /tmp/rp-p2-$1-$slots.err
  done
done
ls -la /tmp/rp-p2-*.err   # 应全为 0 字节
```

- [ ] **Step 2: 统计与判定**

按 scenario 首个 attempt 去重统计 `shouldBlocksTask hit/full/absent`，与报告基线对照（jq 口径同 Task 4 Step 6）。

**PASS 标准（slot=6 主口径，全部满足）：**

| 指标 | 标准 | 基线（slot=6, 2026-07-02 报告 + Task 4 报告） |
|---|---|---|
| 三仓 `R_read_must` | = 1.0000 | 1.0000 |
| cipherlink `shouldBlocksTask full` | ≤ 8 | 12 |
| cipherlink `P_read` | ≥ 0.50 | 0.5333 |
| lishuedu `P_read` | ≥ 0.75 | 0.8000 |
| exam `shouldBlocksTask absent` | ≤ Task 4 报告值 | Task 4 gate 后的新基线 |
| 三仓 readingPayload P50 | ≤ 基线 × 1.1 | 10790 / 6182 / 8136 |
| slot 8/10 对照 | slot=6 的 full 改善 ≥ slot=8 扩容改善的 2/3 | cipherlink: 12→9 (slot 8) |

**FAIL 处理（按优先级）：**

1. must 回退 → 立即回滚 Task 6 接入 commit（`git revert`），保留 Task 5 模块，回到本计划重新设计 pass 0 保护语义。
2. cipherlink full 改善不足 → 调 `classQuotas`：structural 2→3、naming 2→1，重跑矩阵；一次只动一个配额，在报告中记录每次取值与结果。
3. lishuedu `P_read` 跌破 0.75 → naming 配额回 3（说明 lishuedu 的 golden 命中依赖命名召回），重跑。

- [ ] **Step 3: 写 Phase 2 验收报告并提交**

新建 `docs/java-lsp-mcp-readplan-evidence-budget-report-<当天日期>.md`，必须包含：最终配额取值、slot 6/8/10 全矩阵表、与 2026-07-02 报告的同格式对照表、被否决的配额尝试（如有）、Final Test Report。

```bash
git add docs/java-lsp-mcp-readplan-evidence-budget-report-*.md
git commit -m "docs(readplan): evidence budget phase 2 verification report"
```

---

## Phase 3: 持久语义边表（Task 8–10）

### Task 8: EdgeStore 持久语义边表

**Files:**
- Create: `src/edge-store.ts`
- Create: `src/edge-store.test.ts`
- Modify: `src/source-index.ts`（导出 `readJsonLines`）

**背景**：架构反转的最小实现。warm LSP verify 的结果（references/typeHierarchy）目前用完即弃；EdgeStore 把它们以 anchor 文件为 key 持久化（jsonl，与 SourceIndex snapshot 同目录），失效粒度 = anchor 文件 mtime。**不做**后台调度器、**不做**全仓建边——warm-required 显式模式就是"建边动作"，cold 查询消费。

- [ ] **Step 1: 导出 readJsonLines**

`src/source-index.ts` 底部的 `function readJsonLines<T>(file: string): T[]` 改为 `export function readJsonLines<T>(file: string): T[]`。

- [ ] **Step 2: 写失败测试**

新建 `src/edge-store.test.ts`：

```ts
// input: Recorded semantic edges over temp fixture files.
// output: Assertions for persistence, reload, and mtime invalidation.
// pos: Node test coverage for the persistent semantic edge store.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EdgeStore } from "./edge-store.js";

async function fixture(prefix: string): Promise<{ root: string; anchor: string; caller: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const dir = path.join(root, "src", "main", "java", "demo");
  await mkdir(dir, { recursive: true });
  const anchor = path.join(dir, "FooService.java");
  const caller = path.join(dir, "OtherController.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  return { root, anchor, caller };
}

test("EdgeStore records edges and returns them for a fresh anchor", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-store-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  const edges = store.edgesFor(anchor);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, caller);
  assert.equal(edges[0].kind, "reference");
  assert.equal(store.status().hits, 1);
});

test("EdgeStore reloads persisted edges in a new instance", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-reload-");
  new EdgeStore(root).recordEdges(anchor, [{ to: caller, kind: "typeHierarchy", line: 2, column: 14 }]);
  const reloaded = new EdgeStore(root);
  assert.equal(reloaded.edgesFor(anchor).length, 1);
});

test("EdgeStore drops edges after anchor mtime changes", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-stale-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  const future = new Date(Date.now() + 5000);
  utimesSync(anchor, future, future);
  assert.deepEqual(store.edgesFor(anchor), []);
  assert.equal(store.status().invalidated, 1);
});

test("EdgeStore filters edges whose target file is gone", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-target-gone-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  rmSync(caller);
  assert.deepEqual(store.edgesFor(anchor), []);
});

test("EdgeStore re-record replaces previous edges for the same anchor", async () => {
  const { root, anchor, caller } = await fixture("java-lsp-edge-replace-");
  const store = new EdgeStore(root);
  store.recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  store.recordEdges(anchor, [{ to: caller, kind: "typeHierarchy", line: 3, column: 1 }]);
  const reloaded = new EdgeStore(root);
  const edges = reloaded.edgesFor(anchor);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "typeHierarchy");
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npm run build 2>&1 | tail -5`

Expected: 编译失败（`edge-store.js` 不存在）。

- [ ] **Step 4: 实现**

新建 `src/edge-store.ts`：

```ts
// input: LSP-verified reference/implementation/typeHierarchy targets per anchor file.
// output: Durable semantic edges with anchor-mtime invalidation.
// pos: Persistent edge store consumed by AgentRouter cold recall.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoCacheRoot } from "./repo-layout.js";
import { readJsonLines } from "./source-index.js";

export type SemanticEdgeKind = "reference" | "implementation" | "typeHierarchy";

export type SemanticEdge = {
  from: string;
  to: string;
  kind: SemanticEdgeKind;
  line: number;
  column: number;
  fromMtimeMs: number;
  confirmedAt: string;
};

export type SemanticEdgeInput = Pick<SemanticEdge, "to" | "kind" | "line" | "column">;

type EdgeRecord = SemanticEdge & { batchId: string };

export type EdgeStoreStatus = {
  anchors: number;
  edges: number;
  hits: number;
  misses: number;
  invalidated: number;
};

export class EdgeStore {
  private readonly edgesByFrom = new Map<string, EdgeRecord[]>();
  private readonly edgesPath: string;
  private totalRecords = 0;
  private hits = 0;
  private misses = 0;
  private invalidated = 0;

  constructor(repoRoot: string) {
    this.edgesPath = path.join(repoCacheRoot(repoRoot), "semantic-edges.jsonl");
    this.load();
  }

  status(): EdgeStoreStatus {
    let edges = 0;
    for (const records of this.edgesByFrom.values()) {
      edges += records.length;
    }
    return {
      anchors: this.edgesByFrom.size,
      edges,
      hits: this.hits,
      misses: this.misses,
      invalidated: this.invalidated
    };
  }

  recordEdges(fromFile: string, edges: SemanticEdgeInput[]): void {
    if (edges.length === 0) {
      return;
    }
    const stat = statSync(fromFile);
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const confirmedAt = new Date().toISOString();
    const records: EdgeRecord[] = edges.map(edge => ({
      ...edge,
      from: fromFile,
      fromMtimeMs: stat.mtimeMs,
      confirmedAt,
      batchId
    }));
    this.edgesByFrom.set(fromFile, records);
    mkdirSync(path.dirname(this.edgesPath), { recursive: true });
    appendFileSync(this.edgesPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
    this.totalRecords += records.length;
    const live = this.status().edges;
    if (this.totalRecords > live * 2 && this.totalRecords > 200) {
      this.compact();
    }
  }

  edgesFor(fromFile: string): SemanticEdge[] {
    const records = this.edgesByFrom.get(fromFile);
    if (!records || records.length === 0) {
      this.misses += 1;
      return [];
    }
    try {
      if (statSync(fromFile).mtimeMs !== records[0].fromMtimeMs) {
        this.edgesByFrom.delete(fromFile);
        this.invalidated += 1;
        this.misses += 1;
        return [];
      }
    } catch {
      this.edgesByFrom.delete(fromFile);
      this.invalidated += 1;
      this.misses += 1;
      return [];
    }
    const alive = records.filter(record => existsSync(record.to));
    this.hits += 1;
    return alive;
  }

  private load(): void {
    if (!existsSync(this.edgesPath)) {
      return;
    }
    try {
      const batchByFrom = new Map<string, string>();
      for (const record of readJsonLines<EdgeRecord>(this.edgesPath)) {
        if (typeof record.from !== "string" || typeof record.to !== "string" || typeof record.fromMtimeMs !== "number") {
          continue;
        }
        this.totalRecords += 1;
        if (batchByFrom.get(record.from) !== record.batchId) {
          batchByFrom.set(record.from, record.batchId);
          this.edgesByFrom.set(record.from, []);
        }
        this.edgesByFrom.get(record.from)?.push(record);
      }
    } catch {
      rmSync(this.edgesPath, { force: true });
      this.edgesByFrom.clear();
      this.totalRecords = 0;
    }
  }

  private compact(): void {
    const tmp = `${this.edgesPath}.tmp`;
    const lines: string[] = [];
    this.totalRecords = 0;
    for (const records of this.edgesByFrom.values()) {
      for (const record of records) {
        lines.push(JSON.stringify(record));
        this.totalRecords += 1;
      }
    }
    writeFileSync(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    renameSync(tmp, this.edgesPath);
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm run build && node --test dist/edge-store.test.js 2>&1 | tail -5`

Expected: 5 pass, 0 fail。

- [ ] **Step 6: Commit**

```bash
git add src/edge-store.ts src/edge-store.test.ts src/source-index.ts
git commit -m "feat(edge-store): persistent semantic edges with mtime invalidation"
```

### Task 9: semanticVerify 写回边

**Files:**
- Modify: `src/agent-router/index.ts`（构造函数、`semanticVerify`）
- Modify: `src/agent-router.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/agent-router.test.ts` 顶部 import 区加：

```ts
import { EdgeStore } from "./edge-store.js";
```

在 Task 6 新增测试之后追加：

```ts
test("required semantic verify persists reference edges for cold reuse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-edge-writeback-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const caller = path.join(root, "src", "main", "java", "demo", "OtherController.java");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  const session = new FakeSemanticSession([{ uri: pathToFileURL(caller).toString(), range: { start: { line: 1, character: 13 }, end: { line: 1, character: 28 } } }]);

  await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "required"
  }));

  const edges = new EdgeStore(root).edgesFor(anchor);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, caller);
  assert.equal(edges[0].kind, "reference");
});

test("failed semantic verify does not persist edges", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-edge-writeback-fail-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const session = new FakeSemanticSession();
  session.failReferences = true;

  await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "required"
  }));

  assert.deepEqual(new EdgeStore(root).edgesFor(anchor), []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test dist/agent-router.test.js 2>&1 | tail -10`

Expected: 第一个新测试 FAIL（`edgesFor` 为空）。

- [ ] **Step 3: 实现写回**

`src/agent-router/index.ts`：

(a) import 区加：

```ts
import { EdgeStore, type SemanticEdgeInput } from "../edge-store.js";
```

(b) 构造函数追加第 5 个可选参数（在 `layoutContext` 之后）：

```ts
  constructor(
    private readonly repoRoot: string,
    private readonly session: JdtlsSession,
    private readonly sourceIndex: SourceIndex,
    private readonly layoutContext: LayoutContext = probeLayout(repoRoot),
    private readonly edgeStore: EdgeStore = new EdgeStore(repoRoot)
  ) {}
```

(c) `semanticVerify` 的 anchor 循环体改造——在 `const before = Date.now();` 之后声明收集数组，在 references / typeHierarchy 两个循环内各追加一次 push，try/catch 之后统一写回：

```ts
      for (const anchor of anchors) {
        const before = Date.now();
        const verifiedEdges: SemanticEdgeInput[] = [];
        try {
          const references = await this.session.references(anchor.absolutePath, anchor.line, anchor.column, false, options.semanticTimeoutMs);
          semantic.timeout ||= Date.now() - before >= options.semanticTimeoutMs;
          for (const location of references.items.slice(0, 40)) {
            const candidate = this.locationCandidate(location, "reference", anchor, options);
            if (candidate) {
              candidate.confidence = "high";
              candidate.verifiedBy = ["reference"];
              mergeCandidate(candidates, candidate);
              if (candidate.absolutePath !== anchor.absolutePath) {
                verifiedEdges.push({
                  to: candidate.absolutePath,
                  kind: "reference",
                  line: candidate.positions[0]?.line || 1,
                  column: candidate.positions[0]?.column || 1
                });
              }
            }
          }
          if (this.shouldUseTypeHierarchyVerify(anchor, options)) {
            const hierarchy = await this.session.typeHierarchy(anchor.absolutePath, anchor.line, anchor.column, "subtypes", 2, 40);
            for (const edge of hierarchy.edges.slice(0, 40)) {
              const location = hierarchyItemLocation(edge.from);
              const candidate = location ? this.locationCandidate(location, "typeHierarchy", anchor, options) : undefined;
              if (candidate) {
                candidate.confidence = "high";
                candidate.verifiedBy = ["typeHierarchy"];
                mergeCandidate(candidates, candidate);
                if (candidate.absolutePath !== anchor.absolutePath) {
                  verifiedEdges.push({
                    to: candidate.absolutePath,
                    kind: "typeHierarchy",
                    line: candidate.positions[0]?.line || 1,
                    column: candidate.positions[0]?.column || 1
                  });
                }
              }
            }
          }
        } catch {
          semantic.timeout = true;
        }
        if (verifiedEdges.length > 0) {
          try {
            this.edgeStore.recordEdges(anchor.absolutePath, verifiedEdges);
          } catch {
            // persistence is best-effort; never fail the query path
          }
        }
      }
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail，新增 2 pass。

- [ ] **Step 5: Commit**

```bash
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "feat(router): persist verified semantic edges after lsp verify"
```

### Task 10: cold 路径消费持久边 + Phase 3 gate

**Files:**
- Modify: `src/agent-router/index.ts`
- Modify: `src/agent-router.test.ts`

**背景**：cold/fast 查询直接把持久边转为高置信候选（`verifiedBy: ["persisted-reference"]` 等），跑过一次 warm-required 的 anchor 后续获得 LSP 级 recall 而延迟保持毫秒级。`semanticPolicy=required` 时跳过（live LSP 会覆盖同类证据）。Task 5 的 `VERIFIED_EVIDENCE` 已包含 `persisted-*`，配额制自动把这类候选归入 verified 类。

- [ ] **Step 1: 写失败测试**

在 Task 9 新增测试之后追加：

```ts
test("persisted semantic edges provide high-confidence candidates without lsp", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-persisted-recall-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const caller = path.join(root, "src", "main", "java", "demo", "OtherController.java");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  new EdgeStore(root).recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  const session = new FakeSemanticSession();

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const persisted = result.files.find(file => String(file.path).endsWith("OtherController.java")) as Record<string, unknown> | undefined;
  assert.equal(session.referencesCalls, 0);
  assert.equal(persisted?.confidence, "high");
  assert.ok((persisted?.verifiedBy as string[]).includes("persisted-reference"));
});

test("stale persisted edges are ignored after anchor changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-persisted-stale-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const caller = path.join(root, "src", "main", "java", "demo", "OtherController.java");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  new EdgeStore(root).recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  const future = new Date(Date.now() + 5000);
  utimesSync(anchor, future, future);

  const result = await new AgentRouter(root, new JdtlsSession(root), new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  assert.equal(result.files.some(file => ((file as Record<string, unknown>).verifiedBy as string[] | undefined)?.includes("persisted-reference")), false);
});
```

`utimesSync` 需要在测试文件顶部补 import：`import { utimesSync } from "node:fs";`

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test dist/agent-router.test.js 2>&1 | tail -10`

Expected: 第一个新测试 FAIL（无 persisted-reference 候选）。

- [ ] **Step 3: 实现 persisted 召回 phase**

`src/agent-router/index.ts`：

(a) `impact()` 中，在 anchors merge 循环之后、`typeGraph` phase 之前插入：

```ts
    const persistedSemantic = { edgesSeen: 0, addedCandidates: 0, elapsedMs: 0 };
    await timed(phaseMs, "persistedSemantic", async () => this.collectPersistedSemanticCandidates(candidates, anchors, options, persistedSemantic));
    persistedSemantic.elapsedMs = phaseMs.persistedSemantic || 0;
```

payload 的 `metrics` 对象中 `importGraph,` 之后加 `persistedSemantic,`。

(b) 新增方法（放在 `collectImportGraphCandidates` 之后）：

```ts
  private collectPersistedSemanticCandidates(
    candidates: Map<string, CandidateFile>,
    anchors: ResolvedAnchor[],
    options: ImpactOptions,
    metrics: { edgesSeen: number; addedCandidates: number }
  ): void {
    if (options.semanticPolicy === "required") {
      return;
    }
    for (const anchor of anchors) {
      for (const edge of this.edgeStore.edgesFor(anchor.absolutePath).slice(0, 40)) {
        metrics.edgesSeen += 1;
        if (edge.to === anchor.absolutePath) {
          continue;
        }
        const context = classifyPath(this.repoRoot, edge.to);
        const score = scoreBase("semantic", context, anchor, options) + (edge.kind === "implementation" ? 110 : 95);
        mergeCandidate(candidates, {
          absolutePath: edge.to,
          path: context.relativePath,
          module: context.module,
          layer: context.layer,
          sourceSet: context.sourceSet,
          score,
          matchCount: 0,
          positions: [{ line: edge.line, column: edge.column }],
          categories: ["semantic"],
          reasons: [`persisted-${edge.kind}`],
          confidence: "high",
          verifiedBy: [`persisted-${edge.kind}`],
          scoreBreakdown: [breakdown(`semantic.persisted-${edge.kind}`, "semantic-seed", score, `persisted ${edge.kind} edge`)]
        });
        metrics.addedCandidates += 1;
      }
    }
  }
```

- [ ] **Step 4: 运行全量测试确认通过**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail，新增 2 pass。

- [ ] **Step 5: Commit**

```bash
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "feat(router): cold recall from persisted semantic edges"
```

- [ ] **Step 6: Phase 3 真实仓库 gate**

验证"warm 建边 → cold 消费"闭环与默认路径无回退：

```bash
npm run build
# 1) 默认 cold 基线不回退（EdgeStore 为空时行为必须与 Phase 2 收官一致）
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p3-lishuedu-cold.json 2> /tmp/rp-p3-lishuedu-cold.err
# 2) 跑一轮 warm-required 建边
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 1 --verbosity diagnostic > /tmp/rp-p3-lishuedu-warm.json 2> /tmp/rp-p3-lishuedu-warm.err
# 3) 再跑 cold，观察 persisted 边带来的 recall 变化与延迟
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p3-lishuedu-cold-after.json 2> /tmp/rp-p3-lishuedu-cold-after.err
```

**PASS 标准：**

| 检查 | 标准 |
|---|---|
| 步骤 1 vs Phase 2 收官基线 | recall/precision/rReadMust/elapsed 全部一致（EdgeStore 为空 → 行为不变） |
| 步骤 3 vs 步骤 1 | `R_read_must=1.0000` 保持；recall ≥ 步骤 1（预期向 warm-required 的 0.8256 方向收敛）；elapsed P95 仍为 cold 量级（< 500ms，不得出现 LSP 级延迟） |
| 步骤 3 timing | `phaseMs.persistedSemantic` P95 < 50ms |
| stderr | 全空 |

注意：benchmark 的 warm/cold 进程是否共享 `repoCacheRoot` 快照目录决定步骤 2 的边能否被步骤 3 读到。若 benchmark 以隔离 cache 目录运行（读 `src/benchmark-agent-impact.ts` 的 SourceIndex/AgentRouter 构造处确认），本 gate 改用手工验证：对同一 anchor 先调 `java_impact semanticPolicy=required` 再调 `semanticPolicy=fast`，比对第二次输出包含 `persisted-reference` 候选且 `elapsedMs` 为毫秒级；结论写入报告。

- [ ] **Step 7: 写 Phase 3 验收报告并提交**

新建 `docs/java-lsp-mcp-readplan-edge-store-report-<当天日期>.md`（结构同前两份报告），明确记录：空边表零回退证据、建边后 cold recall 增量、persistedSemantic 延迟、边失效行为。

```bash
git add docs/java-lsp-mcp-readplan-edge-store-report-*.md
git commit -m "docs(readplan): edge store phase 3 verification report"
```

---

## 卫生项: routing policy 去 lishuedu 化（Task 11）

### Task 11: routing policy 拆分与按 repo 选择

**Files:**
- Modify: `src/routing-policy.ts`
- Modify: `src/routing-policy.test.ts`
- Modify: `src/agent-router/index.ts`（policy 线程化）

**背景**：`legacyRoutingPolicy` 含 lishuedu 专有正则（`ProductView|ParentBenefit|ItemView`、`SignedUrl|Report`、`ParsedTemplate|DiffBuilder|Draft|PreviewItem`、两条 targeted-tests 规则），当前被无条件施加到所有 repo。拆分原则：**lishuedu 的规则数组保持逐字节等价**（零行为漂移），generic 版只含通用规则；用共享数组去重完全相同的规则。

- [ ] **Step 1: 写失败测试**

`src/routing-policy.test.ts` 追加：

```ts
test("generic policy contains no lishuedu-specific tokens", () => {
  const serialized = JSON.stringify(genericJavaPolicy.scoreRules.map(rule => String(rule.when.pathRegex)));
  for (const token of ["ProductView", "ParentBenefit", "SignedUrl", "ParsedTemplate", "DiffBuilder", "ExcelParserTest", "BenefitEntitlementAssemblerTest"]) {
    assert.equal(serialized.includes(token), false, `generic policy leaked ${token}`);
  }
});

test("lishuedu legacy policy keeps its original rule ids", () => {
  const ids = lishueduLegacyPolicy.scoreRules.map(rule => rule.id);
  for (const id of ["profile.parser.tests", "profile.dto.tests", "profile.dto.family", "profile.port.family"]) {
    assert.ok(ids.includes(id), `legacy policy missing ${id}`);
  }
});

test("resolveRoutingPolicy picks by env override then repo basename", () => {
  process.env.JAVA_LSP_ROUTING_POLICY = "generic-java";
  assert.equal(resolveRoutingPolicy("/x/lishuedu").id, "generic-java");
  process.env.JAVA_LSP_ROUTING_POLICY = "lishuedu-legacy";
  assert.equal(resolveRoutingPolicy("/x/other").id, "lishuedu-legacy");
  delete process.env.JAVA_LSP_ROUTING_POLICY;
  assert.equal(resolveRoutingPolicy("/x/lishuedu").id, "lishuedu-legacy");
  assert.equal(resolveRoutingPolicy("/x/cipherlink").id, "generic-java");
});
```

同时把测试文件的 import 更新为：

```ts
import { genericJavaPolicy, lishueduLegacyPolicy, resolveRoutingPolicy } from "./routing-policy.js";
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build 2>&1 | tail -5`

Expected: 编译失败（`genericJavaPolicy` 等不存在）。

- [ ] **Step 3: 实现 policy 拆分**

`src/routing-policy.ts` 重组 `legacyRoutingPolicy` 定义（`categoryBase`/`confidenceDeltas` 保持不变，抽为共享常量）：

```ts
const sharedCategoryBase: RoutingPolicy["categoryBase"] = {
  persistence: 70,
  protocol: 64,
  java: 56,
  semantic: 80,
  tests: 24,
  config: 18,
  nonJava: 18
};

const sharedConfidenceDeltas: RoutingPolicy["confidenceDeltas"] = { high: 0, medium: 0, low: 0 };

const sharedScoreRules: ScoreRule[] = [
  rule("structure.same-file", { sameFile: true }, 180, "same file as anchor"),
  rule("structure.same-module", { sameModule: true }, 28, "same module as anchor"),
  rule("structure.main-source", { sourceSet: "main" }, 14, "main source set"),
  rule("structure.interface-application-layer", { layer: ["interfaces", "application"] }, 12, "interfaces/application layer"),
  rule("profile.controller.interfaces", { profile: "controller", layer: "interfaces" }, 35, "controller interface layer"),
  rule("profile.repository.infrastructure", { profile: "repository", pathRegex: /(\/infrastructure\/|\/db\/migration\/)/ }, 35, "repository infrastructure evidence"),
  rule("profile.entity.family", { profile: "entity", pathRegex: /(\/entity\/|Entity|DO|Mapper|Repository|db\/migration)/ }, 34, "entity family evidence"),
  rule("profile.mapper.family", { profile: "mapper", pathRegex: /(\/mapper\/|Mapper|Entity|DO|Repository|\.xml$|db\/migration)/ }, 36, "mapper family evidence"),
  rule("profile.job.family", { profile: "job", pathRegex: /(Job|Scheduler|Schedule|Task|Config|AppService|Service|Repository)/ }, 32, "job family evidence"),
  rule("profile.listener.family", { profile: "listener", pathRegex: /(Listener|Event|Publisher|Handler|Consumer|AppService|Service|Repository)/ }, 32, "listener family evidence"),
  rule("profile.parser.persistence-penalty", { profile: "parser", pathRegex: /\/persistence\/|Repository|Mapper|DO|Task(File|Status|Repository|Mapper|DO)?/ }, -70, "parser persistence penalty"),
  rule("profile.vo.family", { profile: "vo", pathRegex: /VO|Vo|View|Assembler|Controller|AppService|Service/ }, 30, "vo family evidence"),
  rule("options.focus-module", { focusModule: true }, 18, "focus module"),
  rule("options.task-keyword", { taskKeyword: true }, 20, "task keyword"),
  rule("structure.common-penalty", { moduleEquals: "common" }, -20, "common module penalty")
];

export const lishueduLegacyPolicy: RoutingPolicy = {
  id: "lishuedu-legacy",
  categoryBase: sharedCategoryBase,
  confidenceDeltas: sharedConfidenceDeltas,
  scoreRules: [
    ...sharedScoreRules,
    rule("profile.parser.family", { profile: "parser", pathRegex: /Parser|ParsedTemplate|DiffBuilder|Draft|PreviewItem/ }, 38, "parser family evidence"),
    rule("profile.parser.tests", { profile: "parser", sourceSet: "test", pathRegex: /ExcelParserTest|DiffBuilderTest/ }, 90, "parser targeted tests"),
    rule("profile.port.family", { profile: "port", pathRegex: /Gateway|Config|SignedUrl|AppService|Report/ }, 30, "port family evidence"),
    rule("profile.dto.family", { profile: "dto", pathRegex: /Assembler|Controller|QueryAppService|ProductView|ParentBenefit|ItemView/ }, 32, "dto family evidence"),
    rule("profile.dto.tests", { profile: "dto", sourceSet: "test", pathRegex: /ParentBenefitQueryAppServiceTest|BenefitEntitlementAssemblerTest/ }, 90, "dto targeted tests")
  ]
};

export const genericJavaPolicy: RoutingPolicy = {
  id: "generic-java",
  categoryBase: sharedCategoryBase,
  confidenceDeltas: sharedConfidenceDeltas,
  scoreRules: [
    ...sharedScoreRules,
    rule("profile.parser.family", { profile: "parser", pathRegex: /Parser/ }, 38, "parser family evidence"),
    rule("profile.port.family", { profile: "port", pathRegex: /Gateway|Port|Client|Config|AppService/ }, 30, "port family evidence"),
    rule("profile.dto.family", { profile: "dto", pathRegex: /Assembler|Controller|QueryAppService/ }, 32, "dto family evidence")
  ]
};

export const legacyRoutingPolicy = lishueduLegacyPolicy;

export function resolveRoutingPolicy(repoRoot: string): RoutingPolicy {
  const override = process.env.JAVA_LSP_ROUTING_POLICY;
  if (override === "lishuedu-legacy") {
    return lishueduLegacyPolicy;
  }
  if (override === "generic-java") {
    return genericJavaPolicy;
  }
  return path.basename(repoRoot) === "lishuedu" ? lishueduLegacyPolicy : genericJavaPolicy;
}
```

文件顶部补 `import path from "node:path";`。**核对点**：`lishueduLegacyPolicy.scoreRules` 展开后与改动前的 21 条规则集合完全一致（顺序变化无影响，`scoreWithPolicy` 是加法累积）。

- [ ] **Step 4: policy 线程化到 router**

`src/agent-router/index.ts`：

(a) import 改为：

```ts
import { resolveRoutingPolicy, scoreWithPolicy, type RoutingPolicy, type ScoreCategory } from "../routing-policy.js";
```

(b) 构造函数追加第 6 个可选参数：

```ts
    private readonly routingPolicy: RoutingPolicy = resolveRoutingPolicy(repoRoot)
```

(c) 模块级 `scoreBase` 增加 policy 首参：

```ts
function scoreBase(policy: RoutingPolicy, category: string, context: ReturnType<typeof classifyPath>, anchor: ResolvedAnchor, options: ImpactOptions): number {
  return scoreWithPolicy(policy, category as ScoreCategory, context, anchor, options);
}
```

(d) 全部调用点更新：类方法内的 `scoreBase(...)` 改为 `scoreBase(this.routingPolicy, ...)`；`parseRgOutput` 增加 `policy: RoutingPolicy` 参数并透传给内部 `scoreBase` 调用，其唯一调用点在 `rgSummary` 内改为传 `this.routingPolicy`；`finalizeScore` 中的 `legacyRoutingPolicy.confidenceDeltas` 改为 `this.routingPolicy.confidenceDeltas`。用 `rg -n "scoreBase\(|legacyRoutingPolicy" src/agent-router/index.ts` 逐个确认无遗漏后再 build。

- [ ] **Step 5: 运行确认通过**

Run: `npm run build && npm test 2>&1 | tail -5`

Expected: 0 fail。注意：既有单测的 fixture repo 名是 mkdtemp 随机名 → 走 generic policy；若有测试因 policy 切换失败，说明该测试依赖了 lishuedu 专有加分，改法是在该测试的 Router 构造处显式传 `lishueduLegacyPolicy`（第 6 参），不放宽断言。

- [ ] **Step 6: Commit**

```bash
git add src/routing-policy.ts src/routing-policy.test.ts src/agent-router/index.ts src/agent-router.test.ts
git commit -m "refactor(policy): split lishuedu-specific rules and resolve per repo"
```

- [ ] **Step 7: 卫生项真实仓库 gate**

cipherlink/exam 默认切到 generic，lishuedu 仍走 legacy：

```bash
npm run build
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-lishuedu.json 2> /tmp/rp-g1-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-cipherlink.json 2> /tmp/rp-g1-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-exam.json 2> /tmp/rp-g1-exam.err
# 诊断（不参与 PASS 判定）：量化 lishuedu 专有规则的过拟合债——同一仓库强制走 generic policy 对照
JAVA_LSP_ROUTING_POLICY=generic-java node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-lishuedu-generic.json 2> /tmp/rp-g1-lishuedu-generic.err
```

**诊断解读（`rp-g1-lishuedu.json` vs `rp-g1-lishuedu-generic.json`，逐场景对比 recall/precision/must）：**

- 差值小（recall 降幅 < 0.02 且 must 不回退）→ 专有规则基本无实际贡献，在报告中建议后续删除 `lishueduLegacyPolicy`，lishuedu 也默认 generic。
- 差值大 → 在报告中列出依赖专有规则的具体场景与 golden 文件（预期集中在 dto/parser），标注为"背答案债"；这些文件是 Phase 1/3 结构召回（import 边 / 持久边）应真实补齐的对象，不新增任何字符串规则去填补。
- 该诊断只产出结论，不触发本任务内的代码改动。

**PASS 标准：**

| 检查 | 标准 |
|---|---|
| lishuedu 全指标 | 与 Task 7/10 收官基线完全一致（仍是 legacy policy） |
| cipherlink / exam `R_read_must` | = 1.0000 |
| cipherlink / exam recall | ≥ 收官基线 − 0.02 |
| cipherlink / exam precision | ≥ 收官基线 − 0.03（预期持平或上升） |

**FAIL 处理**：若 cipherlink/exam 回退，逐个把疑似依赖的词（最可能是 port 的 `Report`）从 lishuedu-only 升回 shared 重测；一次一个词并记录。彻底不通过则保留代码但把 `resolveRoutingPolicy` 默认分支临时改回 `lishueduLegacyPolicy`（等价于现状）并在报告中说明。

- [ ] **Step 8: 写卫生项验收报告并提交**

新建 `docs/java-lsp-mcp-routing-policy-split-report-<当天日期>.md`，记录规则拆分清单、三仓对照表、任何升回 shared 的词及理由，以及 **lishuedu legacy vs generic 的过拟合债诊断结论**（差值、依赖专有规则的场景清单、是否建议删除 legacy policy）。

```bash
git add docs/java-lsp-mcp-routing-policy-split-report-*.md
git commit -m "docs(policy): routing policy split verification report"
```

---

## 最终验收矩阵

全部 11 个任务完成后，一次性复核：

| Check | 命令 / 依据 | PASS 条件 |
|---|---|---|
| Build | `npm run build` | 退出 0 |
| Unit tests | `npm test` | 0 fail；相对 77/73 基线净增约 26 个 pass（Task 1–11 合计新增测试数） |
| 三仓 cold hard gate | Task 7/10/11 的最终 benchmark 输出 | `R_read_must=1.0000` × 3 |
| absent 缺口 | exam attribution | `no-type-edge` ≤ 2（基线 5） |
| readplan-full 缺口 | cipherlink attribution | `shouldBlocksTask full` ≤ 8（基线 12） |
| P_read 不塌 | slot=6 | cipherlink ≥ 0.50、lishuedu ≥ 0.75 |
| 默认行为边界 | 代码审查 | `defaultReadPlanMax` 未改；MCP tool schema 未改；无 warm 调度 |
| Git | `git log --oneline` | 每任务独立 commit，gate 报告入库 |

## 明确不做（本计划边界）

- method-body / method-call graph 扫描（Task 4 报告已否决，触发条件未满足）。
- warm references 并发/批量调度、profile-aware warm 默认化、timeout-degrade（platform proof 的 Do-Not-Do-Now 全部沿用）。
- EdgeStore 的后台批量建边调度器——建边动作只由显式 `semanticPolicy=required` 触发；调度器需等 SLO 证据，另立计划。
- readPlan 分页/续传协议（改公共契约，收益未证）。
- 配额的环境变量配置面——配额是常量，改值走 benchmark 对照 + commit。

## 已知限制与假设

1. **import 边假设**：exam 的 material absent 能被 import 边覆盖是基于报告场景描述的推断。Task 4 gate 就是这个假设的验证点；若 `no-type-edge` 降不到 ≤2，按 FAIL 处理流程收缩而不是加扫描器。
2. **通配符与 static import**：`import com.foo.*;` 不产生边；未缓存文件的 static import 不被 rg fallback 命中。均为精度换成本的有意取舍。
3. **配额初值是先验**：`classQuotas` 的取值由 Task 7 实测校准，计划中的数字不是承诺。
4. **EdgeStore 失效粒度**：只看 anchor 文件 mtime，target 文件内容变化（行号漂移）不失效——候选文件路径仍正确，读窗口可能偏移，属可接受降级；`readWindow` 的 method 对齐逻辑会部分纠偏。
5. **benchmark cache 隔离**：Task 10 gate 依赖 warm/cold 进程共享 `repoCacheRoot`；若隔离则按该任务 Step 6 的手工验证路径执行。
6. **golden 样本量**：全部 gate 基于 15 个场景，配额过拟合风险存在；决策备忘 §4 的 golden 扩充仍应并行推进（不在本计划内）。

## 执行者提醒

- 本仓测试跑的是 `dist/` 产物：**每次改 `src/` 后必须先 `npm run build` 再跑测试**。
- 工作区可能存在计划外的脏改动（未跟踪报告等），不要回退或纳入 commit；`git add` 只加计划列出的文件。
- 真实仓库 benchmark 前先确认三个业务 repo 的 commit 与最近报告快照一致（`git -C <repo> rev-parse --short HEAD`），漂移则先重跑基线再对照。
- 每个 gate 的 FAIL 处理路径已写明；禁止用"调字符串权重 / 扩容量 / 放宽断言"绕过 gate。
