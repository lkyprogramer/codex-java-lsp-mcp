import path from "node:path";
import { pathToFileURL } from "node:url";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { runSqlColdBuild } from "./cold-build.js";

export function parseBuilderArgs(argv: string[]): {
  repo: string;
  db: string;
  mode: string;
  parallelism?: number;
} {
  const out: { repo: string; db: string; mode: string; parallelism?: number } = { repo: "", db: "", mode: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--repo" && value) {
      out.repo = value;
      i += 1;
    } else if (flag === "--db" && value) {
      out.db = value;
      i += 1;
    } else if (flag === "--mode" && value) {
      out.mode = value;
      i += 1;
    } else if (flag === "--parallelism" && value) {
      out.parallelism = Number(value);
      i += 1;
    }
  }
  return out;
}

export async function runBuilderMain(argv = process.argv.slice(2)): Promise<void> {
  const args = parseBuilderArgs(argv);
  if (!args.repo || !args.db || args.mode !== "cold") {
    throw new Error("usage: builder-main --repo <root> --db <path> --mode cold [--parallelism N]");
  }
  const db = openIndexDb(args.db);
  try {
    ensureSchema(db);
    const result = await runSqlColdBuild({
      repoRoot: args.repo,
      db,
      parallelism: args.parallelism !== undefined && Number.isFinite(args.parallelism) && args.parallelism > 0
        ? args.parallelism
        : undefined
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    close(db);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runBuilderMain().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
