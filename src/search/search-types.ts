// input: A ripgrep query bounded by a request deadline.
// output: File matches plus how complete the search actually was.
// pos: Completion travels with the result so callers cannot cache a truncated search.
import type { Completion } from "../runtime/completion.js";
import type { JavaIntelligenceErrorCode } from "../runtime/intelligence-error.js";

export type SearchPosition = { line: number; column: number };

export type SearchFileMatch = {
  absolutePath: string;
  matchCount: number;
  positions: SearchPosition[];
};

export type SearchResult = {
  files: SearchFileMatch[];
  completion: Completion;
  rawBytes: number;
  totalMatches: number;
  elapsedMs: number;
  stderrTail?: string;
  errorCode?: JavaIntelligenceErrorCode;
};

export type RgQuery = {
  pattern: string;
  roots: string[];
  globs: string[];
  cwd: string;
};
