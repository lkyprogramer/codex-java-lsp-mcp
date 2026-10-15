// Bounded declaration text derived exclusively from one captured source.
const SIGNATURE_MAX_LINES = 5;
const SIGNATURE_MAX_CHARS = 300;

function lineAt(content: string, line: number, maxChars: number): string {
  // Same line numbering as the parser ranges: LF ends a line.
  const lines = content.split(/\r?\n/);
  const text = lines[line - 1] ?? "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function signatureText(content: string | undefined, startLine: number, endLine: number): string {
  if (!content) return "";
  const last = Math.min(endLine, startLine + SIGNATURE_MAX_LINES - 1);
  const lines: string[] = [];
  for (let line = startLine; line <= last; line += 1) lines.push(lineAt(content, line, SIGNATURE_MAX_CHARS));
  return lines.join(" ").trim();
}
