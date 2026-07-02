// input: java_restart request.
// output: Restarted JDT LS status.
// pos: Public v5 restart tool handler.
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { detailSchema, isDiagnosticDetail } from "./shared.js";
import { summarizeSessionStatus } from "./status.js";

export const restartSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  clearCache: z.boolean().default(false),
  detail: detailSchema
};

export async function javaRestart(context: ToolContext, args: z.infer<z.ZodObject<typeof restartSchema>>): Promise<unknown> {
  const status = await context.session.restart(args.clearCache);
  if (isDiagnosticDetail(args.detail)) {
    return status;
  }
  return {
    restarted: true,
    clearCache: args.clearCache,
    ...summarizeSessionStatus(status)
  };
}
