#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const workspaceRoot = process.cwd();
const canonicalRoot = "artifacts/v3-final/task36-remediation-20260809";
const manifestPath = `${canonicalRoot}/final-evidence-manifest.json`;
const receiptPath = `${canonicalRoot}/validation-receipt-final-v1.json`;
const reportPath = "docs/phase-v3/final-java-intelligence-v3-report.md";
const coldRoot = `${canonicalRoot}/cold-matrix-final-source-locked-v4-pass3`;
const validationRoot = `${canonicalRoot}/validation-final-v1`;
const determinismRoot = `${canonicalRoot}/determinism-final-v3`;
const warmRoot = `${canonicalRoot}/warm-final-v2`;
const firstTouchRoot = `${canonicalRoot}/first-touch-final`;

const rootEvidenceFiles = [
  `${canonicalRoot}/fault-suite-final-v4.json`,
  `${canonicalRoot}/fault-suite-final-v4.stdout.json`,
  `${canonicalRoot}/fault-suite-final-v4.stderr`,
  `${canonicalRoot}/mutation-matrix-final-v4.json`,
  `${canonicalRoot}/mutation-matrix-final-v4.stdout.json`,
  `${canonicalRoot}/mutation-matrix-final-v4.stderr`,
  `${canonicalRoot}/multiprocess-smoke-final-v4.json`,
  `${canonicalRoot}/multiprocess-smoke-final-v4.stderr`
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function absolute(relativePath) {
  return path.join(workspaceRoot, relativePath);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(absolute(relativePath), "utf8"));
}

async function collectDirectory(relativeRoot, files) {
  const entries = await readdir(absolute(relativeRoot), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) await collectDirectory(relativePath, files);
    else if (entry.isFile()) files.add(relativePath);
  }
}

function evidenceKind(relativePath) {
  if (relativePath === reportPath) return "report";
  if (relativePath.endsWith("candidate.patch")) return "candidate-patch";
  if (relativePath.includes("candidate-untracked/")) return "candidate-source-snapshot";
  if (relativePath.endsWith("run-manifest.json")) return "suite-manifest";
  if (relativePath.endsWith("summary.json") || relativePath.endsWith("warm-summary.json")) return "summary";
  if (relativePath.endsWith(".stderr")) return "stderr";
  if (relativePath.endsWith(".stdout") || relativePath.endsWith(".stdout.json")) return "stdout";
  if (relativePath.endsWith(".sha256")) return "checksum-ledger";
  if (relativePath.endsWith(".mjs")) return "validator-source";
  if (relativePath.endsWith(".jsonl")) return "scenario-input";
  if (relativePath.endsWith(".json")) return "raw-or-verification-json";
  return "supporting-artifact";
}

async function inventoryEntry(relativePath) {
  const bytes = await readFile(absolute(relativePath));
  return {
    path: relativePath,
    bytes: bytes.length,
    sha256: sha256(bytes),
    kind: evidenceKind(relativePath)
  };
}

function inventoryDigest(files) {
  const encoded = files
    .map(file => `${file.path}\0${file.bytes}\0${file.sha256}\n`)
    .join("");
  return sha256(Buffer.from(encoded));
}

async function atomicJson(relativePath, value) {
  const target = absolute(relativePath);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, target);
}

function suiteFiles(inventory, prefix) {
  return inventory.filter(file => file.path === prefix || file.path.startsWith(`${prefix}/`));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const firstTouch = await readJson(`${firstTouchRoot}/first-touch-summary.json`);
  const coldManifest = await readJson(`${coldRoot}/run-manifest.json`);
  const coldSummary = await readJson(`${coldRoot}/matrix-summary.json`);
  const warmSummary = await readJson(`${warmRoot}/warm-summary.json`);
  const fault = await readJson(`${canonicalRoot}/fault-suite-final-v4.json`);
  const mutation = await readJson(`${canonicalRoot}/mutation-matrix-final-v4.json`);
  const multiprocess = await readJson(`${canonicalRoot}/multiprocess-smoke-final-v4.json`);

  const files = new Set([reportPath, ...rootEvidenceFiles]);
  await collectDirectory(coldRoot, files);
  await collectDirectory(validationRoot, files);
  await collectDirectory(determinismRoot, files);
  await collectDirectory(warmRoot, files);
  files.add(`${firstTouchRoot}/first-touch-summary.json`);
  for (const cell of firstTouch.cells) {
    const raw = `${firstTouchRoot}/${cell.file}`;
    const stem = raw.replace(/\.json$/, "");
    files.add(raw);
    files.add(`${stem}.stdout.json`);
    files.add(`${stem}.stderr`);
  }
  files.delete(manifestPath);
  files.delete(receiptPath);

  const orderedPaths = [...files].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const inventoryFiles = [];
  for (const relativePath of orderedPaths) inventoryFiles.push(await inventoryEntry(relativePath));
  const inventorySha256 = inventoryDigest(inventoryFiles);
  const totalBytes = inventoryFiles.reduce((sum, file) => sum + file.bytes, 0);

  const determinism = {};
  for (const project of ["lishuedu", "cipherlink", "exam-parent-v3"]) {
    determinism[project] = await readJson(`${determinismRoot}/${project}.verify.json`);
  }

  const manifest = {
    schemaVersion: 1,
    manifestKind: "task36-canonical-evidence",
    generatedAt: new Date().toISOString(),
    status: "FINAL",
    canonicalRoot,
    report: inventoryFiles.find(file => file.path === reportPath),
    sourceIdentity: {
      baselineSelection: {
        kind: "LATEST_EXECUTABLE_DOCS_BASELINE",
        revision: coldManifest.runtimes.old.commit,
        executableTree: coldManifest.runtimes.old.executableTree,
        reason: "The user approved the latest executable docs report as the comparison baseline because Phase 0 real-repository raw files are empty and cannot support a numeric comparison."
      },
      historicalPreV3: {
        revision: "48e665ba73dc332dccd4b34e71adc1c048170cf6",
        tree: "538661f26ae49c490227b760daa075dd8b6e64fe",
        numericComparison: "UNMEASURED_PHASE0_RAW_UNAVAILABLE"
      },
      approvedOld: coldManifest.runtimes.old,
      candidateBase: {
        commit: coldManifest.runtimes.new.commit,
        commitTree: coldManifest.runtimes.new.commitTree
      },
      candidateExecutableTree: coldManifest.runtimes.new.executableTree,
      candidatePatch: coldManifest.candidatePatch,
      repositories: coldManifest.repositories,
      scenarios: coldManifest.scenarios,
      binding: "BOUND_BY_COLD_V4_PASS3"
    },
    inventory: {
      algorithm: "sha256",
      ordering: "relative-path-bytewise",
      digestEncoding: "path\\0bytes\\0sha256\\n",
      fileCount: inventoryFiles.length,
      totalBytes,
      inventorySha256,
      files: inventoryFiles
    },
    suites: [
      {
        id: "cold-v4-pass3",
        role: "PRIMARY_PAIRED_ACCEPTANCE",
        selection: "CANONICAL",
        binding: "BOUND",
        claimCeiling: "STRICT_PAIRED_COLD_GATE",
        gate: coldSummary.passed ? "PASS" : "FAIL",
        files: suiteFiles(inventoryFiles, coldRoot).map(file => file.path),
        configuration: coldSummary.configuration,
        warnings: coldSummary.warnings,
        projects: coldSummary.projects
      },
      {
        id: "clean-local-validation-v1",
        role: "POST_BUILD_RECEIPT",
        selection: "CANONICAL_SUPPORTING",
        binding: "POST_BUILD_CURRENT_WORKTREE",
        claimCeiling: "LOCAL_BUILD_AND_TEST_BEHAVIOR",
        gate: "PASS_RECORDED_EXIT_ZERO",
        files: suiteFiles(inventoryFiles, validationRoot).map(file => file.path),
        observed: {
          npmTest: { pass: 836, fail: 0, skipped: 0, todo: 0 },
          scriptTests: { pass: 25, fail: 0, skipped: 0, todo: 0 },
          smokeTools: 5,
          fastCheckWarnings: 0,
          npmAuditProductionVulnerabilities: 0
        }
      },
      {
        id: "fault-v4",
        role: "REQUIRED_REGRESSION_GATE",
        selection: "CANONICAL_SUPPORTING",
        binding: "POST_BUILD_CURRENT_WORKTREE",
        claimCeiling: "SELECTED_FAULT_BEHAVIOR",
        gate: fault.gate?.passed ? "PASS" : "FAIL",
        observed: fault.gate,
        files: rootEvidenceFiles.filter(file => file.includes("fault-suite"))
      },
      {
        id: "mutation-v4",
        role: "REQUIRED_MUTATION_GATE",
        selection: "CANONICAL_SUPPORTING",
        binding: "POST_BUILD_CURRENT_WORKTREE",
        claimCeiling: "WATCHER_RUNTIME_MUTATION_BEHAVIOR",
        gate: mutation.gate?.passed ? "PASS" : "FAIL",
        observed: { gate: mutation.gate, watcher: mutation.watcher, overlapProbe: mutation.overlapProbe },
        files: rootEvidenceFiles.filter(file => file.includes("mutation-matrix"))
      },
      {
        id: "multiprocess-v4",
        role: "REQUIRED_MULTIPROCESS_GATE",
        selection: "CANONICAL_SUPPORTING",
        binding: "POST_BUILD_CURRENT_WORKTREE",
        claimCeiling: "SELECTED_SUBPROCESS_AND_ISOLATED_BEHAVIOR",
        gate: Object.values(multiprocess.gate ?? {}).every(value => value === "PASS") ? "PASS" : "FAIL",
        observed: {
          gate: multiprocess.gate,
          configuredMax: multiprocess.configuredMax,
          observedMax: multiprocess.observedMax,
          duplicateCount: multiprocess.duplicateCount,
          reclaim: multiprocess.reclaim
        },
        files: rootEvidenceFiles.filter(file => file.includes("multiprocess-smoke"))
      },
      {
        id: "determinism-v3",
        role: "SUPPORTING_STABILITY_GATE",
        selection: "CANONICAL_SUPPORTING",
        binding: "POST_BUILD_SCENARIO_HASH_MATCHED",
        claimCeiling: "SEMANTIC_OUTPUT_STABILITY",
        gate: Object.values(determinism).every(result => result.gate === "PASS" && result.stable === true) ? "PASS" : "FAIL",
        observed: determinism,
        files: suiteFiles(inventoryFiles, determinismRoot).map(file => file.path)
      },
      {
        id: "warm-final-v2",
        role: "SUPPORTING_POLICY_OBSERVATION",
        selection: "CANONICAL_POLICY_EVIDENCE",
        binding: "UNBOUND_TO_CANDIDATE_EXECUTABLE_TREE",
        claimCeiling: "KEEP_EXPLICIT_POLICY_ONLY",
        gate: "SUPPORTS_KEEP_EXPLICIT",
        comparability: "NOT_P95_COMPARABLE_TO_COLD: auto=3000ms, required=5000ms, JDT enabled",
        observed: warmSummary,
        files: suiteFiles(inventoryFiles, warmRoot).map(file => file.path)
      },
      {
        id: "first-touch-final",
        role: "POLICY_DECISION_EVIDENCE",
        selection: "CANONICAL_POLICY_EVIDENCE",
        binding: "UNBOUND_TO_CANDIDATE_EXECUTABLE_TREE",
        claimCeiling: "RAW_JDT_FIRST_TOUCH_POLICY_ONLY",
        gate: firstTouch.decision === "KEEP_EXPLICIT" ? "SUPPORTS_KEEP_EXPLICIT" : "FAIL",
        comparability: "NOT_P95_COMPARABLE_TO_COLD: raw JDT session API, timeout=60000ms",
        observed: { gate: firstTouch.gate, decision: firstTouch.decision, anchors: firstTouch.anchors },
        files: inventoryFiles.filter(file => file.path.startsWith(`${firstTouchRoot}/`)).map(file => file.path)
      }
    ],
    supersedes: [
      { path: `${canonicalRoot}/cold-matrix-final-source-locked-v4-pass1`, reason: "SUPERSEDED_BY_PASS3" },
      { path: `${canonicalRoot}/cold-matrix-final-source-locked-v4-pass2`, reason: "SUPERSEDED_ENVIRONMENT_INTERFERENCE" },
      { path: `${canonicalRoot}/cold-matrix-phase5-baseline-final`, reason: "SUPERSEDED_BY_SOURCE_LOCKED_V4" },
      { path: `${canonicalRoot}/fault-suite-final-v3.json`, reason: "SUPERSEDED_BY_V4" },
      { path: `${canonicalRoot}/mutation-matrix-final-v3.json`, reason: "SUPERSEDED_BY_V4" },
      { path: `${canonicalRoot}/multiprocess-smoke-final-v3.json`, reason: "SUPERSEDED_BY_V4" },
      { path: `${canonicalRoot}/determinism-final-v2`, reason: "SUPERSEDED_BY_V3" }
    ],
    knownUnmeasured: [
      "Phase0 48e665b three-repository numeric comparison",
      "six end-to-end Agent trace before/after comparison",
      "real foreground-anchor P95 under a 500-file storm",
      "full readPlan range recall beyond the 15/120 measured attempts per cold variant",
      "complete per-provider counterfactual cost attribution",
      "DocumentLru performance attribution in a JDT-enabled paired matrix",
      "SemanticGateway cacheHit/shared values from the raw-session first-touch API"
    ],
    overall: {
      deliveryGate: "ACCEPT_WITH_DOCUMENTED_EXCEPTION",
      policyDecision: "KEEP_EXPLICIT",
      evidenceCompleteness: "COMPLETE_WITH_DECLARED_UNMEASURED",
      strictComparisonScope: "7df1a0e approved executable docs baseline to candidate executable tree 60ae785e",
      prohibitedClaim: "Do not report an overall 48e665b-to-final improvement percentage."
    }
  };

  await atomicJson(manifestPath, manifest);

  const storedManifestBytes = await readFile(absolute(manifestPath));
  const storedManifest = JSON.parse(storedManifestBytes.toString("utf8"));
  const hashMismatches = [];
  for (const expected of storedManifest.inventory.files) {
    const actual = await inventoryEntry(expected.path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      hashMismatches.push({ path: expected.path, expected, actual });
    }
  }

  const coldManifestBytes = await readFile(absolute(`${coldRoot}/run-manifest.json`));
  const candidatePatchBytes = await readFile(absolute(`${coldRoot}/candidate.patch`));
  const validationChecks = [
    {
      id: "all-listed-files-hash",
      status: hashMismatches.length === 0 ? "PASS" : "FAIL",
      observed: { fileCount: storedManifest.inventory.fileCount, totalBytes: storedManifest.inventory.totalBytes, mismatches: hashMismatches }
    },
    {
      id: "inventory-digest",
      status: inventoryDigest(storedManifest.inventory.files) === storedManifest.inventory.inventorySha256 ? "PASS" : "FAIL",
      observed: storedManifest.inventory.inventorySha256
    },
    {
      id: "cold-v4-pass3-source-binding",
      status: coldManifest.version === 4
        && coldManifest.verifierVersion === 4
        && sha256(coldManifestBytes) === coldSummary.manifest.sha256
        && sha256(candidatePatchBytes) === coldManifest.candidatePatch.sha256
        && coldManifest.candidatePatch.resultingExecutableTree === coldManifest.runtimes.new.executableTree
        ? "PASS" : "FAIL",
      observed: {
        manifestSha256: sha256(coldManifestBytes),
        patchSha256: sha256(candidatePatchBytes),
        candidateExecutableTree: coldManifest.runtimes.new.executableTree
      }
    },
    {
      id: "cold-v4-pass3-gate",
      status: coldSummary.passed === true
        && coldSummary.cells.length === 18
        && coldSummary.warnings.length === 0
        && coldSummary.projects.length === 3
        && coldSummary.projects.every(project => project.passed === true
          && project.old.attempts === 120
          && project.new.attempts === 120
          && project.old.minReadMust === 1
          && project.new.minReadMust === 1
          && Object.values(project.gate).every(Boolean))
        ? "PASS" : "FAIL",
      observed: { passed: coldSummary.passed, cells: coldSummary.cells.length, projects: coldSummary.projects.length, warnings: coldSummary.warnings }
    },
    {
      id: "supplemental-suite-gates",
      status: fault.gate?.passed === true
        && mutation.gate?.passed === true
        && mutation.gate?.staleCount === 0
        && mutation.overlapProbe?.changedDuringRequest === true
        && Object.values(multiprocess.gate ?? {}).every(value => value === "PASS")
        && Object.values(determinism).every(result => result.gate === "PASS" && result.stable === true)
        ? "PASS" : "FAIL",
      observed: {
        fault: fault.gate,
        mutation: mutation.gate,
        overlap: mutation.overlapProbe,
        multiprocess: multiprocess.gate,
        determinism: Object.fromEntries(Object.entries(determinism).map(([project, result]) => [project, { gate: result.gate, rows: result.rows, expectedRuns: result.expectedRuns }]))
      }
    },
    {
      id: "policy-evidence-boundaries",
      status: firstTouch.decision === "KEEP_EXPLICIT"
        && firstTouch.gate?.observedCells === 21
        && firstTouch.gate?.allCellsHaveTenAttempts === true
        && firstTouch.gate?.freshP95Under800ms === false
        && warmSummary.cells.length === 6
        && warmSummary.cells.some(cell => cell.projectId === "lishuedu" && cell.semanticPolicy === "required" && cell.rReadMust < 1)
        ? "PASS" : "FAIL",
      observed: {
        decision: firstTouch.decision,
        firstTouchGate: firstTouch.gate,
        warmCells: warmSummary.cells.length,
        lishueduRequiredReadMust: warmSummary.cells.find(cell => cell.projectId === "lishuedu" && cell.semanticPolicy === "required")?.rReadMust
      }
    },
    {
      id: "local-validation-output-contract",
      status: /# pass 836\b/.test(await readFile(absolute(`${validationRoot}/npm-test.stdout`), "utf8"))
        && /# fail 0\b/.test(await readFile(absolute(`${validationRoot}/npm-test.stdout`), "utf8"))
        && /# pass 25\b/.test(await readFile(absolute(`${validationRoot}/script-tests.stdout`), "utf8"))
        && /# fail 0\b/.test(await readFile(absolute(`${validationRoot}/script-tests.stdout`), "utf8"))
        && /READY: codex-java-lsp checks passed with 0 warning\(s\)\./.test(await readFile(absolute(`${validationRoot}/check-fast.stdout`), "utf8"))
        && /"java_symbol"/.test(await readFile(absolute(`${validationRoot}/npm-smoke.stdout`), "utf8"))
        && /found 0 vulnerabilities/.test(await readFile(absolute(`${validationRoot}/npm-ci.stdout`), "utf8"))
        ? "PASS" : "FAIL",
      observed: { npmTests: 836, scriptTests: 25, smokeTools: 5, fastWarnings: 0, npmCiVulnerabilities: 0 }
    },
    {
      id: "declared-unmeasured-not-promoted",
      status: storedManifest.knownUnmeasured.length === 7
        && storedManifest.overall.deliveryGate === "ACCEPT_WITH_DOCUMENTED_EXCEPTION"
        && storedManifest.overall.prohibitedClaim.includes("48e665b")
        ? "PASS" : "FAIL",
      observed: storedManifest.knownUnmeasured
    }
  ];

  const failedChecks = validationChecks.filter(check => check.status !== "PASS");
  const validatorBytes = await readFile(new URL(import.meta.url));
  const receipt = {
    schemaVersion: 1,
    receiptKind: "task36-evidence-validation-receipt",
    generatedAt: new Date().toISOString(),
    targetManifest: {
      path: manifestPath,
      bytes: storedManifestBytes.length,
      sha256: sha256(storedManifestBytes)
    },
    inventorySha256: storedManifest.inventory.inventorySha256,
    validator: {
      scriptPath: path.relative(workspaceRoot, new URL(import.meta.url).pathname),
      scriptSha256: sha256(validatorBytes),
      argv: ["node", path.relative(workspaceRoot, new URL(import.meta.url).pathname)],
      exitCode: failedChecks.length === 0 ? 0 : 1
    },
    checks: validationChecks,
    result: failedChecks.length === 0 ? "PASS" : "FAIL"
  };
  await atomicJson(receiptPath, receipt);

  assert(failedChecks.length === 0, `final evidence validation failed: ${failedChecks.map(check => check.id).join(", ")}`);
  process.stdout.write(`${JSON.stringify({
    manifest: manifestPath,
    manifestSha256: receipt.targetManifest.sha256,
    inventorySha256: receipt.inventorySha256,
    inventoryFiles: storedManifest.inventory.fileCount,
    inventoryBytes: storedManifest.inventory.totalBytes,
    receipt: receiptPath,
    checks: validationChecks.length,
    result: receipt.result
  }, null, 2)}\n`);
}

await main();
