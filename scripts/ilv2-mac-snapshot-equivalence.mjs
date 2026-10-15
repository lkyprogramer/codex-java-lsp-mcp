#!/usr/bin/env node
// G04 snapshot equivalence and structural page-diff tooling.
//   digest  --db F                     logical digest of one facts database
//   compare --left A --right B         logical equality; exit 1 with a bounded diff when unequal
//   pages   --before A --after B       changed pages per table/index between two checkpointed files
//   self-test --out NEW_DIR [--files N] [--changes 20,200]
//     Builds a synthetic repo, then measures stat-only, N-file body edits and
//     equivalence to a fresh cold build. Logical page structure only: these
//     are expectations for the MAC-05 thin slice, never a physical-gate PASS.
import { cp, mkdir, open, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, requireUnprotectedRoot, requireValue, runCli, writeJson } from "./ilv2-mac-contracts.mjs";

const dist = async name => import(new URL(`../dist/${name}`, import.meta.url).href);

async function modules() {
  const [driver, schema, logical, cold, incremental] = await Promise.all([
    dist("java-index/sql/driver.js"), dist("java-index/sql/schema.js"), dist("java-index/sql/logical-export.js"),
    dist("index-builder/cold-build.js"), dist("index-builder/incremental.js")
  ]);
  return { ...driver, ...schema, ...logical, ...cold, ...incremental };
}

async function withDb(file, fn, options = { readOnly: true }) {
  const m = await modules();
  const db = m.openIndexDb(file, options);
  try { return await fn(db, m); } finally { m.close(db); }
}

export async function digestOf(file) {
  return withDb(file, (db, m) => m.logicalDigest(db));
}

export async function compareDbs(left, right, sample = 5) {
  const [a, b] = await Promise.all([digestOf(left), digestOf(right)]);
  if (a.digest === b.digest) return { equal: true, digest: a.digest, tables: a.tables };
  const exports = await Promise.all([left, right].map(file => withDb(file, (db, m) => m.exportLogical(db))));
  const { diffLogical } = await modules();
  return { equal: false, left: a, right: b, diff: diffLogical(exports[0], exports[1], sample) };
}

async function pageSize(handle) {
  const header = Buffer.alloc(100);
  await handle.read(header, 0, 100, 0);
  requireValue(header.subarray(0, 16).toString("latin1") === "SQLite format 3\0", "not an SQLite database file");
  const size = header.readUInt16BE(16);
  return size === 1 ? 65536 : size;
}

async function pageOwners(file) {
  return withDb(file, db => new Map(db.prepare("SELECT pageno, name FROM dbstat").all().map(row => [Number(row.pageno), row.name])));
}

/** Byte-compares two checkpointed database files page by page and attributes changed pages to their b-tree. */
export async function pageDiff(before, after) {
  for (const file of [before, after]) {
    const wal = await stat(`${file}-wal`).catch(() => undefined);
    requireValue(!wal || wal.size === 0, `${file} has an un-checkpointed WAL`);
  }
  const [left, right] = await Promise.all([open(before, "r"), open(after, "r")]);
  try {
    const size = await pageSize(right);
    requireValue(size === await pageSize(left), "page size differs");
    const pages = [Math.floor((await left.stat()).size / size), Math.floor((await right.stat()).size / size)];
    const [ownersBefore, ownersAfter] = await Promise.all([pageOwners(before), pageOwners(after)]);
    const byName = {};
    let changed = 0;
    const a = Buffer.alloc(size), b = Buffer.alloc(size);
    for (let pgno = 1; pgno <= Math.max(...pages); pgno += 1) {
      const offset = (pgno - 1) * size;
      const readA = pgno <= pages[0] ? (await left.read(a, 0, size, offset)).bytesRead : 0;
      const readB = pgno <= pages[1] ? (await right.read(b, 0, size, offset)).bytesRead : 0;
      if (readA === readB && a.subarray(0, readA).equals(b.subarray(0, readB))) continue;
      changed += 1;
      const name = ownersAfter.get(pgno) ?? ownersBefore.get(pgno) ?? "(freelist)";
      byName[name] = (byName[name] ?? 0) + 1;
    }
    const total = pages[1];
    const sorted = Object.fromEntries(Object.entries(byName).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])));
    return { pageSize: size, pagesBefore: pages[0], pagesAfter: total, changed, ratio: total ? changed / total : 0,
      byName: sorted, share: Object.fromEntries(Object.entries(sorted).map(([name, count]) => [name, count / Math.max(1, changed)])) };
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}

const PACKAGES = 20;
const javaRel = index => `src/main/java/syn/p${index % PACKAGES}/C${index}.java`;

function javaSource(index, files, revision = 0) {
  const next = (index + 1) % files;
  const pkg = index % PACKAGES, nextPkg = next % PACKAGES;
  return `package syn.p${pkg};\n\n${nextPkg === pkg ? "" : `import syn.p${nextPkg}.C${next};\n\n`}public class C${index} {\n  private final C${next} next;\n\n  public C${index}(C${next} next) {\n    this.next = next;\n  }\n\n  public int compute${index}(int x) {\n    return next.compute${next}(x + ${index + revision});\n  }\n\n  public String name${index}() {\n    return "c${index}";\n  }\n}\n`;
}

async function writeSyntheticRepo(root, files) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>syn</groupId><artifactId>syn</artifactId><version>1</version></project>\n");
  for (let index = 0; index < files; index += 1) {
    const file = path.join(root, javaRel(index));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, javaSource(index, files));
  }
  const mapper = path.join(root, "src/main/resources/mapper/SynMapper.xml");
  await mkdir(path.dirname(mapper), { recursive: true });
  await writeFile(mapper, `<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="syn.p0.C0">\n  <select id="name0" resultType="string">select 1</select>\n</mapper>\n`);
}

async function coldBuild(repo, dbFile) {
  await withDb(dbFile, async (db, m) => {
    m.ensureSchema(db);
    await m.runSqlColdBuild({ repoRoot: repo, db, generation: 1 });
  }, {});
}

async function job(repo, dbFile, payload) {
  return withDb(dbFile, async (db, m) => {
    const result = await m.applyBuilderJob({ repoRoot: repo, db, job: payload });
    requireValue(result.ok, `builder job failed: ${result.error}`);
  }, {});
}

async function scenario(out, base, name, files, mutate, payload) {
  const dir = path.join(out, name);
  const repo = path.join(dir, "repo");
  await cp(base.repo, repo, { recursive: true, preserveTimestamps: true });
  await cp(base.db, path.join(dir, "db"), { recursive: true });
  const db = path.join(dir, "db", "index.sqlite");
  const changed = await mutate(repo);
  await job(repo, db, payload(changed));
  const facts = await pageDiff(base.dbFile, db);
  const statStore = await pageDiff(path.join(base.db, "workspace-stat.sqlite"), path.join(dir, "db", "workspace-stat.sqlite"));
  const fresh = path.join(dir, "fresh", "index.sqlite");
  await coldBuild(repo, fresh);
  const equivalence = await compareDbs(db, fresh);
  return { files, changedFiles: changed.length, facts, statStore: { changed: statStore.changed, pagesAfter: statStore.pagesAfter },
    equivalentToColdBuild: equivalence.equal, ...(equivalence.equal ? {} : { diff: equivalence.diff }) };
}

// Publication bookkeeping still written by the current builder on any job (MAC-05 moves it out of the facts DB).
export const PUBLICATION_PAGES = new Set(["sqlite_schema", "meta", "source_root_coverage"]);

export async function selfTest({ out, files = 1000, changes = [20, 200] }) {
  requireUnprotectedRoot(out, "self-test output");
  requireValue(!(await stat(out).catch(() => undefined)), `output already exists: ${out}`);
  requireValue(changes.every(count => count > 0 && count <= files), "changes must be within 1..files");
  const base = { repo: path.join(out, "base", "repo"), db: path.join(out, "base", "db") };
  base.dbFile = path.join(base.db, "index.sqlite");
  await writeSyntheticRepo(base.repo, files);
  await coldBuild(base.repo, base.dbFile);
  const report = { schema: "ilv2-mac-g04-structural/v1", kind: "STRUCTURAL_SELF_TEST", physicalGate: "NOT_A_PHYSICAL_GATE",
    note: "Logical page structure on a synthetic repo; expectations for MAC-05, not a physical COW measurement.",
    files, scenarios: {} };
  const later = Date.now() / 1000 + 3600;
  report.scenarios.statOnly = await scenario(out, base, "stat-only", files, async repo => {
    for (let index = 0; index < files; index += 1) await utimes(path.join(repo, javaRel(index)), later, later);
    return [];
  }, () => ({ id: 1, kind: "reconcile", generation: 2 }));
  for (const count of changes) {
    report.scenarios[`b${count}`] = await scenario(out, base, `b${count}`, files, async repo => {
      const changed = [];
      // Spread edits over the id space so they touch many packages, like real batches.
      for (let step = 0; step < count; step += 1) {
        const index = Math.floor((step * files) / count);
        await writeFile(path.join(repo, javaRel(index)), javaSource(index, files, 1));
        changed.push(javaRel(index));
      }
      return changed;
    }, changed => ({ id: 2, kind: "refresh", generation: 2, changed }));
  }
  const statOnly = report.scenarios.statOnly;
  report.checks = {
    statOnlyFactsPagesOutsidePublication: Object.entries(statOnly.facts.byName).filter(([name]) => !PUBLICATION_PAGES.has(name)).reduce((sum, [, count]) => sum + count, 0),
    statOnlyStatStoreRewritten: statOnly.statStore.changed > 0,
    allEquivalentToColdBuild: Object.values(report.scenarios).every(row => row.equivalentToColdBuild)
  };
  report.status = report.checks.statOnlyFactsPagesOutsidePublication === 0 && report.checks.statOnlyStatStoreRewritten && report.checks.allEquivalentToColdBuild ? "PASS" : "FAIL";
  await writeJson(path.join(out, "report.json"), report);
  return report;
}

if (isMain(import.meta.url)) runCli(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "digest") {
    const options = cliOptions(args, ["--db"]);
    console.log(JSON.stringify(await digestOf(options.db), null, 2));
  } else if (command === "compare") {
    const options = cliOptions(args, ["--left", "--right"]);
    const result = await compareDbs(options.left, options.right);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.equal ? 0 : 1;
  } else if (command === "pages") {
    const options = cliOptions(args, ["--before", "--after"]);
    console.log(JSON.stringify(await pageDiff(options.before, options.after), null, 2));
  } else if (command === "self-test") {
    const options = cliOptions(args, ["--out", "--files", "--changes"]);
    requireValue(options.out, "usage: self-test --out NEW_DIR [--files N] [--changes 20,200]");
    const report = await selfTest({ out: options.out, files: options.files ? Number(options.files) : undefined,
      changes: options.changes ? options.changes.split(",").map(Number) : undefined });
    console.log(JSON.stringify({ status: report.status, checks: report.checks, out: options.out }, null, 2));
    process.exitCode = report.status === "PASS" ? 0 : 1;
  } else {
    throw new Error("usage: ilv2-mac-snapshot-equivalence.mjs digest|compare|pages|self-test ...");
  }
});
