#!/usr/bin/env node
// input: Frozen jin-commit-tasks JSON plus a pin checkout.
// output: golden/*.scenarios.jsonl derived from commit diffs. No hand-picked scenes.
// pos: Harvest G1. Same keep rules as generate-commit-tasks.mjs. Holdout is not inspected after freeze.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MIN_JAVA_FILES, sha256, splitTrainHoldout } from "./generate-commit-tasks.mjs";
import { auditMustHit, buildA1RepoContext } from "./audit-golden-quality.mjs";

export const G1_SCHEMA = "g1-golden-scenarios/v1";
export const G1_MAX_SCENARIOS = 40;
export const G1_MIN_SCENARIOS = 20;
export const G1_MIN_HOLDOUT = 6;
export const G1_HOLDOUT_RATIO = 0.3;
export const G1_QUALITY_THIN_OR_NOISE = 0.3;
export const PIN_RUOYI = "2bbe79b34ab8c9c7b0148300599dc8d4881c8db1";

export function isGeneratedNoisePath(relative) {
  const normalized = String(relative ?? "").replaceAll("\\", "/");
  return normalized.includes("/generated/")
    || normalized.includes("/generated-sources/")
    || normalized.includes("/target/")
    || normalized.startsWith("target/");
}

export function collectCommitTasks(payload) {
  return [...(payload?.train ?? []), ...(payload?.holdout ?? [])];
}

function posix(relative) {
  return String(relative ?? "").replaceAll("\\", "/");
}

function isJavaPath(relative) {
  return posix(relative).endsWith(".java");
}

export function javaFilesFromTask(task) {
  return (task?.files ?? []).filter(file => {
    if (!isJavaPath(file?.path)) return false;
    if (file.status === "delete") return false;
    return true;
  });
}

export function fileExistsAtPin(repoRoot, relative) {
  if (!repoRoot || !relative || path.isAbsolute(relative) || posix(relative).split("/").includes("..")) return false;
  return existsSync(path.join(repoRoot, relative));
}

function lineCount(repoRoot, relative) {
  try {
    return readFileSync(path.join(repoRoot, relative), "utf8").split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function livingMethods(file, lines) {
  return (file.methods ?? []).filter(method => {
    if (method?.deleted) return false;
    const start = Number(method?.range?.start?.line);
    const end = Number(method?.range?.end?.line);
    return Number.isInteger(start) && start >= 1 && start <= lines
      && Number.isInteger(end) && end >= start && end <= lines;
  });
}

function focusModule(relative) {
  const first = posix(relative).split("/")[0];
  return first && first !== "src" ? first : undefined;
}

function inferLayoutProfile(project) {
  if (project === "ruoyi-vue-pro" || project === "exam-parent-v3") return "maven-reactor";
  if (project === "cipherlink" || project === "lishuedu") return "ddd-gradle";
  return "generic-java";
}

export function deriveEligibleTasks(payload, repoRoot) {
  const eligible = [];
  let droppedMissing = 0;
  let droppedThin = 0;
  let droppedNoise = 0;
  for (const task of collectCommitTasks(payload)) {
    const declared = javaFilesFromTask(task);
    if (declared.some(file => isGeneratedNoisePath(file.path))) {
      droppedNoise += 1;
      continue;
    }
    const java = declared.filter(file => fileExistsAtPin(repoRoot, file.path));
    if (java.length < MIN_JAVA_FILES) {
      if (declared.length >= MIN_JAVA_FILES) droppedMissing += 1;
      else droppedThin += 1;
      continue;
    }
    eligible.push({ task, java });
  }
  eligible.sort((left, right) => (left.task.timestamp ?? 0) - (right.task.timestamp ?? 0));
  return { eligible, droppedMissing, droppedThin, droppedNoise };
}

export function truncateEligible(eligible, max = G1_MAX_SCENARIOS) {
  if (eligible.length <= max) return eligible;
  return eligible.slice(-max);
}

function scenarioFromTask(task, java, repoCommit, project, layoutProfile) {
  const anchorFile = java.find(file => livingMethods(file, Number.MAX_SAFE_INTEGER).length > 0) ?? java[0];
  const methods = livingMethods(anchorFile, Number.MAX_SAFE_INTEGER);
  const anchorMethod = methods[0];
  const mustHit = java.map(file => posix(file.path));
  const mustReadRanges = {};
  const coordinateRanges = [];
  for (const file of java) {
    const fileLines = livingMethods(file, Number.MAX_SAFE_INTEGER);
    if (fileLines.length === 0) continue;
    mustReadRanges[posix(file.path)] = fileLines.map(method => ({
      startLine: method.range.start.line,
      endLine: method.range.end.line
    }));
    for (const method of fileLines) {
      coordinateRanges.push({
        file: posix(file.path),
        start: { line: method.range.start.line, column: method.range.start.column || 1 },
        end: { line: method.range.end.line, column: (method.range.end.column || 1) + 1 }
      });
    }
  }
  const module = focusModule(anchorFile.path);
  return {
    id: `${project}-${String(task.commit).slice(0, 16)}`,
    name: String(task.task ?? task.commit),
    projectId: project,
    layoutProfile,
    scenarioVersion: 1,
    warmState: "cold-nolsp",
    anchor: {
      file: posix(anchorFile.path),
      line: anchorMethod?.range?.start?.line || 1,
      column: anchorMethod?.range?.start?.column || 1,
      profile: "auto",
      ...(module ? { focusModules: [module] } : {}),
      taskKeywords: []
    },
    golden: {
      mustHit,
      taskBlocking: [],
      shouldHit: [],
      support: [],
      ...(Object.keys(mustReadRanges).length > 0 ? { mustReadRanges } : {}),
      ...(coordinateRanges.length > 0 ? { mustReadCoordinateRangesV2: coordinateRanges } : {})
    },
    repoCommit,
    evaluationSplit: "tuning",
    sourceCommit: task.commit,
    timestamp: task.timestamp
  };
}

function clampRangesToPin(scenario, repoRoot) {
  const linesByFile = new Map();
  const linesOf = relative => {
    if (!linesByFile.has(relative)) linesByFile.set(relative, lineCount(repoRoot, relative));
    return linesByFile.get(relative);
  };
  const anchorLines = linesOf(scenario.anchor.file);
  if (scenario.anchor.line > anchorLines) {
    scenario.anchor.line = 1;
    scenario.anchor.column = 1;
  }
  const ranges = scenario.golden.mustReadRanges;
  if (ranges) {
    for (const [file, items] of Object.entries(ranges)) {
      const total = linesOf(file);
      ranges[file] = items.filter(range => range.startLine <= total && range.endLine <= total);
      if (ranges[file].length === 0) delete ranges[file];
    }
    if (Object.keys(ranges).length === 0) delete scenario.golden.mustReadRanges;
  }
  if (Array.isArray(scenario.golden.mustReadCoordinateRangesV2)) {
    scenario.golden.mustReadCoordinateRangesV2 = scenario.golden.mustReadCoordinateRangesV2.filter(range => {
      const total = linesOf(range.file);
      return range.start.line <= total && range.end.line <= total;
    });
    if (scenario.golden.mustReadCoordinateRangesV2.length === 0) delete scenario.golden.mustReadCoordinateRangesV2;
  }
  return scenario;
}

export function qualityReport(scenarios) {
  const thin = scenarios.filter(row => (row.golden?.mustHit ?? []).length < MIN_JAVA_FILES).length;
  const noise = scenarios.filter(row => (row.golden?.mustHit ?? []).some(isGeneratedNoisePath)).length;
  const n = scenarios.length;
  const rate = n === 0 ? 1 : (thin + noise) / n;
  return {
    n,
    thinMustHit: thin,
    generatedNoise: noise,
    thinOrNoiseRate: rate,
    holdout: scenarios.filter(row => row.evaluationSplit === "holdout").length,
    tuning: scenarios.filter(row => row.evaluationSplit === "tuning").length,
    failed: n < G1_MIN_SCENARIOS || scenarios.filter(row => row.evaluationSplit === "holdout").length < G1_MIN_HOLDOUT || rate > G1_QUALITY_THIN_OR_NOISE
  };
}

export function generateGoldenScenarios(payload, repoRoot, options = {}) {
  const project = options.project ?? payload.project;
  const repoCommit = options.repoCommit ?? payload.head;
  const layoutProfile = options.layoutProfile ?? inferLayoutProfile(project);
  const derived = deriveEligibleTasks(payload, repoRoot);
  let pool = derived.eligible;
  let droppedA1Noisy = 0;
  if (options.a1NeutralFilter) {
    const repoContext = options.a1FilterContext ?? buildA1RepoContext(repoRoot);
    const passing = [];
    for (const item of pool) {
      const scenario = scenarioFromTask(item.task, item.java, repoCommit, project, layoutProfile);
      const labeled = auditMustHit(item.java.map(file => file.path), {
        ...repoContext.contextForTask(item.task),
        anchorFile: scenario.anchor.file
      });
      if (labeled.noisy) {
        droppedA1Noisy += 1;
        continue;
      }
      passing.push(item);
    }
    pool = passing;
  }
  const selected = truncateEligible(pool, options.maxScenarios ?? G1_MAX_SCENARIOS);
  const split = splitTrainHoldout(selected.map(item => item.task), options.holdoutRatio ?? G1_HOLDOUT_RATIO);
  const holdoutCommits = new Set(split.holdout.map(task => task.commit));
  const scenarios = selected.map(({ task, java }) => {
    const scenario = clampRangesToPin(
      scenarioFromTask(task, java, repoCommit, project, layoutProfile),
      repoRoot
    );
    scenario.evaluationSplit = holdoutCommits.has(task.commit) ? "holdout" : "tuning";
    return scenario;
  });
  scenarios.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
  const quality = qualityReport(scenarios);
  return {
    schemaVersion: G1_SCHEMA,
    project,
    repoCommit,
    layoutProfile,
    dropped: {
      missingAtPin: derived.droppedMissing,
      thin: derived.droppedThin,
      generatedNoise: derived.droppedNoise,
      a1Noisy: droppedA1Noisy
    },
    eligible: derived.eligible.length,
    filterPassed: pool.length,
    selected: selected.length,
    scenarios,
    quality,
    decision: options.a1NeutralFilter && pool.length < G1_MIN_SCENARIOS
      ? "A2b"
      : quality.failed ? "G1_QUALITY_FAIL" : "GO"
  };
}

export function scenariosToJsonl(scenarios) {
  return `${scenarios.map(row => JSON.stringify({
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    layoutProfile: row.layoutProfile,
    scenarioVersion: row.scenarioVersion,
    warmState: row.warmState,
    anchor: row.anchor,
    golden: row.golden,
    repoCommit: row.repoCommit,
    evaluationSplit: row.evaluationSplit
  })).join("\n")}\n`;
}

export function smokeGoldenScenarios(scenarios, repoRoot, { skipHoldout = false } = {}) {
  const missing = [];
  for (const row of scenarios) {
    if (skipHoldout && row.evaluationSplit === "holdout") continue;
    if (!fileExistsAtPin(repoRoot, row.anchor?.file)) missing.push("anchor");
    for (const file of row.golden?.mustHit ?? []) {
      if (!fileExistsAtPin(repoRoot, file)) missing.push("mustHit");
    }
  }
  return {
    loaded: scenarios.length,
    missingFiles: missing.length,
    passed: scenarios.length > 0 && missing.length === 0
  };
}

function parseCli(args) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (key === "--a1-neutral-filter") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: false,
    tasks: options.get("--tasks"),
    repo: options.get("--repo"),
    output: options.get("--output"),
    manifest: options.get("--manifest"),
    layoutProfile: options.get("--layout-profile"),
    a1NeutralFilter: flags.has("--a1-neutral-filter")
  };
}

export function g1Manifest(result, extra = {}) {
  return {
    schemaVersion: "g-g1-golden-manifest/v1",
    dated: extra.dated ?? new Date().toISOString().slice(0, 10),
    project: result.project,
    pin: result.repoCommit,
    checkout: extra.checkout ?? null,
    commitTasks: extra.commitTasks ?? null,
    jsonl: extra.jsonl ?? null,
    jsonlSha256: extra.jsonlSha256 ?? null,
    generator: {
      source: "scripts/generate-commit-tasks.mjs",
      holdoutRatio: G1_HOLDOUT_RATIO,
      maxScenarios: G1_MAX_SCENARIOS,
      minScenarios: G1_MIN_SCENARIOS,
      minHoldout: G1_MIN_HOLDOUT,
      split: "time-ordered-splitTrainHoldout",
      layoutProfile: result.layoutProfile,
      handPicked: false,
      a1NeutralFilter: extra.a1NeutralFilter === true,
      a1RuleVersion: extra.a1NeutralFilter ? "a1-noisy-rules/v1" : null
    },
    counts: {
      eligible: result.eligible,
      filterPassed: result.filterPassed ?? result.selected,
      selected: result.selected,
      scenarios: result.scenarios.length,
      tuning: result.quality.tuning,
      holdout: result.quality.holdout,
      droppedMissingAtPin: result.dropped.missingAtPin,
      droppedThin: result.dropped.thin,
      droppedNoise: result.dropped.generatedNoise,
      droppedA1Noisy: result.dropped.a1Noisy ?? 0
    },
    quality: {
      thinMustHit: result.quality.thinMustHit,
      generatedNoise: result.quality.generatedNoise,
      thinOrNoiseRate: result.quality.thinOrNoiseRate,
      gate: G1_QUALITY_THIN_OR_NOISE,
      decision: result.decision
    },
    smoke: extra.smoke ?? null,
    note: "Holdout gold is frozen. Do not inspect holdout mustHit or retune from it."
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/generate-golden-scenarios.mjs --tasks <json> --repo <pin> --output <jsonl> [--manifest <json>]");
    return;
  }
  if (!cli.tasks || !cli.repo || !cli.output) throw new Error("--tasks, --repo, and --output are required");
  const payload = JSON.parse(await readFile(path.resolve(cli.tasks), "utf8"));
  const result = generateGoldenScenarios(payload, path.resolve(cli.repo), {
    layoutProfile: cli.layoutProfile,
    a1NeutralFilter: cli.a1NeutralFilter
  });
  const text = scenariosToJsonl(result.scenarios);
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, text);
  const smoke = smokeGoldenScenarios(result.scenarios, path.resolve(cli.repo), {
    skipHoldout: cli.a1NeutralFilter
  });
  const manifest = g1Manifest(result, {
    checkout: path.resolve(cli.repo),
    commitTasks: path.resolve(cli.tasks),
    jsonl: path.resolve(cli.output),
    jsonlSha256: sha256(text),
    smoke,
    a1NeutralFilter: cli.a1NeutralFilter
  });
  if (cli.manifest) {
    await mkdir(path.dirname(path.resolve(cli.manifest)), { recursive: true });
    await writeFile(cli.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    decision: result.decision,
    scenarios: result.scenarios.length,
    holdout: result.quality.holdout,
    jsonlSha256: manifest.jsonlSha256,
    smoke,
    quality: result.quality
  }));
  if (result.decision !== "GO" || !smoke.passed) process.exitCode = 2;
}

const isMain = process.argv[1] && path.normalize(process.argv[1]).endsWith("generate-golden-scenarios.mjs");
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
