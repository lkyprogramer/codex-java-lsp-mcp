// input: java_shutdown request.
// output: Stopped JDT LS child-process status while keeping the MCP server alive.
// pos: Public v5 shutdown tool handler.
import { z } from "zod";
import type { ToolContext } from "./context.js";

export const shutdownSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  all: z.boolean().default(false)
};

export async function javaShutdown(context: ToolContext, _args: z.infer<z.ZodObject<typeof shutdownSchema>>): Promise<unknown> {
  const before = context.session.status();
  await context.session.stop();
  context.router.clearRgCache();
  return {
    stopped: before.started,
    status: context.session.status(),
    note: "JDT LS has been stopped. The MCP server stays alive; the next semantic tool call will start JDT LS again."
  };
}
