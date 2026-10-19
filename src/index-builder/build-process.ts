// input: one BuildScheduler admission (workspace, job, parser grant).
// output: a request-owned builder process that publishes one job atomically, reports it, and exits.
// pos: MAC-06C real builder adapter. The owner scheduler holds the slot until
//      this process closes; a delta that needs a full reports it (escalation
//      "report") so the full waits for the scheduler's full slot.
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownerChildStdio } from "../mac-platform/owner-lock.js";
import type { BuildAttempt, BuildGrant, BuildHint, BuildOutcome } from "./build-scheduler.js";
import type { BuilderJob, BuilderJobResult } from "./incremental.js";

export type BuildProcessRequest = { repoRoot: string; dbPath: string; job: BuilderJob; parallelism: number };
type BuildProcessMessage = { type: "job"; request: BuildProcessRequest };
type BuildProcessReply = { type: "result"; result: BuilderJobResult } | { type: "failed"; error: string };

const workerPath = fileURLToPath(import.meta.url);

/** The builder job for an admitted hint: a full, a reconcile for a rescan, otherwise a refresh. */
export function builderJobFor(hint: Readonly<BuildHint>, kind = hint.kind): BuilderJob {
  if (kind === "full") return { kind: "full", generation: hint.generation };
  if (hint.rescan) return { kind: "reconcile", generation: hint.generation };
  return { kind: "refresh", generation: hint.generation, changed: [...hint.changed ?? []], deleted: [...hint.deleted ?? []] };
}

/** Fork one builder for one job. It keeps the owner's PGID and lock fd (fd4). */
export function startBuildProcess(input: { repoRoot: string; dbPath: string; job: BuilderJob; grant: BuildGrant; env?: NodeJS.ProcessEnv }): BuildAttempt {
  const child = fork(workerPath, [], {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    env: input.env ?? process.env,
    stdio: ownerChildStdio(["ignore", "ignore", "inherit", "ipc"], input.env)
  });
  const result = new Promise<BuildOutcome>((resolve, reject) => {
    child.on("message", (message: BuildProcessReply) => {
      if (message.type === "failed") { reject(new Error(message.error)); return; }
      if (message.type !== "result") return;
      // Captures are not shipped back: the full re-reads its sources.
      resolve(message.result.escalation !== undefined
        ? { kind: "needs-full", captures: [], reason: message.result.escalation }
        : { kind: "result", result: message.result });
    });
  });
  // Unsettled if the child dies first: the scheduler then reports the exit.
  result.catch(() => undefined);
  child.once("spawn", () => {
    const message: BuildProcessMessage = { type: "job", request: { repoRoot: input.repoRoot, dbPath: input.dbPath, job: input.job, parallelism: input.grant.parserTokens } };
    child.send(message, error => { if (error) child.kill("SIGKILL"); });
  });
  return { child, result };
}

async function runWorker(): Promise<void> {
  // The owner is gone: the job's transaction rolls back on the next open.
  process.once("disconnect", () => process.exit(70));
  const message = await new Promise<BuildProcessMessage>(resolve => process.once("message", resolve));
  const { request } = message;
  const { openIndexDb, close } = await import("../java-index/sql/driver.js");
  const { ensureSchema } = await import("../java-index/sql/schema.js");
  const { applyBuilderJob } = await import("./incremental.js");
  const { contentManifestId } = await import("../java-index/sql/snapshot-manifest.js");
  const { faultBarrier } = await import("../mac-platform/fault-barrier.js");
  const barrier = faultBarrier();
  let reply: BuildProcessReply;
  const db = openIndexDb(request.dbPath);
  try {
    ensureSchema(db);
    const result = await applyBuilderJob({ repoRoot: request.repoRoot, db, job: request.job, escalation: "report", parallelism: request.parallelism,
      ...(barrier ? { onStage: (stage: string) => Promise.resolve(barrier(`builder-${stage}`)) } : {}) });
    // The publish plan carries the content this builder actually captured (contract §2.7), never one derived later.
    reply = { type: "result", result: result.ok && result.escalation === undefined ? { ...result, contentManifestId: contentManifestId(db).id } : result };
  } catch (error) {
    reply = { type: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    close(db);
  }
  // The result follows the commit; exit only once it is handed to the channel.
  process.send!(reply, () => process.exit(0));
}

const entry = process.argv[1];
if (entry && typeof process.send === "function" && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runWorker().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
