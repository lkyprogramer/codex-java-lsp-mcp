// input: Source checkout path selected for immutable release assembly.
// output: Exit 0 only when Git confirms there are no tracked or untracked changes.
// pos: Release provenance gate; BUILD_SHA must identify the exact copied source tree.
import { execFileSync } from "node:child_process";
import path from "node:path";

export function assertCleanSourceTree(sourceDir) {
  const absolute = path.resolve(sourceDir);
  let status;
  try {
    status = execFileSync("git", ["-C", absolute, "status", "--porcelain=v1", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to verify clean release source tree: ${absolute} (${detail})`);
  }
  if (status.trim()) {
    throw new Error(`Refusing to build an immutable release from a dirty source tree: ${absolute}\n${status.trim()}`);
  }
}

function main(args) {
  if (args.length !== 1) {
    throw new Error("Usage: verify-clean-source-tree.mjs <source-dir>");
  }
  assertCleanSourceTree(args[0]);
}

if (process.argv[1]?.endsWith("verify-clean-source-tree.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("[codex-java-lsp] release provenance check failed", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
