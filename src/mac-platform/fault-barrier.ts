// input: JAVA_LSP_ISOLATED_VALIDATION=1 and an absolute JAVA_LSP_FAULT_BARRIER_DIR.
// output: a FaultHook that holds the calling process at an armed step until it is released or killed.
// pos: MAC-09 isolated-validation seam for the fault matrix: an external SIGKILL lands while the
//      owner (or its builder) is inside clone/SQL/checkpoint/seal/binding. Without both variables
//      there is no hook and no file is ever read.
//      `<dir>/<step>.arm` arms one hit; the process that claims it writes `<step>.held` ({ pid, step })
//      and polls until `<step>.release` appears.
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FaultHook } from "../java-index/snapshot/seal.js";

const POLL_MS = 20;

export function faultBarrier(env: NodeJS.ProcessEnv = process.env): FaultHook | undefined {
  const dir = env.JAVA_LSP_FAULT_BARRIER_DIR;
  if (env.JAVA_LSP_ISOLATED_VALIDATION !== "1" || !dir) return undefined;
  if (!path.isAbsolute(dir)) throw new Error("JAVA_LSP_FAULT_BARRIER_DIR must be absolute");
  return async step => {
    const arm = path.join(dir, `${step}.arm`);
    if (!existsSync(arm)) return;
    // One hit: the rename claims the arm, so a second process at the same step passes through.
    const claim = path.join(dir, `${step}.claim-${process.pid}`);
    try { renameSync(arm, claim); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    writeFileSync(claim, `${JSON.stringify({ pid: process.pid, step, at: Date.now() })}\n`);
    renameSync(claim, path.join(dir, `${step}.held`));
    const release = path.join(dir, `${step}.release`);
    while (!existsSync(release)) await delay(POLL_MS);
    unlinkSync(release);
  };
}
