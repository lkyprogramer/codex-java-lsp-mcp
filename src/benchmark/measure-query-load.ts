// input: synthetic repository size (file count) and an output directory.
// output: raw load report — EXPLAIN QUERY PLAN captures, rare-exact vs
//         broad-term comparisons, a bounded 20-query queue, and P50/P95.
// pos: T07 evidence helper. The synthetic corpus proves the mechanisms at
//      scale; it is NOT a performance-gate PASS (warm real-corpus thresholds
//      are measured separately and must not be extrapolated from this).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { openIndexDb, close, type IndexDatabase } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { SqlEntitySearch, readIndexGeneration } from "../java-index/sql/entity-search.js";

interface LoadArgs {
  files: number;
  output: string;
}

function parseArgs(argv: string[]): LoadArgs {
  let files = 1000;
  let output: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--files" && argv[i + 1]) files = Number(argv[i + 1]);
    else if (argv[i] === "--output" && argv[i + 1]) output = argv[i + 1];
  }
  if (!Number.isInteger(files) || files < 1) throw new Error("--files must be a positive integer");
  if (!output) throw new Error("--output is required");
  return { files, output };
}

function generateRepo(root: string, count: number): string[] {
  const written: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const pkg = `p${String(Math.floor(i / 50)).padStart(5, "0")}`;
    const simple = `Service${String(i).padStart(5, "0")}`;
    const relative = path.join("src", "main", "java", "com", "synth", pkg, `${simple}.java`).split(path.sep).join("/");
    const content = `package com.synth.${pkg};
/** Keeps the order record for ${simple}. */
public class ${simple} {
    public void updateOrder(int id) {
        // touch the order ledger
    }

    public void refundOrder(long id) {
        // reverse the order payment
    }
}
`;
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
    written.push(relative);
  }
  return written;
}

function explainPlans(db: IndexDatabase, sampleFqn: string, sampleSimple: string): Record<string, string[][]> {
  const plans: Record<string, string[]> = {
    "exact:fqn_like": [
      `EXPLAIN QUERY PLAN SELECT s.text AS entityId FROM entity e JOIN sym s ON s.id = e.sym WHERE e.fqn = '${sampleFqn}' OR e.fqn LIKE '${sampleFqn}%' LIMIT 10`
    ],
    "suffix:simple_in": [
      `EXPLAIN QUERY PLAN SELECT e.sym FROM entity e WHERE e.kind='type' AND e.simple_name_lc = '${sampleSimple.toLowerCase()}' LIMIT 10`
    ],
    "bm25:entity_postings": [
      "EXPLAIN QUERY PLAN SELECT t.token_sym FROM entity_token t WHERE t.field = 0 AND t.token_sym IN (1, 2, 3)"
    ],
    "doc:search_doc_postings": [
      "EXPLAIN QUERY PLAN SELECT t.doc_sym, t.tf FROM search_doc_token t WHERE t.token_sym IN (1, 2, 3)"
    ],
    "old:avg_length_scan": ["EXPLAIN QUERY PLAN SELECT count(*) AS n, coalesce(sum(ident_len), 0) AS total FROM entity"]
  };
  const out: Record<string, string[][]> = {};
  for (const [name, statements] of Object.entries(plans)) {
    out[name] = statements.map(statement =>
      (db.prepare(statement).all() as Array<Record<string, unknown>>)
        .map(row => Object.values(row).join(" | "))
    );
  }
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.output, { recursive: true });
  const root = path.join(os.tmpdir(), `devkit-load-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const dbPath = path.join(root, "load.sqlite");
  let buildSeconds = 0;
  let buildCounts: unknown;
  try {
    mkdirSync(root, { recursive: true });
    const generatedAt = performance.now();
    generateRepo(root, args.files);
    const generateSeconds = (performance.now() - generatedAt) / 1000;
    const buildDb = openIndexDb(dbPath);
    ensureSchema(buildDb);
    const buildStarted = performance.now();
    const build = await runSqlColdBuild({ db: buildDb, repoRoot: root });
    buildSeconds = (performance.now() - buildStarted) / 1000;
    buildCounts = build;
    close(buildDb);

    const db = openIndexDb(dbPath, { readOnly: true });
    try {
      const search = new SqlEntitySearch(db);
      const generation = readIndexGeneration(db);
      // Deterministic samples: the first file of the corpus.
      const sampleFqn = "com.synth.p00000.Service00000";
      const plans = explainPlans(db, sampleFqn, "service00000");

      // Rare exact: point lookup must not visit a single posting row.
      const exactDeadline = performance.now() + 500;
      const exact = search.searchDetailed(sampleFqn, 10, "exact", {
        budget: { maxPostings: 1, remainingMs: () => Math.max(0, exactDeadline - performance.now()) }
      });
      const broadUnboundedStarted = performance.now();
      const broadUnbounded = search.searchDetailed("order", 10, "text");
      const broadUnboundedMs = performance.now() - broadUnboundedStarted;
      const broadDeadlineMs = 200;
      const broadBoundedStarted = performance.now();
      const broadBounded = search.searchDetailed("order", 10, "text", {
        budget: { maxPostings: 5000, remainingMs: () => Math.max(0, broadBoundedStarted + broadDeadlineMs - performance.now()) }
      });
      const broadBoundedMs = performance.now() - broadBoundedStarted;

      // Bounded queue: 20 broad queries on one synchronous connection, each
      // with its own 200ms parent deadline. Sequential by construction —
      // synchronous SQLite cannot interleave, so "concurrent" means queued.
      const queue: Array<{ ms: number; truncated: boolean; stopReason: string | undefined; postings: number; hits: number }> = [];
      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        const result = search.searchDetailed("order refund ledger", 10, "text", {
          budget: { maxPostings: 5000, remainingMs: () => Math.max(0, started + 200 - performance.now()) }
        });
        queue.push({
          ms: performance.now() - started,
          truncated: result.truncated,
          stopReason: result.stopReason,
          postings: result.work.postings,
          hits: result.hits.length
        });
      }
      const queueMs = queue.map(item => item.ms);
      const report = {
        kind: "synthetic-load",
        files: args.files,
        generateSeconds: round3(generateSeconds),
        buildSeconds: round3(buildSeconds),
        build: buildCounts,
        generation,
        explain: plans,
        exact: {
          fqn: sampleFqn,
          hits: exact.hits.length,
          truncated: exact.truncated,
          stopReason: exact.stopReason ?? null,
          postingsVisited: exact.work.postings
        },
        broad: {
          term: "order",
          unbounded: { hits: broadUnbounded.hits.length, ms: round3(broadUnboundedMs), truncated: broadUnbounded.truncated, postingsVisited: broadUnbounded.work.postings },
          bounded: {
            maxPostings: 5000,
            deadlineMs: broadDeadlineMs,
            hits: broadBounded.hits.length,
            ms: round3(broadBoundedMs),
            truncated: broadBounded.truncated,
            stopReason: broadBounded.stopReason ?? null,
            postingsVisited: broadBounded.work.postings
          }
        },
        queue: {
          queries: 20,
          perQueryDeadlineMs: 200,
          p50Ms: round3(percentile(queueMs, 50)),
          p95Ms: round3(percentile(queueMs, 95)),
          timeouts: queue.filter(item => item.stopReason === "deadline").length,
          postingsStops: queue.filter(item => item.stopReason === "postings").length,
          truncated: queue.filter(item => item.truncated).length,
          rejections: 0
        },
        fts5: "NOT_RUN (same-representation experiment only; no second default backend)",
        note: "Synthetic corpus: mechanism evidence only. Warm 150ms / event-loop thresholds are UNMEASURED without a real corpus."
      };
      writeFileSync(path.join(args.output, "query-load-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      writeFileSync(
        path.join(args.output, "query-load-explain.txt"),
        Object.entries(plans).map(([name, rows]) => `# ${name}\n${rows.flat().join("\n")}\n`).join("\n"),
        "utf8"
      );
      process.stdout.write(`${JSON.stringify({ ok: true, files: args.files, buildSeconds: report.buildSeconds, queueP95Ms: report.queue.p95Ms, queueTimeouts: report.queue.timeouts })}\n`);
    } finally {
      close(db);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});