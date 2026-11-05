#!/usr/bin/env node
// Verify residuals, or finish this run after actual owned resources have exited.
import { lstat, readdir, readFile, mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { contains, readJson, writeJson, sha256, execute, managedPath, requireValue, isMain, runCli, cliOptions } from "./ilv2-mac-contracts.mjs";
import { ISOLATED_LAUNCHD_LABEL, fixtureQuotaFile } from "./ilv2-mac-fixture-quota.mjs";

function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

export async function verifyOwnedExit(manifest) {
  requireValue(Array.isArray(manifest.processes) && Array.isArray(manifest.launchdJobs), "explicit process and job inventory required");
  for (const row of manifest.processes) {
    requireValue(Number.isInteger(row.pid) && row.pid > 1, "invalid owned pid");
    requireValue(exited(row.pid), `owned process still alive: ${row.pid}`);
    if (row.pgid !== undefined) {
      requireValue(row.ownedGroup === true && Number.isInteger(row.pgid) && row.pgid > 1, "owned group identity required");
      requireValue(exited(-row.pgid), `owned group still alive: ${row.pgid}`);
    }
  }
  for (const row of manifest.launchdJobs) {
    requireValue(row.domain === `gui/${process.getuid()}` && ISOLATED_LAUNCHD_LABEL.test(row.label), "isolated launchd identity required");
    try { await execute("/bin/launchctl", ["print", `${row.domain}/${row.label}`]); throw new Error(`launchd job still present: ${row.label}`); }
    catch (error) { requireValue(error.code === 113 && /Could not find service/.test(error.stderr ?? ""), `launchd absence unproven: ${row.label}`); }
  }
  if (manifest.runRoot) {
    // A process that never published its PID (e.g. killed before evidence was
    // copied) is still found while its argv names this run root. Our own
    // ancestors (the shell that invoked closeout) are not residuals.
    const rows = (await execute("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], { maxBuffer: 32 * 1024 * 1024 })).stdout.split("\n").filter(Boolean)
      .map(line => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
    const parent = new Map(rows.map(row => [row.pid, row.ppid]));
    const ancestors = new Set();
    for (let pid = process.pid; pid > 1 && !ancestors.has(pid); pid = parent.get(pid) ?? 1) ancestors.add(pid);
    const named = rows.filter(row => !ancestors.has(row.pid) && (row.command.includes(`${manifest.runRoot}/`) || row.command.split(/\s+/).includes(manifest.runRoot)));
    requireValue(!named.length, `live process references run root: ${named.map(row => row.pid).join(",")}`);
  }
  if (manifest.workRoot) {
    const db = new DatabaseSync(fixtureQuotaFile(manifest.workRoot), { readOnly: true });
    try {
      const pids = new Set(manifest.processes.map(row => row.pid));
      const rows = db.prepare("SELECT s.*,j.run_root FROM fixture_slots s LEFT JOIN external_fixture_jobs j ON j.token=s.token").all();
      requireValue(!rows.some(row => pids.has(row.pid) || pids.has(row.child_pid) || row.run_root && contains(manifest.runRoot, row.run_root)), "owned fixture quota remains registered");
    } finally { db.close(); }
  }
  return { status: "PASS", processes: manifest.processes, launchdJobs: manifest.launchdJobs };
}

async function inventory(root, targets) {
  const rows = [];
  async function visit(file) {
    const stat = await lstat(file);
    requireValue(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), "archive requires regular files/directories");
    if (stat.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(path.join(file, name));
    else rows.push({ path: path.relative(root, file), bytes: stat.size, sha256: sha256(await readFile(file)) });
  }
  for (const target of targets) await visit(target);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

// The runs this closeout covered; a broker run appended later was never inventoried or archived.
async function indexSnapshot(root) {
  let bytes;
  try { bytes = await readFile(path.join(root, "validation-index.jsonl")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const runs = bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).name);
  return { sha256: sha256(bytes), runs };
}

export async function finishCloseout(manifest) {
  const root = manifest.runRoot;
  requireValue(await realpath(root) === root && (await readFile(path.join(root, "run-root.txt"), "utf8")).trim() === root, "preregistered canonical run root required");
  const output = await managedPath(root, manifest.closeoutDirectory);
  requireValue(output === manifest.closeoutDirectory && manifest.artifacts.some(row => row.path === output && row.class === "LOCAL" && row.recursive), "closeout output must be registered LOCAL");
  await mkdir(output, { recursive: true });
  try { await lstat(path.join(output, "closeout.json")); throw new Error("closeout already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const before = await validateCloseout(manifest);
  requireValue(before.unregisteredPaths.length === 0, "unregistered paths must be resolved before cleanup");
  const resourceExit = await verifyOwnedExit(manifest);
  const expired = manifest.artifacts.filter(row => row.expiresAtGate === manifest.gateId && !row.carryOver);
  for (const row of expired) {
    requireValue(["RAW", "BULK", "INPUT"].includes(row.class), "retained records cannot expire");
    requireValue(!manifest.artifacts.some(other => other !== row && contains(row.path, other.path)), "overlapping cleanup registrations rejected");
    requireValue(await managedPath(root, row.path) === row.path, "cleanup symlink/alias rejected");
  }
  const existing = [];
  for (const row of expired) {
    try { await lstat(row.path); existing.push(row); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const raw = existing.filter(row => row.class === "RAW");
  let archive = null;
  if (raw.length) {
    const files = await inventory(root, raw.map(row => row.path));
    const archivePath = path.join(output, "raw-evidence.tar.gz");
    await writeJson(path.join(output, "archive-manifest.json"), { files });
    await execute("/usr/bin/tar", ["-czf", archivePath, "-C", root, "--", ...raw.map(row => path.relative(root, row.path))]);
    const verification = await mkdtemp(path.join(output, "verify-"));
    try {
      await execute("/usr/bin/tar", ["-xzf", archivePath, "-C", verification]);
      const actual = await inventory(verification, raw.map(row => path.join(verification, path.relative(root, row.path))));
      requireValue(JSON.stringify(actual) === JSON.stringify(files), "physical archive verification mismatch");
    } finally { await rm(verification, { recursive: true, force: true }); }
    archive = { path: archivePath, sha256: sha256(await readFile(archivePath)), fileCount: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0), physicalVerification: "PASS" };
  }
  for (const row of existing) await rm(row.path, { recursive: true, force: true });
  const remaining = await validateCloseout(manifest);
  const result = { ...remaining, closeoutId: manifest.gateId, validationIndex: await indexSnapshot(root), gatePassClaim: false, resourceExit, archive, deletedPaths: existing.map(row => row.path) };
  await writeJson(path.join(output, "closeout.json"), result);
  return result;
}

export async function validateCloseout(manifest) {
  const root = manifest.runRoot;
  requireValue(path.isAbsolute(root) && Array.isArray(manifest.artifacts), "invalid closeout manifest");
  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    await managedPath(root, artifact.path);
    requireValue(!paths.has(artifact.path), "duplicate artifact registration");
    paths.add(artifact.path);
    requireValue(["BULK", "RAW", "INPUT", "LOCAL", "REPO"].includes(artifact.class), "invalid artifact class");
    if (["BULK", "RAW", "INPUT"].includes(artifact.class)) {
      requireValue(typeof artifact.expiresAtGate === "string" && artifact.expiresAtGate.length > 0, "temporary/input artifacts require an expiry gate");
      if (artifact.expiresAtGate !== manifest.gateId) requireValue(artifact.carryOver === true, "retained artifact requires explicit carry-over");
    }
    if (artifact.carryOver) requireValue(artifact.consumer && artifact.expiresAtGate && artifact.expiresAtGate !== manifest.gateId, "carry-over must name a later consumer and gate");
  }
  const unregisteredPaths = [];
  const expiredResidualPaths = [];
  let expiredResidualBytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const registrations = manifest.artifacts.filter(row => row.recursive ? contains(row.path, file) : row.path === file);
      if (!registrations.length && !manifest.artifacts.some(row => contains(file, row.path))) unregisteredPaths.push(file);
      const stat = await lstat(file);
      // The broker's node_modules link points into its own private dependency
      // copy. Inspect the link without traversing it; external targets fail.
      if (stat.isSymbolicLink()) await managedPath(root, file);
      const expired = registrations.some(row => row.expiresAtGate === manifest.gateId && !row.carryOver);
      if (expired) expiredResidualPaths.push(file);
      if (entry.isDirectory()) await visit(file);
      else if (expired) expiredResidualBytes += stat.size;
    }
  }
  await visit(root);
  return { status: unregisteredPaths.length || expiredResidualPaths.length ? "FAIL" : "PASS", unregisteredPaths, expiredResidualPaths, expiredResidualBytes,
    carryOver: manifest.artifacts.filter(row => row.carryOver) };
}
if (isMain(import.meta.url)) runCli(async () => {
  const options = cliOptions(process.argv.slice(2), ["--manifest", "--finish"]);
  requireValue(Boolean(options.manifest) !== Boolean(options.finish), "choose --manifest or --finish");
  const manifest = await readJson(options.manifest ?? options.finish);
  const result = options.finish ? await finishCloseout(manifest) : await validateCloseout(manifest);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "PASS" ? 0 : 1;
});
