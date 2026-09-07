import path from "node:path";
import { pathToFileURL } from "node:url";
import { close, openIndexDb, type IndexDatabase } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { runSqlColdBuild } from "./cold-build.js";

function dbstatByName(db: IndexDatabase): Array<{ name: string; bytes: number; miB: number; rows?: number; bytesPerRow?: number }> {
  try {
    const rows = db.prepare(
      "SELECT name AS name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC"
    ).all() as Array<{ name: string; bytes: number | bigint }>;
    const counts = new Map<string, number>();
    for (const table of db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as Array<{ name: string }>) {
      const n = db.prepare(`SELECT count(*) AS n FROM "${table.name.replaceAll("\"", "\"\"")}"`).get() as { n: number | bigint };
      counts.set(table.name, typeof n.n === "bigint" ? Number(n.n) : Number(n.n));
    }
    return rows.map(row => {
      const bytes = typeof row.bytes === "bigint" ? Number(row.bytes) : Number(row.bytes);
      const n = counts.get(row.name);
      return {
        name: row.name,
        bytes,
        miB: Math.round((bytes / (1024 * 1024)) * 10) / 10,
        ...(n !== undefined ? { rows: n, bytesPerRow: n > 0 ? Math.round(bytes / n) : 0 } : {})
      };
    });
  } catch {
    return [];
  }
}

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
    process.stdout.write(`${JSON.stringify({ dbstat: dbstatByName(db) })}\n`);
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
