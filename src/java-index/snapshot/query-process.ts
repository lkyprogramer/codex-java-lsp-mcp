// input: QueryWorker runs ({ dbPath, request }) for sealed snapshots, one at a time.
// output: a persistent query process: answers each run from a cached immutable connection
//         and reports which connections it still holds, so the pool's leases follow them.
// pos: MAC-08A production query worker for QueryPool. Unlike a worker thread, a process
//      can be killed in the middle of a native SQLite step; the pool releases its slot
//      and every lease it held only once it actually closed.
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownerChildStdio } from "../../mac-platform/owner-lock.js";
import type { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { QueryOpName, QueryOps, QueryRequest, SnapshotConnection } from "./query-ops.js";
import type { QueryLease, QueryTask, QueryWorkerReply, QueryWorkerRequest } from "./query-pool.js";

export type QueryRunPayload = {
  dbPath: string;
  request: QueryRequest;
  /** Test seam (forwarded only with allowTestHooks): hold a read snapshot
   * and stall this long before answering, as a stuck native step would. */
  testBlockMs?: number;
};

/** Connections one worker keeps between runs; older ones are closed (and their leases released). */
export const WORKER_CONNECTIONS = 4;

const workerPath = fileURLToPath(import.meta.url);

/** Fork one persistent query worker. It keeps the owner's PGID and lock fd (fd4). */
export function spawnQueryWorker(env?: NodeJS.ProcessEnv): ChildProcess {
  return fork(workerPath, [], {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    env: env ?? process.env,
    serialization: "advanced",
    stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"], env)
  });
}

/** A QueryPool task for one operation on the snapshot `acquire` leases. */
export function queryOpTask<K extends QueryOpName>(input: {
  request: QueryRequest<K>;
  budget: DeadlineBudget;
  signal?: AbortSignal;
  acquire(signal: AbortSignal): (QueryLease & { readonly dbPath: string }) | Promise<QueryLease & { readonly dbPath: string }>;
  allowTestHooks?: boolean;
  testBlockMs?: number;
}): QueryTask<QueryOps[K]["result"]> {
  let dbPath = "";
  return {
    budget: input.budget,
    signal: input.signal,
    acquire: async signal => {
      const lease = await input.acquire(signal);
      dbPath = lease.dbPath;
      return lease;
    },
    payload: () => ({ dbPath, request: input.request,
      ...(input.allowTestHooks && input.testBlockMs ? { testBlockMs: input.testBlockMs } : {}) } satisfies QueryRunPayload)
  };
}

function runWorker(): void {
  // Registered before the ops module loads: an early run waits on the chain, it is never dropped.
  const ops = import("./query-ops.js");
  ops.catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
  const connections = new Map<string, SnapshotConnection>();
  const open = () => [...connections.keys()];
  const closeKey = (key: string) => {
    const conn = connections.get(key);
    connections.delete(key);
    try { conn?.close(); } catch { /* the lease is released either way once the key is gone */ }
  };
  const send = (reply: QueryWorkerReply) => new Promise<void>(resolve => process.send!(reply, () => resolve()));
  process.once("disconnect", () => {
    for (const key of open()) closeKey(key);
    process.exit(0);
  });
  let chain: Promise<unknown> = ops;
  process.on("message", (message: QueryWorkerRequest) => {
    chain = chain.then(async () => {
      const { SnapshotConnection: Connection, runQueryOp } = await ops;
      if (message.type === "exit") {
        for (const key of open()) closeKey(key);
        process.exit(0);
      }
      if (message.type === "close") {
        for (const key of message.keys) closeKey(key);
        await send({ type: "closed", open: open() });
        return;
      }
      const deadlineAt = performance.now() + message.remainingMs;
      const payload = message.payload as QueryRunPayload;
      try {
        let conn = connections.get(message.key);
        if (conn) {
          connections.delete(message.key);
        } else {
          conn = new Connection(payload.dbPath);
        }
        connections.set(message.key, conn); // most recently used last
        while (connections.size > WORKER_CONNECTIONS) closeKey(connections.keys().next().value!);
        if (payload.testBlockMs) {
          conn.db.exec("BEGIN");
          conn.db.prepare("SELECT count(*) AS n FROM file").get();
          await send({ type: "started", id: message.id });
          const until = performance.now() + payload.testBlockMs;
          while (performance.now() < until) { /* a stalled step: the event loop stays blocked */ }
          conn.db.exec("COMMIT");
        }
        const value = await runQueryOp(conn, payload.request, () => deadlineAt - performance.now());
        await send({ type: "result", id: message.id, value, open: open() });
      } catch (error) {
        await send({ type: "failed", id: message.id, error: error instanceof Error ? error.message : String(error), open: open() });
      }
    });
  });
}

const entry = process.argv[1];
if (entry && typeof process.send === "function" && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runWorker();
}
