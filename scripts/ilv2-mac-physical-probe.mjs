// Private Tier-0 probe (not evidence): where a seed-shaped delta's physical growth goes. One delta job
// (HEAD~k sources, at most CAP changed Java files) on a clone of the MAC-12 572 MB baseline DB, then the
// seal's checkpoint (TRUNCATE, journal_mode=DELETE). Prints volume free-space deltas per step, the peak WAL
// size and the page diff against the baseline; counts and bytes only, no paths, symbols or source.
// env: BASELINE (baseline-db.json), PROBE_TMP (work dir), CLONE_ROOT (a root holding both), REPO (frozen input
// worktree, read-only), DEPTH (k), CAP (changed Java files, default 200), OUT (json), PARALLELISM (parser grant).
// FULL=1 builds the base fresh from HEAD first and reports its growth (the gate's denominator) and the ratio.
// WAL=1 keeps every frame (no autocheckpoint) and, before the close folds it in, counts the distinct pages the job
// wrote and how many of those end byte-identical to the baseline (a write that a clone still pays for).
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";
const at = rel => import(pathToFileURL(path.join(process.cwd(), rel)).href);
const { openIndexDb, close } = await at("dist/java-index/sql/driver.js");
const { ensureSchema } = await at("dist/java-index/sql/schema.js");
const { applyBuilderJob } = await at("dist/index-builder/incremental.js");
const { cloneSealedDatabase, warmFile } = await at("dist/mac-platform/clonefile.js");
const { pageDiff } = await at("scripts/ilv2-mac-snapshot-equivalence.mjs");
const baseline = JSON.parse(await readFile(process.env.BASELINE, "utf8"));
const repo = process.env.REPO, depth = Number(process.env.DEPTH), cap = Number(process.env.CAP ?? 200);
const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { maxBuffer: 1 << 28 });
const free = async () => { const s = await statfs(process.env.PROBE_TMP); return s.bavail * s.bsize; };
const work = await mkdtemp(path.join(process.env.PROBE_TMP, "physical-"));
try {
  const src = path.join(work, "src");
  for (const rel of git("ls-files", "-z").toString().split("\0").filter(Boolean)) {
    await mkdir(path.dirname(path.join(src, rel)), { recursive: true }); await copyFile(path.join(repo, rel), path.join(src, rel));
  }
  // FULL=1: the base is a fresh full build of HEAD made here (as the gate's denominator), not the baseline clone.
  let baseDb = baseline.db, full;
  if (process.env.FULL === "1") {
    baseDb = path.join(work, "full", "index.sqlite");
    const before = await free(), started = performance.now(), cpu = process.cpuUsage();
    const fdb = openIndexDb(baseDb);
    try { ensureSchema(fdb); await applyBuilderJob({ repoRoot: src, db: fdb, job: { kind: "full", generation: 1 }, parallelism: Number(process.env.PARALLELISM ?? 2) }); } finally { close(fdb); }
    const sealer = new DatabaseSync(baseDb);
    try { sealer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); sealer.prepare("PRAGMA journal_mode=DELETE").get(); } finally { sealer.close(); }
    await new Promise(resolve => setTimeout(resolve, 5000));
    const used = process.cpuUsage(cpu);
    full = { growthMB: Math.round((before - await free()) / 1e5) / 10, dbMB: Math.round((await stat(baseDb)).size / 1e5) / 10,
      ms: Math.round(performance.now() - started), cpuMs: Math.round((used.user + used.system) / 1000) };
    await chmod(baseDb, 0o444);
  }
  const from = git("rev-parse", `HEAD~${depth}`).toString().trim();
  const rows = git("diff", "--name-status", "-z", "--no-renames", "HEAD", from).toString().split("\0").filter(Boolean);
  const changed = [];
  for (let i = 0; i < rows.length && changed.length < cap; i += 2) {
    const [status, rel] = [rows[i], rows[i + 1]];
    if (status === "D" || !rel.endsWith(".java")) continue;
    await mkdir(path.dirname(path.join(src, rel)), { recursive: true }); await writeFile(path.join(src, rel), git("show", `${from}:${rel}`)); changed.push(rel);
  }
  const dbPath = path.join(work, "index.sqlite"), steps = {};
  let mark = await free();
  const step = async name => { const now = await free(); steps[name] = mark - now; mark = now; };
  await cloneSealedDatabase(baseDb, dbPath, process.env.CLONE_ROOT);
  await chmod(dbPath, 0o644);
  await step("clone");
  await warmFile(dbPath);
  let walPeak = 0;
  const sampler = setInterval(() => void stat(`${dbPath}-wal`).then(s => { walPeak = Math.max(walPeak, s.size); }, () => {}), 50);
  const db = openIndexDb(dbPath);
  let result;
  let written;
  try {
    ensureSchema(db);
    if (process.env.WAL === "1") db.exec("PRAGMA wal_autocheckpoint=0");
    result = await applyBuilderJob({ repoRoot: src, db, job: { kind: "refresh", changed, deleted: [] }, escalation: "report", parallelism: Number(process.env.PARALLELISM ?? 2) });
    if (process.env.WAL === "1") written = await walPages(`${dbPath}-wal`, baseDb);
  } finally { close(db); clearInterval(sampler); }
  const walAfterJob = await stat(`${dbPath}-wal`).then(s => s.size, () => 0);
  walPeak = Math.max(walPeak, walAfterJob);
  await step("job");
  // As the seal's checkpoint step: fold the WAL into the file and leave no sidecar.
  const sealer = new DatabaseSync(dbPath);
  try { sealer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); sealer.prepare("PRAGMA journal_mode=DELETE").get(); } finally { sealer.close(); }
  await step("checkpoint");
  // Space a closed WAL or journal held can come back after the unlink returns: read the volume again later.
  for (const wait of [5, 30]) { await new Promise(resolve => setTimeout(resolve, wait * 1000 - (wait === 30 ? 5000 : 0))); await step(`settle${wait}s`); }
  const pages = await pageDiff(baseDb, dbPath);
  const moves = process.env.MOVES === "1" ? rowMoves(baseDb, dbPath) : undefined;
  const MB = bytes => Math.round(bytes / 1e5) / 10;
  const report = { depth, changed: changed.length, ok: result.ok, escalation: result.escalation ?? null, rows: result.stages?.sql?.rows,
    freeDeltaMB: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, MB(v)])), totalMB: MB(Object.values(steps).reduce((a, b) => a + b, 0)),
    walPeakMB: MB(walPeak), walAfterJobMB: MB(walAfterJob), pageSize: pages.pageSize, pagesBefore: pages.pagesBefore, pagesAfter: pages.pagesAfter,
    ...(full ? { full, ratio: Math.round(Object.values(steps).reduce((a, b) => a + b, 0) / 1e5 / 10 / full.growthMB * 1000) / 1000 } : {}), ...(written ? { written } : {}), ...(moves ? { moves } : {}), changedPages: pages.changed, changedMB: MB(pages.changed * pages.pageSize), topTables: Object.entries(pages.byName ?? {}).slice(0, 30) };
  await writeFile(process.env.OUT, JSON.stringify(report, null, 1));
} finally { await rm(work, { recursive: true, force: true }); }

/** Distinct pages in a WAL (last frame wins) and how many of them equal the same page of `base`. */
async function walPages(wal, base) {
  const [w, b] = await Promise.all([open(wal, "r"), open(base, "r")]);
  try {
    const header = Buffer.alloc(32); await w.read(header, 0, 32, 0);
    const size = header.readUInt32BE(8), frames = Math.floor(((await w.stat()).size - 32) / (24 + size));
    const last = new Map(), fh = Buffer.alloc(24);
    for (let i = 0; i < frames; i++) { await w.read(fh, 0, 24, 32 + i * (24 + size)); last.set(fh.readUInt32BE(0), i); }
    const baseBytes = (await b.stat()).size; let identical = 0;
    const x = Buffer.alloc(size), y = Buffer.alloc(size);
    for (const [pgno, i] of last) {
      if ((pgno - 1) * size >= baseBytes) continue;
      await w.read(x, 0, size, 32 + i * (24 + size) + 24); await b.read(y, 0, size, (pgno - 1) * size);
      if (x.equals(y)) identical++;
    }
    // APFS unshares a cloned file in 16 KiB units: a lone 4 KiB page write pays for four.
    const chunks = new Set([...last.keys()].map(pgno => Math.floor((pgno - 1) * size / 16384)));
    return { frames, distinct: last.size, identical, chunks16k: chunks.size, chunksMB: Math.round(chunks.size * 16384 / 1e5) / 10, walMB: Math.round(frames * (24 + size) / 1e5) / 10 };
  } finally { await Promise.all([w.close(), b.close()]); }
}

/**
 * Rows the delta deleted and inserted in edge and search_doc, and how many of those pairs keep their
 * identity apart from the source range (same owner file, kind and endpoints / declaration): a line shift.
 */
function rowMoves(before, after) {
  const read = (file, sql) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const tally = (sql, identity, exact) => {
    const count = rows => { const m = new Map(); for (const r of rows) { const k = exact(r); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
    const a = count(read(before, sql)), b = count(read(after, sql));
    const gone = new Map(), added = new Map(); let deleted = 0, inserted = 0;
    for (const [k, n] of a) { const d = n - (b.get(k) ?? 0); if (d > 0) { deleted += d; const g = identity(k); gone.set(g, (gone.get(g) ?? 0) + d); } }
    for (const [k, n] of b) { const d = n - (a.get(k) ?? 0); if (d > 0) { inserted += d; const g = identity(k); added.set(g, (added.get(g) ?? 0) + d); } }
    let moved = 0; for (const [g, n] of gone) moved += Math.min(n, added.get(g) ?? 0);
    return { deleted, inserted, moved };
  };
  const fresh = table => { const top = read(before, `SELECT max(id) m FROM ${table}`)[0].m; return read(after, `SELECT count(*) n FROM ${table} WHERE id>${Number(top)}`)[0].n; };
  return {
    newIds: { edge: fresh("edge"), searchDoc: fresh("search_doc") },
    edge: tally("SELECT kind_sym k, from_sym f, to_sym t, file_id i, sl, sc, el, ec FROM edge", key => key.split("|")[0], r => `${r.k}:${r.f}:${r.t}:${r.i}|${r.sl}:${r.sc}:${r.el}:${r.ec}`),
    entityToken: tally("SELECT entity_sym e, field f, token_sym t, tf FROM entity_token", key => key.split("|")[0], r => `${r.e}:${r.f}:${r.t}|${r.tf}`),
    searchDocToken: tally("SELECT doc_id d, token_sym t, tf FROM search_doc_token", key => key.split("|")[0], r => `${r.d}:${r.t}|${r.tf}`),
    searchDoc: tally("SELECT declaration_sym d, kind k, source_path_sym p, start_line s, end_line e FROM search_doc", key => key.split("|")[0], r => `${r.d}:${r.k}:${r.p}|${r.s}:${r.e}`)
  };
}
