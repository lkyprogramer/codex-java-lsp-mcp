# 冷路径排序精度改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 Task 实施。步骤用 `- [ ]` checkbox 跟踪。

**Goal:** 在 `recall 不降`、`rReadMust=1.0` 前提下，用结构信号重权 + 结构感知断崖截断减少返回候选数，拿到 `precision↑` 与 `raw token↓`。

**Architecture:** 新增 `src/agent-router/ranking-signals.ts` 放四个纯函数结构信号（S1 注解协作 / S2 包邻近 / S3 对称类型 / S4 kind 配对）；`finalizeScore` 首轮只接入加法信号；`finalizeRank` 的 `sort` 之后用 `truncateCandidateTail` 截断 readPlan 覆盖之外的纯字符串尾部，并由截断函数内部强制保留 readPlan 覆盖候选。纯字符串权重下调后置为可选 Batch C，只在 benchmark 收益不足时单独执行。

**Tech Stack:** TypeScript（ESM）、`node:test` + `node:assert/strict`、ripgrep、JDT LS（冷路径不启用）。

**Spec:** `docs/superpowers/specs/2026-06-25-cold-path-ranking-precision-design.md`
**代码基线:** `main`，commit `753e947`（Batch 2 after，已合入 `origin/main`）。计划内行号/签名以该基线为准，执行时以实际为准。

**测试运行方式:** 本仓库测试 build 后跑 dist：`npm run build && npm test`（`npm test` = `node --test "dist/**/*.test.js"`）。单个测试用 `node --test --test-name-pattern="<name>" "dist/**/*.test.js"`。

**执行批次:** Batch A = Task 1-3（结构加法）；Batch B = Task 5（L2 截尾）+ Task 6（benchmark）；Batch C = Task 4（字符串降权，可选，只有 Batch B 收益不足且 recall/readPlan 门槛稳定时执行）。

---

## Task 1: 新建 `ranking-signals.ts` + S1 注解协作 + S2 包邻近

纯函数信号，单测驱动，不依赖仓库 fixture。

**Files:**
- Create: `src/agent-router/ranking-signals.ts`
- Test: `src/ranking-signals.test.ts`

- [ ] **Step 1: 写失败测试** —— 创建 `src/ranking-signals.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { annotationCollaborationDelta, packageProximityDelta } from "./agent-router/ranking-signals.js";

test("annotationCollaborationDelta rewards known stereotype collaboration (symmetric)", () => {
  assert.equal(annotationCollaborationDelta(["@Service"], ["@Repository"]), 50);
  assert.equal(annotationCollaborationDelta(["@RestController"], ["@Service"]), 50);
  // backward direction also counts as collaboration
  assert.equal(annotationCollaborationDelta(["@Repository"], ["@Service"]), 50);
});

test("annotationCollaborationDelta ignores non-collaborating or missing stereotypes", () => {
  assert.equal(annotationCollaborationDelta(["@Repository"], ["@Controller"]), 0);
  // candidate carries only method annotations -> no stereotype -> 0
  assert.equal(annotationCollaborationDelta(["@Service"], ["@Override", "@GetMapping"]), 0);
  // fully-qualified annotation still resolves to its simple name
  assert.equal(annotationCollaborationDelta(["@org.springframework.stereotype.Service"], ["@Repository"]), 50);
});

test("packageProximityDelta grades by shared package prefix depth", () => {
  assert.equal(packageProximityDelta("a.b.c.d.e", "a.b.c.d.e"), 30); // same package
  assert.equal(packageProximityDelta("a.b.c.d.e", "a.b.c.d.f"), 18); // same family: ≥3 shared, differ only in last
  assert.equal(packageProximityDelta("a.b.x", "a.b.y"), 0); // shallow shared prefix (2 segments) is not enough
  assert.equal(packageProximityDelta("a.b.c.d.e.f.g", "a.b.c.d.x.y.z"), 8); // shared prefix depth 4 but far tails
  assert.equal(packageProximityDelta("a.b.c", "x.y.z"), 0); // no shared prefix
  assert.equal(packageProximityDelta(undefined, "a.b"), 0); // missing package
});
```

- [ ] **Step 2: build 验证失败**

Run: `npm run build`
Expected: FAIL —— `Cannot find module './agent-router/ranking-signals.js'`（实现文件尚未创建）。

- [ ] **Step 3: 实现** —— 创建 `src/agent-router/ranking-signals.ts`

```ts
// input: Annotation lists and package names from resolved anchor / candidate facts.
// output: Additive cold-path ranking deltas (S1 annotation collaboration, S2 package proximity).
// pos: Pure ranking-signal helpers extracted from agent-router for unit testing.

const STEREOTYPE_NAMES = new Set([
  "Controller", "RestController", "Service", "AppService", "QueryAppService",
  "Repository", "Mapper", "Component", "Configuration", "Entity", "Table"
]);

// Forward collaboration: anchor stereotype -> downstream collaborator stereotypes it commonly drives.
const STEREOTYPE_COLLABORATION: Record<string, string[]> = {
  Controller: ["Service", "AppService", "QueryAppService"],
  RestController: ["Service", "AppService", "QueryAppService"],
  Service: ["Repository", "Mapper", "Component", "Service", "Configuration"],
  AppService: ["Repository", "Mapper", "Service"],
  QueryAppService: ["Repository", "Mapper", "Service"],
  Repository: ["Mapper", "Entity", "Table"],
  Mapper: ["Entity", "Table"],
  Component: ["Service", "Repository", "Component"]
};

export function stereotypeOf(annotations: string[]): string | undefined {
  for (const annotation of annotations) {
    const withoutAt = annotation.replace(/^@/, "");
    const simple = withoutAt.slice(withoutAt.lastIndexOf(".") + 1);
    if (STEREOTYPE_NAMES.has(simple)) {
      return simple;
    }
  }
  return undefined;
}

export function annotationCollaborationDelta(anchorAnnotations: string[], candidateAnnotations: string[]): number {
  const anchorStereotype = stereotypeOf(anchorAnnotations);
  const candidateStereotype = stereotypeOf(candidateAnnotations);
  if (!anchorStereotype || !candidateStereotype) {
    return 0;
  }
  const forward = (STEREOTYPE_COLLABORATION[anchorStereotype] || []).includes(candidateStereotype);
  const backward = (STEREOTYPE_COLLABORATION[candidateStereotype] || []).includes(anchorStereotype);
  return forward || backward ? 50 : 0;
}

export function packageProximityDelta(anchorPackage: string | undefined, candidatePackage: string | undefined): number {
  if (!anchorPackage || !candidatePackage) {
    return 0;
  }
  if (anchorPackage === candidatePackage) {
    return 30;
  }
  const anchorSegments = anchorPackage.split(".");
  const candidateSegments = candidatePackage.split(".");
  const limit = Math.min(anchorSegments.length, candidateSegments.length);
  let common = 0;
  while (common < limit && anchorSegments[common] === candidateSegments[common]) {
    common += 1;
  }
  if (common === 0) {
    return 0;
  }
  const anchorGap = anchorSegments.length - common;
  const candidateGap = candidateSegments.length - common;
  if (common >= 3 && anchorGap <= 1 && candidateGap <= 1) {
    return 18; // same immediate package family (≥3 shared segments, differ in ≤1 trailing)
  }
  return common >= 4 ? 8 : 0; // deep shared prefix only
}
```

- [ ] **Step 4: build + test 通过**

Run: `npm run build && node --test --test-name-pattern="annotationCollaborationDelta|packageProximityDelta" "dist/**/*.test.js"`
Expected: PASS（3 tests, 0 fail）。

- [ ] **Step 5: commit**

```bash
git add src/agent-router/ranking-signals.ts src/ranking-signals.test.ts
git commit -m "feat(ranking): 增加 S1 注解协作与 S2 包邻近信号"
```

## Task 2: S3 对称类型关系 + S4 kind 配对

接收 `JavaSourceFacts`，纯函数。补全现有 `typeRelationDelta` 只判「候选是 anchor 子类型」的另一半（anchor 是候选子类型）+ port 接口/实现配对。

**Files:**
- Modify: `src/agent-router/ranking-signals.ts`
- Test: `src/ranking-signals.test.ts`（追加）

- [ ] **Step 1: 写失败测试** —— 向 `src/ranking-signals.test.ts` 顶部 import 区追加，并追加测试

```ts
import { symmetricTypeRelationDelta, kindPairingDelta } from "./agent-router/ranking-signals.js";
import type { JavaSourceFacts } from "./source-index.js";

function facts(partial: Partial<JavaSourceFacts>): JavaSourceFacts {
  return { absolutePath: "/x.java", implementsTypes: [], annotations: [], methods: [], factSource: "regex", ...partial };
}

test("symmetricTypeRelationDelta rewards when anchor is a subtype of the candidate", () => {
  const anchor = facts({ typeName: "OrderServiceImpl", implementsTypes: ["OrderService"] });
  const candidate = facts({ typeName: "OrderService", kind: "interface" });
  assert.equal(symmetricTypeRelationDelta(anchor, candidate), 95);
  // reverse direction is the job of the existing typeRelationDelta, not this one
  assert.equal(symmetricTypeRelationDelta(candidate, anchor), 0);
});

test("kindPairingDelta rewards interface×impl only under port profile", () => {
  const port = facts({ typeName: "StorageGateway", kind: "interface" });
  const impl = facts({ typeName: "OssStorageGateway", kind: "class", implementsTypes: ["StorageGateway"] });
  assert.equal(kindPairingDelta(port, impl, "port"), 20);
  assert.equal(kindPairingDelta(port, impl, "service"), 0); // non-port profile
  const unrelated = facts({ typeName: "Foo", kind: "class", implementsTypes: ["Bar"] });
  assert.equal(kindPairingDelta(port, unrelated, "port"), 0); // does not implement the anchor interface
});
```

- [ ] **Step 2: build 验证失败**

Run: `npm run build`
Expected: FAIL —— `symmetricTypeRelationDelta`/`kindPairingDelta` 未从 `ranking-signals.js` 导出。

- [ ] **Step 3: 实现** —— 在 `src/agent-router/ranking-signals.ts` 顶部加 import，并在文件末尾追加

```ts
// 顶部（与现有内容并列，置于文件首行注释之后）：
import type { JavaSourceFacts } from "../source-index.js";

// 文件末尾追加：
function simpleName(value: string): string {
  const withoutGenerics = value.replace(/<.*$/, "");
  return withoutGenerics.slice(withoutGenerics.lastIndexOf(".") + 1);
}

export function symmetricTypeRelationDelta(anchorFacts: JavaSourceFacts, candidateFacts: JavaSourceFacts): number {
  const candidateTypeName = candidateFacts.typeName;
  if (!candidateTypeName) {
    return 0;
  }
  const anchorParents = [...anchorFacts.implementsTypes, anchorFacts.extendsType || ""]
    .map(simpleName)
    .filter(Boolean);
  return anchorParents.includes(candidateTypeName) ? 95 : 0;
}

export function kindPairingDelta(anchorFacts: JavaSourceFacts, candidateFacts: JavaSourceFacts, profile: string): number {
  if (profile !== "port" || anchorFacts.kind !== "interface" || candidateFacts.kind !== "class") {
    return 0;
  }
  const anchorTypeName = anchorFacts.typeName;
  if (!anchorTypeName) {
    return 0;
  }
  const candidateParents = [...candidateFacts.implementsTypes, candidateFacts.extendsType || ""].map(simpleName);
  return candidateParents.includes(anchorTypeName) ? 20 : 0;
}
```

- [ ] **Step 4: build + test 通过**

Run: `npm run build && node --test --test-name-pattern="symmetricTypeRelationDelta|kindPairingDelta" "dist/**/*.test.js"`
Expected: PASS（2 tests, 0 fail）。

- [ ] **Step 5: commit**

```bash
git add src/agent-router/ranking-signals.ts src/ranking-signals.test.ts
git commit -m "feat(ranking): 增加 S3 对称类型关系与 S4 kind 配对信号"
```

## Task 3: 接入 `finalizeScore`（L1 加法）

把 S1–S4 接到打分主链路（纯加法，先不动字符串权重）。端到端验证真协作候选被打上结构分。

**Files:**
- Modify: `src/agent-router/index.ts`（import；新增 `structuralDeltas` method；`finalizeScore` 内加 4 行）
- Test: `src/agent-router.test.ts`（追加）

- [ ] **Step 1: 写失败测试** —— 向 `src/agent-router.test.ts` 追加

```ts
test("L1 structural signals are scored on a real collaborator candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-l1-"));
  const base = path.join(root, "modules", "order", "src", "main", "java", "com", "x", "order");
  await mkdir(path.join(base, "app"), { recursive: true });
  await mkdir(path.join(base, "infra"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(base, "app", "OrderService.java"), [
    "package com.x.order.app;",
    "@Service",
    "public class OrderService { public void placeOrder() { } }",
    ""
  ].join("\n"));
  await writeFile(path.join(base, "infra", "OrderRepository.java"), [
    "package com.x.order.infra;",
    "@Repository",
    "public class OrderRepository { public void saveOrder(Long orderId) { } }",
    ""
  ].join("\n"));

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "modules/order/src/main/java/com/x/order/app/OrderService.java", line: 3, column: 21 }],
    taskKeywords: ["order"],
    verbosity: "diagnostic"
  }));

  const repo = result.files.find(file => String(file.path).endsWith("OrderRepository.java"));
  assert.ok(repo, "OrderRepository should be returned as a candidate");
  const breakdown = new Map(((repo.scoreBreakdown as Array<{ id: string; delta: number }>) || []).map(item => [item.id, item.delta]));
  assert.equal(breakdown.get("finalize.structural.annotation"), 50); // @Service × @Repository
  assert.equal(breakdown.get("finalize.structural.package"), 18);    // com.x.order.app vs com.x.order.infra
});
```

- [ ] **Step 2: build + test 验证失败**

Run: `npm run build && node --test --test-name-pattern="L1 structural signals are scored" "dist/**/*.test.js"`
Expected: FAIL —— `breakdown.get(...)` 为 `undefined`（`finalizeScore` 尚未产出 `finalize.structural.*`）。build 本身应通过。

> 若 `assert.ok(repo)` 先失败，说明 rg 未召回 OrderRepository——检查 anchor `taskKeywords`/profile，确认候选被召回后再继续。

- [ ] **Step 3: 实现** —— 修改 `src/agent-router/index.ts`

1. 顶部 import 区追加：

```ts
import { annotationCollaborationDelta, packageProximityDelta, symmetricTypeRelationDelta, kindPairingDelta } from "./ranking-signals.js";
import type { JavaSourceFacts } from "../source-index.js";
```

2. 在 `typeRelationDelta` method（约 `:564-575`）之后，新增 method。实现时复用现有 `simpleTypeName()` 口径；`typeRelation` 与 S3/S4 共用同一次 `candidateFacts` 读取，避免重复 `factsFor()`：

```ts
private structuralDeltas(candidate: CandidateFile, anchor: ResolvedAnchor, anchorFacts?: JavaSourceFacts): {
  annotation: number; packageProximity: number; typeRelation: number; typeSymmetric: number; kind: number;
} {
  const zero = { annotation: 0, packageProximity: 0, typeRelation: 0, typeSymmetric: 0, kind: 0 };
  if (!anchorFacts || candidate.absolutePath === anchor.absolutePath || !candidate.absolutePath.endsWith(".java")) {
    return zero;
  }
  try {
    const candidateFacts = this.sourceIndex.factsFor(candidate.absolutePath);
    const candidateParents = [...candidateFacts.implementsTypes, candidateFacts.extendsType || ""].map(simpleTypeName);
    return {
      annotation: annotationCollaborationDelta(anchorFacts.annotations, candidateFacts.annotations),
      packageProximity: packageProximityDelta(anchorFacts.packageName, candidateFacts.packageName),
      typeRelation: anchor.className && candidateParents.includes(anchor.className) ? 95 : 0,
      typeSymmetric: symmetricTypeRelationDelta(anchorFacts, candidateFacts),
      kind: kindPairingDelta(anchorFacts, candidateFacts, anchor.profile)
    };
  } catch {
    return zero;
  }
}
```

3. 将 `finalizeScore` 增加可选 `anchorFacts` 参数；`finalizeRank` 在 `.map(...)` 前先算一次 `anchorFacts`，再传入每个候选。替换现有 `finalize.type-relation` 读取逻辑为结构 delta：

```ts
const structural = this.structuralDeltas(candidate, anchor, anchorFacts);
score += addScoreDelta(scoreBreakdown, "finalize.type-relation", structural.typeRelation, "implements or extends anchor type");
score += addScoreDelta(scoreBreakdown, "finalize.structural.annotation", structural.annotation, "stereotype collaboration");
score += addScoreDelta(scoreBreakdown, "finalize.structural.package", structural.packageProximity, "package proximity");
score += addScoreDelta(scoreBreakdown, "finalize.structural.type-symmetric", structural.typeSymmetric, "anchor is candidate subtype");
score += addScoreDelta(scoreBreakdown, "finalize.structural.kind", structural.kind, "interface-impl pairing");
```

`anchorFacts` 获取失败时按 `undefined` 处理，所有结构信号返回 0；不要让结构加分阻断原有路由。

- [ ] **Step 4: build + test 通过**

Run: `npm run build && npm test`
Expected: 全量 PASS（现有 + 新增），0 fail。`rReadMust` 相关现有 lishuedu 测试若有 `LISHUEDU_ROOT` 则不回退。

- [ ] **Step 5: commit**

```bash
git add src/agent-router/index.ts src/agent-router.test.ts
git commit -m "feat(ranking): 将 S1-S4 结构信号接入 finalizeScore（加法）"
```

## Task 4: 可选 Batch C：L1 减法（字符串权重下调 + 重排 `finalizeScore`）

默认不执行。本节只在 Task 6 证明「S1-S4 加法 + L2 截尾」收益不足，且 `recall/rReadMust/readPlan` 稳定后单独执行。不要和 Task 3/5 混在同一个提交里，否则 benchmark 退化时无法归因。

把纯字符串权重的「封顶 + 折扣」抽成可单测纯函数；重排 `finalizeScore`，使结构信号先算出 `hasStructural`，再据此折扣 `match-count`/`task-keyword`。

**Files:**
- Modify: `src/agent-router/ranking-signals.ts`（追加 `downWeightedStringDeltas`）
- Modify: `src/agent-router/index.ts`（import；重写 `finalizeScore`）
- Test: `src/ranking-signals.test.ts`（追加）

- [ ] **Step 1: 写失败测试** —— 向 `src/ranking-signals.test.ts` 追加

```ts
import { downWeightedStringDeltas } from "./agent-router/ranking-signals.js";

test("downWeightedStringDeltas caps match-count and discounts when no structural signal", () => {
  assert.equal(downWeightedStringDeltas(100, false, true).matchCount, 28);  // capped at 28
  assert.equal(downWeightedStringDeltas(100, false, false).matchCount, 17); // 28*0.6=16.8 -> 17
  assert.equal(downWeightedStringDeltas(5, false, true).matchCount, 8);     // min(28, 5*1.6)=8
  assert.equal(downWeightedStringDeltas(0, true, true).taskKeyword, 22);    // full when structural
  assert.equal(downWeightedStringDeltas(0, true, false).taskKeyword, 13);   // 22*0.6=13.2 -> 13
  assert.equal(downWeightedStringDeltas(0, false, true).taskKeyword, 0);    // no keyword hit
});
```

- [ ] **Step 2: build 验证失败**

Run: `npm run build`
Expected: FAIL —— `downWeightedStringDeltas` 未导出。

- [ ] **Step 3: 实现**

(a) 向 `src/agent-router/ranking-signals.ts` 末尾追加：

```ts
export function downWeightedStringDeltas(matchCount: number, taskKeywordHit: boolean, hasStructural: boolean): { matchCount: number; taskKeyword: number } {
  const discount = hasStructural ? 1 : 0.6;
  return {
    matchCount: Math.round(Math.min(28, matchCount * 1.6) * discount),
    taskKeyword: taskKeywordHit ? Math.round(22 * discount) : 0
  };
}
```

(b) `src/agent-router/index.ts` 顶部 import 追加 `downWeightedStringDeltas`（并入 Task 3 的 import 行）。

(c) 基于 Task 3 形状替换 `finalizeScore` method（`:533-561`，已含 `anchorFacts` 参数）：

```ts
private finalizeScore(candidate: CandidateFile, anchor: ResolvedAnchor, options: ImpactOptions, suppressed: Record<string, number>, anchorFacts?: JavaSourceFacts): CandidateFile {
  const scoreBreakdown = [...(candidate.scoreBreakdown || [breakdown("unknown.initial", "policy", candidate.score, "initial candidate score")])];
  let score = candidate.score;

  // Structural signals first, so string signals can be discounted when no structural relation exists.
  const focusModule = Boolean(candidate.module && options.focusModules.includes(candidate.module));
  if (focusModule) {
    score += addScoreDelta(scoreBreakdown, "finalize.focus-module", 35, "focus module");
  }
  const directCollab = directCollaboratorDelta(candidate, anchor, options);
  score += addScoreDelta(scoreBreakdown, "finalize.direct-collaborator", directCollab, "direct type-name collaborator");
  const structural = this.structuralDeltas(candidate, anchor, anchorFacts);
  score += addScoreDelta(scoreBreakdown, "finalize.type-relation", structural.typeRelation, "implements or extends anchor type");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.annotation", structural.annotation, "stereotype collaboration");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.package", structural.packageProximity, "package proximity");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.type-symmetric", structural.typeSymmetric, "anchor is candidate subtype");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.kind", structural.kind, "interface-impl pairing");
  const hasStructural = focusModule || structural.typeRelation > 0 || directCollab > 0 ||
    structural.annotation > 0 || structural.packageProximity > 0 || structural.typeSymmetric > 0 || structural.kind > 0;

  // String signals: capped, and discounted when the candidate has no structural relation to the anchor.
  const keywordHit = Boolean(candidate.path && matchesAny(candidate.path, options.taskKeywords));
  const stringDeltas = downWeightedStringDeltas(candidate.matchCount, keywordHit, hasStructural);
  score += addScoreDelta(scoreBreakdown, "finalize.match-count", stringDeltas.matchCount, "match count");
  if (keywordHit) {
    score += addScoreDelta(scoreBreakdown, "finalize.task-keyword", stringDeltas.taskKeyword, "task keyword");
  }

  if (candidate.sourceSet === "test" && options.testReadMode === "defer") {
    score += addScoreDelta(scoreBreakdown, "finalize.defer-test", -10, "defer test candidate");
    suppressed.deferredTests += 1;
  }
  if (candidate.module && candidate.module !== anchor.module && options.crossModulePolicy !== "all") {
    if (!options.focusModules.includes(candidate.module) && !keywordHit) {
      score += addScoreDelta(scoreBreakdown, "finalize.cross-module", options.crossModulePolicy === "focused" ? -80 : -20, "cross module policy");
      suppressed.crossModuleConsumers += 1;
    }
  }
  score += addScoreDelta(scoreBreakdown, "finalize.confidence", legacyRoutingPolicy.confidenceDeltas[candidate.confidence || "medium"], "confidence delta");
  const finalScore = Math.max(1, score);
  if (finalScore !== score) {
    addScoreDelta(scoreBreakdown, "finalize.clamp", finalScore - score, "minimum score clamp");
  }
  return { ...candidate, score: finalScore, scoreBreakdown };
}
```

- [ ] **Step 4: build + 全量 test 通过**

Run: `npm run build && npm test`
Expected: 全量 PASS，0 fail。若有 `LISHUEDU_ROOT`，现有 lishuedu 路由/读预算测试不回退（权重下调是温和的，须复核 `result.readPlan.length===6` 等断言仍成立；若某断言因排序变动失败，记录并在 Task 6 benchmark 阶段评估，不可放宽 `rReadMust`）。

- [ ] **Step 5: commit**

```bash
git add src/agent-router/ranking-signals.ts src/agent-router/index.ts src/ranking-signals.test.ts
git commit -m "feat(ranking): L1 下调纯字符串权重并对无结构信号候选折扣"
```

## Task 5: Batch B：L2 结构感知断崖截断 + 接入 `finalizeRank`

`truncateCandidateTail` 纯函数（含 `hasProtectedStructuralSignal`），单测覆盖断崖/动态上限/floor/启用阈值/保护，再接入 `finalizeRank`。`packageProximity` 只参与加分，不进入保护集，避免弱包邻近保护过多噪声候选。

**Files:**
- Modify: `src/agent-router/ranking-signals.ts`（追加 `hasProtectedStructuralSignal`、`truncateCandidateTail`）
- Modify: `src/agent-router/index.ts`（import；重写 `finalizeRank`）
- Test: `src/ranking-signals.test.ts`（追加）

- [ ] **Step 1: 写失败测试** —— 向 `src/ranking-signals.test.ts` 追加

```ts
import { hasProtectedStructuralSignal, truncateCandidateTail } from "./agent-router/ranking-signals.js";
import type { CandidateFile, ScoreBreakdownItem } from "./agent-types.js";

function cand(absolutePath: string, score: number, breakdown: ScoreBreakdownItem[]): CandidateFile {
  return { absolutePath, score, matchCount: 0, positions: [], categories: [], reasons: [], scoreBreakdown: breakdown } as CandidateFile;
}
function strong(absolutePath: string, score: number): CandidateFile {
  return cand(absolutePath, score, [{ id: "finalize.direct-collaborator", source: "finalize", delta: 170, reason: "x" }]);
}
function noise(absolutePath: string, score: number): CandidateFile {
  return cand(absolutePath, score, [{ id: "finalize.match-count", source: "finalize", delta: 10, reason: "x" }]);
}

test("hasProtectedStructuralSignal reads positive protected deltas from scoreBreakdown", () => {
  assert.equal(hasProtectedStructuralSignal(strong("/a.java", 100)), true);
  assert.equal(hasProtectedStructuralSignal(noise("/b.java", 100)), false);
  const zero = cand("/c.java", 1, [{ id: "finalize.structural.package", source: "finalize", delta: 0, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(zero), false);
  const weakPackage = cand("/d.java", 10, [{ id: "finalize.structural.package", source: "finalize", delta: 8, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(weakPackage), false); // package proximity scores but does not protect
  const weakAnnotation = cand("/e.java", 10, [{ id: "finalize.structural.annotation", source: "finalize", delta: 50, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(weakAnnotation), false); // annotation scores but does not protect
  const weakFocus = cand("/f.java", 10, [{ id: "finalize.focus-module", source: "finalize", delta: 35, reason: "" }]);
  assert.equal(hasProtectedStructuralSignal(weakFocus), false); // focus scores but does not protect
});

test("truncateCandidateTail returns input unchanged when 10 or fewer candidates", () => {
  const ranked = Array.from({ length: 9 }, (_, i) => noise(`/n/N${i}.java`, 50 - i));
  assert.equal(truncateCandidateTail(ranked, new Set()).length, 9);
});

test("truncateCandidateTail keeps protected/structural, trims pure-string tail, honors floor", () => {
  const struct = Array.from({ length: 8 }, (_, i) => strong(`/a/S${i}.java`, 200 - i));
  const tail = Array.from({ length: 12 }, (_, i) => noise(`/n/N${i}.java`, 50 - i)); // gentle slope, no cliff
  const ranked = [...struct, ...tail]; // 20 total, score-desc
  const readPlanCovered = new Set<CandidateFile>([struct[0], tail[0]]);
  const result = truncateCandidateTail(ranked, readPlanCovered);
  assert.ok(struct.every(file => result.includes(file))); // strong structural always kept
  // strong=8 -> budget=4; readPlan-covered tail also protected -> total 13
  assert.equal(result.length, 13);
  assert.ok(result.length < ranked.length);
});

test("truncateCandidateTail cuts at a score cliff inside the discardable tail", () => {
  const struct = Array.from({ length: 8 }, (_, i) => strong(`/s/S${i}.java`, 300 - i)); // 8 strong -> budget=4
  const tail = [noise("/n/A.java", 100), noise("/n/B.java", 95), noise("/n/C.java", 20)]; // cliff: 95 -> 20 (<95*0.5)
  const ranked = [...struct, ...tail]; // 11 total
  const result = truncateCandidateTail(ranked, new Set<CandidateFile>());
  // cliffIdx=2 (C drops below B*0.5); keep=min(budget 4, cliff 2)=2 -> A,B kept, C cut; 8 struct + 2 = 10
  assert.ok(result.some(f => f.absolutePath === "/n/A.java"));
  assert.ok(result.some(f => f.absolutePath === "/n/B.java"));
  assert.ok(!result.some(f => f.absolutePath === "/n/C.java"));
});

test("truncateCandidateTail skips tail trimming when structural evidence is too thin", () => {
  const struct = Array.from({ length: 3 }, (_, i) => strong(`/s/S${i}.java`, 300 - i));
  const tail = Array.from({ length: 9 }, (_, i) => noise(`/n/N${i}.java`, 100 - i));
  const ranked = [...struct, ...tail];
  const result = truncateCandidateTail(ranked, new Set<CandidateFile>(), 20);
  assert.equal(result.length, 12);
});
```

- [ ] **Step 2: build 验证失败**

Run: `npm run build`
Expected: FAIL —— `hasProtectedStructuralSignal`/`truncateCandidateTail` 未导出。

- [ ] **Step 3: 实现**

(a) 向 `src/agent-router/ranking-signals.ts` 追加（顶部 import 区加 `import type { CandidateFile } from "../agent-types.js";`）：

```ts
const STRUCTURAL_SIGNAL_IDS = new Set([
  "finalize.structural.type-symmetric",
  "finalize.structural.kind",
  "finalize.type-relation",
  "finalize.direct-collaborator"
]);
const MIN_STRUCTURAL_EVIDENCE_FOR_TAIL_TRUNCATION = 6;

export function hasProtectedStructuralSignal(candidate: CandidateFile): boolean {
  return (candidate.scoreBreakdown || []).some(item => item.delta > 0 && STRUCTURAL_SIGNAL_IDS.has(item.id));
}

// ranked MUST be score-descending. readPlanCovered holds the exact candidate objects that buildReadPlan will use.
export function truncateCandidateTail(ranked: CandidateFile[], readPlanCovered: Set<CandidateFile>, limit = ranked.length): CandidateFile[] {
  if (ranked.length <= 10) {
    return ranked;
  }
  const isProtected = (file: CandidateFile): boolean =>
    readPlanCovered.has(file) ||
    hasProtectedStructuralSignal(file);

  const protectedFiles: CandidateFile[] = [];
  const discardable: CandidateFile[] = []; // inherits score-desc order from ranked
  for (const file of ranked) {
    (isProtected(file) ? protectedFiles : discardable).push(file);
  }
  const structuralCount = ranked.filter(hasProtectedStructuralSignal).length;
  if (structuralCount < MIN_STRUCTURAL_EVIDENCE_FOR_TAIL_TRUNCATION) {
    return limitKeepingProtected(sortByScore(ranked), [...readPlanCovered], limit);
  }
  const dynamicBudget = Math.min(Math.floor(structuralCount * 0.5), 4);
  let cliffIdx = discardable.length;
  for (let i = 1; i < discardable.length; i += 1) {
    if (discardable[i].score < discardable[i - 1].score * 0.5) {
      cliffIdx = i;
      break;
    }
  }
  const keep = Math.min(dynamicBudget, cliffIdx);
  const floor = Math.max(readPlanCovered.size, 8);
  let kept = [...protectedFiles, ...discardable.slice(0, keep)];
  if (kept.length < floor) {
    kept = [...kept, ...discardable.slice(keep, keep + (floor - kept.length))];
  }
  const sorted = kept.sort((left, right) => right.score - left.score || (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  if (sorted.length <= limit) {
    return sorted;
  }
  const protectedSet = new Set(protectedFiles);
  const limited = sorted.filter(file => protectedSet.has(file));
  for (const file of sorted) {
    if (limited.length >= limit) {
      break;
    }
    if (!protectedSet.has(file)) {
      limited.push(file);
    }
  }
  return limited.sort((left, right) => right.score - left.score || (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
}
```

(b) `src/agent-router/index.ts` 顶部 import 追加 `truncateCandidateTail`（并入既有 ranking-signals import 行）。

(c) 用以下完整版**替换** `finalizeRank`（`:577-594`）：

```ts
private finalizeRank(candidates: Map<string, CandidateFile>, anchor: ResolvedAnchor, options: ImpactOptions, suppressed: Record<string, number>): CandidateFile[] {
  let anchorFacts: JavaSourceFacts | undefined;
  try {
    anchorFacts = this.sourceIndex.factsFor(anchor.absolutePath);
  } catch {
    anchorFacts = undefined;
  }
  const ranked = [...candidates.values()]
    .filter(candidate => {
      if (candidate.module && options.excludeModules.includes(candidate.module)) {
        suppressed.excludedModules += 1;
        return false;
      }
      return true;
    })
    .map(candidate => this.finalizeScore(candidate, anchor, options, suppressed, anchorFacts))
    .sort((left, right) => right.score - left.score || (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath));
  const maxItems = options.readPlanMaxItems ?? defaultReadPlanMax(options.mode);
  const readPlanCovered = new Set(
    [...ranked]
      .map(file => ({ file, priority: readPriority(file, options) }))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
      .slice(0, maxItems)
      .map(entry => entry.file)
  );
  return truncateCandidateTail(ranked, readPlanCovered, candidateLimit(options.mode, anchor.profile));
}
```

- [ ] **Step 4: build + 全量 test 通过**

Run: `npm run build && npm test`
Expected: 全量 PASS，0 fail。重点确认（有 `LISHUEDU_ROOT` 时）现有 `result.readPlan.length===6`、`readPlanMaxItems:3 -> 3`、`files.some(...Assembler...)` 等断言不回退。若 readPlan 文件集合变化，必须输出 before/after diff 并说明是否仍满足 `rReadMust=1.0` 与 `pRead` 门槛；不要用“结构保证”掩盖排序变化。

- [ ] **Step 5: commit**

```bash
git add src/agent-router/ranking-signals.ts src/agent-router/index.ts src/ranking-signals.test.ts
git commit -m "feat(ranking): L2 结构感知断崖截断接入 finalizeRank"
```

> **回标 spec:** 实现把 `finalize.direct-collaborator` 纳入保护信号集，并明确 `finalize.structural.package` 只加分、不保护，防止 L2 被弱包邻近噪声钝化。

## Task 6: Benchmark 三项目验证 + 自适应回退 + 写回 guide

非 TDD 的验证收口。硬门槛失败则按 §4.3 调参重跑，而非放宽门槛。需要干净 shell（注意本机 nvm lazy-load 递归问题，必要时用绝对 node 路径）。

**Files:**
- Modify: `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`（追加 Batch 3 验证快照）
- 可能 Modify: `src/agent-router/ranking-signals.ts`（仅当需 §4.3 回退调参）

仓库路径：lishuedu=`/Users/luo/Documents/program/lishu/lishuedu`、cipherlink=`/Users/luo/Documents/program/cipherlink`、exam=`/Users/luo/Documents/program/exam-parent-v3`。

- [ ] **Step 1: 采集 before 基线**（必须在改造前 commit `753e947` 上；若已改造，用 `git worktree add /tmp/ranking-before 753e947` 回采）

```bash
npm run build
for p in "lishuedu:/Users/luo/Documents/program/lishu/lishuedu" "cipherlink:/Users/luo/Documents/program/cipherlink" "exam-parent-v3:/Users/luo/Documents/program/exam-parent-v3"; do
  id="${p%%:*}"; root="${p#*:}"
  node dist/benchmark-agent-impact.js --repo-root "$root" --project-id "$id" --warm-state cold-nolsp --strategy impact --runs 5 > "/tmp/bench-$id-before.json"
done
```

- [ ] **Step 2: 采集 after（改造后当前分支）**

```bash
npm run build
for p in "lishuedu:/Users/luo/Documents/program/lishu/lishuedu" "cipherlink:/Users/luo/Documents/program/cipherlink" "exam-parent-v3:/Users/luo/Documents/program/exam-parent-v3"; do
  id="${p%%:*}"; root="${p#*:}"
  node dist/benchmark-agent-impact.js --repo-root "$root" --project-id "$id" --warm-state cold-nolsp --strategy impact --runs 5 > "/tmp/bench-$id-after.json"
done
node scripts/summarize-impact-benchmark.mjs /tmp/bench-lishuedu-before.json /tmp/bench-lishuedu-after.json
node scripts/summarize-impact-benchmark.mjs /tmp/bench-cipherlink-before.json /tmp/bench-cipherlink-after.json
node scripts/summarize-impact-benchmark.mjs /tmp/bench-exam-parent-v3-before.json /tmp/bench-exam-parent-v3-after.json
```

- [ ] **Step 3: 核对硬门槛**（对每个 after.json 的 `totals`）

- `rReadMust === 1.0`（三项目）。
- `recall >= 基线`：lishuedu `0.7756` / cipherlink `1.0` / exam `1.0`。
- `readingPayload` 相对 before 原则上应持平；若变化，必须输出 readPlan before/after 文件集合与窗口 diff，确认 `rReadMust=1.0` 且 `pRead >= 基线 - 0.02` 后才能判断可接受。
- 目标：lishuedu `precision > 0.3144`；三项目 `rawSearchPayload` 与平均 `returnedFiles` 下降（cipherlink/exam 允许持平）。

**若任一项目 `recall < 基线`或 `rReadMust < 1.0`**：按 §4.3 顺序回退 `src/agent-router/ranking-signals.ts` 常量——优先提高 `MIN_STRUCTURAL_EVIDENCE_FOR_TAIL_TRUNCATION` 或放松 `dynamicBudget`，仍不达标再把 `truncateCandidateTail` 的断崖系数 `0.5` 调到 `0.6`，重跑。记录最终「recall 不降的最激进参数」。

- [ ] **Step 4: 写回 benchmark guide**

在 `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md` 的「本轮验证快照」区追加一节，按下表填实测值：

```markdown
Batch 3 cold-path ranking precision 验证（before = 753e947 / Batch 2 after，cold-nolsp impact runs=5）：

| project | raw before | raw after | raw drop | returnedFiles before | after | precision before | after | recall | R_read_must |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lishuedu | … | … | … | … | … | 0.3144 | … | … | 1.0 |
| cipherlink | … | … | … | … | … | 0.5455 | … | … | 1.0 |
| exam-parent-v3 | … | … | … | … | … | 0.5833 | … | … | 1.0 |

最终 L2 参数：dynamicBudget cap=…，cliff ratio=…。
readPlan diff 结论：…（若 readingPayload 变化，必须列明原因；未变化写 no change）。
```

- [ ] **Step 5: commit**

```bash
git add docs/java-lsp-mcp-benchmark-guide-2026-06-23.md src/agent-router/ranking-signals.ts
git commit -m "test(ranking): Batch 3 冷路径排序精度 benchmark 验证与门槛快照"
```

## 附：计划自审记录

- **Spec 覆盖**：§3.1 → Task 1-3；§3.2 可选后置 → Task 4；§4 → Task 5；§4.3 自适应回退 → Task 6 Step 3；§6 边界 → Task 3 `try/catch`、Task 1 `stereotypeOf` 缺失、Task 5 `≤10`/`floor`；§7 验收 → 各 Task 单测 + Task 6。
- **一致性修正**：① 首轮只做结构加法 + L2 截尾，字符串降权后置为 Batch C；② L2 保护口径收窄为 direct/type/kind/readPlan，不保护 annotation/package/focus；③ `candidateLimit` 由 `truncateCandidateTail` 内部应用，只截非 protected 候选；④ 强结构候选少于 6 时不做尾部裁剪，只做 readPlan-aware limit。
- **已知偏差（已回标 spec）**：原计划把 annotation/focus 纳入 protected，实测在 lishuedu 大模块上会让同层 Service 或同模块候选绕过 limit，导致 raw payload 反增；最终实现保留 annotation/focus 加分，但不用于 L2 保护。
- **实测占位**：Task 6 的 guide 表格已在 `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md` Batch 3 小节填入；Batch C 未执行。
- **执行环境**：测试 build 后跑 dist；benchmark 需干净 shell（本机 nvm lazy-load 递归，必要时用绝对 node 路径）。
