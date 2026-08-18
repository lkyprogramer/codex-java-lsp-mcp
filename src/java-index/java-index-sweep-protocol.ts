import type { JavaFileBundle } from "./index-types.js";
import type { DiscoveredJavaFile } from "./manifest.js";
import { validateFileBundleArray } from "./worker-protocol.js";

export type SweepWorkerRequest =
  | { id: number; type: "OPEN"; repoRoot: string }
  | { id: number; type: "PARSE_CHUNK"; generation: number; files: DiscoveredJavaFile[] }
  | { id: number; type: "CLOSE" };

export type SweepWorkerCommand = SweepWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

export type SweepParsedFile =
  | { relativePath: string; sourceRoot: string; ok: true; bundle: JavaFileBundle }
  | { relativePath: string; sourceRoot: string; ok: false; error: string };

export type SweepWorkerValue =
  | { type: "OPENED" }
  | { type: "PARSED"; files: SweepParsedFile[] }
  | { type: "CLOSED" };

export type SweepWorkerResponse =
  | { id: number; ok: true; value: SweepWorkerValue }
  | { id: number; ok: false; error: { code: string; message: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSweepWorkerResponse(value: unknown): value is SweepWorkerResponse {
  if (!isRecord(value) || typeof value.id !== "number" || !Number.isFinite(value.id)) return false;
  if (value.ok === true) return "value" in value;
  if (value.ok === false) {
    const error = value.error;
    return isRecord(error) && typeof error.code === "string" && typeof error.message === "string";
  }
  return false;
}

export function validateSweepParsedFiles(value: unknown): SweepParsedFile[] {
  if (!Array.isArray(value)) throw new Error("sweep PARSE_CHUNK must return an array");
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.relativePath !== "string" || typeof entry.sourceRoot !== "string") {
      throw new Error(`sweep file[${index}] is missing path identity`);
    }
    if (entry.ok === true) {
      const [bundle] = validateFileBundleArray([entry.bundle]);
      return { relativePath: entry.relativePath, sourceRoot: entry.sourceRoot, ok: true, bundle };
    }
    if (entry.ok === false && typeof entry.error === "string") {
      return { relativePath: entry.relativePath, sourceRoot: entry.sourceRoot, ok: false, error: entry.error };
    }
    throw new Error(`sweep file[${index}] is neither ok facts nor an error`);
  });
}
