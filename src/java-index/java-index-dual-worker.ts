/**
 * V4-05 / ADR-01: opt-in second JavaIndex parse thread.
 * Default remains the single query worker until storm gates pass twice.
 */
export const JAVA_LSP_JAVA_INDEX_DUAL_WORKER = "JAVA_LSP_JAVA_INDEX_DUAL_WORKER";

export function isJavaIndexDualWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JAVA_LSP_JAVA_INDEX_DUAL_WORKER] === "1";
}
