#!/usr/bin/env node
// Validate the actual remaining tree; this command never deletes evidence.
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { contains, readJson, managedPath, requireValue, isMain, runCli, cliOptions } from "./ilv2-mac-contracts.mjs";

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
      requireValue(!stat.isSymbolicLink(), "closeout residual symlink rejected");
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
  const options = cliOptions(process.argv.slice(2), ["--manifest"]);
  const result = await validateCloseout(await readJson(options.manifest));
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "PASS" ? 0 : 1;
});
