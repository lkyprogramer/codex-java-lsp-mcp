// input: process name and a Process-like event target.
// output: one structured JSON line on uncaughtException / unhandledRejection / exit / near-heap.
// pos: FSX4. KeepAlive previously hid 12 daemon OOMs; these markers must land before process death.
import v8 from "node:v8";

export const CRASH_MARKER = "codex-java-lsp-crash";

export type CrashMarkerPayload = {
  marker: typeof CRASH_MARKER;
  process: string;
  event: "uncaughtException" | "unhandledRejection" | "exit" | "nearHeapLimit";
  pid: number;
  at: string;
  code?: number;
  name?: string;
  message?: string;
  heapLimitBytes?: number;
  heapUsedBytes?: number;
};

export type MarkerProcess = {
  pid: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  exit?: (code: number) => void;
};

let installedFor: string | undefined;

export function formatCrashMarker(payload: CrashMarkerPayload): string {
  return JSON.stringify(payload);
}

export function installProcessCrashMarkers(
  processName: string,
  target: MarkerProcess = process
): void {
  if (installedFor === processName && target === process) return;
  if (target === process) installedFor = processName;

  const emit = (event: CrashMarkerPayload["event"], extra: Partial<CrashMarkerPayload> = {}): void => {
    const line = formatCrashMarker({
      marker: CRASH_MARKER,
      process: processName,
      event,
      pid: target.pid,
      at: new Date().toISOString(),
      ...extra
    });
    console.error(line);
  };

  target.on("uncaughtException", (...args: unknown[]) => {
    const error = args[0];
    const err = error instanceof Error ? error : new Error(String(error));
    emit("uncaughtException", { name: err.name, message: err.message.slice(0, 500) });
    // A listener would otherwise swallow the default crash. Keep the process dying.
    target.exit?.(1);
  });
  target.on("unhandledRejection", (...args: unknown[]) => {
    const reason = args[0];
    const err = reason instanceof Error ? reason : new Error(String(reason));
    emit("unhandledRejection", { name: err.name, message: err.message.slice(0, 500) });
  });
  target.on("exit", (...args: unknown[]) => {
    emit("exit", { code: typeof args[0] === "number" ? args[0] : undefined });
  });

  if (target === process) {
    const setNearHeapLimitCallback = (
      v8 as { setNearHeapLimitCallback?: (callback: (heapLimitBytes: number, heapUsedBytes: number) => number) => void }
    ).setNearHeapLimitCallback;
    try {
      setNearHeapLimitCallback?.((heapLimitBytes, heapUsedBytes) => {
        emit("nearHeapLimit", { heapLimitBytes, heapUsedBytes });
        return heapLimitBytes;
      });
    } catch {
      // Older Node or already-installed callback: markers for exit/uncaught still land.
    }
  }
}
