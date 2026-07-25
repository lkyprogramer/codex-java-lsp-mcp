import { parentPort } from "node:worker_threads";
import type { JavaIndexStatus, JavaTypeLookupResult } from "./index-types.js";
import type { JavaIndexRequest, JavaIndexResponse } from "./worker-protocol.js";

let status: JavaIndexStatus = {
  state: "NEW",
  indexedGeneration: 0,
  files: 0,
  types: 0,
  methods: 0,
  edges: 0,
  snapshotBytes: 0,
  pendingForeground: 0,
  pendingBackground: 0,
  coverage: []
};

const commandQueue: JavaIndexRequest[] = [];
let draining = false;

function respond(response: JavaIndexResponse): void {
  parentPort?.postMessage(response);
}

function unresolvedTypeLookup(): JavaTypeLookupResult {
  // No extraction is implemented yet (Task 16+); DEGRADED is the honest
  // coverage state for a worker that has not indexed anything.
  return { state: "UNRESOLVED", coverage: "DEGRADED" };
}

async function handle(request: JavaIndexRequest): Promise<void> {
  try {
    switch (request.type) {
      case "OPEN": {
        status = { ...status, state: "READY", indexedGeneration: request.generation };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "STATUS": {
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "CLOSE": {
        status = { ...status, state: "CLOSED" };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "REFRESH":
      case "RECONCILE":
      case "FLUSH": {
        status = { ...status, indexedGeneration: "generation" in request ? request.generation : status.indexedGeneration };
        respond({ id: request.id, ok: true, value: status });
        return;
      }
      case "QUERY_ANCHOR": {
        respond({ id: request.id, ok: true, value: undefined });
        return;
      }
      case "QUERY_TYPE": {
        respond({ id: request.id, ok: true, value: unresolvedTypeLookup() });
        return;
      }
      case "QUERY_IMPLEMENTERS":
      case "QUERY_TYPE_REFERENCERS":
      case "QUERY_CALLERS":
      case "QUERY_CALLEES":
      case "QUERY_FILES": {
        respond({ id: request.id, ok: true, value: [] });
        return;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`unhandled command: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    respond({
      id: request.id,
      ok: false,
      error: {
        code: "WORKER_UNHANDLED",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    });
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (commandQueue.length > 0) {
      const next = commandQueue.shift();
      if (next) await handle(next);
    }
  } finally {
    draining = false;
  }
}

parentPort?.on("message", (request: JavaIndexRequest) => {
  commandQueue.push(request);
  void drain();
});
