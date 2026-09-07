import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function vacuumInto(sourcePath: string, destPath: string): void {
  if (!existsSync(sourcePath)) {
    throw new Error(`VACUUM INTO missing source ${sourcePath}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

const invoked = (process.argv[1] ?? "").replaceAll("\\", "/").endsWith("/vacuum-into.js")
  || (process.argv[1] ?? "").replaceAll("\\", "/").endsWith("/vacuum-into.ts");
if (invoked) {
  const source = process.argv[2];
  const dest = process.argv[3];
  if (!source || !dest) {
    process.stderr.write("usage: vacuum-into.js <source> <dest>\n");
    process.exit(2);
  }
  vacuumInto(source, dest);
}
