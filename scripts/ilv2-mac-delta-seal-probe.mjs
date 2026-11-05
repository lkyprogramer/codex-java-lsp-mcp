// input: BASELINE (a registered baseline-db.json: a private real-repository database), PROBE_TMP (a private dir on the same APFS volume) and CLONE_ROOT (a directory holding both).
// output: JSON of counts and timings only (no paths, symbols or source): delta seal per 1/20/200 rewritten files, a split of one delta check, and one background full verify.
// pos: MAC-12 plan B diagnostic, Tier-0 only (dev.sh); NOT_GATED, never evidence for a gate.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const at = rel => import(pathToFileURL(path.join(process.cwd(), "dist", rel)).href);
const seal = await at("java-index/snapshot/seal.js");
const { deltaScopes } = await at("java-index/snapshot/seal-worker.js");
const { validateLogicalTable } = await at("java-index/sql/logical-export.js");
const { compatibleDeltaBase } = await at("index-builder/execution-plan.js");
const { contentManifestId, buildKeyOf } = await at("java-index/sql/snapshot-manifest.js");
const { cloneSealedDatabase } = await at("mac-platform/clonefile.js");
const baseline = JSON.parse(await readFile(process.env.BASELINE, "utf8"));
const work = await mkdtemp(path.join(process.env.PROBE_TMP, "delta-seal-"));
const out = { bytes: baseline.bytes, load1: os.loadavg()[0], samples: [] };

/** A clone whose next generation rewrote `files` deterministic file rows (as a delta build marks them). */
async function deltaClone(layout, name, files) {
  const job = path.join(layout.jobs, name);
  await mkdir(job);
  const source = path.join(job, seal.DB_FILE);
  await cloneSealedDatabase(baseline.db, source, process.env.CLONE_ROOT);
  await chmod(source, 0o644);
  const db = new DatabaseSync(source);
  try {
    const n = sql => db.prepare(sql).get().n;
    const g = Number(db.prepare("SELECT value FROM meta WHERE key='indexedGeneration'").get().value) + 1;
    db.exec("BEGIN");
    db.prepare("UPDATE meta SET value=? WHERE key='indexedGeneration'").run(String(g));
    const ids = db.prepare("SELECT id FROM file ORDER BY (id * 2654435761) % 1000003 LIMIT ?").all(files).map(row => row.id);
    for (const id of ids) db.prepare("UPDATE file SET generation=? WHERE id=?").run(g, id);
    db.exec("COMMIT");
    const written = `file_id IN (SELECT id FROM file WHERE generation=${g})`;
    return { job, rows: { file: files, type: n(`SELECT count(*) n FROM type WHERE ${written}`), method: n(`SELECT count(*) n FROM method WHERE ${written}`),
      edge: n(`SELECT count(*) n FROM edge WHERE ${written}`), kgEdgeTotal: n("SELECT count(*) n FROM kg_edge"), kgNodeTotal: n("SELECT count(*) n FROM kg_node"),
      mybatis: n("SELECT count(*) n FROM mybatis_resource") } };
  } finally { db.close(); }
}

try {
  const layout = seal.mac1Layout(work);
  for (const dir of [layout.snapshots, layout.jobs, layout.verified]) await mkdir(dir, { recursive: true });
  for (const files of [1, 20, 200]) {
    for (let round = 0; round < 3; round++) {
      const { job, rows } = await deltaClone(layout, `job-${files}-${round}`, files);
      const timings = {};
      const started = performance.now();
      const manifest = await seal.sealJobDatabase(layout, job, { snapshotId: `probe-${files}-${round}-x`, mode: "delta", timings });
      out.samples.push({ files, round, totalMs: performance.now() - started, timings, rows, pages: manifest.file.pages });
    }
  }
  // Split of one delta check, in this thread, on a sealed 20-file clone.
  const db = new DatabaseSync(path.join(layout.snapshots, "probe-20-0-x", seal.DB_FILE), { readOnly: true });
  try {
    const split = {};
    const time = (name, work) => { const t0 = performance.now(); const value = work(); split[name] = Math.round(performance.now() - t0); return value; };
    time("compatibleDeltaBase", () => compatibleDeltaBase(db));
    const scopes = time("deltaScopes", () => deltaScopes(db));
    for (const [table, where] of scopes) time(`validate:${table}`, () => validateLogicalTable(db, table, where));
    time("contentManifestId", () => contentManifestId(db));
    time("buildKeyOf", () => buildKeyOf(db));
    out.split = split;
  } finally { db.close(); }
  const verifyTimings = {};
  const v0 = performance.now();
  await seal.verifyDatabaseFile(path.join(layout.snapshots, "probe-1-0-x", seal.DB_FILE), { workers: 1, timings: verifyTimings });
  out.backgroundVerify = { workers: 1, totalMs: performance.now() - v0, ...verifyTimings };
  out.load1End = os.loadavg()[0];
} finally {
  // Sealed directories are 0555 by design; only the probe's own teardown lifts that.
  const snapshots = path.join(work, "mac1", "snapshots");
  for (const name of await readdir(snapshots).catch(() => [])) await chmod(path.join(snapshots, name), 0o755).catch(() => {});
  await rm(work, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 1));
