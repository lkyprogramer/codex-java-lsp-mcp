import { cpus, totalmem } from "node:os";

export type ResourceDefaults = {
  machineMemoryGb: number;
  logicalCpu: number;
  maxActiveRepos: number;
  idleTtlMs: number;
  /** T_hibernate; overlay/facts drop. Independent of machine size. */
  hibernateTtlMs: number;
  jdtlsXmx: string;
  importConcurrency: number;
};

export const DEFAULT_HIBERNATE_TTL_MS = 300000;
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

export const DEFAULT_PREWARM_HOT = "lishuedu,lishu-v2";
export const DEFAULT_INDEX_IDLE_TTL_MS = 1_200_000;

export function parsePrewarmHotSet(
  knownIds: readonly string[] = [],
  raw: string | undefined = process.env.JAVA_LSP_PREWARM_HOT
): { hot: Set<string>; ignored: string[] } {
  const source = raw === undefined || raw.trim() === "" ? DEFAULT_PREWARM_HOT : raw;
  const wanted = [...new Set(source.split(",").map(id => id.trim()).filter(Boolean))];
  if (knownIds.length === 0) return { hot: new Set(wanted), ignored: [] };
  const known = new Set(knownIds);
  const ignored = wanted.filter(id => !known.has(id));
  return { hot: new Set(wanted.filter(id => known.has(id))), ignored };
}

function defaults(memoryGb: number, maxActiveRepos: number, idleTtlMs: number, jdtlsXmx: string, importConcurrency: number): ResourceDefaults {
  return {
    machineMemoryGb: Math.round(memoryGb),
    logicalCpu: cpus().length,
    maxActiveRepos,
    idleTtlMs,
    hibernateTtlMs: DEFAULT_HIBERNATE_TTL_MS,
    jdtlsXmx,
    importConcurrency
  };
}
