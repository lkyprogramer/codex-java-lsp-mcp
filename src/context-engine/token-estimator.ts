// input: Serialized text or an injectable tokenizer.
// output: Token estimate. bytes/4 is the default fallback; live injects an endpoint tokenizer.
// pos: JIN N4-01. No new npm tokenizer. Production default stays BYTE_DIV_4.
export type Tokenizer = {
  readonly id: string;
  estimateTokens(text: string): number;
};

export const BYTES_PER_TOKEN = 4;

export const BYTES_DIV_4: Tokenizer = {
  id: "bytes/4",
  estimateTokens(text: string): number {
    return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
  }
};

export function estimateTokens(text: string, tokenizer: Tokenizer = BYTES_DIV_4): number {
  return tokenizer.estimateTokens(text);
}

export function estimateSpanBytes(startLine: number, endLine: number, source?: string): number {
  const start = Math.max(1, startLine);
  const end = Math.max(start, endLine);
  if (!source) return Math.max(1, (end - start + 1) * 48);
  const lines = source.split(/\r?\n/);
  const slice = lines.slice(start - 1, end).join("\n");
  return Math.max(1, Buffer.byteLength(slice, "utf8"));
}
