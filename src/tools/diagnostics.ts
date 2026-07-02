// input: java_diagnostics files and wait budget.
// output: JDT LS diagnostics for opened files.
// pos: Public v5 diagnostics tool handler.
import { z } from "zod";
import { normalizeRepoFile } from "../repo-layout.js";
import type { LspDiagnostic } from "../jdtls-session.js";
import type { ToolContext } from "./context.js";
import { compact, describeFile, detailSchema, isDiagnosticDetail } from "./shared.js";

export const diagnosticsSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  files: z.array(z.string()).min(1).max(50),
  waitMs: z.number().int().min(0).max(10000).default(1000),
  detail: detailSchema
};

export async function javaDiagnostics(context: ToolContext, args: z.infer<z.ZodObject<typeof diagnosticsSchema>>): Promise<unknown> {
  const files = args.files.map(file => normalizeRepoFile(context.repoRoot, file));
  const diagnostics = await context.session.diagnosticsFor(files, args.waitMs);
  if (isDiagnosticDetail(args.detail)) {
    return {
      files,
      diagnostics
    };
  }
  return {
    totalDiagnostics: files.reduce((sum, file) => sum + (diagnostics[file]?.length || 0), 0),
    files: files.map(file => {
      const items = diagnostics[file] || [];
      return {
        ...describeFile(context.repoRoot, file),
        diagnosticCount: items.length,
        diagnostics: items.map(formatDiagnostic)
      };
    })
  };
}

function formatDiagnostic(diagnostic: LspDiagnostic): Record<string, unknown> {
  return compact({
    severity: diagnostic.severity,
    source: diagnostic.source,
    code: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1
  });
}
