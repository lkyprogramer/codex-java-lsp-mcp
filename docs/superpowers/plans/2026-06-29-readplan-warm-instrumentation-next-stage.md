# readPlan Warm Instrumentation Next Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a measurable next-stage path for `java_impact` warm latency: first add attribution v2 latency instrumentation and a final test report, then decide whether to optimize scheduling, cache warmup, or warm policy.

**Architecture:** Keep cold `impact` behavior as the default and do not implement Task 3/4/5 in this plan. The first patch is instrument-only: benchmark JSON must expose warm prepare, router phase, session phase, and LSP request timings so the warm-auto `semantic.used=false` 1.5s P95 can be explained before any scheduling change.

**Tech Stack:** TypeScript, Node test runner, existing `AgentRouter.metrics.phaseMs`, existing `JdtlsSession.drainPhaseMetrics()`, benchmark JSONL golden files, Markdown reports.

---

## Decision Record

### Accepted Conclusions

- Cold recall is at the current value plateau: all three real repos hold `R_read_must=1.0000`; remaining recall gaps are `should` / `side`, not hard gate failures.
- `warm-required` improves recall but is not defaultable today: latest P95 ratios vs cold are lishuedu `25.43x`, cipherlink `48.09x`, exam-parent-v3 `63.19x`.
- Task 3/4/5 stay downgraded to attribution-triggered repair templates. They are not the next mainline.

### Correction To Previous Direction

The first proof point is not "parallelize serialized semantic calls".

Reason: lishuedu `warm-auto` had `semantic.used=false` but still had `P95 1604.12ms`. That disproves "serialized semantic calls are the proven first bottleneck". `warm-required` also shows a bimodal shape: low P50 after cache hit, high P95 on first-touch miss. The first move must be instrumentation, not scheduling.

### New SLO

Do not use `warm-required P95 <= cold P95 * 5` as the main warm SLO. Cold is pure local no-LSP work; `5x` gives only `119-330ms`, which is below realistic first-touch LSP round-trip cost and would permanently ban useful warm semantic paths.

Use absolute gates:

| Gate | Target | Meaning |
|---|---:|---|
| `warm-auto` no-semantic P95 | `<= 300ms` | If semantic is not used, warm mode must not add a 1.5s fixed cost. |
| `warm-required` first-touch P95 | `<= 800ms` | Profile-aware warm can only be considered under this line. |
| `warm-required` cache-hit P50 | `<= 100ms` | Repeated agent calls should stay close to local routing cost. |
| `semantic timeout logs` | `0` | No `textDocument/implementation` / `references` timeout in defaultable path. |
| `R_read_must` | `1.0000` | Warm optimization must not break readPlan correctness. |

These are decision gates, not Task 1 pass/fail gates. Task 1 only proves where time is going.

## Files

- Modify: `src/benchmark-agent-impact.ts`
  - Add benchmark-level timing fields to impact attempts.
  - Measure `prepareWarmState` outside attempts.
  - Drain `JdtlsSession` phase metrics after warm preparation and after each impact attempt.
- Modify: `src/agent-router/index.ts`
  - Add coarse `phaseMs` buckets around currently unmeasured routing sections.
  - No ranking or candidate behavior changes.
- Modify: `src/jdtls-session.ts`
  - Add per-LSP-method request duration and timeout counters into existing `phaseMetrics`.
  - Reuse `addPhaseMetric`; do not add a new telemetry framework.
- Modify: `src/benchmark-agent-impact.test.ts`
  - Assert benchmark JSON exposes timing fields for impact runs and keeps no-lsp output stable.
- Create: `docs/java-lsp-mcp-warm-instrumentation-report-2026-06-29.md`
  - Final output report for Task 1.
- Optionally modify later: `docs/java-lsp-mcp-readplan-next-stage-decision-2026-06-26.md`
  - Only after report proves the new SLO and first bottleneck.

## Output JSON Contract

Add these fields only to benchmark JSON. Do not change MCP public tool options.

```json
{
  "metadata": {
    "prepareWarmMs": 0,
    "prepareWarmPhaseMs": {
      "ensureStart": 0,
      "progressIdleWait": 0,
      "textDocument/documentSymbol": 0
    }
  },
  "rows": [
    {
      "attempts": [
        {
          "timing": {
            "phaseMs": {
              "sourceStatusBefore": 0,
              "rg": 0,
              "nonLspReadPlan": 0,
              "semantic": 0,
              "semanticVerify": 0,
              "finalizeRank": 0,
              "buildReadPlan": 0
            },
            "sessionPhaseMs": {
              "ensureStart": 0,
              "textDocument/definition": 0,
              "textDocument/implementation": 0,
              "textDocument/references": 0,
              "typeHierarchy/subtypes": 0
            },
            "semantic": {
              "used": false,
              "skipped": true,
              "timeout": false,
              "verifyUsed": false,
              "verifySkipped": true,
              "policy": "auto",
              "timeoutMs": 1500
            }
          }
        }
      ]
    }
  ]
}
```

Use `0` only in this contract example. Real output should omit empty objects where the phase does not exist.

## Task 1: Instrument Benchmark Timing Without Behavior Change

**Files:**
- Modify: `src/benchmark-agent-impact.ts`
- Modify: `src/agent-router/index.ts`
- Modify: `src/jdtls-session.ts`
- Test: `src/benchmark-agent-impact.test.ts`

- [ ] **Step 1: Add the failing benchmark JSON assertion**

Add a test next to the existing benchmark tests:

```ts
test("impact benchmark exposes timing diagnostics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-benchmark-impact-timing-"));
  const srcDir = path.join(root, "src", "main", "java", "demo");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(srcDir, "DemoService.java"), [
    "package demo;",
    "public class DemoService {",
    "  public DemoResult execute(DemoCommand command) { return null; }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(srcDir, "DemoCommand.java"), "package demo; public record DemoCommand(String id) {}\n");
  await writeFile(path.join(srcDir, "DemoResult.java"), "package demo; public record DemoResult(String id) {}\n");

  const scenarioFile = path.join(root, "generic-java.scenarios.jsonl");
  await writeFile(scenarioFile, `${JSON.stringify({
    id: "demo-service-execute",
    name: "DemoService#execute",
    projectId: "generic-java",
    layoutProfile: "generic-java",
    scenarioVersion: 1,
    warmState: "cold-nolsp",
    anchor: {
      file: "src/main/java/demo/DemoService.java",
      line: 3,
      column: 21,
      profile: "service",
      taskKeywords: ["demo", "execute"]
    },
    golden: {
      mustHit: ["src/main/java/demo/DemoService.java"],
      shouldHit: [],
      side: []
    }
  })}\n`);

  const result = spawnSync(process.execPath, [
    "dist/benchmark-agent-impact.js",
    "--repo-root", root,
    "--scenarios", scenarioFile,
    "--project-id", "generic-java",
    "--warm-state", "cold-nolsp",
    "--strategy", "impact",
    "--runs", "1",
    "--verbosity", "diagnostic"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const timing = payload.rows[0].attempts[0].timing;
  assert.equal(typeof timing.phaseMs, "object");
  assert.equal(timing.semantic.policy, "fast");
  assert.equal(timing.semantic.used, false);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run build && node --test --test-name-pattern="impact benchmark exposes timing diagnostics" "dist/**/*.test.js"
```

Expected: FAIL because `attempt.timing` is missing.

- [ ] **Step 3: Expose existing router metrics in benchmark attempts**

In `src/benchmark-agent-impact.ts`, add a tiny helper and include it in `impactAttempt`:

```ts
function timingPayload(result: Awaited<ReturnType<AgentRouter["impact"]>>, sessionPhaseMs: Record<string, number>): Record<string, unknown> {
  const metrics = result.metrics || {};
  return compactRecord({
    phaseMs: metrics.phaseMs,
    sessionPhaseMs,
    semantic: metrics.semantic
  });
}
```

Then change the return payload:

```ts
const sessionPhaseMs = router.session?.drainPhaseMetrics?.() || {};
return {
  ...attemptPayload("impact", quality, rawSearchPayload, readingPayload, elapsedMs, 1 + result.readPlan.length, result.readPlan.length, Number(result.counts.totalRgRawBytes || 0), 0),
  timing: timingPayload(result, sessionPhaseMs),
  goldenAttribution: goldenAttributionForImpact(result, scenario)
};
```

If `router.session` is private, do not make it public. Instead change `impactAttempt` to accept `session: JdtlsSession` and call `session.drainPhaseMetrics()` there. This is the smaller, explicit dependency.

- [ ] **Step 4: Measure warm preparation once**

Wrap `prepareWarmState` in the top-level runner:

```ts
let prepareWarmMs = 0;
let prepareWarmPhaseMs: Record<string, number> = {};
if (session) {
  const startedAt = performance.now();
  await prepareWarmState(cli, session, scenarios);
  prepareWarmMs = performance.now() - startedAt;
  prepareWarmPhaseMs = session.drainPhaseMetrics();
}
```

Add to `metadata`:

```ts
prepareWarmMs,
prepareWarmPhaseMs
```

For `cold-nolsp`, keep `prepareWarmMs=0` and `{}`.

- [ ] **Step 5: Add coarse router phases**

In `src/agent-router/index.ts`, wrap only existing blocks. Do not change ranking logic.

```ts
const sourceBefore = await timed(phaseMs, "sourceStatusBefore", async () => this.sourceIndex.status());
const cacheBefore = await timed(phaseMs, "sessionCacheBefore", async () => this.session.cacheStatus());
const rgBefore = await timed(phaseMs, "rgCacheBefore", async () => this.rgCacheStatus());
const anchors = await timed(phaseMs, "resolveAnchors", async () => options.anchors.map((anchor, index) => this.resolveAnchor(anchor, options.profile, `A${index + 1}`)));
await timed(phaseMs, "typeGraph", async () => this.collectTypeGraphCandidates(candidates, anchors, options));
const nonLspReadPlanPaths = await timed(phaseMs, "nonLspReadPlan", async () => this.nonLspReadPlanPaths(candidates, anchors[0], options));
const ranked = await timed(phaseMs, "finalizeRank", async () => this.finalizeRank(candidates, anchors[0], options, suppressed, nonLspReadPlanPaths));
const readPlan = await timed(phaseMs, "buildReadPlan", async () => this.buildReadPlan(ranked, idByPath, options, nonLspReadPlanPaths));
```

If TypeScript complains because a wrapped function is sync, keep `timed` as-is; async wrapping sync work is acceptable in this diagnostic path.

- [ ] **Step 6: Add LSP request method timing**

In `src/jdtls-session.ts`, update `request()`:

```ts
const startedAt = Date.now();
try {
  return await withTimeout(this.connection.sendRequest(method, params, cancellation.token), timeoutMs, method, () => cancellation.cancel()) as T;
} finally {
  this.addPhaseMetric(method, Date.now() - startedAt);
}
```

Do not add a new counter class. Timeout failures already flow through this method and still record elapsed time.

- [ ] **Step 7: Run the targeted test**

Run:

```bash
npm run build && node --test --test-name-pattern="impact benchmark exposes timing diagnostics" "dist/**/*.test.js"
```

Expected: PASS.

- [ ] **Step 8: Run full tests**

Run:

```bash
npm run build && npm test
```

Expected: `0 fail`.

- [ ] **Step 9: Commit**

```bash
git add src/benchmark-agent-impact.ts src/agent-router/index.ts src/jdtls-session.ts src/benchmark-agent-impact.test.ts
git commit -m "feat(benchmark): expose warm phase timing"
```

## Task 2: Produce Instrumentation Report

**Files:**
- Create: `docs/java-lsp-mcp-warm-instrumentation-report-2026-06-29.md`

- [ ] **Step 1: Run the warm/cold diagnostic matrix**

Run:

```bash
npm run build
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-lishuedu-cold.json 2> /tmp/warm-inst-lishuedu-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-auto --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-lishuedu-auto.json 2> /tmp/warm-inst-lishuedu-auto.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-lishuedu-required.json 2> /tmp/warm-inst-lishuedu-required.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-cipherlink-cold.json 2> /tmp/warm-inst-cipherlink-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-cipherlink-required.json 2> /tmp/warm-inst-cipherlink-required.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-exam-cold.json 2> /tmp/warm-inst-exam-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-exam-required.json 2> /tmp/warm-inst-exam-required.err
```

- [ ] **Step 2: Generate the summary table**

Run:

```bash
node --input-type=module <<'NODE'
import fs from 'node:fs';

const files = [
  ['lishuedu cold', '/tmp/warm-inst-lishuedu-cold.json', '/tmp/warm-inst-lishuedu-cold.err'],
  ['lishuedu warm-auto', '/tmp/warm-inst-lishuedu-auto.json', '/tmp/warm-inst-lishuedu-auto.err'],
  ['lishuedu warm-required', '/tmp/warm-inst-lishuedu-required.json', '/tmp/warm-inst-lishuedu-required.err'],
  ['cipherlink cold', '/tmp/warm-inst-cipherlink-cold.json', '/tmp/warm-inst-cipherlink-cold.err'],
  ['cipherlink warm-required', '/tmp/warm-inst-cipherlink-required.json', '/tmp/warm-inst-cipherlink-required.err'],
  ['exam cold', '/tmp/warm-inst-exam-cold.json', '/tmp/warm-inst-exam-cold.err'],
  ['exam warm-required', '/tmp/warm-inst-exam-required.json', '/tmp/warm-inst-exam-required.err']
];

for (const [name, jsonFile, errFile] of files) {
  const data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const err = fs.readFileSync(errFile, 'utf8');
  const phaseTotals = {};
  for (const row of data.rows) {
    for (const attempt of row.attempts) {
      for (const [key, value] of Object.entries(attempt.timing?.phaseMs || {})) {
        phaseTotals[key] = (phaseTotals[key] || 0) + value;
      }
      for (const [key, value] of Object.entries(attempt.timing?.sessionPhaseMs || {})) {
        phaseTotals[`session.${key}`] = (phaseTotals[`session.${key}`] || 0) + value;
      }
    }
  }
  console.log(JSON.stringify({
    name,
    projectId: data.metadata.projectId,
    warmState: data.metadata.warmState,
    prepareWarmMs: Math.round(data.metadata.prepareWarmMs || 0),
    elapsedMsP50: Number(data.totals.elapsedMsP50.toFixed(2)),
    elapsedMsP95: Number(data.totals.elapsedMsP95.toFixed(2)),
    rReadMust: data.totals.rReadMust,
    recall: Number(data.totals.recall.toFixed(4)),
    topPhases: Object.entries(phaseTotals).sort((a, b) => b[1] - a[1]).slice(0, 8),
    timeoutLog: /Timed out waiting|textDocument\\/.*failed/.test(err)
  }));
}
NODE
```

- [ ] **Step 3: Write the report**

Create `docs/java-lsp-mcp-warm-instrumentation-report-2026-06-29.md`.

Rules:

- The Summary section must name the single largest phase from Step 2.
- The Commands section must paste the exact commands from Task 2 Step 1.
- The Results table must contain one row for each JSON file from Task 2 Step 1.
- The Root Cause section must name the observed phase, not a guessed fix.
- The Final Test Report must contain concrete PASS or FAIL values plus the observed output summary.

Use this structure:

```markdown
# java_impact warm instrumentation report (2026-06-29)

## Summary

- First bottleneck: measured phase name and milliseconds.
- warm-auto no-semantic fixed cost: measured top phase and P95.
- warm-required first-touch miss: measured top phase and P95.
- Defaultability decision: blocked or allowed by the absolute SLO.

## Commands

The report must include the seven benchmark commands from Task 2 Step 1.

## Results

| project | warmState | prepareWarmMs | elapsed P50 | elapsed P95 | top phase | timeout log | R_read_must | recall |
|---|---|---:|---:|---:|---|---:|---:|---:|

## Root Cause

State which observed phase dominates warm-auto and warm-required. Do not name an optimization unless the phase proves it.

## Decision

- If top phase is `progressIdleWait` or `prepareWarmMs`: optimize readiness/warmup policy first.
- If top phase is `textDocument/references` or `textDocument/implementation`: optimize semantic request scheduling first.
- If top phase is `rg` or local ranking: do not touch LSP scheduling.

## Final Test Report

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | status word plus observed summary |
| Unit tests | `npm test` | status word plus observed summary |
| lishuedu cold hard gate | benchmark command | status word plus observed summary |
| cipherlink cold hard gate | benchmark command | status word plus observed summary |
| exam cold hard gate | benchmark command | status word plus observed summary |
| warm timeout logs | `rg "Timed out waiting|textDocument/.+failed" /tmp/warm-inst-*.err` | status word plus observed summary |
```

- [ ] **Step 4: Validate report completeness**

Run:

```bash
rg -n "TBD|TODO|PASS/FAIL|measured value|concrete pass|paste commands|guessed fix|status word" docs/java-lsp-mcp-warm-instrumentation-report-2026-06-29.md
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add docs/java-lsp-mcp-warm-instrumentation-report-2026-06-29.md
git commit -m "docs(benchmark): report warm instrumentation baseline"
```

## Task 3: Choose One Optimization Based On Report

**Files:**
- Modify only the file proven by Task 2.
- Do not implement more than one optimization in this task.

- [ ] **Step 1: Pick the branch**

Use this exact mapping:

| Report top cause | Patch allowed | Files |
|---|---|---|
| `prepareWarmMs` / `progressIdleWait` dominates warm-auto | Reduce or gate warm readiness wait | `src/benchmark-agent-impact.ts`, `src/jdtls-session.ts` |
| `textDocument/references` dominates warm-required | Add bounded request concurrency for references/type hierarchy | `src/agent-router/index.ts` |
| `textDocument/implementation` dominates warm-required | Gate implementation lookup by profile/kind or lower timeout | `src/agent-router/index.ts`, `src/jdtls-session.ts` |
| local `rg` / ranking dominates | Do not touch warm; open a separate cold-path plan | N/A |

- [ ] **Step 2: Write the smallest failing test**

Example if the chosen patch is readiness wait:

```ts
test("warm-auto benchmark records prepare warm cost outside attempts", async () => {
  const payload = JSON.parse(readFileSync("/tmp/warm-inst-lishuedu-auto.json", "utf8"));
  assert.equal(typeof payload.metadata.prepareWarmMs, "number");
  assert.ok(payload.metadata.prepareWarmMs >= 0);
});
```

For scheduling changes, use an existing fake session test in `src/agent-router/*.test.ts` and assert call count/order only for the chosen method.

- [ ] **Step 3: Implement only that patch**

Rules:

- No new public API.
- No new dependency.
- No method-call graph.
- No Task 3/4/5 graph expansion.
- No profile-aware warm until the absolute SLO passes.

- [ ] **Step 4: Run targeted test**

Run the exact test touched by Step 2.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run build && npm test
```

Expected: `0 fail`.

- [ ] **Step 6: Re-run warm matrix**

Use the same commands from Task 2 Step 1, with output suffix `-after.json`.

- [ ] **Step 7: Write final optimization report**

Create `docs/java-lsp-mcp-warm-optimization-test-report-2026-06-29.md`.

The report must contain observed values from before/after JSON files. Do not leave empty table cells.

```markdown
# java_impact warm optimization test report (2026-06-29)

## Patch

- Changed files:
- Behavior changed:
- Behavior intentionally not changed:

## Before / After

| project | warmState | before P95 | after P95 | before R_read_must | after R_read_must | timeout logs |
|---|---|---:|---:|---:|---:|---:|

## SLO Decision

| Gate | Target | Result | Pass |
|---|---:|---:|---:|
| warm-auto no-semantic P95 | <=300ms | observed number | boolean |
| warm-required first-touch P95 | <=800ms | observed number | boolean |
| warm-required cache-hit P50 | <=100ms | observed number | boolean |
| timeout logs | 0 | observed number | boolean |
| R_read_must | 1.0000 | observed number | boolean |

## Final Test Report

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | status word plus observed summary |
| Unit tests | `npm test` | status word plus observed summary |
| lishuedu warm matrix | benchmark command | status word plus observed summary |
| cipherlink warm matrix | benchmark command | status word plus observed summary |
| exam warm matrix | benchmark command | status word plus observed summary |
```

- [ ] **Step 8: Commit**

```bash
# If readiness wait was changed:
git add src/benchmark-agent-impact.ts src/jdtls-session.ts docs/java-lsp-mcp-warm-optimization-test-report-2026-06-29.md
git commit -m "fix(benchmark): reduce measured warm readiness cost"

# If semantic request scheduling was changed:
git add src/agent-router/index.ts src/jdtls-session.ts docs/java-lsp-mcp-warm-optimization-test-report-2026-06-29.md
git commit -m "fix(router): reduce measured warm semantic latency"
```

## Stop Rules

Stop and do not optimize if Task 2 shows:

- `warm-auto` P95 is dominated by benchmark harness overhead, not router/session phases.
- `warm-required` top phase is distributed across multiple unrelated phases with no single phase over 40%.
- Any optimization would weaken `R_read_must=1.0000`.
- Any Task 3/4/5 trigger is still absent after attribution v2.

## Final Acceptance Checklist

- [ ] `npm run build` passes.
- [ ] `npm test` passes with `0 fail`.
- [ ] Three real-repo cold benchmarks keep `R_read_must=1.0000`.
- [ ] Final report exists at `docs/java-lsp-mcp-warm-instrumentation-report-2026-06-29.md`.
- [ ] If an optimization is implemented, final before/after report exists at `docs/java-lsp-mcp-warm-optimization-test-report-2026-06-29.md`.
- [ ] The report states whether profile-aware warm remains blocked or can move to a new plan.
- [ ] No Task 3/4/5 work is included unless attribution v2 explicitly triggers it.
