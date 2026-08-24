// input: java_runtime action=restart|shutdown request.
// output: Restarted or stopped JDT LS session status.
// pos: Public runtime tool handler. Folds the retired java_restart/java_shutdown
//      tools in as action="restart"|"shutdown" (Task 31 Step 7). The `all` shutdown
//      variant (stop every active repo) stays server.ts-level, same as before the
//      merge - it needs the repo-runtime-manager singleton, not a per-repo ToolContext.
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { detailSchema, isDiagnosticDetail } from "./shared.js";
import { summarizeSessionStatus } from "./status.js";

export const runtimeSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  action: z.enum(["restart", "shutdown"]),
  clearCache: z.boolean().default(false),
  all: z.boolean().default(false),
  detail: detailSchema
};

export async function javaRuntime(context: ToolContext, args: z.infer<z.ZodObject<typeof runtimeSchema>>): Promise<unknown> {
  if (args.action === "restart") {
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
  const before = context.session.status();
  await context.session.stop();
  context.router.clearRgCache();
  if (!isDiagnosticDetail(args.detail)) {
    return {
      stopped: before.started,
      repoRoot: before.repoRoot,
      wasStarted: before.started,
      started: false,
      rgCacheCleared: true
    };
  }
  return {
    stopped: before.started,
    status: context.session.status(),
    note: "JDT LS has been stopped. The MCP server stays alive; the next semantic tool call will start JDT LS again."
  };
}
