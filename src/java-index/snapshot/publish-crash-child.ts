// input: argv[2] JSON {cacheRoot, template, plan, step}.
// output: publishes a copy of `template` for `plan`, SIGKILLing itself at `step` (or exiting 0 when "none").
// pos: MAC-07 G07 crash child for snapshot-store.test.ts; a real process death at each publish boundary.
import { copyFile } from "node:fs/promises";
import { SnapshotStore, type BindPlan } from "./snapshot-store.js";

const { cacheRoot, template, plan, step } = JSON.parse(process.argv[2]!) as { cacheRoot: string; template: string; plan: BindPlan; step: string };
const { store } = await SnapshotStore.open(cacheRoot, { faultAt: at => { if (at === step) process.kill(process.pid, "SIGKILL"); } });
store.track(plan.workspaceId, { root: plan.root, workspaceGeneration: plan.workspaceGeneration, trackerEpoch: plan.trackerEpoch });
const job = await store.createJob({ workspaceId: plan.workspaceId, captureId: plan.captureId });
process.stdout.write(`${JSON.stringify({ jobId: job.jobId })}\n`);
await copyFile(template, job.dbPath);
const binding = await store.publish(plan, job);
process.stdout.write(`${JSON.stringify({ published: binding.snapshotId })}\n`);
