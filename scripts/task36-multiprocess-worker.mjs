// Independent OS-process participant for the Task36 Step6a lease smoke.
// Coordination is exclusively IPC based: the parent opens a barrier, asks a
// worker to claim/release a real filesystem lease, and observes the result.
import { FileCrossProcessLeaseStore, defaultLeaseClockDeps } from "../dist/cross-process-lease.js";
import { DeadlineBudget } from "../dist/runtime/deadline-budget.js";

const leaseRoot = process.env.TASK36_LEASE_ROOT;
const jdtSlots = Number(process.env.TASK36_JDT_SLOTS);
const sweepSlots = Number(process.env.TASK36_SWEEP_SLOTS);
const workerId = process.env.TASK36_WORKER_ID ?? `worker-${process.pid}`;

if (!leaseRoot || !Number.isInteger(jdtSlots) || jdtSlots <= 0 || !Number.isInteger(sweepSlots) || sweepSlots <= 0) {
  throw new Error("TASK36_LEASE_ROOT and positive integer slot capacities are required");
}
if (typeof process.send !== "function") {
  throw new Error("task36-multiprocess-worker.mjs requires a Node IPC channel");
}

const store = new FileCrossProcessLeaseStore(leaseRoot, defaultLeaseClockDeps());
let jdtLease;
let sweepLease;

function identity(repoHash) {
  return {
    repoRoot: `/task36/${repoHash}`,
    repoHash,
    familyHash: "task36-family",
    isLinkedWorktree: true
  };
}

async function releaseAll() {
  if (sweepLease) {
    const lease = sweepLease;
    sweepLease = undefined;
    await lease.release();
  }
  if (jdtLease) {
    const lease = jdtLease;
    jdtLease = undefined;
    await lease.release();
  }
}

async function handleCommand(message) {
  const { requestId, op } = message;
  if (op === "try-jdt") {
    if (jdtLease) throw new Error("worker already holds a JDT lease");
    const result = await store.tryAcquireJdt(identity(message.repoHash));
    if (result.kind === "ACQUIRED") jdtLease = result.lease;
    process.send({ type: "response", requestId, result: { kind: result.kind, pid: process.pid } });
    return;
  }

  if (op === "acquire-sweep") {
    if (sweepLease) throw new Error("worker already holds a sweep lease");
    try {
      sweepLease = await store.acquireSweep(
        identity(message.repoHash),
        DeadlineBudget.fromTimeout(message.timeoutMs)
      );
      process.send({ type: "response", requestId, result: { kind: "SWEEP_SLOT", pid: process.pid } });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const kind = /deadline exceeded/i.test(messageText) ? "DEADLINE_EXCEEDED" : "ERROR";
      process.send({ type: "response", requestId, result: { kind, message: messageText, pid: process.pid } });
    }
    return;
  }

  if (op === "status") {
    process.send({ type: "response", requestId, result: await store.status() });
    return;
  }

  if (op === "release-jdt") {
    if (jdtLease) {
      const lease = jdtLease;
      jdtLease = undefined;
      await lease.release();
    }
    process.send({ type: "response", requestId, result: { released: true } });
    return;
  }

  if (op === "release-sweep") {
    if (sweepLease) {
      const lease = sweepLease;
      sweepLease = undefined;
      await lease.release();
    }
    process.send({ type: "response", requestId, result: { released: true } });
    return;
  }

  if (op === "shutdown") {
    await releaseAll();
    process.send({ type: "response", requestId, result: { released: true } }, () => {
      process.disconnect();
    });
    return;
  }

  if (op === "crash-without-release") {
    // This is the deliberate dead-owner fixture. process.exit bypasses normal
    // cleanup so the next real process must reclaim both lease directories.
    process.exit(86);
  }

  throw new Error(`unknown worker operation: ${String(op)}`);
}

await store.open({ jdtSlots, sweepSlots });
process.send({ type: "ready", workerId, pid: process.pid });

let commandChain = Promise.resolve();
process.on("message", message => {
  commandChain = commandChain
    .then(() => handleCommand(message))
    .catch(error => {
      process.send({
        type: "response",
        requestId: message?.requestId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
});

process.on("disconnect", () => {
  void releaseAll().finally(() => {
    process.exitCode = 0;
  });
});
