// input: A raw discovery query string and the requested search mode.
// output: Whether the query is an exact code shape (class/FQN/owner#method) or
//         free-text task intent. Mixed strings such as "OrderService rollback
//         refund" are text: the class name is a scope clue, not an early
//         return condition.
// pos: T04 - exact names and task intent must take different search routes.
export type QueryIntent = "exact" | "text";

const CODE_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*)*(?:#[A-Za-z_$][A-Za-z0-9_$]*(?:\([^()]*\))?)?$/;

export function classifyQuery(raw: string, mode: "auto" | "exact" | "text" = "auto"): QueryIntent {
  const q = raw.trim();
  if (!q || q.length > 512) throw new Error("query length must be 1..512");
  if (mode !== "auto") return mode;
  // Whitespace or CJK makes the query a task description, not a code shape:
  // "rollback" alone is ambiguous, and CJK words must never be mistaken for
  // Java identifiers.
  if (/\s/.test(q) || /[\u3400-\u9fff]/.test(q)) return "text";
  // Exact only for supported code shapes: dotted/owned/parenthesised
  // identifiers, or ASCII Pascal/camelCase names. Complex generics are not
  // supported and fall through to text rather than a faked exact match.
  if (!CODE_SHAPE.test(q)) return "text";
  return /[.#()]/.test(q) || /[A-Z]/.test(q) ? "exact" : "text";
}