// Private Tier-0 probe (not evidence): one seed-shaped delta builder job (HEAD~k sources on a HEAD index)
// on a clone of the MAC-12 572 MB baseline DB. Prints counts and stage timings only; no paths, symbols or source.
// env: BASELINE (baseline-db.json), PROBE_TMP (work dir), CLONE_ROOT (a root holding both), REPO (frozen input worktree, read-only), DEPTH (k), OUT (json)
// Run with --cpu-prof to profile the job; WARM=1 runs warmFile first, as the builder process does.
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const at = rel => import(pathToFileURL(path.join(process.cwd(), "dist", rel)).href);
const { openIndexDb, close } = await at("java-index/sql/driver.js");
const { ensureSchema } = await at("java-index/sql/schema.js");
const { applyBuilderJob } = await at("index-builder/incremental.js");
const { cloneSealedDatabase, warmFile } = await at("mac-platform/clonefile.js");
const baseline = JSON.parse(await readFile(process.env.BASELINE, "utf8"));
const repo = process.env.REPO, depth = Number(process.env.DEPTH);
const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { maxBuffer: 1 << 28 });
const work = await mkdtemp(path.join(process.env.PROBE_TMP, "seed-builder-"));
try {
  const src = path.join(work, "src");
  const tracked = git("ls-files", "-z").toString().split("\0").filter(Boolean);
  for (const rel of tracked) { await mkdir(path.dirname(path.join(src, rel)), { recursive: true }); await copyFile(path.join(repo, rel), path.join(src, rel)); }
  const from = git("rev-parse", `HEAD~${depth}`).toString().trim();
  const rows = git("diff", "--name-status", "-z", "--no-renames", "HEAD", from).toString().split("\0").filter(Boolean);
  const changed = [], deleted = [];
  for (let i = 0; i < rows.length; i += 2) {
    const [status, rel] = [rows[i], rows[i + 1]];
    if (!rel.endsWith(".java") && !rel.endsWith(".xml")) continue;
    if (status === "D") { await rm(path.join(src, rel), { force: true }); deleted.push(rel); }
    else { await mkdir(path.dirname(path.join(src, rel)), { recursive: true }); await writeFile(path.join(src, rel), git("show", `${from}:${rel}`)); changed.push(rel); }
  }
  const dbPath = path.join(work, "index.sqlite");
  // The clone source and target must share one root: the work root holds both the baseline and PROBE_TMP.
  await cloneSealedDatabase(baseline.db, dbPath, process.env.CLONE_ROOT);
  await chmod(dbPath, 0o644);
  // WARM=1 measures the job as the builder process runs it: warmFile, then the job (warm time included).
  const started = performance.now();
  const warmMs = process.env.WARM === "1" ? await warmFile(dbPath) : 0;
  const db = openIndexDb(dbPath);
  const marks = [];
  try {
    ensureSchema(db);
    const result = await applyBuilderJob({ repoRoot: src, db, job: { kind: "refresh", changed, deleted }, escalation: "report",
      onStage: async stage => { marks.push([stage, Math.round(performance.now() - started)]); } });
    const totalMs = performance.now() - started;
    await writeFile(process.env.OUT, JSON.stringify({ depth, changed: changed.length, deleted: deleted.length, ok: result.ok, escalation: result.escalation ?? null,
      error: result.error ?? null, totalMs, warmMs, marks, stages: result.stages, load1: os.loadavg()[0] }, null, 1));
  } finally { close(db); }
} finally { await rm(work, { recursive: true, force: true }); }
