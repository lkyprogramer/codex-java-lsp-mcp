// Synthetic acceptance entry only (MAC-03B). The owner launcher preloads its lock guard; the tracker
// runs on the real native FSEvents helper and publishes into a real SnapshotStore under the owner cache.
import { createInterface } from "node:readline";
import { runSqlColdBuild } from "../dist/index-builder/cold-build.js";
import { close, openIndexDb } from "../dist/java-index/sql/driver.js";
import { ensureSchema } from "../dist/java-index/sql/schema.js";
import { contentManifestId } from "../dist/java-index/sql/snapshot-manifest.js";
import { readSnapshotContent } from "../dist/java-index/snapshot/seal.js";
import { SnapshotStore } from "../dist/java-index/snapshot/snapshot-store.js";
import { nativeTrackerSource, WorkspaceTracker } from "../dist/java-index/snapshot/workspace-tracker.js";

const [repo, cache] = process.argv.slice(2);
let tracker;
let store;
const invalid = [];

async function cycle() {
  const workspaceId = tracker.workspaceId;
  const round = await tracker.dispatch({ bindingVersion: store.bindingVersionOf(workspaceId) });
  store.track(workspaceId, tracker.trackedState());
  const bound = store.binding(workspaceId);
  const base = bound ? await readSnapshotContent(store.layout, bound.snapshotId) : undefined;
  const verification = await tracker.verify(round, base && { entries: base.entries, buildKey: base.manifest.buildKey });
  let binding;
  let builtContent = null;
  if (verification.noop) binding = await store.confirmNoop(tracker.planFor(verification));
  else {
    const job = await store.createJob({ workspaceId, captureId: round.captureId });
    const db = openIndexDb(job.dbPath);
    try { ensureSchema(db); await runSqlColdBuild({ repoRoot: repo, db, generation: round.workspaceGeneration }); builtContent = contentManifestId(db).id; }
    finally { close(db); }
    binding = await store.publish(tracker.planFor(verification, builtContent), job);
  }
  const status = tracker.complete(round, binding);
  return { epoch: round.epoch, cut: round.cut, mode: round.mode, changed: verification.changed, deleted: verification.deleted, hashed: verification.hashed,
    noop: verification.noop, agree: builtContent === null || builtContent === verification.contentManifestId, snapshotId: binding.snapshotId,
    bindingVersion: binding.bindingVersion, coveredThroughSeq: binding.coveredThroughSeq, status };
}

for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  try {
    let result;
    if (command.op === "start") {
      ({ store } = await SnapshotStore.open(cache));
      tracker = await WorkspaceTracker.start({ canonicalRoot: repo, source: nativeTrackerSource(repo), onInvalidRoot: error => invalid.push(String(error)) });
      store.track(tracker.workspaceId, tracker.trackedState());
      result = { workspaceId: tracker.workspaceId, epoch: tracker.trackerEpoch, status: tracker.status() };
    } else if (command.op === "cycle") result = await cycle();
    else if (command.op === "status") result = { status: tracker.status(), diagnostics: tracker.diagnostics(), invalid };
    else if (command.op === "restart") { await tracker.restartStream(); store.track(tracker.workspaceId, tracker.trackedState()); result = { epoch: tracker.trackerEpoch, status: tracker.status() }; }
    else if (command.op === "dispatch-invalid") {
      try { await tracker.dispatch({ bindingVersion: store.bindingVersionOf(tracker.workspaceId) }); result = { refused: false }; }
      catch (error) { store.track(tracker.workspaceId, tracker.trackedState()); result = { refused: true, error: String(error), served: Boolean(store.acquireBound(tracker.workspaceId, "request")) }; }
    } else if (command.op === "stop") { await tracker.stop(5000); result = { stopped: true }; }
    else if (command.op === "exit") { process.stdout.write(JSON.stringify({ id: command.id, result: { exiting: true } }) + "\n"); break; }
    else throw new Error("unknown fixture command");
    process.stdout.write(JSON.stringify({ id: command.id, result }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ id: command.id, error: String(error && error.stack || error) }) + "\n"); process.exitCode = 1; break; }
}
if (tracker) await tracker.stop(5000).catch(() => undefined);
