// input: Outcome of a bounded provider operation.
// output: One shared completion vocabulary for caching and reporting decisions.
// pos: Single source of truth for "is this result whole enough to cache".
export type Completion =
  | "COMPLETE"
  | "PARTIAL_TIMEOUT"
  | "PARTIAL_LIMIT"
  | "CANCELLED"
  | "FAILED";

export function isCacheableCompletion(value: Completion): boolean {
  return value === "COMPLETE";
}
