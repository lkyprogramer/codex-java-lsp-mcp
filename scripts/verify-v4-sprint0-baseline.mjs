#!/usr/bin/env node
// input: A V4 Sprint0' manifest plus the git-tracked summary files it names.
// output: A hash-bound non-empty baseline verdict; exit 2 on any 0-byte or SHA mismatch.
// pos: Closes the V3.2 Sprint0 failure mode where artifacts/v3-baseline/ was all empty files.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const V4_SPRINT0_SCHEMA_VERSION = "v4-sprint0-baseline/v1";
export const V4_SPRINT0_IDENTITY_COMMIT = "4323b3cfead3a368b5a81c880176841d162ceced";
export const V4_SPRINT0_PRODUCTION_TREE = "1be810da3cc7a2895e143be204542174367e0b30";
export const V4_SPRINT0_CAMPAIGNS = ["cold-matrix", "bytes", "progressive", "first-touch"];
export const V4_SPRINT0_VERIFIER_VERSION = 1;

export class Sprint0ValidationError extends Error {}

export function verifyV4Sprint0Baseline(manifestFile, { requireRaw = false } = {}) {
  if (!manifestFile) throw new Sprint0ValidationError("manifest file is required");
  const resolvedManifest = path.resolve(manifestFile);
  const manifestRead = readJson(resolvedManifest);
  const manifest = manifestRead.value;
  if (manifest?.schemaVersion !== V4_SPRINT0_SCHEMA_VERSION) {
    throw new Sprint0ValidationError(`${resolvedManifest}: unsupported schema ${String(manifest?.schemaVersion)}`);
  }
  if (manifest.verifierVersion !== V4_SPRINT0_VERIFIER_VERSION) {
    throw new Sprint0ValidationError(`${resolvedManifest}: verifier version mismatch`);
  }
  if (manifest.identity?.commit !== V4_SPRINT0_IDENTITY_COMMIT) {
    throw new Sprint0ValidationError(`${resolvedManifest}: identity.commit must be the V4 merge baseline`);
  }
  if (manifest.identity?.productionTree !== V4_SPRINT0_PRODUCTION_TREE) {
    throw new Sprint0ValidationError(`${resolvedManifest}: identity.productionTree must match the frozen V4 LOC tree`);
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.identity?.measuredCommit ?? "")) {
    throw new Sprint0ValidationError(`${resolvedManifest}: identity.measuredCommit must be a full SHA`);
  }

  const root = path.dirname(resolvedManifest);
  const campaigns = manifest.campaigns ?? {};
  const missing = V4_SPRINT0_CAMPAIGNS.filter(name => !campaigns[name]);
  if (missing.length > 0) {
    throw new Sprint0ValidationError(`${resolvedManifest}: missing campaigns: ${missing.join(", ")}`);
  }

  const artifacts = [];
  for (const name of V4_SPRINT0_CAMPAIGNS) {
    const campaign = campaigns[name];
    if (!Array.isArray(campaign.summaries) || campaign.summaries.length === 0) {
      throw new Sprint0ValidationError(`${resolvedManifest}: ${name} must record at least one summary`);
    }
    for (const [index, descriptor] of campaign.summaries.entries()) {
      artifacts.push(validateDescriptor(root, descriptor, `${name}.summaries[${index}]`, { json: true }));
    }
    if (Array.isArray(campaign.rawArtifacts)) {
      for (const [index, descriptor] of campaign.rawArtifacts.entries()) {
        artifacts.push(validateDescriptor(root, descriptor, `${name}.rawArtifacts[${index}]`, {
          optional: !requireRaw,
          allowAbsolute: true
        }));
      }
    }
  }

  validateFirstTouchHostQuiet(campaigns["first-touch"], resolvedManifest);

  const empty = artifacts.filter(item => item.bytes === 0);
  if (empty.length > 0) {
    throw new Sprint0ValidationError(
      `${resolvedManifest}: zero-byte baseline artifacts are forbidden: ${empty.map(item => item.file).join(", ")}`
    );
  }

  return {
    schemaVersion: V4_SPRINT0_SCHEMA_VERSION,
    verifierVersion: V4_SPRINT0_VERIFIER_VERSION,
    verifiedAt: new Date().toISOString(),
    manifest: {
      file: resolvedManifest,
      bytes: manifestRead.bytes,
      sha256: manifestRead.sha256
    },
    identity: manifest.identity,
    campaigns: V4_SPRINT0_CAMPAIGNS,
    artifacts: artifacts.map(item => ({
      file: item.file,
      bytes: item.bytes,
      sha256: item.sha256,
      present: item.present
    })),
    passed: true
  };
}

function validateFirstTouchHostQuiet(campaign, context) {
  const quiet = campaign?.hostQuiet;
  if (!quiet || quiet.passed !== true) {
    throw new Sprint0ValidationError(`${context}: first-touch.hostQuiet.passed must be true`);
  }
  if (!(Number.isFinite(quiet.loadavg1) && Number.isInteger(quiet.logicalCpus) && quiet.logicalCpus > 0)) {
    throw new Sprint0ValidationError(`${context}: first-touch.hostQuiet is incomplete`);
  }
  if (quiet.perCpu !== quiet.loadavg1 / quiet.logicalCpus) {
    throw new Sprint0ValidationError(`${context}: first-touch.hostQuiet.perCpu does not match the recorded load sample`);
  }
  const memory = quiet.memory;
  if (!memory
    || !(Number.isFinite(memory.availableBytes) && memory.availableBytes >= 0)
    || !(Number.isFinite(memory.minAvailableBytes) && memory.minAvailableBytes > 0)
    || !(Number.isFinite(memory.totalBytes) && memory.totalBytes > 0)) {
    throw new Sprint0ValidationError(`${context}: first-touch.hostQuiet.memory is incomplete`);
  }
  if (memory.availableBytes < memory.minAvailableBytes) {
    throw new Sprint0ValidationError(`${context}: first-touch.hostQuiet was recorded below the available-memory floor`);
  }
}

function validateDescriptor(root, descriptor, context, { json = false, optional = false, allowAbsolute = false } = {}) {
  if (!descriptor || typeof descriptor.file !== "string"
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? "")
    || !Number.isInteger(descriptor.bytes)) {
    throw new Sprint0ValidationError(`invalid ${context} descriptor`);
  }
  if (descriptor.bytes <= 0) {
    throw new Sprint0ValidationError(`${context}: zero-byte artifacts are forbidden`);
  }
  const file = path.isAbsolute(descriptor.file) ? descriptor.file : path.resolve(root, descriptor.file);
  if (!allowAbsolute && path.isAbsolute(descriptor.file)) {
    throw new Sprint0ValidationError(`${context}: git-tracked summaries must use paths relative to the manifest`);
  }
  if (!allowAbsolute && !isWithin(root, file)) {
    throw new Sprint0ValidationError(`${context}: escapes manifest root`);
  }
  if (!existsSync(file)) {
    if (optional) return { ...descriptor, file, present: false };
    throw new Sprint0ValidationError(`${context}: missing file ${file}`);
  }
  const bytes = readFileSync(file);
  if (bytes.length === 0) {
    throw new Sprint0ValidationError(`${context}: on-disk file is empty`);
  }
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw new Sprint0ValidationError(`${context}: hash/bytes mismatch`);
  }
  if (statSync(file).size <= 0) {
    throw new Sprint0ValidationError(`${context}: ls-size is not positive`);
  }
  return json
    ? { ...descriptor, file, present: true, value: parseJson(bytes, file) }
    : { ...descriptor, file, present: true };
}

function readJson(file) {
  const bytes = readFileSync(file);
  if (bytes.length === 0) throw new Sprint0ValidationError(`${file}: manifest is empty`);
  return { file, bytes: bytes.length, sha256: sha256(bytes), value: parseJson(bytes, file) };
}

function parseJson(bytes, file) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Sprint0ValidationError(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function printUsage() {
  console.log("usage: node scripts/verify-v4-sprint0-baseline.mjs --manifest <file> [--require-raw]");
}

function parseCli(args) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "--require-raw") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: flags.has("--help"),
    requireRaw: flags.has("--require-raw"),
    manifest: options.get("--manifest")
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printUsage();
  } else {
    try {
      const result = verifyV4Sprint0Baseline(cli.manifest, { requireRaw: cli.requireRaw });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
