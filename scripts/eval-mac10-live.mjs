// input: a verified MAC-10 dataset (ilv2-mac-eval-dataset.mjs), one split's tasks and gold parts, the frozen
//        inputs record of each corpus and, for repair tasks, the frozen JDK.
// output: evaluate-java-task rows (tasks, gold), corpora materialized like the retrieval runner does (frozen tree,
//         repair pre-state overlays, hidden tests removed, hashes checked), the public answer contract taken from
//         the dataset's own agent-visible part, and a repair judge backed by the MAC-10 oracle.
// pos: post-ILV2 Q10 LIVE adapter (docs/post-ilv2/decisions.md D10). Gold, oracles and curation stay on the
//      evaluator side: only the task prompt, its anchors and the answer slots reach the model.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execute, readJson, requireValue, sha256 } from "./ilv2-mac-contracts.mjs";
import { ANSWER_CONTRACT_SCHEMA, GOLD_SCHEMA, ORACLE_SCHEMA, TASK_SCHEMA, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus } from "./ilv2-mac-retrieval-eval.mjs";
import { ORACLE_STATE, evaluateOracle, javaIdentity } from "./ilv2-mac-repair-oracle.mjs";
import { diffCandidateTrees } from "./eval-repair-adapter.mjs";
import { buildSubmitAnswerTool } from "./eval-answer-contract.mjs";

export const MAC10_LIVE_ADAPTER = "mac10-live-adapter/v1";
export const PILOT_RULE = "per (corpus, category) stratum, tasks ordered by sha256(seed, stratum, taskId); strata ordered by sha256(seed, stratum); one task per stratum per round until the count is reached";

// MAC-10 slot type -> public submit_answer field. string-set is scored order-free (see scoreQaAnswer setKeys).
const SLOT_FIELDS = Object.freeze({
  string: () => ({ type: "string", minLength: 1, description: "Exact text." }),
  "string-set": () => ({ type: "array", items: { type: "string", minLength: 1 }, description: "JSON array of unique exact strings; order is not scored." }),
  boolean: () => ({ type: "boolean" }),
  integer: () => ({ type: "integer" })
});

export const isMac10TaskRow = row => row?.schema === TASK_SCHEMA;

/** Public answer keys and fields of one task's slots. */
export function mac10PublicFields(slots) {
  requireValue(slots && typeof slots === "object" && Object.keys(slots).length > 0, "answer slots required");
  const fields = {};
  for (const [name, slot] of Object.entries(slots)) {
    requireValue(Object.hasOwn(SLOT_FIELDS, slot?.type), `unsupported slot type ${slot?.type} for ${name}`);
    fields[name] = SLOT_FIELDS[slot.type]();
    // A curator's own slot description is part of the agent-visible contract; it goes before the type rule.
    if (typeof slot.description === "string" && slot.description.trim()) fields[name].description = `${slot.description.trim()} ${fields[name].description ?? ""}`.trim();
  }
  const answerKeys = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.type]));
  buildSubmitAnswerTool(answerKeys, fields);
  return { answerKeys, fields };
}

/** Parses --source-budget: "none", or LINES:BYTES applied to every QA task of every arm. */
export function parseSourceBudget(value) {
  requireValue(typeof value === "string", "--source-budget none|LINES:BYTES is required for MAC-10 runs (06 §6.4: the same budget on every arm)");
  if (value === "none") return null;
  const match = /^(\d+):(\d+)$/.exec(value);
  requireValue(match, "--source-budget must be none or LINES:BYTES");
  const budget = { max_lines: Number(match[1]), max_bytes: Number(match[2]) };
  requireValue(Number.isSafeInteger(budget.max_lines) && budget.max_lines > 0 && Number.isSafeInteger(budget.max_bytes) && budget.max_bytes > 0, "source budget must be positive");
  return budget;
}

/** The agent-visible task as an evaluate-java-task row. Anchors are agent-visible by dataset design (leaks()). */
export function toEvalTask(task, slots, sourceBudget = null, rules = null) {
  requireValue(isMac10TaskRow(task) && typeof task.taskId === "string" && typeof task.corpusId === "string", "MAC-10 task row required");
  const anchors = Array.isArray(task.anchors) && task.anchors.length > 0 ? `\nNamed anchors: ${task.anchors.map(anchor => `\`${anchor}\``).join(", ")}.` : "";
  const row = { id: task.taskId, schema: TASK_SCHEMA, corpus: task.corpusId, kind: task.kind, category: task.category, split: task.split, query: `${task.prompt}${anchors}` };
  if (task.kind === "qa") {
    const { answerKeys } = mac10PublicFields(slots);
    row.output_contract = { answer_keys: answerKeys };
    row.answerSlots = Object.fromEntries(Object.entries(slots).map(([name, slot]) => [name, slot.type]));
    // The dataset's agent-visible answer rules (answer-contract.json `rules`).
    if (typeof rules === "string" && rules.trim()) row.query += `\nAnswer rules: ${rules.trim()}`;
    if (sourceBudget) row.budget = { ...sourceBudget };
  }
  return row;
}

/** Evaluator-side gold: string-set values sorted, required evidence with the hash of the file it was verified on. */
export function toEvalGold(row, slots) {
  requireValue(row?.schema === GOLD_SCHEMA && Array.isArray(row.requiredEvidence), "MAC-10 gold row required");
  const out = { id: row.taskId, kind: row.kind,
    required_evidence: row.requiredEvidence.map(item => ({ path: item.path, start_line: item.startLine, end_line: item.endLine, file_sha256: item.fileSha256 })) };
  if (row.kind === "qa") {
    out.answer = Object.fromEntries(Object.entries(row.answer).map(([name, value]) => [name, slots?.[name]?.type === "string-set" ? [...value].sort() : value]));
  } else {
    out.repairOracle = row.repairOracle;
  }
  return out;
}

/** Deterministic stratified pilot; the gold is never read, so the choice cannot follow results (06 §6.6). */
export function selectPilot(tasks, { count, seed }) {
  requireValue(Number.isSafeInteger(count) && count >= 1 && count <= tasks.length, `--pilot must be 1..${tasks.length}`);
  requireValue(typeof seed === "string" && seed.length > 0, "--pilot-seed is required with --pilot");
  const hash = text => createHash("sha256").update(text).digest("hex");
  const strata = new Map();
  for (const task of tasks) {
    const key = `${task.corpus ?? task.corpusId ?? ""}/${task.category ?? "uncategorized"}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(task);
  }
  const ordered = [...strata].map(([key, members]) => ({ key, rank: hash(`${seed}\0${key}`),
    members: members.map(task => ({ task, rank: hash(`${seed}\0${key}\0${task.id}`) })).sort((a, b) => a.rank.localeCompare(b.rank)) }))
    .sort((a, b) => a.rank.localeCompare(b.rank));
  const chosen = new Set();
  for (let round = 0; chosen.size < count; round += 1) {
    for (const stratum of ordered) {
      if (chosen.size >= count) break;
      if (stratum.members[round]) chosen.add(stratum.members[round].task.id);
    }
  }
  return { tasks: tasks.filter(task => chosen.has(task.id)), identity: { count, seed, rule: PILOT_RULE, taskIds: [...chosen].sort() } };
}

/**
 * The frozen JDK of an ILV2 toolchains manifest: every listed file under javaHome (bin/java and bin/javac
 * required among them) must still hash to its frozen value. Drift fails closed.
 */
export async function frozenJdk(toolchainsFile) {
  requireValue(typeof toolchainsFile === "string" && toolchainsFile.length > 0, "repair tasks need the frozen JDK: set ILV2_TOOLCHAINS");
  const frozen = await readJson(toolchainsFile);
  const home = frozen?.javaHome;
  requireValue(typeof home === "string" && path.isAbsolute(home) && Array.isArray(frozen.files), "toolchains manifest has no javaHome or files");
  const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
  const jdkFiles = frozen.files.filter(entry => typeof entry?.path === "string" && entry.path.startsWith(prefix));
  for (const binary of ["bin/java", "bin/javac"]) {
    requireValue(jdkFiles.some(entry => entry.path === path.join(home, binary)), `toolchains manifest does not freeze ${binary}`);
  }
  for (const entry of jdkFiles) requireValue(sha256(await readFile(entry.path)) === entry.sha256, `frozen JDK drift: ${entry.path}`);
  return { javaHome: home, toolchainsSha256: sha256(await readFile(toolchainsFile)), frozenFiles: jdkFiles.length };
}

/**
 * The input repository must sit exactly at its frozen head with nothing untracked or ignored: materializeCorpus copies
 * the working tree, so build output (classes of the fix, of hidden tests) would otherwise reach the agent.
 */
export async function assertPristineInput(record, git = (args) => execute("git", ["--no-optional-locks", "-C", record.repoRoot, ...args], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" })) {
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  requireValue(head === record.head, `input ${record.name} is at ${head}, not its frozen head ${record.head}`);
  const dirty = (await git(["status", "--porcelain", "--ignored", "--untracked-files=all"])).stdout.split("\n").filter(Boolean);
  requireValue(dirty.length === 0, `input ${record.name} has untracked, ignored or modified files (${dirty.slice(0, 5).join("; ")}); materialize from a clean checkout of the frozen head`);
}

const VERDICT_STATE = Object.freeze({
  [ORACLE_STATE.PASS]: "VALIDATED_SUCCESS",
  [ORACLE_STATE.JUDGE_ERROR]: "JUDGE_ERROR"
});

/**
 * Loads one split for a LIVE (or dry) run. Fails closed on any identity mismatch: the tasks and gold must be the
 * same split's parts of the verified dataset, every corpus must match its frozen input, every oracle its hashes.
 */
export async function prepareMac10Live({ datasetFile, tasksFile, goldFile, inputsFile, outputDir, taskIds = null, toolchainsFile = null, sourceBudget = null,
  materialize = materializeCorpus, javaIdentityOf = javaIdentity, evaluate = evaluateOracle, checkInput = assertPristineInput }) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  const split = ["dev", "holdout"].find(name => manifest.parts[`tasks-${name}`]?.sha256 === sha256(tasksBytes));
  requireValue(split, "--tasks is not a tasks part of --dataset");
  requireValue(goldFile, "--gold is required for MAC-10 runs");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts[`gold-${split}`]?.sha256 === sha256(goldBytes), `--gold is not the ${split} gold of --dataset`);
  const contractPart = manifest.parts["answer-contract"];
  const contractBytes = await readFile(path.join(root, contractPart.file));
  const contract = JSON.parse(contractBytes);
  requireValue(contract.schema === ANSWER_CONTRACT_SCHEMA && contract.datasetId === manifest.datasetId, "answer contract does not belong to this dataset");
  const parse = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const wanted = taskIds ? new Set(taskIds) : null;
  const rows = parse(tasksBytes).filter(row => !wanted || wanted.has(row.taskId));
  requireValue(rows.length > 0 && (!wanted || rows.length === wanted.size), "selected tasks are not all in this split");
  const goldRows = new Map(parse(goldBytes).map(row => [row.taskId, row]));
  const tasks = [];
  const gold = new Map();
  const contractTasks = new Map();
  for (const row of rows) {
    requireValue(isMac10TaskRow(row) && row.split === split, `task ${row.taskId} is not a ${split} MAC-10 task`);
    const goldRow = goldRows.get(row.taskId);
    requireValue(goldRow && goldRow.kind === row.kind && goldRow.corpusId === row.corpusId, `task ${row.taskId} has no matching gold`);
    const slots = row.kind === "qa" ? contract.tasks?.[row.taskId]?.slots : undefined;
    requireValue(row.kind !== "qa" || slots, `task ${row.taskId} has no public answer slots`);
    tasks.push(toEvalTask(row, slots, sourceBudget, contract.rules));
    gold.set(row.taskId, toEvalGold(goldRow, slots));
    if (row.kind === "qa") contractTasks.set(row.taskId, mac10PublicFields(slots).fields);
  }
  const publicAnswerContract = { version: `${manifest.datasetId}/answer-contract`, sha256: contractPart.sha256, tasks: contractTasks };

  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputsBytes = await readFile(inputsFile);
  const inputs = new Map(JSON.parse(inputsBytes).map(record => [record.name, record]));
  const repoRoots = {};
  const corpora = {};
  for (const corpusId of [...new Set(tasks.map(task => task.corpus))].sort()) {
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(item => item.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    await checkInput(record);
    // Materialized from the frozen tree, never the raw repository: that holds the fixed code and the hidden tests.
    repoRoots[corpusId] = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(path.resolve(outputDir), "corpora", corpusId) });
    corpora[corpusId] = { head: corpus.head, inputManifestSha256: corpus.inputManifestSha256, overlays: corpus.overlays.length, hidden: (corpus.hidden ?? []).length };
  }

  const oracles = new Map();
  let java = null;
  let javaHome = null;
  const repairTasks = tasks.filter(task => task.kind === "repair");
  if (repairTasks.length > 0) {
    const jdk = await frozenJdk(toolchainsFile);
    javaHome = jdk.javaHome;
    java = { ...await javaIdentityOf(javaHome), toolchainsSha256: jdk.toolchainsSha256, frozenFiles: jdk.frozenFiles };
    for (const task of repairTasks) {
      const ref = gold.get(task.id).repairOracle;
      const oracle = await readJson(path.join(root, ref));
      requireValue(oracle.schema === ORACLE_SCHEMA && oracle.taskId === task.id && oracle.corpusId === task.corpus, `${task.id}: oracle does not belong to this task`);
      const oracleDir = path.join(root, path.dirname(ref));
      const testSource = await readFile(path.join(oracleDir, oracle.test), "utf8");
      requireValue(sha256(testSource) === oracle.testSha256, `${task.id}: oracle test changed`);
      const materialized = await readFile(path.join(repoRoots[task.corpus], oracle.file), "utf8");
      requireValue(sha256(materialized) === oracle.preStateSha256, `${task.id}: materialized corpus does not hold the broken pre-state`);
      oracles.set(task.id, { oracle, testSource });
    }
  }

  /** evaluate-java-task repairJudge: allowed edit is the oracle's file only; the oracle test never enters the candidate. */
  async function repairJudge({ taskId, candidateRoot, outputRoot }) {
    const entry = oracles.get(taskId);
    if (!entry) return { state: "JUDGE_ERROR", validatedSuccess: false, reason: `no oracle for ${taskId}` };
    const { oracle, testSource } = entry;
    await mkdir(outputRoot, { recursive: true });
    const policy = { judge: "mac10-oracle", allowedEdits: [oracle.file], oracleTestSha256: oracle.testSha256, javaSha256: java?.javaSha256 ?? null };
    let verdict;
    try {
      const diff = diffCandidateTrees({ fixtureRoot: repoRoots[oracle.corpusId], candidateRoot, allowedEdits: [oracle.file] });
      const target = await lstat(path.join(candidateRoot, oracle.file)).catch(() => null);
      if (diff.violations.length > 0) {
        verdict = { state: "REJECTED_DISALLOWED_EDIT", validatedSuccess: false, reason: `edits outside ${oracle.file}: ${diff.violations.slice(0, 10).join(", ")}`,
          added: diff.added.slice(0, 50), removed: diff.removed.slice(0, 50) };
      } else if (diff.missingAllowed.length > 0 || !target) {
        verdict = { state: ORACLE_STATE.MISSING_FILE, validatedSuccess: false, reason: `${oracle.file} was deleted` };
      } else if (!target.isFile()) {
        // A symlink or directory in place of the repaired file is never followed.
        verdict = { state: "REJECTED_NOT_REGULAR_FILE", validatedSuccess: false, reason: `${oracle.file} is not a regular file` };
      } else {
        const sourceText = await readFile(path.join(candidateRoot, oracle.file), "utf8");
        const result = await evaluate({ oracle, testSource, sourceText, javaHome, workDir: outputRoot });
        verdict = { state: VERDICT_STATE[result.state] ?? result.state, validatedSuccess: result.state === ORACLE_STATE.PASS, reason: result.detail ?? null,
          oracle: { state: result.state, completion: result.completion, compileMs: result.compileMs, runMs: result.runMs },
          candidateSha256: sha256(sourceText), changed: diff.changed };
      }
    } catch (error) {
      // A judge failure is the evaluator's, not the agent's: the slot stays unmeasured (JUDGE_ERROR), never a failed task.
      verdict = { state: "JUDGE_ERROR", validatedSuccess: false, reason: String(error?.message ?? error).slice(0, 300) };
    }
    const judgeArtifactPath = path.join(outputRoot, "verdict.json");
    await writeFile(judgeArtifactPath, `${JSON.stringify({ taskId, ...verdict, policy }, null, 2)}\n`);
    return { ...verdict, policy, judgeArtifactPath };
  }

  return {
    split, tasks, gold, publicAnswerContract, repoRoots, repairJudge,
    identity: { adapter: MAC10_LIVE_ADAPTER, split, answerContractSha256: contractPart.sha256, inputsSha256: sha256(inputsBytes), corpora, java, sourceBudget,
      scoring: { qa: "strict slots (string-set order-free) + every required evidence line received from the file hash it was verified on", repair: "MAC-10 oracle on the candidate's repaired file; edits elsewhere are rejected" } }
  };
}
