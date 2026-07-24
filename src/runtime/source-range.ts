// input: Positions produced by JDT LS, Tree-sitter and the source index.
// output: One persisted range convention shared by every module.
// pos: 1-based line, 1-based UTF-16 code-unit column, end exclusive.
export type SourcePosition = { line: number; column: number };
export type SourceRange = { start: SourcePosition; end: SourcePosition };
