export type QueryIntent = "exact" | "text";
export function classifyQuery(raw: string, mode: "auto"|"exact"|"text"): QueryIntent {
  const q=raw.trim();
  if (!q || q.length>512) throw new Error("query length must be 1..512");
  if (mode!=="auto") return mode;
  if (/\s/.test(q) || /[\u3400-\u9fff]/.test(q)) return "text";
  const shape=/^[A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*)*(?:#[A-Za-z_$][A-Za-z0-9_$]*(?:\([^()]*\))?)?$/;
  return shape.test(q) && (/[.#()]/.test(q) || /[A-Z]/.test(q)) ? "exact" : "text";
}