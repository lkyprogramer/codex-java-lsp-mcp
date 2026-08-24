// input: Raw stdout chunks from `rg --json`.
// output: Complete NDJSON lines, with a hard cap on any single record.
// pos: Decodes only after a newline so UTF-8 sequences split across chunks stay intact.
export class BoundedLineDecoder {
  private pending: Buffer = Buffer.alloc(0);

  constructor(private readonly maxLineBytes: number) {}

  push(chunk: Buffer): string[] {
    this.pending = this.pending.length === 0
      ? chunk
      : Buffer.concat([this.pending, chunk]);
    const lines: string[] = [];
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > this.maxLineBytes) {
        throw new Error(`rg JSON line exceeded ${this.maxLineBytes} bytes`);
      }
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      lines.push(
        line
          .subarray(0, line.at(-1) === 0x0d ? line.length - 1 : line.length)
          .toString("utf8")
      );
    }
    if (this.pending.length > this.maxLineBytes) {
      throw new Error(`rg JSON line exceeded ${this.maxLineBytes} bytes`);
    }
    return lines;
  }

  finish(): string[] {
    if (this.pending.length === 0) return [];
    if (this.pending.length > this.maxLineBytes) {
      throw new Error(`rg JSON line exceeded ${this.maxLineBytes} bytes`);
    }
    const line = this.pending.toString("utf8");
    this.pending = Buffer.alloc(0);
    return [line];
  }
}
