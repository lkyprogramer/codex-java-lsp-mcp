// input: { id, repoRoot, layoutProfile } messages from probeLayoutOffThread.
// output: { id, value } with the LayoutContext, or { id, error }.
// pos: layout probing off the owner's event loop. The probe walks module and source directories with
//      synchronous stat/readdir; on a disk busy with builds and seals one walk took 5.7 s on the owner
//      thread and held every request past its deadline (MAC-11 G11 evidence).
import { parentPort } from "node:worker_threads";
import { probeLayout } from "./layout-probe.js";

parentPort!.on("message", (input: { id: number; repoRoot: string; layoutProfile: string }) => {
  try {
    parentPort!.postMessage({ id: input.id, value: probeLayout(input.repoRoot, input.layoutProfile) });
  } catch (error) {
    parentPort!.postMessage({ id: input.id, error: error instanceof Error ? error.message : String(error), code: (error as NodeJS.ErrnoException).code });
  }
});
