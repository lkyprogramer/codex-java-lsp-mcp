// input: LSP payloads returned by Eclipse JDT LS.
// output: Shared TypeScript shapes for locations, symbols, and diagnostics.
// pos: Extracted from JdtlsSession so request I/O and lifecycle do not own protocol types.
import type { GeneratedCodeStatus } from "./generated-code.js";

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspLocation = {
  uri: string;
  range: LspRange;
};

export type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
};

export type LspSymbol = {
  name: string;
  kind: number;
  containerName?: string;
  location?: LspLocation;
  data?: unknown;
};

export type LspDocumentSymbol = {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
};

export type LspDiagnostic = {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

export type DiagnosticFilterInput = {
  readonly generatedCode: GeneratedCodeStatus;
  readonly source?: string;
  readonly diagnostics: readonly LspDiagnostic[];
};
