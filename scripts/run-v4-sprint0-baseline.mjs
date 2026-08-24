#!/usr/bin/env node
// input: Three frozen golden Java repos plus a quiet host.
// output: Command plan and optional Sprint0' campaign execution; git only receives hashed summaries.
// pos: V4-03 orchestrator. It never writes into the active LSP checkout caches.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertHostQuiet, inspectHostQuiet } from "./host-quiet.mjs";
import {
  V4_SPRINT0_IDENTITY_COMMIT,
  V4_SPRINT0_PRODUCTION_TREE,
  V4_SPRINT0_SCHEMA_VERSION,
  V4_SPRINT0_VERIFIER_VERSION
} from "./verify-v4-sprint0-baseline.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const V4_SPRINT0_PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
export const FIRST_TOUCH_ANCHORS = {
  cipherlink: {
    file: "modules/organization/src/main/java/com/hhtele/cipherlink/organization/application/DefaultOrganizationAppService.java",
    line: 693,
    column: 23
  },
  lishuedu: {
    file: "modules/iam/src/main/java/com/lishu/edu/iam/application/service/InternalUserAppServiceImpl.java",
    line: 37,
    column: 14
  },
  "exam-parent-v3": {
    file: "exam-service/exam-service-candidate/src/main/java/com/hhtele/exam/service/candidate/impl/OrgServiceImpl.java",
    line: 26,
    column: 14
  }
};

export function defaultJdtJavaHome(home = os.homedir()) {
  const candidates = [
    process.env.JDTLS_JAVA_HOME,
    path.join(home, ".sdkman/candidates/java/21.0.10-tem"),
    path.join(home, ".sdkman/candidates/java/21.0.10-amzn"),
    "/opt/homebrew/opt/openjdk@21"
  ];
  return candidates.find(value => value && existsSync(value)) ?? "";
}

export function defaultProjectJavaHome(home = os.homedir()) {
  const candidates = [
    process.env.JAVA_LSP_PROJECT_JAVA_HOME,
    path.join(home, ".sdkman/candidates/java/25.0.1-open"),
    path.join(home, ".sdkman/candidates/java/current")
  ];
  return candidates.find(value => value && existsSync(value)) ?? "";
}

export function defaultRepoCandidates(home = os.homedir()) {
  return {
    lishuedu: [
      "/tmp/codex-java-v3-golden-20260809/lishuedu",
      "/tmp/frozen-java-repos/lishuedu",
      path.join(home, "Documents/program/lishu/lishuedu")
    ],
    cipherlink: [
      "/tmp/codex-java-v3-golden-20260809/cipherlink",
      "/tmp/frozen-java-repos/cipherlink",
      path.join(home, "Documents/program/cipherlink")
    ],
    "exam-parent-v3": [
      "/tmp/codex-java-v3-golden-20260809/exam-parent-v3",
      "/tmp/frozen-java-repos/exam-parent-v3",
      path.join(home, "Documents/program/exam-parent-v3")
    ]
  };
}

export function loadFrozenRepoCommits(scenarioLock = path.join(scriptRoot, "golden", "progressive-index-v1.json")) {
  const document = JSON.parse(readFileSync(scenarioLock, "utf8"));
  if (document?.schemaVersion !== 1 || !Array.isArray(document.scenarios)) {
    throw new Error(`invalid progressive scenario lock: ${scenarioLock}`);
  }
  return Object.fromEntries(document.scenarios.map(scenario => [scenario.projectId, scenario.repoCommit]));
}

export function parseSprint0Cli(args, env = process.env) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "--dry-run") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  const stage = options.get("--stage") ?? "all";
  if (!["all", "cold-matrix", "bytes", "progressive", "first-touch"].includes(stage)) {
    throw new Error(`unsupported --stage ${stage}`);
  }
  return {
    help: flags.has("--help"),
    dryRun: flags.has("--dry-run"),
    stage,
    baseline: options.get("--baseline") ?? V4_SPRINT0_IDENTITY_COMMIT,
    outputDir: options.get("--output-dir"),
    docsDir: options.get("--docs-dir") ?? path.join(scriptRoot, "docs", "phase-v4"),
    candidateRoot: options.get("--candidate-root") ?? scriptRoot,
    repositories: {
      lishuedu: options.get("--lishuedu") || env.LISHUEDU_ROOT,
      cipherlink: options.get("--cipherlink") || env.CIPHERLINK_ROOT,
      "exam-parent-v3": options.get("--exam-parent-v3") || env.EXAM_PARENT_V3_ROOT
    }
  };
}

export async function resolveSprint0Repositories({
  repositories = {},
  candidates = defaultRepoCandidates(),
  expectedCommits = loadFrozenRepoCommits(),
  git = readGitHead
} = {}) {
  const resolved = {};
  const notes = [];
  for (const project of V4_SPRINT0_PROJECTS) {
    const expected = expectedCommits[project];
    if (!/^[a-f0-9]{40}$/.test(expected ?? "")) {
      throw new Error(`${project}: progressive lock is missing a frozen commit`);
    }
    const search = [repositories[project], ...(candidates[project] ?? [])].filter(Boolean);
    let match;
    for (const repoRoot of search) {
      if (!existsSync(repoRoot)) {
        notes.push(`${project}: missing ${repoRoot}`);
        continue;
      }
      const head = await git(repoRoot);
      if (head === expected) {
        match = { project, repoRoot: path.resolve(repoRoot), head };
        break;
      }
      notes.push(`${project}: ${repoRoot} is at ${head}, expected ${expected}`);
    }
    if (!match) {
      throw new Error(
        `${project}: no frozen checkout at ${expected}. Create one with:\n`
        + `  git -C <source> worktree add /tmp/frozen-java-repos/${project} ${expected}\n`
        + notes.join("\n")
      );
    }
    resolved[project] = match;
  }
  return resolved;
}

export function buildSprint0CommandPlan({
  repositories,
  outputDir,
  baseline = V4_SPRINT0_IDENTITY_COMMIT,
  candidateRoot = scriptRoot,
  jdtlsBin = process.env.JDTLS_BIN ?? "/opt/homebrew/bin/jdtls",
  jdtJavaHome = process.env.JDTLS_JAVA_HOME ?? defaultJdtJavaHome(),
  projectJavaHome = process.env.JAVA_LSP_PROJECT_JAVA_HOME ?? defaultProjectJavaHome(),
  runs = 5
}) {
  const isolatedNode = ["sh", path.join(candidateRoot, "scripts", "run-isolated-node.sh")];
  const repoFlags = [
    "--lishuedu", repositories.lishuedu.repoRoot,
    "--cipherlink", repositories.cipherlink.repoRoot,
    "--exam-parent-v3", repositories["exam-parent-v3"].repoRoot
  ];
  return {
    "cold-matrix": {
      argv: [
        ...isolatedNode,
        path.join(candidateRoot, "scripts", "run-three-repo-cold-matrix.mjs"),
        "--baseline", baseline,
        ...repoFlags,
        "--output-dir", path.join(outputDir, "cold-matrix"),
        "--runs", String(runs)
      ]
    },
    bytes: {
      argvByProject: Object.fromEntries(V4_SPRINT0_PROJECTS.map(project => [project, [
        ...isolatedNode,
        path.join(candidateRoot, "scripts", "run-isolated-validation.mjs"),
        "--profile", "targeted",
        "--",
        "node", "scripts/run-isolated-jdt-benchmark.mjs",
        "--repo-root", repositories[project].repoRoot,
        "--revision", repositories[project].head,
        "--",
        "node", "scripts/attribute-impact-payload.mjs",
        "--repo-root", "{repo}",
        "--project-id", project,
        "--mode", "balanced",
        "--index-cache-dir", "{state}/index"
      ]]))
    },
    progressive: {
      argv: [
        ...isolatedNode,
        path.join(candidateRoot, "scripts", "run-isolated-validation.mjs"),
        "--profile", "compile",
        "--keep",
        "--",
        "node", "scripts/run-progressive-index-three-repo.mjs",
        ...repoFlags,
        "--output-dir", "{state}/progressive",
        "--runs", String(runs)
      ]
    },
    "first-touch": {
      argvByProject: Object.fromEntries(V4_SPRINT0_PROJECTS.map(project => {
        const anchor = FIRST_TOUCH_ANCHORS[project];
        return [project, [
          ...isolatedNode,
          path.join(candidateRoot, "scripts", "run-isolated-validation.mjs"),
          "--profile", "compile",
          "--keep",
          "--env", `JDTLS_BIN=${jdtlsBin}`,
          ...(jdtJavaHome ? ["--env", `JDTLS_JAVA_HOME=${jdtJavaHome}`] : []),
          ...(projectJavaHome ? ["--env", `JAVA_HOME=${projectJavaHome}`, "--env", `JAVA_LSP_PROJECT_JAVA_HOME=${projectJavaHome}`] : []),
          "--env", `JAVA_LSP_BENCH_ANCHOR_FILE=${anchor.file}`,
          "--env", `JAVA_LSP_BENCH_ANCHOR_LINE=${String(anchor.line)}`,
          "--env", `JAVA_LSP_BENCH_ANCHOR_COLUMN=${String(anchor.column)}`,
          "--",
          "node", "scripts/run-isolated-jdt-benchmark.mjs",
          "--keep",
          "--repo-root", repositories[project].repoRoot,
          "--revision", repositories[project].head,
          "--",
          "node", "dist/benchmark/semantic-first-touch.js",
          "--repo-root", "{repo}",
          "--project-id", project,
          "--workspace-state", "fresh",
          "--operation", "references",
          "--prepare", "none",
          "--runs", String(runs),
          "--timeout-ms", "60000"
        ]];
      }))
    }
  };
}

export function descriptorForBytes(file, bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length <= 0) throw new Error(`${file}: refusing to record a zero-byte Sprint0' artifact`);
  return {
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export function extractTrailingJson(text) {
  let last;
  for (let index = 0; index < text.length; ) {
    const start = text.indexOf("{", index);
    if (start < 0) break;
    const sliced = sliceBalancedJsonObject(text, start);
    if (!sliced) {
      index = start + 1;
      continue;
    }
    last = JSON.parse(sliced.value);
    index = sliced.end;
  }
  if (last === undefined) throw new Error("artifact does not contain a trailing JSON object");
  return last;
}

function sliceBalancedJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { value: text.slice(start, index + 1), end: index + 1 };
    }
  }
  return undefined;
}

export async function writeSprint0DocsManifest(plan) {
  const docsDir = plan.docsDir;
  const summaryDir = path.join(docsDir, "v4-sprint0-summaries");
  await mkdir(summaryDir, { recursive: true });
  const campaigns = {
    "cold-matrix": await writeCampaignSummary(summaryDir, "cold-matrix.json", await readRequiredJson(
      path.join(plan.outputDir, "cold-matrix", "matrix-summary.json")
    ), [path.join(plan.outputDir, "cold-matrix", "run-manifest.json")]),
    bytes: await writeCampaignSummary(summaryDir, "bytes.json", {
      projects: Object.fromEntries(await Promise.all(V4_SPRINT0_PROJECTS.map(async project => [
        project,
        extractTrailingJson(await readFile(path.join(plan.outputDir, `bytes-${project}.stdout.log`), "utf8"))
      ])))
    }, V4_SPRINT0_PROJECTS.map(project => path.join(plan.outputDir, `bytes-${project}.stdout.log`))),
    progressive: await writeCampaignSummary(summaryDir, "progressive.json", await readRequiredJson(
      path.join(plan.outputDir, "progressive", "progressive-summary.json")
    ), [path.join(plan.outputDir, "progressive", "progressive-manifest.json")]),
    "first-touch": {
      ...await writeCampaignSummary(summaryDir, "first-touch.json", {
        hostQuiet: plan.hostQuiet,
        projects: Object.fromEntries(await Promise.all(V4_SPRINT0_PROJECTS.map(async project => [
          project,
          extractTrailingJson(await readFile(path.join(plan.outputDir, `first-touch-${project}.stdout.log`), "utf8"))
        ])))
      }, V4_SPRINT0_PROJECTS.map(project => path.join(plan.outputDir, `first-touch-${project}.stdout.log`))),
      hostQuiet: plan.hostQuiet
    }
  };
  const manifest = {
    schemaVersion: V4_SPRINT0_SCHEMA_VERSION,
    verifierVersion: V4_SPRINT0_VERIFIER_VERSION,
    identity: plan.identity,
    campaigns
  };
  const manifestFile = path.join(docsDir, "v4-sprint0-manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestFile;
}

async function writeCampaignSummary(summaryDir, name, payload, rawFiles) {
  const relative = path.join("v4-sprint0-summaries", name);
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(path.join(summaryDir, name), contents);
  return {
    summaries: [descriptorForBytes(relative, contents)],
    rawArtifacts: rawFiles
      .filter(file => existsSync(file))
      .map(file => descriptorForBytes(file, readFileSync(file)))
  };
}

async function readRequiredJson(file) {
  if (!existsSync(file)) throw new Error(`missing Sprint0' summary: ${file}`);
  const bytes = readFileSync(file);
  if (bytes.length <= 0) throw new Error(`${file}: refusing to record a zero-byte Sprint0' artifact`);
  return JSON.parse(bytes.toString("utf8"));
}

export async function planV4Sprint0Baseline(cli, helpers = {}) {
  if (!cli.outputDir) throw new Error("--output-dir is required and must sit outside the source checkout");
  const outputDir = path.resolve(cli.outputDir);
  if (isWithin(path.resolve(cli.candidateRoot), outputDir)) {
    throw new Error("Sprint0' --output-dir must be outside the candidate source checkout");
  }
  const hostQuiet = cli.dryRun
    ? (helpers.inspectHostQuiet ?? inspectHostQuiet)()
    : (helpers.assertHostQuiet ?? assertHostQuiet)();
  const repositories = await (helpers.resolveRepositories ?? resolveSprint0Repositories)({
    repositories: cli.repositories
  });
  const commands = buildSprint0CommandPlan({
    repositories,
    outputDir,
    baseline: cli.baseline,
    candidateRoot: cli.candidateRoot
  });
  return {
    schemaVersion: V4_SPRINT0_SCHEMA_VERSION,
    verifierVersion: V4_SPRINT0_VERIFIER_VERSION,
    dryRun: cli.dryRun === true,
    stage: cli.stage,
    identity: {
      commit: V4_SPRINT0_IDENTITY_COMMIT,
      productionTree: V4_SPRINT0_PRODUCTION_TREE,
      measuredCommit: helpers.measuredCommit ?? null
    },
    hostQuiet,
    repositories,
    candidateRoot: path.resolve(cli.candidateRoot),
    outputDir,
    docsDir: path.resolve(cli.docsDir),
    commands
  };
}

async function main(args = process.argv.slice(2)) {
  const cli = parseSprint0Cli(args);
  if (cli.help) return printUsage();
  const measuredCommit = await readGitHead(cli.candidateRoot);
  const plan = await planV4Sprint0Baseline(cli, { measuredCommit });
  if (cli.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  await mkdir(plan.outputDir, { recursive: true });
  await writeFile(path.join(plan.outputDir, "run-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  const stages = cli.stage === "all" ? ["cold-matrix", "bytes", "progressive", "first-touch"] : [cli.stage];
  for (const stage of stages) {
    if (stage === "first-touch" || stage === "cold-matrix" || stage === "progressive") {
      assertHostQuiet();
    }
    await executeStage(stage, plan);
  }
  if (sprint0ArtifactsReady(plan.outputDir)) await writeSprint0DocsManifest(plan);
  return plan;
}

export function sprint0ArtifactsReady(outputDir) {
  return [
    path.join(outputDir, "cold-matrix", "matrix-summary.json"),
    path.join(outputDir, "progressive", "progressive-summary.json"),
    ...V4_SPRINT0_PROJECTS.flatMap(project => [
      path.join(outputDir, `bytes-${project}.stdout.log`),
      path.join(outputDir, `first-touch-${project}.stdout.log`)
    ])
  ].every(file => existsSync(file) && readFileSync(file).length > 0);
}

export function assertRealJdtlsBin(jdtlsBin = process.env.JDTLS_BIN ?? "/opt/homebrew/bin/jdtls") {
  if (!jdtlsBin || path.basename(jdtlsBin) === "false") {
    throw new Error("first-touch requires a real JDTLS_BIN; /usr/bin/false is only for compile-only isolation");
  }
  return jdtlsBin;
}

async function executeStage(stage, plan) {
  const command = plan.commands[stage];
  if (stage === "first-touch") assertRealJdtlsBin();
  if (command.argv) {
    if (stage === "cold-matrix") {
      // Quality-gate FAIL is the Sprint0' denominator, not a crash.
      await runInherited(command.argv, plan.candidateRoot ?? scriptRoot, { allowedExitCodes: [0, 1] });
      return;
    }
    if (stage === "progressive") {
      const stdoutFile = path.join(plan.outputDir, "progressive.stdout.log");
      await runCaptured(command.argv, plan.candidateRoot ?? scriptRoot, stdoutFile);
      await collectKeptProgressiveOutput(stdoutFile, path.join(plan.outputDir, "progressive"));
      return;
    }
    await runInherited(command.argv, plan.candidateRoot ?? scriptRoot);
    return;
  }
  for (const [project, argv] of Object.entries(command.argvByProject)) {
    const stdoutFile = path.join(plan.outputDir, `${stage}-${project}.stdout.log`);
    console.log(`v4-sprint0: ${stage} ${project}`);
    await runCaptured(argv, scriptRoot, stdoutFile);
  }
}

async function collectKeptProgressiveOutput(stdoutFile, dest) {
  const text = await readFile(stdoutFile, "utf8");
  const match = text.match(/preserved isolated validation root: (.+)/);
  if (!match) throw new Error("progressive isolation root was not preserved");
  const source = path.join(match[1].trim(), "progressive");
  if (!existsSync(source)) throw new Error(`missing progressive output: ${source}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, { recursive: true, errorOnExist: true });
}

function runInherited(argv, cwd, { allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => allowedExitCodes.includes(code)
      ? resolve()
      : reject(new Error(`${argv.join(" ")} exited ${code}`)));
  });
}

function runCaptured(argv, cwd, stdoutFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
    const chunks = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", async code => {
      const bytes = Buffer.concat(chunks);
      try {
        await mkdir(path.dirname(stdoutFile), { recursive: true });
        await writeFile(stdoutFile, bytes);
      } catch (error) {
        reject(error);
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${argv.join(" ")} exited ${code}; see ${stdoutFile}`));
    });
  });
}

async function readGitHead(repoRoot) {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repoRoot, "rev-parse", "HEAD^{commit}"], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", code => {
      if (code !== 0) {
        reject(new Error(`git -C ${repoRoot} rev-parse failed: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function printUsage() {
  console.log(`usage: node scripts/run-v4-sprint0-baseline.mjs \\
  --output-dir <dir-outside-checkout> [--dry-run] [--stage all|cold-matrix|bytes|progressive|first-touch] \\
  [--lishuedu <repo>] [--cipherlink <repo>] [--exam-parent-v3 <repo>]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
