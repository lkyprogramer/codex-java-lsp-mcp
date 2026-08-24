// input: Graph-search candidates plus sliced spans.
// output: EvidenceBundle records. A bundle is not a file.
// pos: JIN N4-02. Roles follow JIN §10.1.
export const EVIDENCE_ROLES = [
  "ANCHOR",
  "CHANGE_SITE",
  "CONTRACT",
  "CALLEE",
  "CALLER",
  "IMPLEMENTATION",
  "PERSISTENCE",
  "DATAFLOW",
  "FRAMEWORK",
  "TEST"
] as const;

export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

export type CodeSpan = {
  start: number;
  end: number;
  bytes: number;
  text?: string;
};

export type ProvingStep = {
  kind: string;
  fromId: string;
  toId: string;
};

export type EvidenceBundle = {
  id: string;
  role: EvidenceRole;
  path: string;
  proof: string[];
  spans: CodeSpan[];
  closes: string[];
  confidence: number;
  tokenCost: number;
  latencyCost: number;
  hops: number;
  provingPath: ProvingStep[];
};

export function isP0Bundle(bundle: Pick<EvidenceBundle, "role" | "hops">): boolean {
  return bundle.hops === 0 || bundle.role === "ANCHOR" || bundle.role === "CHANGE_SITE";
}

function spanBytes(span: Pick<CodeSpan, "start" | "end" | "text">): number {
  if (span.text !== undefined) return Math.max(1, Buffer.byteLength(span.text, "utf8"));
  return Math.max(1, (span.end - span.start + 1) * 48);
}

export function mergeSpans(spans: CodeSpan[]): CodeSpan[] {
  if (spans.length === 0) return [];
  const ordered = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CodeSpan[] = [{ ...ordered[0]!, text: ordered[0]!.text }];
  for (const span of ordered.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span.start <= last.end + 1) {
      last.end = Math.max(last.end, span.end);
      if (last.text !== undefined || span.text !== undefined) {
        last.text = `${last.text ?? ""}\n${span.text ?? ""}`.trim();
      }
      last.bytes = spanBytes(last);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function bundleTokenCost(spans: CodeSpan[], tokenizerEstimate: (text: string) => number): number {
  const bytes = spans.reduce((sum, span) => sum + span.bytes, 0);
  const proxy = spans
    .map(span => span.text ?? "")
    .filter(Boolean)
    .join("\n");
  if (proxy.length > 0) return tokenizerEstimate(proxy);
  return Math.ceil(Math.max(1, bytes) / 4);
}
