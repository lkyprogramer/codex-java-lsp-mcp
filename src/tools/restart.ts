// input: java_restart request.
// output: Restarted JDT LS status.
// pos: Public v5 restart tool handler.
import { z } from "zod";
import type { ToolContext } from "./context.js";

export const restartSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  clearCache: z.boolean().default(false)
};

export async function javaRestart(context: ToolContext, args: z.infer<z.ZodObject<typeof restartSchema>>): Promise<unknown> {
  return context.session.restart(args.clearCache);
}
