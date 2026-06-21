// input: java_diagnostics files and wait budget.
// output: JDT LS diagnostics for opened files.
// pos: Public v5 diagnostics tool handler.
import { z } from "zod";
import { normalizeRepoFile } from "../repo-layout.js";
import type { ToolContext } from "./context.js";

export const diagnosticsSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  files: z.array(z.string()).min(1).max(50),
  waitMs: z.number().int().min(0).max(10000).default(1000)
};

export async function javaDiagnostics(context: ToolContext, args: z.infer<z.ZodObject<typeof diagnosticsSchema>>): Promise<unknown> {
  const files = args.files.map(file => normalizeRepoFile(context.repoRoot, file));
  const diagnostics = await context.session.diagnosticsFor(files, args.waitMs);
  return {
    files,
    diagnostics
  };
}
