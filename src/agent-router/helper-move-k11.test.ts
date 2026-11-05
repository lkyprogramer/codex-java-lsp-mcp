// input: One fixture repo in two layouts — the called helper class after the
//         caller (A) and before it (B) — both fully indexed and both run
//         through the real static java_impact read-plan path.
// output: K11 contract evidence: the helper relation and its required
//         evidence must not depend on which side of the caller the helper
//         happens to sit on; a dropped helper window is named, never silent.
// pos: M2 T08 - "helper moved before/after caller" equivalence; the plan
//      must not just look at the lines after the call site.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { ToolContext } from "../tools/context.js";
import { javaImpact } from "../tools/impact.js";
import { openIndexDb, close } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";
import { LocalBuilder } from "../java-index/local-builder.js";
import { RouterJavaIndex } from "../java-index/router-java-index.js";
import { AgentRouter } from "./index.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

const CALL = "seats.reserve(id);";

// The caller's method is long enough that the planner uses extreme-method
// windows (head + anchor-centered + tail); the helper sits far from the call
// anchor on one side in layout A and far on the other side in layout B.
const FILLER = Array.from({ length: 320 }, (_, i) => `        int pad${i} = id.length();`).join("\n");

const LAYOUT_AFTER = `package com.acme;

public class K11Entry {
    private final Seats seats = new Seats();

    public void place(String id) {
        ${CALL}
${FILLER}
    }
}

class Seats {
    /** reserves one seat */
    public void reserve(String id) {
    }
}
`;

const LAYOUT_BEFORE = `package com.acme;

class Seats {
    /** reserves one seat */
    public void reserve(String id) {
    }
}

public class K11Entry {
    private final Seats seats = new Seats();

    public void place(String id) {
        ${CALL}
${FILLER}
    }
}
`;

class EmptyRgRunner extends RgRunner {
  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
}

async function waitForCompleteIndex(index: RouterJavaIndex): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await index.routerStatus()).coverage === "complete") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("K11 fixture JavaIndex did not reach complete coverage");
}

type K11Fixture = { repoRoot: string; source: string; client: JavaIndexClientApi; cleanup: () => Promise<void> };

async function buildLayoutFixture(source: string): Promise<K11Fixture> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "k11-helper-move-"));
  const javaRoot = path.join(repoRoot, "src", "main", "java", "com", "acme");
  await mkdir(javaRoot, { recursive: true });
  await writeFile(path.join(javaRoot, "K11Entry.java"), source, "utf8");
  const dbPath = path.join(repoRoot, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot, db, generation: 1 });
  close(db);
  const client = new SqlJavaIndexClient(repoRoot, dbPath, new LocalBuilder({ repoRoot, dbPath })) as unknown as JavaIndexClientApi;
  return {
    repoRoot,
    source,
    client,
    cleanup: async () => {
      await client.close().catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
    }
  };
}

function callAnchor(source: string): { file: string; line: number; column: number } {
  const beforeCall = source.slice(0, source.indexOf(CALL));
  const line = beforeCall.split("\n").length;
  const column = source.slice(beforeCall.length).indexOf(CALL) + 1;
  return { file: "src/main/java/com/acme/K11Entry.java", line, column };
}

function reserveRange(source: string): { startLine: number; endLine: number } {
  const marker = "public void reserve(String id)";
  const beforeMarker = source.slice(0, source.indexOf(marker));
  const startLine = beforeMarker.split("\n").length;
  const close = source.indexOf("}", source.indexOf(marker) + marker.length + " {".length);
  const endLine = source.slice(0, close).split("\n").length;
  return { startLine, endLine };
}

type ImpactOutcome = {
  helperCovered: boolean;
  helperNamed: boolean;
  gaps: string[];
};

async function impactOutcome(fixture: K11Fixture): Promise<ImpactOutcome> {
  const client = fixture.client as SqlJavaIndexClient;
  const routerIndex = new RouterJavaIndex(fixture.repoRoot, client);
  try {
    await routerIndex.open(1);
    await routerIndex.reconcile(1);
    await waitForCompleteIndex(routerIndex);
    const session = {
      cacheStatus() {
        return { invalidations: 0, entries: 0, hits: 0, misses: 0 };
      },
      drainPhaseMetrics() {
        return {};
      },
      async start() {
        throw new Error("JDT must not start for a static K11 impact");
      },
      async workspaceSymbols() {
        throw new Error("JDT workspace symbols must not be used for static discovery");
      },
      async symbolContext() {
        return { hover: undefined, definitions: [], implementations: [] };
      },
      async references() {
        return { items: [], totalReferences: 0, truncated: false };
      },
      status() {
        return { started: false, ready: false, progress: { active: 0 }, generatedCode: { lombok: { detected: false } } };
      },
      async stop() {
        return { started: false, ready: false, progress: { active: 0 } };
      },
      async restart() {
        throw new Error("JDT must not restart for a static K11 impact");
      },
      async diagnosticsFor() {
        return {};
      },
      async documentSymbols() {
        return [];
      },
      async executeCommand() {
        throw new Error("unsupported in test");
      }
    } as unknown as ToolContext["session"];
    const router = new AgentRouter(fixture.repoRoot, session as never, routerIndex, undefined, undefined, new EmptyRgRunner());
    const context = {
      repoRoot: fixture.repoRoot,
      repoHash: "k11",
      rootSource: "explicit",
      lsp: { enabled: false, matchedBy: "none", effectiveRepoRoot: fixture.repoRoot },
      session,
      javaIndexClient: client,
      javaIndex: routerIndex,
      router
    } as unknown as ToolContext;

    const anchor = callAnchor(fixture.source);
    const impact = (await javaImpact(context, {
      file: anchor.file,
      line: anchor.line,
      column: anchor.column,
      semanticPolicy: "fast"
    } as unknown as Parameters<typeof javaImpact>[1], { budget: DeadlineBudget.fromTimeout(30000) } as unknown as Parameters<typeof javaImpact>[2])) as Record<string, unknown>;

    // The required helper evidence is the plan's selected ranges for the
    // anchor file: they must cover the helper declaration itself (the payload
    // carries ranges, not file contents, so class names never appear).
    // V6 (diagnostic) exposes readPlan[]; the default wire is CompactImpact
    // (contexts[].spans with s/e/b) - read whichever shape the tool returned.
    let anchorRanges: Array<{ startLine: number; endLine: number }> = [];
    if (Array.isArray(impact.readPlan)) {
      anchorRanges = (impact.readPlan as Array<{ ranges?: Array<{ startLine: number; endLine: number }> }>)
        .flatMap(item => (item.ranges ?? []).map(range => ({ startLine: range.startLine, endLine: range.endLine })));
    } else if (Array.isArray(impact.contexts)) {
      anchorRanges = (impact.contexts as Array<{ path?: string; spans?: Array<{ s: number; e: number }> }>)
        .filter(context => (context.path ?? "").endsWith("K11Entry.java"))
        .flatMap(context => (context.spans ?? []).map(span => ({ startLine: span.s, endLine: span.e })));
    }
    const helper = reserveRange(fixture.source);
    const helperCovered = anchorRanges.some(range => range.startLine <= helper.startLine && range.endLine >= helper.endLine);
    const gaps = Array.isArray(impact.evidenceGaps) ? (impact.evidenceGaps as string[])
      : Array.isArray(impact.unresolved) ? (impact.unresolved as string[])
        : [];
    const helperNamed = gaps.some(gap => gap.includes("K11Entry.java") || gap.includes("reserve") || gap.includes("partial") || gap.includes("bounded"));
    return { helperCovered, helperNamed, gaps };
  } finally {
    await routerIndex.close().catch(() => undefined);
  }
}

test("K11: helper before the caller carries the same required evidence as after", async () => {
  const before = await buildLayoutFixture(LAYOUT_BEFORE);
  const after = await buildLayoutFixture(LAYOUT_AFTER);
  try {
    const outcomeBefore = await impactOutcome(before);
    const outcomeAfter = await impactOutcome(after);
    const available = (outcome: ImpactOutcome): boolean => outcome.helperCovered || outcome.helperNamed;
    assert.ok(available(outcomeBefore),
      `helper before the caller must be evidenced or explicitly named, gaps=${JSON.stringify(outcomeBefore.gaps)}`);
    assert.ok(available(outcomeAfter),
      `helper after the caller must be evidenced or explicitly named, gaps=${JSON.stringify(outcomeAfter.gaps)}`);
    assert.equal(outcomeBefore.helperCovered, outcomeAfter.helperCovered,
      "the helper's evidence state must not depend on which side of the call site it sits on");
  } finally {
    await before.cleanup();
    await after.cleanup();
  }
});