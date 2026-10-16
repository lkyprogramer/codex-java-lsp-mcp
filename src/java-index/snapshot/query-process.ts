// input: one static entity search (db path, task, limit, mode, deadline).
// output: a request-owned query process that opens its own read-only connection, answers, and exits.
// pos: MAC-06C real query adapter for QueryPool. Unlike the discovery worker
//      thread, a process can be killed in the middle of a native SQLite step;
//      the pool releases its slot and lease only once it actually closed.
import { fork } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DetailedEntitySearchResult, EntitySearchMode, EntitySearchScope } from "../entity-search.js";
import { ownerChildStdio } from "../../mac-platform/owner-lock.js";
import type { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { QueryLease, QueryTask } from "./query-pool.js";

export type QueryProcessRequest = {
  dbPath: string;
  task: string;
  limit: number;
  mode: EntitySearchMode;
  scope?: EntitySearchScope;
  maxPostings?: number;
  /** Test seam (forwarded only with allowTestHooks): hold a read snapshot
   * and stall this long before searching, as a stuck native step would. */
  testBlockMs?: number;
};
type QueryProcessMessage = { type: "search"; request: QueryProcessRequest; remainingMs: number };
type QueryProcessReply =
  | { type: "started" }
  | { type: "result"; result: DetailedEntitySearchResult }
  | { type: "failed"; error: string };

const workerPath = fileURLToPath(import.meta.url);

/** Fork one query process. It keeps the owner's PGID and lock fd (fd4). */
export function startQueryProcess(input: {
  request: QueryProcessRequest;
  budget: DeadlineBudget;
  allowTestHooks?: boolean;
  onStarted?: () => void;
  env?: NodeJS.ProcessEnv;
}) {
  const child = fork(workerPath, [], {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    env: input.env ?? process.env,
    stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"], input.env)
  });
  const result = new Promise<DetailedEntitySearchResult>((resolve, reject) => {
    child.on("message", (message: QueryProcessReply) => {
      if (message.type === "started") input.onStarted?.();
      if (message.type === "failed") reject(new Error(message.error));
      if (message.type === "result") resolve(message.result);
    });
  });
  result.catch(() => undefined);
  const { testBlockMs, ...request } = input.request;
  const message: QueryProcessMessage = { type: "search", remainingMs: input.budget.remainingMs(),
    request: input.allowTestHooks && testBlockMs ? { ...request, testBlockMs } : request };
  child.once("spawn", () => child.send(message, error => { if (error) child.kill("SIGKILL"); }));
  return { child, result };
}

/** A QueryPool task for one search under `lease`. */
export function queryProcessTask(input: {
  request: QueryProcessRequest;
  budget: DeadlineBudget;
  signal?: AbortSignal;
  acquire(signal: AbortSignal): QueryLease | Promise<QueryLease>;
  allowTestHooks?: boolean;
  onStarted?: () => void;
}): QueryTask<DetailedEntitySearchResult> {
  return {
    budget: input.budget,
    signal: input.signal,
    acquire: input.acquire,
    start: () => startQueryProcess({ request: input.request, budget: input.budget, allowTestHooks: input.allowTestHooks, onStarted: input.onStarted })
  };
}

async function runWorker(): Promise<void> {
  process.once("disconnect", () => process.exit(70));
  const message = await new Promise<QueryProcessMessage>(resolve => process.once("message", resolve));
  const deadlineAt = performance.now() + message.remainingMs;
  const { openIndexDb, close } = await import("../sql/driver.js");
  const { SqlEntitySearch } = await import("../sql/entity-search.js");
  const { request } = message;
  let reply: QueryProcessReply;
  const db = openIndexDb(request.dbPath, { readOnly: true });
  try {
    if (request.testBlockMs) {
      db.exec("BEGIN");
      db.prepare("SELECT count(*) AS n FROM entity").get();
      await new Promise<void>(resolve => process.send!({ type: "started" } satisfies QueryProcessReply, () => resolve()));
      const until = performance.now() + request.testBlockMs;
      while (performance.now() < until) { /* a stalled step: the event loop stays blocked */ }
      db.exec("COMMIT");
    } else process.send!({ type: "started" } satisfies QueryProcessReply);
    const result = new SqlEntitySearch(db).searchDetailed(request.task, request.limit, request.mode, {
      scope: request.scope,
      budget: { maxPostings: request.maxPostings, remainingMs: () => deadlineAt - performance.now() }
    });
    reply = { type: "result", result };
  } catch (error) {
    reply = { type: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    close(db);
  }
  process.send!(reply, () => process.exit(0));
}

const entry = process.argv[1];
if (entry && typeof process.send === "function" && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runWorker().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
