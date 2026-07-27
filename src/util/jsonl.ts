// input: A JSONL file path on disk.
// output: Parsed line records, skipping blank lines.
// pos: Shared JSONL reader for persisted edge/cache files.
import { readFileSync } from "node:fs";

export function readJsonLines<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}
