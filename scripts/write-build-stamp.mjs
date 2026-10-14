import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resourceDefaults } from "../dist/resource-defaults.js";
import { verifyRuntime } from "./ilv2-mac-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await verifyRuntime();
const native = JSON.parse(readFileSync(path.join(root, "dist/native/manifest.json"), "utf8"));
if (native.runtime.runtimeManifestSha256 !== runtime.runtimeManifestSha256 || native.arch !== runtime.arch ||
    native.binarySha256 !== createHash("sha256").update(readFileSync(path.join(root, "dist/native/ilv2-mac"))).digest("hex")) throw new Error("native build identity mismatch");
const defaults = resourceDefaults();
const gitSha = process.env.CODEX_JAVA_LSP_BUILD_SHA || run("git", ["rev-parse", "--short=12", "HEAD"]) || "unknown";
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
  runtime,
  native,
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
