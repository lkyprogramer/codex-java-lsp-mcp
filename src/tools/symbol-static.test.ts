// input: A fixture repo with a real on-disk V2 index and a JDT session that
//        must never be touched by the static backend.
// output: K25/K26 contract evidence: static java_symbol query succeeds with
//         JDT disabled and zero JDT interactions; position/references keep
//         the JDT requirement; a returned locator feeds java_impact directly.
// pos: T06 RED→GREEN target tests (static discovery backend for java_symbol).
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { ToolContext } from "./context.js";
import { javaSymbol, symbolNeedsJdt } from "./symbol.js";
import { javaImpact } from "./impact.js";
import { openIndexDb, close } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";
import { LocalBuilder } from "../java-index/local-builder.js";
import { RouterJavaIndex } from "../java-index/router-java-index.js";
import { AgentRouter } from "../agent-router/index.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

const ORDER_SERVICE = `package com.acme;

/** Keeps the order ledger. */
public class OrderService {
    public void updateOrder(int id) {
        // touch the order record
    }

    public void refundOrder(long id) {
        // reverse the order payment
    }
}
`;

const PAYMENT_CLIENT = `package com.acme;

/** Talks to the payment gateway. */
public class PaymentClient {
    public String charge(long amount) {
        return "charged";
    }
}
`;

type JdtArgs = Record<string, unknown>;

/** The handler receives zod OUTPUT (defaults applied); tests cast raw args. */
const args = (value: JdtArgs): Parameters<typeof javaSymbol>[1] => value as unknown as Parameters<typeof javaSymbol>[1];

type JdtProbe = {
  startCalls: number;
  workspaceSymbolsCalls: number;
  referencesCalls: number;
  symbolContextCalls: number;
};

function makeContext(repoRoot: string, client: JavaIndexClientApi, probe: JdtProbe, extra?: { router?: AgentRouter; javaIndex?: RouterJavaIndex }): ToolContext {
  const context = {
    repoRoot,
    repoHash: "test-repo-hash",
    rootSource: "explicit",
    lsp: { enabled: false, matchedBy: "none", effectiveRepoRoot: repoRoot },
    session: {
      cacheStatus() {
        return { invalidations: 0, entries: 0, hits: 0, misses: 0 };
      },
      drainPhaseMetrics() {
        return {};
      },
      async start() {
        probe.startCalls += 1;
        throw new Error("JDT must not start for static discovery");
      },
      async workspaceSymbols() {
        probe.workspaceSymbolsCalls += 1;
        throw new Error("JDT workspace symbols must not be used for static discovery");
      },
      async symbolContext() {
        probe.symbolContextCalls += 1;
        return { hover: undefined, definitions: [], implementations: [] };
      },
      async references() {
        probe.referencesCalls += 1;
        return { items: [], totalReferences: 0, truncated: false };
      },
      status() {
        return { started: false, ready: false, progress: { active: 0 }, generatedCode: { lombok: { detected: false } } };
      },
      async stop() {
        return { started: false, ready: false, progress: { active: 0 } };
      },
      async restart() {
        probe.startCalls += 1;
        throw new Error("JDT must not restart for static discovery");
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
    } as unknown as ToolContext["session"],
    javaIndexClient: client,
    ...(extra?.javaIndex ? { javaIndex: extra.javaIndex } : {}),
    router: (extra?.router ?? { impact: async () => { throw new Error("router not wired"); } }) as unknown as ToolContext["router"]
  };
  return context as unknown as ToolContext;
}

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
  assert.fail("fixture JavaIndex did not reach complete coverage");
}

type Fixture = { repoRoot: string; dbPath: string; client: JavaIndexClientApi; cleanup: () => Promise<void> };

async function buildFixture(): Promise<Fixture> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "symbol-static-"));
  const javaRoot = path.join(repoRoot, "src", "main", "java", "com", "acme");
  await mkdir(javaRoot, { recursive: true });
  await writeFile(path.join(javaRoot, "OrderService.java"), ORDER_SERVICE, "utf8");
  await writeFile(path.join(javaRoot, "PaymentClient.java"), PAYMENT_CLIENT, "utf8");
  const dbPath = path.join(repoRoot, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot, db, generation: 1 });
  close(db);
  const client = new SqlJavaIndexClient(repoRoot, dbPath, new LocalBuilder({ repoRoot, dbPath })) as unknown as JavaIndexClientApi;
  return {
    repoRoot,
    dbPath,
    client,
    cleanup: async () => {
      await client.close().catch(() => undefined);
      await rm(repoRoot, { recursive: true, force: true });
    }
  };
}

async function openFixtureClient(fixture: Fixture): Promise<void> {
  await (fixture.client as SqlJavaIndexClient).open(1);
}

test("MAC11 stale view cannot return a confident static miss", async () => {
  const fixture = await buildFixture();
  const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
  try {
    await openFixtureClient(fixture);
    const context = makeContext(fixture.repoRoot, fixture.client, probe);
    const held = { state: "STALE" as const, workspaceId: "workspace-held", snapshotId: "snapshot-held", bindingVersion: 7, coveredThroughSeq: 7 };
    context.indexView = held;
    const query = args({ query: "com.acme.AbsentMac11Type", searchMode: "exact", preview: "none" });
    const stale = await javaSymbol(context, query, { budget: DeadlineBudget.fromTimeout(15000) }) as Record<string, unknown>;
    assert.equal(stale.scopeState, "PARTIAL");
    assert.equal(stale.exact, undefined, "an old complete snapshot cannot prove a current miss");
    assert.equal(stale.emptyReason, undefined);
    assert.equal(stale.stopReason, "source_changed", "a view behind edits on disk is partial because the source changed");
    assert.deepEqual(stale.indexView, held);
    const hit = await javaSymbol(context, args({ query: "com.acme.OrderService", searchMode: "exact", preview: "none" })) as Record<string, unknown>;
    assert.equal(hit.scopeState, "PARTIAL");
    assert.equal(hit.exact, "match", "verified positive evidence remains usable from the held view");
    assert.deepEqual(hit.indexView, held);
    context.indexView = { ...held, state: "FRESH", bindingVersion: 8 };
    const fresh = await javaSymbol(context, query) as Record<string, unknown>;
    assert.equal(fresh.scopeState, "READY");
    assert.equal(fresh.exact, "miss");
    const incomplete = await javaSymbol(context, query, { budget: DeadlineBudget.fromTimeout(15000), negativeLookupAllowed: false }) as Record<string, unknown>;
    assert.equal(incomplete.scopeState, "PARTIAL", "FRESH does not make partial coverage complete");
    assert.equal(incomplete.exact, undefined);
    context.indexView = { state: "NOT_READY" };
    const cold = await javaSymbol(context, query) as Record<string, unknown>;
    assert.equal(cold.scopeState, "PARTIAL");
    assert.equal(cold.exact, undefined);
    assert.equal(cold.stopReason, "index_partial");
    assert.deepEqual(stale.indexView, held, "later bindings cannot relabel an earlier response");
    assert.equal(probe.startCalls, 0);
  } finally { await fixture.cleanup(); }
});

test("MAC11 stale evidence exposes the held view and remains partial", async () => {
  const fixture = await buildFixture();
  const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
  try {
    await openFixtureClient(fixture);
    const context = makeContext(fixture.repoRoot, fixture.client, probe);
    context.indexView = { state: "STALE", snapshotId: "snapshot-held", bindingVersion: 7 };
    const out = await javaSymbol(context, args({ operation: "evidence", file: "src/main/java/com/acme/OrderService.java", line: 4, column: 21 })) as Record<string, unknown>;
    assert.equal(out.scopeState, "PARTIAL");
    assert.deepEqual(out.indexView, context.indexView);
    assert.ok((out.reasons as string[]).includes("INDEX_VIEW_STALE"));
  } finally { await fixture.cleanup(); }
});

test("explicit evidence uses the static index and does not start JDT", async () => {
  const fixture = await buildFixture();
  const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
  try {
    await openFixtureClient(fixture);
    const context = makeContext(fixture.repoRoot, fixture.client, probe);
    const result = await javaSymbol(context, args({ operation: "evidence",
      file: "src/main/java/com/acme/OrderService.java", line: 4, column: 21
    }), { budget: DeadlineBudget.fromTimeout(15000) }) as Record<string, unknown>;
    assert.equal(result.schemaVersion, "java-evidence-unit/v1");
    assert.equal(result.generation, 1);
    assert.equal(result.scopeState, "READY");
    assert.deepEqual(result.units, [], "a type without XML relations has no resource source units");
    assert.deepEqual(probe, { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 });
    await assert.rejects(javaSymbol(context, args({ operation: "evidence" })), /requires file\/line\/column/);
    await assert.rejects(javaSymbol(context, args({ operation: "evidence", backend: "jdt",
      file: "src/main/java/com/acme/OrderService.java", line: 4, column: 21
    })), /static index/);
    assert.equal(probe.startCalls, 0);
  } finally { await fixture.cleanup(); }
});

test("K25: static query succeeds with JDT disabled and zero JDT interactions", async () => {
  const fixture = await buildFixture();
  await openFixtureClient(fixture);
  const previousJdtBin = process.env.JDT_BIN;
  process.env.JDT_BIN = "/usr/bin/false";
  const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
  const context = makeContext(fixture.repoRoot, fixture.client, probe);
  try {
    const result = (await javaSymbol(context, args({
      query: "order refund payment",
      searchMode: "text",
      semanticTimeoutMs: 3000
    }), { budget: DeadlineBudget.fromTimeout(15000) })) as Record<string, unknown>;

    assert.equal(result.schemaVersion, "java-discovery/v1", "static query must return the docs/02 discovery contract");
    assert.ok(["READY", "PARTIAL"].includes(String(result.scopeState)));
    const candidates = result.candidates as Array<Record<string, unknown>>;
    assert.ok(candidates.length > 0, "the fixture corpus must produce candidates");
    for (const candidate of candidates) {
      const declaration = candidate.declaration as Record<string, unknown>;
      assert.equal(typeof declaration.name, "string");
      assert.ok((declaration.name as string).length > 0, "declaration.name must be explicit, not a display label");
      const selection = declaration.selection as { line: number; column: number };
      assert.ok(selection.line >= 1 && selection.column >= 1, "selection must be 1-based UTF-16");
    }
    // The comment-only word "ledger" exists in no identifier: it must resolve
    // through the source-linked document route.
    const docResult = (await javaSymbol(context, args({ query: "ledger", semanticTimeoutMs: 3000 }))) as Record<string, unknown>;
    const docCandidates = docResult.candidates as Array<Record<string, unknown>>;
    assert.ok(docCandidates.some(candidate => {
      const declaration = candidate.declaration as Record<string, unknown>;
      return declaration.name === "OrderService";
    }), "comment-only term must resolve to the declaration via its indexed document");
    // The 1-based locator must point at real source whose hash matches the
    // declaration, so java_impact never re-searches the line.
    const first = candidates[0].declaration as { relativePath: string; contentHash: string; selection: { line: number } };
    const onDisk = await readFile(path.join(fixture.repoRoot, first.relativePath), "utf8");
    assert.equal(createHash("sha256").update(onDisk, "utf8").digest("hex"), first.contentHash);

    assert.equal(probe.startCalls, 0, "static discovery must never start JDT");
    assert.equal(probe.workspaceSymbolsCalls, 0);
    assert.equal(probe.referencesCalls, 0);
    assert.equal(probe.symbolContextCalls, 0);
  } finally {
    if (previousJdtBin === undefined) delete process.env.JDT_BIN;
    else process.env.JDT_BIN = previousJdtBin;
    await fixture.cleanup();
  }
});

test("T06: preview evidenceRange stays within physical file lines and is byte-exact", async () => {
  // A file whose last line ends with a newline has N physical lines but
  // N+1 elements when split on "\\n"; the evidence range and preview must
  // use the physical count, or independent scoring rejects every region
  // near end-of-file as out of bounds.
  const fixture = await buildFixture();
  await openFixtureClient(fixture);
  const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
  const context = makeContext(fixture.repoRoot, fixture.client, probe);
  try {
    const result = (await javaSymbol(context, args({ query: "refundOrder", semanticTimeoutMs: 3000 }))) as Record<string, unknown>;
    const candidates = (result.candidates as Array<Record<string, unknown>>).filter(candidate => typeof candidate.preview === "string");
    assert.ok(candidates.length > 0, "expected at least one end-of-file candidate with a source preview");
    const withPreview = candidates[candidates.length - 1] as { declaration: { relativePath: string }; evidenceRange?: { startLine: number; endLine: number }; preview?: string };
    const raw = await readFile(path.join(fixture.repoRoot, withPreview.declaration.relativePath), "utf8");
    const physical = raw.split(/(?<=\r\n|\n|\r)/);
    if (physical[physical.length - 1] === "") physical.pop();
    const { startLine, endLine } = withPreview.evidenceRange as { startLine: number; endLine: number };
    assert.ok(startLine >= 1 && startLine <= endLine && endLine <= physical.length,
      `evidence range ${startLine}..${endLine} must fit the ${physical.length} physical lines`);
    assert.equal(withPreview.preview, physical.slice(startLine - 1, endLine).join(""),
      "the preview must be the exact source window, not a re-serialized one");
  } finally {
    await fixture.cleanup();
  }
});

test("K25: exact FQN query returns a unique source-declaration with a usable locator", async () => {
  const fixture = await buildFixture();
  await openFixtureClient(fixture);
  const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
  const context = makeContext(fixture.repoRoot, fixture.client, probe);
  try {
    const result = (await javaSymbol(context, args({ query: "com.acme.OrderService", semanticTimeoutMs: 3000 }))) as Record<string, unknown>;
    assert.equal(result.schemaVersion, "java-discovery/v1");
    const candidates = result.candidates as Array<Record<string, unknown>>;
    assert.equal(candidates.length, 1, "an exact FQN match must stay unambiguous");
    const declaration = candidates[0].declaration as Record<string, unknown>;
    assert.equal(declaration.name, "OrderService");
    assert.equal(declaration.fqn, "com.acme.OrderService");
    assert.equal(declaration.kind, "type");
    assert.equal(declaration.relativePath, "src/main/java/com/acme/OrderService.java");
    assert.equal(candidates[0].binding, "source-declaration");
    assert.equal(probe.startCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("K26: position/references keep the explicit JDT requirement", async () => {
  assert.equal(symbolNeedsJdt({ operation: "query" }), false, "default query backend is static");
  assert.equal(symbolNeedsJdt({ operation: "query", backend: "jdt" }), true);
  assert.equal(symbolNeedsJdt({ operation: "position" }), true);
  assert.equal(symbolNeedsJdt({ operation: "references" }), true);
  assert.equal(symbolNeedsJdt({ operation: "evidence" }), false, "explicit evidence never starts JDT");
  assert.equal(symbolNeedsJdt({ operation: "evidence", backend: "jdt" }), false, "invalid evidence backend is rejected without starting JDT");
  assert.equal(symbolNeedsJdt({ query: "OrderService" }), false, "omitted operation infers query");

  const fixture = await buildFixture();
  await openFixtureClient(fixture);
  const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
  const context = makeContext(fixture.repoRoot, fixture.client, probe);
  try {
    // position: routed to the session (JDT channel untouched by T06).
    const position = (await javaSymbol(context, args({
      file: "src/main/java/com/acme/OrderService.java",
      line: 4,
      column: 21,
      semanticTimeoutMs: 3000
    }))) as Record<string, unknown>;
    assert.equal(position.mode, "position");
    assert.equal(probe.symbolContextCalls, 1, "position must keep using the LSP session");

    // references: same.
    const references = (await javaSymbol(context, args({
      operation: "references",
      file: "src/main/java/com/acme/OrderService.java",
      line: 4,
      column: 21,
      semanticTimeoutMs: 3000
    }))) as Record<string, unknown>;
    assert.equal(typeof references.totalReferences, "number");
    assert.equal(probe.referencesCalls, 1);

    // backend=jdt keeps the legacy workspace symbol channel.
    const jdtProbe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
    const jdtContext = makeContext(fixture.repoRoot, fixture.client, jdtProbe);
    (jdtContext.session as unknown as { workspaceSymbols: () => Promise<{ items: unknown[]; truncated: boolean }> }).workspaceSymbols = async () => {
      jdtProbe.workspaceSymbolsCalls += 1;
      return { items: [], truncated: false };
    };
    const jdt = (await javaSymbol(jdtContext, args({ query: "OrderService", backend: "jdt", semanticTimeoutMs: 3000 }))) as Record<string, unknown>;
    assert.equal(jdt.mode, "query", "backend=jdt keeps the legacy result shape");
    assert.equal(jdtProbe.workspaceSymbolsCalls, 1);
    assert.equal(jdtProbe.startCalls, 0, "an already-open session is used, never started");
  } finally {
    await fixture.cleanup();
  }
});

test("query→impact: the returned locator feeds java_impact on the same snapshot", async () => {
  const fixture = await buildFixture();
  // One client over the on-disk snapshot: the router opens it, then the
  // symbol tool's static path reuses the same READY instance.
  const client = fixture.client as SqlJavaIndexClient;
  const routerIndex = new RouterJavaIndex(fixture.repoRoot, client);
  try {
    await routerIndex.open(1);
    await routerIndex.reconcile(1);
    await waitForCompleteIndex(routerIndex);
    const probe: JdtProbe = { startCalls: 0, workspaceSymbolsCalls: 0, referencesCalls: 0, symbolContextCalls: 0 };
    const router = new AgentRouter(fixture.repoRoot, makeContext(fixture.repoRoot, client, probe).session as never, routerIndex, undefined, undefined, new EmptyRgRunner());
    const context = makeContext(fixture.repoRoot, client, probe, { router, javaIndex: routerIndex });

    const discovery = (await javaSymbol(context, args({ query: "com.acme.OrderService", semanticTimeoutMs: 3000 }), { budget: DeadlineBudget.fromTimeout(15000) })) as Record<string, unknown>;
    const declaration = ((discovery.candidates as Array<Record<string, unknown>>)[0].declaration) as {
      relativePath: string;
      contentHash: string;
      selection: { line: number; column: number };
    };
    assert.equal(discovery.generation, 1, "discovery must report the index generation it read");
    assert.ok(declaration.selection.line >= 1);

    // semanticPolicy=fast: impact stays fully static, so the locator is the
    // only thing that places the anchor — no row re-search allowed.
    const impact = (await javaImpact(context, {
      file: declaration.relativePath,
      line: declaration.selection.line,
      column: declaration.selection.column,
      semanticPolicy: "fast"
    } as unknown as Parameters<typeof javaImpact>[1], { budget: DeadlineBudget.fromTimeout(15000) } as unknown as Parameters<typeof javaImpact>[2] )) as Record<string, unknown>;
    const serialized = JSON.stringify(impact);
    assert.ok(serialized.includes("OrderService.java"), "impact must anchor the file the locator named");
    assert.ok(serialized.includes(String(declaration.selection.line)), "impact must keep the locator line verbatim");

    const status = await client.status();
    assert.equal(discovery.generation, status.indexedGeneration, "query and impact must agree on the generation");
    const onDisk = await readFile(path.join(fixture.repoRoot, declaration.relativePath), "utf8");
    assert.equal(createHash("sha256").update(onDisk, "utf8").digest("hex"), declaration.contentHash);
    assert.equal(probe.startCalls, 0);
  } finally {
    await fixture.cleanup();
  }
});
