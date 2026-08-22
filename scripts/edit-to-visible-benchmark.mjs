// Task 13 Step 2: edit-to-visible latency against a synthetic fixture (the
// golden repos are not readable in this environment; this measures the
// repo-wide freshness path itself, not real-repo quality).
//
// Each cycle writes a new collaborator Java file, then polls java_impact
// (the real production handler, through RepoRuntimeManager.withContext, the
// same freshness barrier a real MCP client hits) until the new file appears
// in the result or a per-cycle timeout is reached. This deliberately does
// NOT call flushNow()/generation directly — a stale answer must be caught by
// checking the actual result, not by asserting on internal state.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { RepoRuntimeManager } from "../dist/repo-runtime-manager.js";
import { RepoResolver } from "../dist/repo-resolver.js";
import { AliasRegistry } from "../dist/alias-registry.js";
import { javaImpact, impactSchema } from "../dist/tools/impact.js";
import { MAX_REQUEST_DEADLINE_MS } from "../dist/runtime/request-context.js";

const CYCLES = 30;
const POLL_INTERVAL_MS = 25;
const PER_CYCLE_TIMEOUT_MS = 3000;

const argsSchema = z.object(impactSchema);

async function buildFixture() {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "edit-to-visible-"));
  const javaDir = path.join(repoRoot, "src", "main", "java", "demo");
  await mkdir(javaDir, { recursive: true });
  await writeFile(path.join(repoRoot, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  await writeFile(path.join(javaDir, "AnchorService.java"), [
    "package demo;",
    "",
    "public class AnchorService {",
    "  public void handle() {}",
    "}",
    ""
  ].join("\n"));
  return { repoRoot, javaDir };
}

async function runCycle(runtimes, repoRoot, javaDir, index) {
  const collaboratorName = `Collaborator${index}`;
  const collaboratorFile = path.join(javaDir, `${collaboratorName}.java`);
  const args = argsSchema.parse({
    file: "src/main/java/demo/AnchorService.java",
    line: 3,
    column: 14,
    mode: "recall",
    semanticPolicy: "fast"
  });

  const startedAt = performance.now();
  await writeFile(collaboratorFile, [
    "package demo;",
    "",
    `public class ${collaboratorName} {`,
    "  private final AnchorService svc = new AnchorService();",
    "}",
    ""
  ].join("\n"));

  for (;;) {
    const result = await runtimes.withContext(
      { repoRoot },
      (context, request) => javaImpact(context, args, request),
      {
        mayStartLsp: false,
        requestOptions: {
          mode: "recall",
          semanticPolicy: "fast",
          // recall+fast defaults to 2000ms, which is the hot-path budget.
          // Cycle 0 pays runtime.create (worker spawn + files-only OPEN).
          deadlineMs: MAX_REQUEST_DEADLINE_MS
        }
      }
    );
    const visible = JSON.stringify(result).includes(`${collaboratorName}.java`);
    if (visible) {
      return { index, elapsedMs: performance.now() - startedAt, stale: false };
    }
    if (performance.now() - startedAt > PER_CYCLE_TIMEOUT_MS) {
      return { index, elapsedMs: performance.now() - startedAt, stale: true };
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

const { repoRoot, javaDir } = await buildFixture();
const registry = new AliasRegistry(path.join(repoRoot, ".nonexistent-aliases.json"));
const resolver = new RepoResolver(registry);
const runtimes = new RepoRuntimeManager(resolver);

try {
  await runtimes.initialize();

  // Cycle 0 is a warm-up: it also pays for chokidar's initial scan/ready and
  // is discarded from the P50/P95, per Task 13 Step 2 asking for edit-to-
  // visible latency, not cold-start latency.
  const warmup = await runCycle(runtimes, repoRoot, javaDir, 0);
  console.log("warm-up cycle (discarded):", JSON.stringify(warmup));

  const cycles = [];
  for (let index = 1; index <= CYCLES; index += 1) {
    const cycle = await runCycle(runtimes, repoRoot, javaDir, index);
    cycles.push(cycle);
  }

  const staleCount = cycles.filter(cycle => cycle.stale).length;
  const elapsed = cycles.map(cycle => cycle.elapsedMs).sort((a, b) => a - b);
  const p50 = percentile(elapsed, 50);
  const p95 = percentile(elapsed, 95);

  const report = {
    fixture: "synthetic (golden repos unreadable in this environment)",
    cycles: cycles.length,
    staleCount,
    p50Ms: p50,
    p95Ms: p95,
    pollIntervalMs: POLL_INTERVAL_MS,
    perCycleTimeoutMs: PER_CYCLE_TIMEOUT_MS,
    raw: cycles
  };
  console.log(JSON.stringify(report, null, 2));

  const gatePass = staleCount === 0 && p95 !== undefined && p95 <= 500;
  console.log(gatePass
    ? "GATE: PASS (stale=0, P95<=500ms) on this machine/fixture"
    : `GATE: FAIL staleCount=${staleCount} p95Ms=${p95}`);
  process.exitCode = gatePass ? 0 : 1;
} finally {
  await runtimes.shutdownAll();
  await rm(repoRoot, { recursive: true, force: true });
}
