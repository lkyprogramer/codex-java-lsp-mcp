// input: A compact java_impact result that may embed wall-clock elapsedMs.
// output: UTF-8 byte length of JSON with elapsedMs frozen to a 3-digit sentinel.
// pos: Identity token P50 must not move when latency crosses 99/100/999/1000.

/** Typical cold-nolsp elapsedMs JSON width. Not the measured duration. */
const IDENTITY_ELAPSED_MS = 100;

export function jsonBytesForImpactTokens(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, identityTokenReplacer), "utf8");
}

function identityTokenReplacer(key: string, value: unknown): unknown {
  if (key === "elapsedMs") return IDENTITY_ELAPSED_MS;
  return value;
}
