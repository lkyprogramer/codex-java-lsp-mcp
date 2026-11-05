// MAC-10 dataset conversion. jin-commit-tasks/v1 rows are candidate inputs only: a task enters the
// dataset through a curator-verified curation record, and the converter splits it into agent-visible
// tasks and answer contract, private gold, repair oracles and a corpus manifest, each hashed into one
// dataset digest. Required evidence is what the curator verified, never a commit's changed-file list.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";

const execute = promisify(execFile);
export const CURATION_SCHEMA = "ilv2-mac10-curation/v1";
export const TASK_SCHEMA = "ilv2-mac10-task/v1";
export const GOLD_SCHEMA = "ilv2-mac10-gold/v1";
export const ANSWER_CONTRACT_SCHEMA = "ilv2-mac10-answer-contract/v1";
export const CORPUS_SCHEMA = "ilv2-mac10-corpus/v1";
export const DATASET_SCHEMA = "ilv2-mac10-dataset/v1";
export const ORACLE_SCHEMA = "ilv2-mac10-repair-oracle/v1";
export const CATEGORIES = Object.freeze(["callers", "implementations", "xml", "spring", "dto-impact", "repair"]);
export const SLOT_TYPES = Object.freeze(["string", "string-set", "boolean", "integer"]);
const CANDIDATE_SOURCES = new Set(["jin-commit-tasks/v1", "git-history"]);
const PRIVATE_FILE = 0o600;

/** Lines [startLine, endLine] (1-based, inclusive) joined by "\n"; the unit every evidence hash covers. */
export function lineRange(text, startLine, endLine) {
  const lines = text.split("\n");
  requireValue(Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine && endLine <= lines.length, `line range ${startLine}-${endLine} outside ${lines.length} lines`);
  return lines.slice(startLine - 1, endLine).join("\n");
}
export const rangeHash = (text, startLine, endLine) => sha256(lineRange(text, startLine, endLine));
export function replaceLines(text, startLine, endLine, replacement) {
  const lines = text.split("\n");
  lineRange(text, startLine, endLine);
  return [...lines.slice(0, startLine - 1), ...replacement.split("\n"), ...lines.slice(endLine)].join("\n");
}
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

/** Deterministic holdout: per (repo, category) stratum, round(ratio * n) unpinned tasks with the smallest seeded hash. */
export function assignSplits(tasks, { ratio, seed }) {
  requireValue(ratio > 0 && ratio < 1 && typeof seed === "string" && seed.length > 0, "holdout ratio in (0,1) and a seed are required");
  const strata = new Map();
  for (const task of tasks) {
    const key = `${task.repo}/${task.category}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(task);
  }
  const split = new Map();
  for (const [key, members] of [...strata].sort(([a], [b]) => a.localeCompare(b))) {
    const holdout = Math.round(members.length * ratio);
    const eligible = members.filter(task => !task.pinnedDev)
      .map(task => ({ task, rank: createHash("sha256").update(`${seed}\0${key}\0${task.id}`).digest("hex") }))
      .sort((a, b) => a.rank.localeCompare(b.rank));
    requireValue(eligible.length >= holdout, `stratum ${key}: ${holdout} holdout tasks needed, only ${eligible.length} unpinned`);
    const chosen = new Set(eligible.slice(0, holdout).map(row => row.task.id));
    for (const task of members) split.set(task.id, chosen.has(task.id) ? "holdout" : "dev");
  }
  return split;
}

function answerStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(answerStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(answerStrings);
  return [];
}
/** Agent-visible text may name what the task is about (its anchors), never the answer or the evidence it must find. */
export function leaks(task) {
  const visible = [task.prompt, ...(task.anchors ?? []), ...Object.keys(task.answer?.slots ?? {})].join("\n");
  const anchors = new Set(task.anchors ?? []);
  const found = [];
  for (const value of answerStrings(task.answer?.value)) {
    if (value.length >= 3 && visible.includes(value) && !anchors.has(value)) found.push({ kind: "answer", value });
  }
  for (const item of [...task.evidence, ...(task.repair ? [{ path: task.repair.file }] : [])]) {
    if (visible.includes(item.path)) found.push({ kind: "evidence-path", value: item.path });
    const stem = path.basename(item.path).replace(/\.[^.]+$/, "");
    if (stem.length >= 3 && visible.includes(stem) && !anchors.has(stem)) found.push({ kind: "evidence-file", value: stem });
  }
  return found;
}

function validateTask(task, candidates, changed) {
  const where = `task ${task.id}`;
  requireValue(/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(task.id ?? ""), `${where}: invalid id`);
  requireValue(CATEGORIES.includes(task.category), `${where}: unknown category ${task.category}`);
  requireValue(task.kind === (task.category === "repair" ? "repair" : "qa"), `${where}: kind must follow category`);
  requireValue(typeof task.prompt === "string" && task.prompt.trim().length >= 20, `${where}: prompt required`);
  requireValue(task.anchors === undefined || (Array.isArray(task.anchors) && task.anchors.every(item => typeof item === "string" && item.length > 0)), `${where}: anchors must be strings`);
  const verification = task.verification;
  requireValue(verification && typeof verification.by === "string" && verification.by && !Number.isNaN(Date.parse(verification.at)) && typeof verification.method === "string" && verification.method && typeof verification.notes === "string" && verification.notes.length >= 20, `${where}: unverified (verification.by/at/method/notes required)`);
  requireValue(CANDIDATE_SOURCES.has(task.source?.type) && /^[0-9a-f]{40}$/.test(task.source.commit ?? "") && /^[0-9a-f]{40}$/.test(task.source.parent ?? ""), `${where}: candidate source commit required`);
  const candidate = task.source.type === "jin-commit-tasks/v1" ? candidates.get(`${task.repo}:${task.source.commit}`) : null;
  requireValue(task.source.type !== "jin-commit-tasks/v1" || candidate, `${where}: commit is not a jin-commit-tasks/v1 candidate of ${task.repo}`);
  requireValue(Array.isArray(task.evidence) && task.evidence.length > 0, `${where}: verified evidence required`);
  for (const item of task.evidence) {
    requireValue(typeof item.path === "string" && !path.isAbsolute(item.path) && !item.path.split("/").includes("..") && Number.isInteger(item.startLine) && Number.isInteger(item.endLine), `${where}: invalid evidence row`);
    requireValue(typeof item.why === "string" && item.why.length >= 10, `${where}: evidence ${item.path} lacks its verified reason`);
    // A commit's changed files are a candidate list: one becomes required evidence only with its own verification.
    requireValue(!changed.has(item.path) || item.fromCommitFiles === true, `${where}: ${item.path} is a changed file of the source commit; mark fromCommitFiles after verifying it`);
  }
  if (task.kind === "qa") {
    const slots = task.answer?.slots;
    requireValue(slots && Object.keys(slots).length > 0 && Object.values(slots).every(slot => SLOT_TYPES.includes(slot.type)), `${where}: answer slots required`);
    requireValue(task.answer.value && JSON.stringify(Object.keys(task.answer.value).sort()) === JSON.stringify(Object.keys(slots).sort()), `${where}: gold answer must fill exactly the answer slots`);
    for (const [name, slot] of Object.entries(slots)) {
      const value = task.answer.value[name];
      const ok = slot.type === "string" ? typeof value === "string" && value.length > 0
        : slot.type === "string-set" ? Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0) && new Set(value).size === value.length
          : slot.type === "boolean" ? typeof value === "boolean" : Number.isInteger(value);
      requireValue(ok, `${where}: gold value for ${name} does not match ${slot.type}`);
    }
    requireValue(!task.repair, `${where}: a QA task has no repair oracle`);
  } else {
    const repair = task.repair;
    requireValue(repair && typeof repair.file === "string" && Number.isInteger(repair.startLine) && Number.isInteger(repair.endLine) && typeof repair.preState === "string"
      && typeof repair.oracle === "string" && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(repair.mainClass ?? "") && Number.isInteger(repair.release) && repair.release >= 8
      && Number.isInteger(repair.timeoutMs) && repair.timeoutMs > 0 && repair.timeoutMs <= 60000, `${where}: repair needs file, line range, preState, oracle, mainClass, release and timeoutMs <= 60000`);
    requireValue(!task.answer, `${where}: a repair task is scored by its oracle, not an answer`);
  }
  const found = leaks(task);
  requireValue(found.length === 0, `${where}: agent-visible text leaks gold: ${found.map(item => `${item.kind}=${item.value}`).join(", ")}`);
}

async function gitShow(repoRoot, head, file) {
  const { stdout } = await execute("git", ["--no-optional-locks", "-C", repoRoot, "show", `${head}:${file}`], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}
async function gitChanged(repoRoot, parent, commit) {
  const { stdout } = await execute("git", ["--no-optional-locks", "-C", repoRoot, "diff", "--name-only", "--no-renames", parent, commit], { maxBuffer: 16 * 1024 * 1024, encoding: "utf8" });
  return stdout.split("\n").filter(Boolean);
}
/** Any source set but src/main (test, integrationTest, testFixtures, ...). */
export const TEST_SOURCE = /(?:^|\/)src\/(?!main\/)[^/]+\//;
/**
 * Test-source files at the frozen head that a repair's own commit touched (followed through later renames), and
 * test-source Java files naming the repaired class.
 */
async function gitTestFiles(repoRoot, head, { commit, changed, className }) {
  const list = async args => {
    try { return (await execute("git", ["--no-optional-locks", "-C", repoRoot, ...args], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" })).stdout.split("\n").filter(Boolean); }
    catch (error) { if (error.code === 1) return []; throw error; }
  };
  const touched = changed.filter(file => TEST_SOURCE.test(file));
  const atCommit = touched.length ? await list(["ls-tree", "-r", "--name-only", commit, "--", ...touched]) : [];
  // commit..head over the whole tree, with exhaustive rename detection (-l0) and a low similarity bar: pairing a test with
  // the wrong successor hides one test too many, missing a successor would leave a revealing test visible. A test that
  // is deleted after the fix is not in the corpus; one moved out of the test sources is refused by the caller.
  const moved = new Map();
  const deleted = new Set();
  if (atCommit.length) {
    for (const line of await list(["diff", "--name-status", "-M30%", "-l0", commit, head])) {
      const [status, from, to] = line.split("\t");
      if (status.startsWith("R")) moved.set(from, to);
      else if (status === "D") deleted.add(from);
    }
  }
  return {
    changed: atCommit.filter(file => !deleted.has(file)).map(file => moved.get(file) ?? file),
    referencing: (await list(["grep", "-l", "-w", "-F", "-e", className, head, "--", "*.java"])).map(line => line.slice(head.length + 1)).filter(file => TEST_SOURCE.test(file))
  };
}

/** Build every dataset part in memory; `convertDataset` writes them. */
export async function buildDataset({ curation, curationDir, inputs, candidateSets, readSource = gitShow, listChanged = gitChanged, listTestFiles = gitTestFiles }) {
  requireValue(curation.schema === CURATION_SCHEMA && /^[a-z0-9][a-z0-9.-]{1,63}$/.test(curation.datasetId ?? ""), "curation schema and datasetId required");
  requireValue(Array.isArray(curation.tasks) && curation.tasks.length > 0, "curation lists no tasks");
  requireValue(new Set(curation.tasks.map(task => task.id)).size === curation.tasks.length, "duplicate task ids");
  const candidates = new Map();
  for (const [repo, set] of candidateSets) {
    requireValue(set.schemaVersion === "jin-commit-tasks/v1", `${repo}: candidates are not jin-commit-tasks/v1`);
    for (const row of [...set.train, ...set.holdout]) candidates.set(`${repo}:${row.commit}`, row);
  }
  const corpora = new Map(inputs.map(record => [record.name, record]));
  const changedBy = new Map();
  for (const task of curation.tasks) {
    requireValue(corpora.has(task.repo), `task ${task.id}: ${task.repo} is not a frozen input`);
    // The commit's own diff, not the curation's word for it, decides which files need fromCommitFiles.
    const record = corpora.get(task.repo);
    requireValue(task.source?.type !== "jin-commit-tasks/v1" || candidates.has(`${task.repo}:${task.source.commit}`), `task ${task.id}: commit is not a jin-commit-tasks/v1 candidate of ${task.repo}`);
    let changed = [];
    if (/^[0-9a-f]{40}$/.test(task.source?.commit ?? "") && /^[0-9a-f]{40}$/.test(task.source?.parent ?? "")) {
      try { changed = await listChanged(record.repoRoot, task.source.parent, task.source.commit); }
      catch { throw new Error(`task ${task.id}: source commit ${task.source.commit} is not in ${task.repo}`); }
    }
    validateTask(task, candidates, new Set(changed));
    changedBy.set(task.id, changed);
  }
  // Repair pre-states overlay the frozen tree; QA evidence and other repairs must not depend on those files.
  const overlays = new Map();
  for (const task of curation.tasks.filter(item => item.kind === "repair")) {
    const key = `${task.repo}:${task.repair.file}`;
    requireValue(!overlays.has(key), `task ${task.id}: ${task.repair.file} is already the pre-state of ${overlays.get(key)}`);
    overlays.set(key, task.id);
  }
  for (const task of curation.tasks) for (const item of task.evidence) {
    const owner = overlays.get(`${task.repo}:${item.path}`);
    requireValue(!owner || owner === task.id, `task ${task.id}: evidence ${item.path} is overlaid by repair ${owner}`);
  }
  // The frozen head holds the tests that the repair's own fix brought or that exercise the repaired class: they assert the
  // fixed behaviour the private oracle judges, so they are removed from every materialized corpus of that repository.
  const hidden = new Map();
  for (const task of curation.tasks.filter(item => item.kind === "repair")) {
    const record = corpora.get(task.repo);
    const found = await listTestFiles(record.repoRoot, record.head, { commit: task.source.commit, changed: changedBy.get(task.id), className: path.basename(task.repair.file).replace(/\.java$/, "") });
    for (const file of [...found.changed, ...found.referencing]) {
      requireValue(TEST_SOURCE.test(file), `task ${task.id}: ${file} is not a test source`);
      const row = hidden.get(`${task.repo}:${file}`) ?? { corpusId: task.repo, path: file, taskIds: [] };
      if (!row.taskIds.includes(task.id)) row.taskIds.push(task.id);
      hidden.set(`${task.repo}:${file}`, row);
    }
  }
  for (const task of curation.tasks) for (const item of task.evidence) {
    requireValue(!hidden.has(`${task.repo}:${item.path}`), `task ${task.id}: evidence ${item.path} is a test hidden from the repair corpus`);
  }
  const split = assignSplits(curation.tasks, curation.holdout ?? {});
  const sources = new Map();
  const source = async (repo, file) => {
    const key = `${repo}:${file}`;
    if (!sources.has(key)) sources.set(key, readSource(corpora.get(repo).repoRoot, corpora.get(repo).head, file));
    return sources.get(key);
  };
  const tasks = [];
  const gold = [];
  const oracles = [];
  const evidenceFiles = new Map();
  const contract = { schema: ANSWER_CONTRACT_SCHEMA, datasetId: curation.datasetId,
    rules: "Answer with one strict JSON object holding exactly the task's slots. string: exact text; string-set: a JSON array of unique exact strings, order-free; boolean/integer: JSON literals. Repair tasks take no answer: their edited source is judged by an evaluator-owned oracle.",
    tasks: {} };
  for (const task of curation.tasks) {
    const record = corpora.get(task.repo);
    let preState = null;
    if (task.kind === "repair") {
      const fixed = await source(task.repo, task.repair.file);
      const replacement = await readFile(path.resolve(curationDir, task.repair.preState), "utf8");
      preState = { fixed, broken: replaceLines(fixed, task.repair.startLine, task.repair.endLine, replacement) };
      requireValue(preState.broken !== fixed, `task ${task.id}: pre-state equals the known fix`);
    }
    const requiredEvidence = [];
    for (const item of task.evidence) {
      // Evidence inside a repair's own file is hashed on the pre-state the agent actually sees.
      const text = preState && item.path === task.repair.file ? preState.broken : await source(task.repo, item.path);
      requiredEvidence.push({ path: item.path, startLine: item.startLine, endLine: item.endLine, sha256: rangeHash(text, item.startLine, item.endLine), fileSha256: sha256(text) });
      evidenceFiles.set(`${task.repo}:${item.path}`, { corpusId: task.repo, path: item.path, sha256: sha256(await source(task.repo, item.path)) });
    }
    const visible = { schema: TASK_SCHEMA, taskId: task.id, corpusId: task.repo, kind: task.kind, category: task.category, split: split.get(task.id),
      prompt: task.prompt, anchors: task.anchors ?? [] };
    tasks.push(visible);
    if (task.kind === "qa") contract.tasks[task.id] = { slots: task.answer.slots };
    const row = { schema: GOLD_SCHEMA, taskId: task.id, split: split.get(task.id), kind: task.kind, category: task.category, corpusId: task.repo,
      requiredEvidence, source: task.source, verification: task.verification };
    if (task.kind === "qa") row.answer = task.answer.value;
    else {
      const testSource = await readFile(path.resolve(curationDir, task.repair.oracle));
      const oracle = { schema: ORACLE_SCHEMA, taskId: task.id, corpusId: task.repo, head: record.head, file: task.repair.file,
        startLine: task.repair.startLine, endLine: task.repair.endLine, mainClass: task.repair.mainClass, release: task.repair.release, timeoutMs: task.repair.timeoutMs,
        test: `${task.repair.mainClass.split(".").at(-1)}.java`, testSha256: sha256(testSource),
        preState: "pre-state.java", preStateSha256: sha256(preState.broken), fixSha256: sha256(preState.fixed) };
      oracles.push({ taskId: task.id, oracle, testSource, preState: preState.broken });
      row.repairOracle = `private/oracles/${task.id}/oracle.json`;
    }
    gold.push(row);
  }
  const order = (a, b) => a.taskId.localeCompare(b.taskId);
  tasks.sort(order); gold.sort(order);
  const hiddenRows = [];
  for (const row of [...hidden.values()].sort((a, b) => a.corpusId.localeCompare(b.corpusId) || a.path.localeCompare(b.path))) {
    hiddenRows.push({ ...row, taskIds: row.taskIds.sort(), sha256: sha256(await source(row.corpusId, row.path)) });
  }
  const corpus = { schema: CORPUS_SCHEMA, datasetId: curation.datasetId,
    corpora: [...new Set(curation.tasks.map(task => task.repo))].sort().map(repo => {
      const record = corpora.get(repo);
      return { corpusId: repo, head: record.head, inputManifest: record.manifest, inputManifestSha256: record.manifestSha256, inputFiles: record.inputFiles,
        evidenceFiles: [...evidenceFiles.values()].filter(row => row.corpusId === repo).map(({ path: file, sha256: hash }) => ({ path: file, sha256: hash })).sort((a, b) => a.path.localeCompare(b.path)),
        overlays: oracles.filter(item => item.oracle.corpusId === repo).map(item => ({ taskId: item.taskId, path: item.oracle.file, preStateSha256: item.oracle.preStateSha256 })),
        hidden: hiddenRows.filter(row => row.corpusId === repo).map(({ path: file, sha256: hash, taskIds }) => ({ path: file, sha256: hash, taskIds })) };
    }) };
  return { datasetId: curation.datasetId, tasks, gold, contract, corpus, oracles, holdout: curation.holdout };
}

function counts(rows) {
  const by = key => rows.reduce((out, row) => ({ ...out, [row[key]]: (out[row[key]] ?? 0) + 1 }), {});
  const strata = rows.reduce((out, row) => {
    const key = `${row.corpusId}/${row.category}`;
    out[key] ??= { dev: 0, holdout: 0 };
    out[key][row.split] += 1;
    return out;
  }, {});
  return { total: rows.length, bySplit: by("split"), byCorpus: by("corpusId"), byCategory: by("category"), byKind: by("kind"), strata };
}

/** Writes the dataset into a new directory; gold, oracles and the curation copy are owner-only files. */
export async function convertDataset({ curationFile, inputsFile, candidateFiles, out }) {
  const curationBytes = await readFile(curationFile);
  const curation = JSON.parse(curationBytes);
  const inputsBytes = await readFile(inputsFile);
  const inputs = JSON.parse(inputsBytes);
  const candidateSets = new Map();
  const candidateDigests = {};
  for (const file of candidateFiles) {
    const bytes = await readFile(file);
    const set = JSON.parse(bytes);
    candidateSets.set(set.project, set);
    candidateDigests[set.project] = sha256(bytes);
  }
  const built = await buildDataset({ curation, curationDir: path.dirname(curationFile), inputs, candidateSets });
  await mkdir(out, { recursive: false, mode: 0o700 });
  const parts = {};
  const write = async (name, text, { secret = false } = {}) => {
    const file = path.join(out, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, text, { mode: secret ? PRIVATE_FILE : 0o644 });
    if (secret) await chmod(file, PRIVATE_FILE);
    return { file: name, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) };
  };
  for (const split of ["dev", "holdout"]) {
    const tasks = built.tasks.filter(task => task.split === split);
    const gold = built.gold.filter(row => row.split === split);
    parts[`tasks-${split}`] = { ...await write(`tasks-${split}.jsonl`, jsonl(tasks)), rows: tasks.length };
    parts[`gold-${split}`] = { ...await write(`private/gold-${split}.jsonl`, jsonl(gold), { secret: true }), rows: gold.length };
  }
  parts["answer-contract"] = await write("answer-contract.json", `${JSON.stringify(built.contract, null, 2)}\n`);
  parts.corpus = await write("corpus-manifest.json", `${JSON.stringify(built.corpus, null, 2)}\n`);
  const oracles = [];
  for (const item of built.oracles) {
    const dir = `private/oracles/${item.taskId}`;
    await write(`${dir}/${item.oracle.test}`, item.testSource.toString("utf8"), { secret: true });
    await write(`${dir}/${item.oracle.preState}`, item.preState, { secret: true });
    oracles.push({ taskId: item.taskId, ...await write(`${dir}/oracle.json`, `${JSON.stringify(item.oracle, null, 2)}\n`, { secret: true }) });
  }
  parts.oracles = { rows: oracles.length, sha256: sha256(canonical(oracles)), files: oracles };
  await copyFile(curationFile, path.join(out, "private/curation.json"));
  await chmod(path.join(out, "private/curation.json"), PRIVATE_FILE);
  const identity = { datasetId: built.datasetId, parts: Object.fromEntries(Object.entries(parts).map(([name, part]) => [name, part.sha256])) };
  const manifest = { schema: DATASET_SCHEMA, datasetId: built.datasetId, datasetDigest: sha256(canonical(identity)), parts,
    createdFrom: { curationSha256: sha256(curationBytes), inputsFile, inputsSha256: sha256(inputsBytes), candidates: candidateDigests },
    split: { ratio: built.holdout.ratio, seed: built.holdout.seed, rule: "per (corpus, category) stratum: round(ratio*n) unpinned tasks with the smallest sha256(seed, stratum, taskId) are holdout" },
    counts: counts(built.tasks), access: "tasks-* and answer-contract.json are agent-visible; private/ (gold, oracles, curation) is read by the scorer only; holdout gold and results are closed to tuning" };
  await writeFile(path.join(out, "dataset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The identity a scorer or comparator checks before it reads a single result. */
export async function verifyDataset(manifestFile) {
  const manifest = await readJson(manifestFile);
  requireValue(manifest.schema === DATASET_SCHEMA, "not a MAC-10 dataset manifest");
  const root = path.dirname(manifestFile);
  for (const [name, part] of Object.entries(manifest.parts)) {
    if (name === "oracles") {
      for (const row of part.files) requireValue(sha256(await readFile(path.join(root, row.file))) === row.sha256, `dataset oracle ${row.taskId} changed`);
      requireValue(sha256(canonical(part.files)) === part.sha256, "dataset oracle list changed");
      continue;
    }
    requireValue(sha256(await readFile(path.join(root, part.file))) === part.sha256, `dataset part ${name} changed`);
  }
  const identity = { datasetId: manifest.datasetId, parts: Object.fromEntries(Object.entries(manifest.parts).map(([name, part]) => [name, part.sha256])) };
  requireValue(sha256(canonical(identity)) === manifest.datasetDigest, "dataset digest mismatch");
  return { root, manifest };
}

export const readJsonl = async file => (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));

/** Every (task, driver, repeat) slot, interleaved by a seeded order fixed before anything runs. */
export function buildSchedule({ tasks, drivers, repeats, seed, deadlineMs }) {
  requireValue(Number.isInteger(repeats) && repeats >= 1 && Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 600000, "repeats >= 1 and a bounded deadline required");
  requireValue(drivers.length > 0 && new Set(drivers).size === drivers.length, "unique drivers required");
  const rows = [];
  for (const task of tasks) for (let repeat = 0; repeat < repeats; repeat += 1) for (const driverId of drivers) {
    rows.push({ slotId: `${task.taskId}/${driverId}/${repeat}`, taskId: task.taskId, corpusId: task.corpusId, driverId, repeat, deadlineMs,
      order: createHash("sha256").update(`${seed}\0${task.taskId}\0${driverId}\0${repeat}`).digest("hex") });
  }
  return rows.sort((a, b) => a.corpusId.localeCompare(b.corpusId) || a.order.localeCompare(b.order));
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "convert") {
    const options = cliOptions(rest, ["--curation", "--inputs", "--candidates", "--out"]);
    const manifest = await convertDataset({ curationFile: path.resolve(options.curation), inputsFile: path.resolve(options.inputs),
      candidateFiles: options.candidates.split(",").map(file => path.resolve(file)), out: path.resolve(options.out) });
    console.log(JSON.stringify({ datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, counts: manifest.counts }, null, 2));
  } else if (command === "verify") {
    const options = cliOptions(rest, ["--dataset"]);
    const { manifest } = await verifyDataset(path.resolve(options.dataset));
    console.log(JSON.stringify({ datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, status: "VERIFIED" }));
  } else if (command === "schedule") {
    const options = cliOptions(rest, ["--tasks", "--drivers", "--repeats", "--seed", "--deadline-ms", "--out"]);
    const rows = buildSchedule({ tasks: await readJsonl(options.tasks), drivers: options.drivers.split(","), repeats: Number(options.repeats),
      seed: options.seed, deadlineMs: Number(options["deadline-ms"]) });
    await writeFile(options.out, jsonl(rows), { flag: "wx" });
    console.log(JSON.stringify({ schedule: path.resolve(options.out), slots: rows.length, sha256: sha256(Buffer.from(jsonl(rows))) }));
  } else throw new Error("usage: ilv2-mac-eval-dataset.mjs convert --curation F --inputs F --candidates F,F --out DIR | verify --dataset MANIFEST | schedule --tasks F --drivers a,b --repeats N --seed S --deadline-ms N --out F");
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
