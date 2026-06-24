import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resourceDefaults } from "../dist/resource-defaults.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = resourceDefaults();
const gitSha = run("git", ["rev-parse", "--short=12", "HEAD"]) || "unknown";
const generatedAt = new Date().toISOString();
const defaultsFingerprint = createHash("sha1")
  .update(JSON.stringify({
    idleTtlMs: defaults.idleTtlMs,
    importConcurrency: defaults.importConcurrency,
    jdtlsXmx: defaults.jdtlsXmx,
    maxActiveRepos: defaults.maxActiveRepos
  }))
  .digest("hex")
  .slice(0, 12);

mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(path.join(root, "dist", "build-stamp.json"), `${JSON.stringify({
  gitSha,
  generatedAt,
  defaults: {
    idleTtlMs: defaults.idleTtlMs,
    importConcurrency: defaults.importConcurrency,
    jdtlsXmx: defaults.jdtlsXmx,
    maxActiveRepos: defaults.maxActiveRepos
  },
  defaultsFingerprint
}, null, 2)}\n`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
