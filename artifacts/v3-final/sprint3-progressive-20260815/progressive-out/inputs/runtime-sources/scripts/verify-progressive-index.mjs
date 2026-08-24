#!/usr/bin/env node
// input: One or two source-locked three-repository progressive-index manifests.
// output: Integrity validation and a zero-absolute-slack quiet progressive comparison.
// pos: V3.2-16/17/18 verifier; deliberately separate from the cold Token gate.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROGRESSIVE_PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
export const PROGRESSIVE_RUNS = 5;
export const PROGRESSIVE_VERIFIER_VERSION = 1;
const STAGES = ["open", "anchorReady", "moduleReady", "complete", "snapshotDurable"];
const EPSILON = 1e-12;

export class ProgressiveValidationError extends Error {}

export function verifyProgressiveManifest(manifestFile) {
  if (!manifestFile) throw new ProgressiveValidationError("manifest file is required");
  const manifestRead = readJson(path.resolve(manifestFile));
  const manifest = manifestRead.value;
  if (manifest?.schemaVersion !== 1 || manifest?.kind !== "v32-progressive-index-three-repo") {
    throw new ProgressiveValidationError(`${manifestFile}: unsupported progressive manifest`);
  }
  if (manifest.verifierVersion !== PROGRESSIVE_VERIFIER_VERSION) {
    throw new ProgressiveValidationError(`${manifestFile}: verifier version mismatch`);
  }
  if (manifest.protocol?.runs !== PROGRESSIVE_RUNS) {
    throw new ProgressiveValidationError(`${manifestFile}: formal progressive gate requires ${PROGRESSIVE_RUNS} runs`);
  }
  if (manifest.protocol?.cache !== "EMPTY_PRIVATE_PER_ATTEMPT" || manifest.protocol?.jdtlsDisabled !== true) {
    throw new ProgressiveValidationError(`${manifestFile}: progressive cache/JDT isolation contract mismatch`);
  }
  validateDescriptor(manifestRead.file, manifest.scenarioLock, "scenarioLock");
  validateDescriptor(manifestRead.file, manifest.runtime?.patch, "runtime.patch");
  const runPlan = validateDescriptor(manifestRead.file, manifest.runPlan, "runPlan", true);
  if (runPlan.value?.kind !== "v32-progressive-index-run-plan"
    || stableJson(runPlan.value.runtime) !== stableJson(manifest.runtime)
    || stableJson(runPlan.value.repositories) !== stableJson(manifest.repositories)
    || stableJson(runPlan.value.scenarioLock) !== stableJson(manifest.scenarioLock)
    || stableJson(runPlan.value.sourceFiles) !== stableJson(manifest.sourceFiles)
    || stableJson(runPlan.value.protocol) !== stableJson(manifest.protocol)) {
    throw new ProgressiveValidationError(`${manifestFile}: run plan does not match final manifest`);
  }
  validateSourceFiles(manifestRead.file, manifest.sourceFiles);
  validateRuntime(manifest.runtime, manifestFile);

  const expectedKeys = [...PROGRESSIVE_PROJECTS].sort();
  if (stableJson(Object.keys(manifest.repositories ?? {}).sort()) !== stableJson(expectedKeys)) {
    throw new ProgressiveValidationError(`${manifestFile}: repository set mismatch`);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== PROGRESSIVE_PROJECTS.length * PROGRESSIVE_RUNS) {
    throw new ProgressiveValidationError(`${manifestFile}: expected ${PROGRESSIVE_PROJECTS.length * PROGRESSIVE_RUNS} attempt artifacts`);
  }

  const attemptsByProject = Object.fromEntries(PROGRESSIVE_PROJECTS.map(project => [project, []]));
  const seen = new Set();
  const cacheIdentities = new Set();
  const runtimeStateIdentities = new Set();
  for (const artifact of manifest.artifacts) {
    if (!PROGRESSIVE_PROJECTS.includes(artifact?.project) || !Number.isInteger(artifact?.run)
      || artifact.run < 1 || artifact.run > PROGRESSIVE_RUNS) {
      throw new ProgressiveValidationError(`${manifestFile}: invalid artifact project/run`);
    }
    const key = `${artifact.project}:${artifact.run}`;
    if (seen.has(key)) throw new ProgressiveValidationError(`${manifestFile}: duplicate artifact ${key}`);
    seen.add(key);
    for (const [field, identities] of [["cacheIdentity", cacheIdentities], ["runtimeStateIdentity", runtimeStateIdentities]]) {
      if (!/^[a-f0-9]{64}$/.test(artifact[field] ?? "") || identities.has(artifact[field])) {
        throw new ProgressiveValidationError(`${manifestFile}: reused/invalid ${field} for ${key}`);
      }
      identities.add(artifact[field]);
    }
    const raw = validateDescriptor(manifestRead.file, artifact.raw, `${key}.raw`, true);
    const stdout = validateDescriptor(manifestRead.file, artifact.stdout, `${key}.stdout`, false);
    const stderr = validateDescriptor(manifestRead.file, artifact.stderr, `${key}.stderr`, false);
    if (artifact.exitCode !== 0 || stderr.bytes !== 0) {
      throw new ProgressiveValidationError(`${manifestFile}: ${key} exited ${artifact.exitCode} with ${stderr.bytes} stderr bytes`);
    }
    if (stdout.bytes === 0) throw new ProgressiveValidationError(`${manifestFile}: ${key} stdout is empty`);
    validateAttempt(raw.value, manifest, artifact, runPlan.sha256, manifestFile);
    attemptsByProject[artifact.project].push(raw.value.attempt);
  }

  const projects = PROGRESSIVE_PROJECTS.map(project => {
    const attempts = attemptsByProject[project];
    if (attempts.length !== PROGRESSIVE_RUNS) {
      throw new ProgressiveValidationError(`${manifestFile}: ${project} attempt count mismatch`);
    }
    const digests = new Set(attempts.map(attempt => attempt.finalSemanticDigest));
    if (digests.size !== 1) throw new ProgressiveValidationError(`${manifestFile}: ${project} semantic digest drift`);
    return {
      project,
      repository: manifest.repositories[project],
      semanticDigest: [...digests][0],
      stages: Object.fromEntries(STAGES.map(stage => [stage, summarize(attempts.map(attempt => attempt.stages[stage].elapsedMs))]))
    };
  });

  return {
    schemaVersion: 1,
    verifierVersion: PROGRESSIVE_VERIFIER_VERSION,
    verifiedAt: new Date().toISOString(),
    manifest: { file: manifestRead.file, sha256: manifestRead.sha256 },
    runtime: manifest.runtime,
    scenarioLock: manifest.scenarioLock,
    protocol: manifest.protocol,
    projects,
    passed: true
  };
}

export function compareProgressiveManifests({ baselineManifest, candidateManifest, summaryFile } = {}) {
  const baseline = verifyProgressiveManifest(baselineManifest);
  const candidate = verifyProgressiveManifest(candidateManifest);
  validateComparable(baseline, candidate);
  const projects = PROGRESSIVE_PROJECTS.map(project => {
    const oldProject = baseline.projects.find(item => item.project === project);
    const newProject = candidate.projects.find(item => item.project === project);
    const ratios = Object.fromEntries(STAGES.map(stage => [stage, ratio(newProject.stages[stage].p95, oldProject.stages[stage].p95)]));
    const baselineAnchorP95 = oldProject.stages.anchorReady.p95;
    const anchorTargetMs = baselineAnchorP95 > 2_000 ? 2_000 : baselineAnchorP95 * 0.80;
    const gate = {
      semanticDigest: oldProject.semanticDigest === newProject.semanticDigest,
      anchorReady: newProject.stages.anchorReady.p95 <= anchorTargetMs + EPSILON,
      moduleReady: newProject.stages.moduleReady.p95 < oldProject.stages.moduleReady.p95 - EPSILON,
      complete: newProject.stages.complete.p95 <= oldProject.stages.complete.p95 * 1.10 + EPSILON
    };
    return {
      project,
      baseline: oldProject,
      candidate: newProject,
      delta: {
        p95Ratio: ratios,
        anchorTargetMs,
        p95Ms: Object.fromEntries(STAGES.map(stage => [stage, newProject.stages[stage].p95 - oldProject.stages[stage].p95]))
      },
      gate,
      passed: Object.values(gate).every(Boolean)
    };
  });
  const result = {
    schemaVersion: 1,
    verifierVersion: PROGRESSIVE_VERIFIER_VERSION,
    verifiedAt: new Date().toISOString(),
    policy: {
      percentile: "nearest-rank-ceil",
      absoluteSlackMs: 0,
      anchorReady: "baseline-p95>2000ms => candidate<=2000ms; otherwise candidate<=baseline*0.80",
      moduleReady: "candidate-p95<baseline-p95",
      complete: "candidate-p95<=baseline-p95*1.10",
      scope: "QUIET_PROGRESSIVE_ONLY_STORM_GATE_SEPARATE"
    },
    baseline: baseline.manifest,
    candidate: candidate.manifest,
    projects,
    passed: projects.every(project => project.passed)
  };
  if (summaryFile) writeFileSync(path.resolve(summaryFile), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}

export function nearestRank(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) throw new ProgressiveValidationError("cannot summarize an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function validateComparable(baseline, candidate) {
  if (baseline.scenarioLock.sha256 !== candidate.scenarioLock.sha256) {
    throw new ProgressiveValidationError("baseline/candidate scenario lock mismatch");
  }
  for (const field of ["runs", "generation", "pollMs", "timeoutMs", "cache", "jdtlsDisabled"]) {
    if (baseline.protocol[field] !== candidate.protocol[field]) {
      throw new ProgressiveValidationError(`baseline/candidate protocol mismatch: ${field}`);
    }
  }
  for (const project of PROGRESSIVE_PROJECTS) {
    const oldRepo = baseline.projects.find(item => item.project === project).repository;
    const newRepo = candidate.projects.find(item => item.project === project).repository;
    for (const field of ["head", "tree", "statusSha256"]) {
      if (oldRepo[field] !== newRepo[field]) {
        throw new ProgressiveValidationError(`baseline/candidate ${project} repository mismatch: ${field}`);
      }
    }
  }
}

function validateAttempt(value, manifest, artifact, runPlanSha256, context) {
  const { project, run } = artifact;
  if (value?.schemaVersion !== 1 || value.sourceLock?.repoCommit !== manifest.repositories[project].head
    || value.sourceLock?.repoTree !== manifest.repositories[project].tree
    || value.sourceLock?.repoStatusSha256 !== manifest.repositories[project].statusSha256
    || value.sourceLock?.scenarioFileSha256 !== manifest.scenarioLock.sha256
    || stableJson(value.sourceLock?.runtimeBuild) !== stableJson(manifest.runtime.buildStamp)) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} source lock mismatch`);
  }
  if (value.protocol?.cache !== manifest.protocol.cache || value.protocol?.generation !== manifest.protocol.generation
    || value.protocol?.pollMs !== manifest.protocol.pollMs || value.protocol?.timeoutMs !== manifest.protocol.timeoutMs
    || value.protocol?.jdtlsDisabled !== true) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} protocol mismatch`);
  }
  const attempt = value.attempt;
  if (attempt?.projectId !== project || attempt.generation !== manifest.protocol.generation
    || !/^[a-f0-9]{64}$/.test(attempt.finalSemanticDigest ?? "")) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} attempt identity/digest mismatch`);
  }
  const provenance = value.matrixProvenance;
  const expectedProvenance = {
    runPlanSha256,
    project,
    run,
    runtimeCommit: manifest.runtime.commit,
    runtimeCommitTree: manifest.runtime.commitTree,
    runtimeExecutableTree: manifest.runtime.executableTree,
    runtimePatchSha256: manifest.runtime.patch.sha256,
    repoHead: manifest.repositories[project].head,
    repoTree: manifest.repositories[project].tree,
    repoStatusSha256: manifest.repositories[project].statusSha256,
    scenarioLockSha256: manifest.scenarioLock.sha256,
    cachePolicy: manifest.protocol.cache,
    cacheIdentity: artifact.cacheIdentity,
    runtimeStateIdentity: artifact.runtimeStateIdentity
  };
  if (stableJson(provenance) !== stableJson(expectedProvenance)) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} matrix provenance mismatch`);
  }
  for (const stage of STAGES) {
    const item = attempt.stages?.[stage];
    if (item?.state !== "REACHED" || !(Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0)) {
      throw new ProgressiveValidationError(`${context}: ${project}:${run} stage ${stage} did not reach`);
    }
  }
  if (attempt.stages.anchorReady.proof?.anchorGeneration !== manifest.protocol.generation
    || !Array.isArray(attempt.stages.moduleReady.proof?.roots)
    || attempt.stages.moduleReady.proof.roots.length === 0) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} anchor/module proof is incomplete`);
  }
  const completeProof = attempt.stages.complete.proof;
  if (completeProof?.indexedGeneration !== manifest.protocol.generation
    || completeProof?.state !== "READY"
    || completeProof?.pendingForeground !== 0
    || completeProof?.pendingBackground !== 0
    || !Array.isArray(completeProof?.coverage)
    || completeProof.coverage.length === 0
    || completeProof.coverage.some(root => root.generation !== manifest.protocol.generation
      || root.state !== "COMPLETE" || root.failedFiles !== 0 || root.recoveredFiles !== 0)
    || !Array.isArray(completeProof?.resourceCoverage)
    || completeProof.resourceCoverage.some(root => root.generation !== manifest.protocol.generation
      || root.state !== "COMPLETE" || root.failedFiles !== 0)) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} complete proof is not authoritative`);
  }
  if (!(attempt.stages.open.elapsedMs <= attempt.stages.anchorReady.elapsedMs + EPSILON
    && attempt.stages.anchorReady.elapsedMs <= attempt.stages.moduleReady.elapsedMs + EPSILON
    && attempt.stages.moduleReady.elapsedMs <= attempt.stages.complete.elapsedMs + EPSILON
    && attempt.stages.complete.elapsedMs <= attempt.stages.snapshotDurable.elapsedMs + EPSILON)) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} stage timeline is invalid`);
  }
  if (attempt.negativeLookup?.beforeComplete?.state !== "UNRESOLVED"
    || attempt.negativeLookup?.beforeComplete?.coverage === "COMPLETE"
    || attempt.negativeLookup?.beforeComplete?.authoritative !== false
    || attempt.negativeLookup?.afterComplete?.state !== "UNRESOLVED"
    || attempt.negativeLookup?.afterComplete?.coverage !== "COMPLETE"
    || attempt.negativeLookup?.afterComplete?.authoritative !== true) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} negative lookup contract failed`);
  }
  const buildingEvents = Array.isArray(attempt.events) ? attempt.events.filter(event =>
    event?.status?.coverage?.some(root => root?.generation === manifest.protocol.generation && root?.state === "BUILDING")
  ) : [];
  if (buildingEvents.length === 0 || Math.min(...buildingEvents.map(event => event.elapsedMs)) > attempt.stages.anchorReady.elapsedMs + EPSILON) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} did not observe BUILDING`);
  }
  if (attempt.stages.snapshotDurable.proof?.semanticDigest !== attempt.finalSemanticDigest
    || !/^[a-f0-9]{64}$/.test(attempt.stages.snapshotDurable.proof?.manifestFingerprint ?? "")
    || !(attempt.stages.snapshotDurable.proof?.bytes > 0)) {
    throw new ProgressiveValidationError(`${context}: ${project}:${run} snapshot digest mismatch`);
  }
}

function validateSourceFiles(manifestFile, descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw new ProgressiveValidationError(`${manifestFile}: sourceFiles are required`);
  }
  const seen = new Set();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.file)) throw new ProgressiveValidationError(`${manifestFile}: duplicate source file descriptor`);
    seen.add(descriptor.file);
    validateDescriptor(manifestFile, descriptor, `sourceFiles:${descriptor.file}`);
  }
}

function validateRuntime(runtime, context) {
  for (const field of ["commit", "commitTree", "executableTree"]) {
    if (!/^[a-f0-9]{40}$/.test(runtime?.[field] ?? "")) {
      throw new ProgressiveValidationError(`${context}: runtime.${field} must be an exact tree/commit`);
    }
  }
  if (!runtime.buildStamp || !runtime.dependencies?.sha256) {
    throw new ProgressiveValidationError(`${context}: runtime build/dependency identity is incomplete`);
  }
}

function validateDescriptor(manifestFile, descriptor, context, json = false) {
  if (!descriptor || typeof descriptor.file !== "string" || path.isAbsolute(descriptor.file)
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 ?? "") || !Number.isInteger(descriptor.bytes)) {
    throw new ProgressiveValidationError(`${manifestFile}: invalid ${context} descriptor`);
  }
  const root = path.dirname(path.resolve(manifestFile));
  const file = path.resolve(root, descriptor.file);
  if (!isWithin(root, file)) throw new ProgressiveValidationError(`${manifestFile}: ${context} escapes artifact root`);
  const bytes = readFileSync(file);
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
    throw new ProgressiveValidationError(`${manifestFile}: ${context} hash/bytes mismatch`);
  }
  return json ? { ...descriptor, file, value: parseJson(bytes, file) } : { ...descriptor, file };
}

function summarize(values) {
  return {
    samples: values.length,
    min: Math.min(...values),
    p50: nearestRank(values, 0.50),
    p95: nearestRank(values, 0.95),
    max: Math.max(...values)
  };
}

function ratio(candidate, baseline) {
  return baseline === 0 ? (candidate === 0 ? 1 : Number.POSITIVE_INFINITY) : candidate / baseline;
}

function readJson(file) {
  const bytes = readFileSync(file);
  return { file, bytes: bytes.length, sha256: sha256(bytes), value: parseJson(bytes, file) };
}

function parseJson(bytes, file) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ProgressiveValidationError(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key?.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[index + 1]);
  }
  return {
    baselineManifest: options.get("--baseline-manifest"),
    candidateManifest: options.get("--candidate-manifest"),
    summaryFile: options.get("--summary-file")
  };
}

function printUsage() {
  console.log("Usage: node scripts/verify-progressive-index.mjs --baseline-manifest FILE [--candidate-manifest FILE] [--summary-file FILE]");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const cli = parseCli(process.argv.slice(2));
    if (cli.help) printUsage();
    else {
      const result = cli.candidateManifest
        ? compareProgressiveManifests(cli)
        : verifyProgressiveManifest(cli.baselineManifest);
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
