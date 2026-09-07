import { cpus, totalmem } from "node:os";

export type ResourceDefaults = {
  machineMemoryGb: number;
  logicalCpu: number;
  maxActiveRepos: number;
  idleTtlMs: number;
  jdtlsXmx: string;
  importConcurrency: number;
};

export const DEFAULT_FREEMEM_PRESSURE_BYTES = 2 * 1024 * 1024 * 1024;

export function resourceDefaults(): ResourceDefaults {
  const memoryGb = totalmem() / 1024 / 1024 / 1024;
  if (memoryGb <= 24) {
    return defaults(memoryGb, 1, 900000, "1536m", 1);
  }
  if (memoryGb <= 48) {
    return defaults(memoryGb, 3, 2700000, "2g", 2);
  }
  return defaults(memoryGb, 4, 2700000, "3g", 2);
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Like positiveInteger but 0 is a valid disable-the-timer sentinel. */
export function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function defaults(memoryGb: number, maxActiveRepos: number, idleTtlMs: number, jdtlsXmx: string, importConcurrency: number): ResourceDefaults {
  return {
    machineMemoryGb: Math.round(memoryGb),
    logicalCpu: cpus().length,
    maxActiveRepos,
    idleTtlMs,
    jdtlsXmx,
    importConcurrency
  };
}
