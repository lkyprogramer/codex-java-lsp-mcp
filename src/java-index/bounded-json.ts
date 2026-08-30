// input: An RPC/tool value that might be tens of megabytes if stringified whole.
// output: JSON at most `capBytes`, built from per-item stringify so one ArrayMap of the
// whole payload cannot run. Truncates trailing array elements when the cap is hit.
// pos: FSY2. Worker heap dumps twice named JsonStringify of an unbounded array.

export const JSON_STRINGIFY_CAP_BYTES = 32 * 1024 * 1024;

export type BoundedJson = {
  json: string;
  truncated: boolean;
  bytes: number;
};

export function jsonStringifyBounded(
  value: unknown,
  capBytes: number = JSON_STRINGIFY_CAP_BYTES
): BoundedJson {
  if (Array.isArray(value)) return stringifyArrayBounded(value, capBytes);
  if (value !== null && typeof value === "object") {
    return stringifyObjectBounded(value as Record<string, unknown>, capBytes);
  }
  if (typeof value === "string" && value.length + 2 > capBytes) {
    return { json: "null", truncated: true, bytes: 4 };
  }
  const json = JSON.stringify(value);
  if (typeof json !== "string") return { json: "null", truncated: false, bytes: 4 };
  if (json.length <= capBytes) return { json, truncated: false, bytes: json.length };
  return { json: "null", truncated: true, bytes: 4 };
}

function stringifyArrayBounded(items: unknown[], capBytes: number): BoundedJson {
  const parts: string[] = ["["];
  let size = 1;
  let truncated = false;
  let wrote = 0;
  for (let index = 0; index < items.length; index += 1) {
    const remaining = capBytes - size - 1;
    if (remaining <= 1) {
      truncated = true;
      break;
    }
    const piece = jsonStringifyBounded(items[index], remaining);
    // A primitive that cannot fit is replaced with null. Do not emit that
    // sentinel and keep walking — that would hide truncation and inflate size.
    if (piece.truncated && piece.json === "null") {
      truncated = true;
      break;
    }
    const extra = piece.json.length + (wrote === 0 ? 0 : 1);
    if (size + extra + 1 > capBytes) {
      truncated = true;
      break;
    }
    if (wrote > 0) parts.push(",");
    parts.push(piece.json);
    size += extra;
    wrote += 1;
    if (piece.truncated) truncated = true;
  }
  if (wrote < items.length) truncated = true;
  parts.push("]");
  size += 1;
  return { json: parts.join(""), truncated, bytes: size };
}

function stringifyObjectBounded(source: Record<string, unknown>, capBytes: number): BoundedJson {
  const parts: string[] = ["{"];
  let size = 1;
  let truncated = false;
  let wrote = false;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const keyJson = JSON.stringify(key);
    const remaining = capBytes - size - keyJson.length - 3;
    if (remaining <= 1) {
      truncated = true;
      break;
    }
    const valueJson = jsonStringifyBounded(value, remaining);
    if (valueJson.truncated && valueJson.json === "null") {
      truncated = true;
      break;
    }
    const extra = keyJson.length + 1 + valueJson.bytes + (wrote ? 1 : 0);
    if (size + extra + 1 > capBytes) {
      truncated = true;
      break;
    }
    if (wrote) parts.push(",");
    parts.push(keyJson, ":", valueJson.json);
    size += extra;
    wrote = true;
    if (valueJson.truncated) truncated = true;
  }
  parts.push("}");
  size += 1;
  return { json: parts.join(""), truncated, bytes: size };
}

/** Keep the live object graph, dropping trailing array elements so stringify stays under cap. */
export function truncateToJsonCap(value: unknown, capBytes: number = JSON_STRINGIFY_CAP_BYTES): unknown {
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let used = 2;
    for (const item of value) {
      const remaining = capBytes - used;
      if (remaining <= 1) break;
      const piece = jsonStringifyBounded(item, remaining);
      if (piece.truncated && piece.json === "null") break;
      const extra = piece.bytes + (kept.length === 0 ? 0 : 1);
      if (used + extra > capBytes) break;
      kept.push(truncateToJsonCap(item, remaining));
      used += extra;
    }
    return kept;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    let used = 2;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) continue;
      const keyJson = JSON.stringify(key);
      const remaining = capBytes - used - keyJson.length - 2;
      if (remaining <= 1) break;
      const piece = jsonStringifyBounded(child, remaining);
      if (piece.truncated && piece.json === "null") break;
      const extra = keyJson.length + 1 + piece.bytes + (Object.keys(out).length === 0 ? 0 : 1);
      if (used + extra > capBytes) break;
      out[key] = truncateToJsonCap(child, remaining);
      used += extra;
    }
    return out;
  }
  return value;
}
