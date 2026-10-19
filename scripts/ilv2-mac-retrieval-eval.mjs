// MAC-10 model-free retrieval runner. Three phases, in this order:
//   1. plan: queries come from the agent-visible task alone (anchors, then identifiers in the prompt);
//   2. execute: every schedule slot runs its driver against a corpus clone, and every source range the
//      driver actually received is recorded with its bytes and hash;
//   3. score: only now is the private gold parsed. Required evidence is credited when a received range
//      covers it and the covered text hashes to the gold hash; a listed-but-unread file earns nothing.
// Exit 0: every slot ran to completion and was scored; 1: a slot timed out, failed or is missing;
// 2: identity, precondition or environment error.
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cliOptions, contains, isMain, readJson, requireValue, runCli, sha256, writeJson } from "./ilv2-mac-contracts.mjs";
import { lineRange, readJsonl, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";

const execute = promisify(execFile);
export const REPORT_SCHEMA = "ilv2-mac10-retrieval-report/v1";
export const DRIVERS_SCHEMA = "ilv2-mac10-drivers/v1";
export const PLANNER_VERSION = "anchor-identifier/v2";
export const MAX_TERMS = 6;
export const SLOT_STATUS = Object.freeze({ COMPLETE: "COMPLETE", TIMEOUT: "TIMEOUT", ERROR: "ERROR", MISSING: "MISSING" });
const WINDOW_DEFAULT = Object.freeze({ before: 20, after: 60, maxLines: 80 });
const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);

/**
 * Phase 1. Deterministic in the agent-visible task; it has no access to gold by construction. Only the identifiers
 * the task marks (anchors, then backtick spans) are queried: prose, including the shared answer-format sentence, is
 * not mined, so a pure-symptom task plans nothing and its slot is reported with planTerms 0.
 */
export function planQueries(task) {
  const terms = [];
  const add = term => { if (term && !terms.includes(term) && terms.length < MAX_TERMS) terms.push(term); };
  for (const anchor of task.anchors ?? []) add(anchor);
  for (const match of String(task.prompt ?? "").matchAll(/`([^`\n]{2,64})`/g)) add(match[1].trim());
  return { taskId: task.taskId, planner: PLANNER_VERSION, terms };
}

async function corpusLines(corpusRoot, relativePath) {
  const file = path.resolve(corpusRoot, relativePath);
  requireValue(!path.isAbsolute(relativePath) && contains(corpusRoot, file), `read outside corpus: ${relativePath}`);
  const real = await realpath(file);
  requireValue(contains(await realpath(corpusRoot), real), `read escapes corpus: ${relativePath}`);
  return (await readFile(real, "utf8")).split("\n");
}
function received(relativePath, lines, startLine, endLine) {
  const text = lines.slice(startLine - 1, endLine).join("\n");
  return { path: relativePath, startLine, endLine, text, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}
/** The one reader both arms share: a bounded line window of a corpus file, as received bytes. */
export async function readWindow(corpusRoot, relativePath, line, window = WINDOW_DEFAULT) {
  const lines = await corpusLines(corpusRoot, relativePath);
  const startLine = Math.max(1, Math.min(line, lines.length) - window.before);
  return received(relativePath, lines, startLine, Math.min(lines.length, startLine + window.maxLines - 1, line + window.after));
}
/** An exact span (a read-plan range), capped at maxLines like every other read. */
export async function readSpan(corpusRoot, relativePath, startLine, endLine, window = WINDOW_DEFAULT) {
  const lines = await corpusLines(corpusRoot, relativePath);
  const start = Math.max(1, Math.min(startLine, lines.length));
  return received(relativePath, lines, start, Math.min(lines.length, Math.max(start, endLine), start + window.maxLines - 1));
}

/** Phase 3, per slot. */
export function scoreSlot({ required, receipts, status }) {
  const credited = new Map();
  let wrongHash = 0;
  let partial = 0;
  let duplicates = 0;
  let bytes = 0;
  let firstCorrect = null;
  let allRequired = null;
  const seen = new Set();
  for (const receipt of receipts) {
    bytes += receipt.bytes;
    const key = `${receipt.path}\0${receipt.startLine}\0${receipt.endLine}\0${receipt.sha256}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    for (const [index, item] of required.entries()) {
      if (item.path !== receipt.path || receipt.endLine < item.startLine || receipt.startLine > item.endLine) continue;
      if (receipt.startLine > item.startLine || receipt.endLine < item.endLine) { partial += 1; continue; }
      const covered = lineRange(receipt.text, item.startLine - receipt.startLine + 1, item.endLine - receipt.startLine + 1);
      if (sha256(covered) !== item.sha256) { wrongHash += 1; continue; }
      if (credited.has(index)) continue;
      credited.set(index, receipt.ordinal);
      firstCorrect ??= { ordinal: receipt.ordinal, bytesThrough: bytes, elapsedMs: receipt.atMs };
      if (credited.size === required.length) allRequired = { ordinal: receipt.ordinal, bytesThrough: bytes, elapsedMs: receipt.atMs };
    }
  }
  return { status, required: required.length, credited: credited.size, recall: required.length ? credited.size / required.length : null,
    receipts: receipts.length, duplicates, wrongHash, partial, bytes, firstCorrect, allRequired };
}

/** nearest-rank: the ceil(p*n)-th smallest; n and max are always reported with it. */
export function nearestRank(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function aggregate(slots) {
  const byDriver = {};
  for (const slot of slots) {
    const row = byDriver[slot.driverId] ??= { planned: 0, emptyPlan: 0, status: {}, recallSum: 0, fullRecall: 0, firstCorrectMs: [], firstCorrectBytes: [], bytes: [], duplicates: 0, wrongHash: 0, partial: 0 };
    row.planned += 1;
    if (slot.planTerms === 0) row.emptyPlan += 1;
    row.status[slot.score.status] = (row.status[slot.score.status] ?? 0) + 1;
    // Every planned slot stays in the denominator: a missing, failed or timed-out slot keeps what it received (often nothing).
    row.recallSum += slot.score.recall ?? 0;
    if (slot.score.required && slot.score.credited === slot.score.required) row.fullRecall += 1;
    if (slot.score.firstCorrect) { row.firstCorrectMs.push(slot.score.firstCorrect.elapsedMs); row.firstCorrectBytes.push(slot.score.firstCorrect.bytesThrough); }
    row.bytes.push(slot.score.bytes);
    row.duplicates += slot.score.duplicates; row.wrongHash += slot.score.wrongHash; row.partial += slot.score.partial;
  }
  return Object.fromEntries(Object.entries(byDriver).map(([driverId, row]) => [driverId, {
    planned: row.planned, emptyPlanSlots: row.emptyPlan, status: row.status, meanRecall: row.recallSum / row.planned, fullRecallSlots: row.fullRecall,
    firstCorrect: { n: row.firstCorrectMs.length, p50Ms: nearestRank(row.firstCorrectMs, 0.5), p95Ms: nearestRank(row.firstCorrectMs, 0.95), maxMs: row.firstCorrectMs.length ? Math.max(...row.firstCorrectMs) : null,
      p50Bytes: nearestRank(row.firstCorrectBytes, 0.5) },
    receivedBytes: { p50: nearestRank(row.bytes, 0.5), p95: nearestRank(row.bytes, 0.95), max: row.bytes.length ? Math.max(...row.bytes) : null },
    duplicates: row.duplicates, wrongHash: row.wrongHash, partial: row.partial }]));
}

function run(binary, args, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    const out = [];
    let bytes = 0;
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes <= 8 * 1024 * 1024) out.push(chunk); });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString("utf8"), bytes }); });
  });
}

/** native-rg/v1: fixed-string word matches over Java/XML, files ranked by hit count, a window at the first hit. */
export function nativeRgDriver(config) {
  requireValue(path.isAbsolute(config.rg ?? ""), "native-rg/v1 needs an absolute rg binary");
  const window = { ...WINDOW_DEFAULT, ...config.window };
  const filesPerTerm = config.filesPerTerm ?? 3;
  return {
    async identity() {
      const version = await execute(config.rg, ["--version"]);
      return { kind: "native-rg/v1", rg: config.rg, rgSha256: sha256(await readFile(config.rg)), version: version.stdout.split("\n")[0], filesPerTerm, window };
    },
    async open(corpusRoot) {
      return {
        async query(term, { remainingMs, signal }) {
          const result = await run(config.rg, ["--no-config", "--line-number", "--fixed-strings", "--word-regexp", "--sort", "path", "--max-count", "50",
            "--glob", "*.java", "--glob", "*.xml", "--", term, "."], { cwd: corpusRoot, timeoutMs: Math.max(1, remainingMs()), signal });
          requireValue(result.code === 0 || result.code === 1, `rg failed with exit ${result.code}`);
          const hits = new Map();
          for (const line of result.stdout.split("\n").filter(Boolean)) {
            const match = /^\.\/(.+?):(\d+):/.exec(line);
            if (!match) continue;
            const row = hits.get(match[1]) ?? { count: 0, first: Number(match[2]) };
            row.count += 1;
            hits.set(match[1], row);
          }
          const files = [...hits].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, filesPerTerm);
          const receipts = [];
          for (const [file, row] of files) receipts.push(await readWindow(corpusRoot, file, row.first, window));
          return { payloadBytes: result.bytes, receipts };
        },
        async close() {}
      };
    }
  };
}

async function distDigest(distRoot) {
  const files = [];
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else if (/\.js$/.test(name) && !/\.test\.js$/.test(name)) files.push(name);
    }
  }
  await walk(distRoot);
  files.sort();
  const rows = [];
  for (const file of files) rows.push(`${file}\0${sha256(await readFile(path.join(distRoot, file)))}`);
  return { files: files.length, sha256: sha256(rows.join("\n")) };
}

/** product-mcp/v1: per term, the candidate's java_symbol static query (a window at each declaration), then
 *  java_impact at the first declaration with the shared reader on every read-plan span. A read-plan entry
 *  without spans, or a span never read, is not received source. */
export function productMcpDriver(config) {
  requireValue(path.isAbsolute(config.serverJs ?? ""), "product-mcp/v1 needs an absolute dist/server.js");
  const window = { ...WINDOW_DEFAULT, ...config.window };
  const limit = config.limit ?? 3;
  const impactPerTerm = config.impactPerTerm ?? 1;
  const readyTimeoutMs = config.readyTimeoutMs ?? 900000;
  return {
    async identity() {
      const dist = path.dirname(config.serverJs);
      const stamp = await readFile(path.join(dist, "build-stamp.json"));
      return { kind: "product-mcp/v1", serverJs: config.serverJs, buildStampSha256: sha256(stamp), gitSha: JSON.parse(stamp).gitSha, dist: await distDigest(dist), limit, impactPerTerm, window };
    },
    async open(corpusRoot, { workDir, signal }) {
      const { startOwnerDaemon } = await import("./owner-daemon.mjs");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const env = { PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`, TMPDIR: workDir, JDTLS_BIN: "/usr/bin/false" };
      const owner = await startOwnerDaemon({ serverJs: config.serverJs, cacheRoot: path.join(workDir, "cache"), env, ephemeralCache: false });
      let client;
      try {
        client = new Client({ name: "ilv2-mac10-retrieval", version: "1.0.0" });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [config.serverJs], cwd: corpusRoot, env: owner.relayEnv, stderr: "ignore" }));
        const call = async (name, args, timeoutMs) => {
          const result = await client.callTool({ name, arguments: args }, undefined, { timeout: Math.max(1, Math.ceil(timeoutMs)), signal });
          const text = result.content?.map(part => part.text).join("\n") ?? "";
          requireValue(!result.isError, `${name} failed: ${text.slice(0, 300)}`);
          return { value: JSON.parse(text), bytes: Buffer.byteLength(text) };
        };
        // The index must be FRESH for this corpus before any slot is timed.
        const started = performance.now();
        await call("java_status", { repoRoot: corpusRoot, start: true }, 60000);
        for (;;) {
          signal?.throwIfAborted();
          const status = (await call("java_status", { repoRoot: corpusRoot }, 60000)).value;
          if (status.indexView?.state === "FRESH") break;
          requireValue(performance.now() - started < readyTimeoutMs, `product index not FRESH within ${readyTimeoutMs} ms (state ${status.indexView?.state})`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        const readyMs = performance.now() - started;
        return {
          readyMs,
          async query(term, { remainingMs }) {
            const response = await call("java_symbol", { repoRoot: corpusRoot, operation: "query", query: term, limit, preview: "none" }, remainingMs());
            let payloadBytes = response.bytes;
            const receipts = [];
            const candidates = response.value.candidates ?? [];
            for (const candidate of candidates) {
              const located = candidate.evidenceRange ?? { relativePath: candidate.declaration.relativePath, startLine: candidate.declaration.selection.line };
              receipts.push(await readWindow(corpusRoot, located.relativePath, located.startLine, window));
            }
            for (const candidate of candidates.slice(0, impactPerTerm)) {
              if (remainingMs() <= 0) break;
              const { relativePath, selection } = candidate.declaration;
              const impact = await call("java_impact", { repoRoot: corpusRoot, file: relativePath, line: selection.line, column: selection.column,
                mode: "balanced", semanticPolicy: "fast", verbosity: "compact", deadlineMs: Math.max(1, Math.min(15000, Math.floor(remainingMs()))) }, remainingMs());
              payloadBytes += impact.bytes;
              for (const context of impact.value.contexts ?? []) {
                for (const span of context.spans ?? []) receipts.push(await readSpan(corpusRoot, context.path, span.s, span.e, window));
              }
            }
            return { payloadBytes, receipts };
          },
          async close() {
            try { await client.close(); } finally { await owner.stop(); }
          }
        };
      } catch (error) {
        try { await client?.close(); } finally { await owner.stop(); }
        throw error;
      }
    }
  };
}

export const DRIVER_KINDS = Object.freeze({ "native-rg/v1": nativeRgDriver, "product-mcp/v1": productMcpDriver });

/** One slot: the plan's terms in order until done or the deadline; receipts after the deadline are not credited. */
export async function runSlot({ slot, plan, session, signal }) {
  const started = performance.now();
  const remainingMs = () => slot.deadlineMs - (performance.now() - started);
  const receipts = [];
  let payloadBytes = 0;
  let status = SLOT_STATUS.COMPLETE;
  let error = null;
  for (const term of plan.terms) {
    if (remainingMs() <= 0) { status = SLOT_STATUS.TIMEOUT; break; }
    let result;
    try {
      result = await Promise.race([session.query(term, { remainingMs, signal }),
        new Promise(resolve => setTimeout(() => resolve(null), Math.max(1, remainingMs())).unref?.())]);
    } catch (caught) { status = SLOT_STATUS.ERROR; error = String(caught?.message ?? caught).slice(0, 300); break; }
    if (result === null || remainingMs() < 0) { status = SLOT_STATUS.TIMEOUT; break; }
    payloadBytes += result.payloadBytes;
    const atMs = performance.now() - started;
    for (const receipt of result.receipts) receipts.push({ ordinal: receipts.length + 1, term, atMs, ...receipt });
  }
  return { slotId: slot.slotId, status, error, elapsedMs: performance.now() - started, payloadBytes, receipts };
}

/** Materialize a corpus: an APFS clone of the frozen tree (no .git) plus the repair pre-state overlays, each checked by hash. */
export async function materializeCorpus({ record, corpus, oraclesRoot, target, signal }) {
  await mkdir(path.dirname(target), { recursive: true });
  const entries = (await readdir(record.repoRoot)).filter(name => name !== ".git");
  await mkdir(target);
  for (const name of entries) await execute("/bin/cp", ["-c", "-R", path.join(record.repoRoot, name), path.join(target, name)], { signal });
  const overlaid = new Set();
  for (const overlay of corpus.overlays) {
    const text = await readFile(path.join(oraclesRoot, overlay.taskId, "pre-state.java"), "utf8");
    requireValue(sha256(text) === overlay.preStateSha256, `overlay ${overlay.taskId} changed`);
    await writeFile(path.join(target, overlay.path), text);
    overlaid.add(overlay.path);
  }
  for (const file of corpus.evidenceFiles) {
    if (overlaid.has(file.path)) continue;
    requireValue(sha256(await readFile(path.join(target, file.path))) === file.sha256, `corpus file ${file.path} differs from the frozen input`);
  }
  return target;
}

export async function runRetrieval({ datasetFile, tasksFile, goldFile, scheduleFile, driversFile, inputsFile, out, driverKinds = DRIVER_KINDS, signal }) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  const split = ["dev", "holdout"].find(name => manifest.parts[`tasks-${name}`].sha256 === sha256(tasksBytes));
  requireValue(split, "tasks file is not a part of this dataset");
  // Gold is hashed here for identity and parsed only in phase 3.
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts[`gold-${split}`].sha256 === sha256(goldBytes), `gold file is not this dataset's ${split} gold`);
  const scheduleBytes = await readFile(scheduleFile);
  const driversBytes = await readFile(driversFile);
  const driversConfig = JSON.parse(driversBytes);
  requireValue(driversConfig.schema === DRIVERS_SCHEMA && Array.isArray(driversConfig.drivers), "drivers file schema required");
  const tasks = new Map(tasksBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(task => [task.taskId, task]));
  const schedule = scheduleBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  requireValue(schedule.length > 0 && new Set(schedule.map(slot => slot.slotId)).size === schedule.length, "schedule needs unique slots");
  const drivers = new Map(driversConfig.drivers.map(config => {
    requireValue(driverKinds[config.kind], `unknown driver kind ${config.kind}`);
    return [config.id, { config, driver: driverKinds[config.kind](config) }];
  }));
  for (const slot of schedule) {
    requireValue(tasks.has(slot.taskId), `schedule slot ${slot.slotId}: task not in this split`);
    requireValue(drivers.has(slot.driverId), `schedule slot ${slot.slotId}: unknown driver`);
    requireValue(tasks.get(slot.taskId).corpusId === slot.corpusId && Number.isInteger(slot.deadlineMs) && slot.deadlineMs > 0, `schedule slot ${slot.slotId}: corpus or deadline mismatch`);
  }
  await mkdir(out);
  const plans = new Map([...tasks.values()].map(task => [task.taskId, planQueries(task)]));
  const planText = [...plans.values()].map(plan => JSON.stringify(plan)).join("\n") + "\n";
  await writeFile(path.join(out, "query-plan.jsonl"), planText);
  const driverIdentities = {};
  for (const [id, { driver }] of drivers) driverIdentities[id] = await driver.identity();
  const identity = { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split, tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes),
    scheduleSha256: sha256(scheduleBytes), driversSha256: sha256(driversBytes), driverIdentities, planSha256: sha256(planText), planner: PLANNER_VERSION };
  await writeJson(path.join(out, "identity.json"), identity);
  // Phase 2.
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const results = new Map();
  const sessions = {};
  const callsFile = path.join(out, "calls.jsonl");
  await writeFile(callsFile, "");
  for (const corpusId of [...new Set(schedule.map(slot => slot.corpusId))]) {
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(row => row.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materializeCorpus({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId), signal });
    const slots = schedule.filter(slot => slot.corpusId === corpusId);
    for (const driverId of [...new Set(slots.map(slot => slot.driverId))]) {
      const workDir = path.join(out, "drivers", `${corpusId}-${driverId}`);
      await mkdir(workDir, { recursive: true });
      let session;
      try {
        session = await drivers.get(driverId).driver.open(corpusRoot, { workDir, signal });
        sessions[`${corpusId}/${driverId}`] = { readyMs: session.readyMs ?? null, error: null };
      } catch (error) {
        sessions[`${corpusId}/${driverId}`] = { readyMs: null, error: String(error?.message ?? error).slice(0, 500) };
      }
      try {
        for (const slot of slots.filter(item => item.driverId === driverId)) {
          signal?.throwIfAborted();
          const result = session
            ? await runSlot({ slot, plan: plans.get(slot.taskId), session, signal })
            : { slotId: slot.slotId, status: SLOT_STATUS.ERROR, error: `driver did not open: ${sessions[`${corpusId}/${driverId}`].error}`, elapsedMs: 0, payloadBytes: 0, receipts: [] };
          results.set(slot.slotId, result);
          await appendFile(callsFile, `${JSON.stringify(result)}\n`);
        }
      } finally { await session?.close(); }
    }
  }
  // Phase 3.
  const gold = new Map(goldBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.taskId, row]));
  const scored = schedule.map(slot => {
    const result = results.get(slot.slotId);
    const required = gold.get(slot.taskId)?.requiredEvidence ?? [];
    return { slotId: slot.slotId, taskId: slot.taskId, corpusId: slot.corpusId, driverId: slot.driverId, repeat: slot.repeat, planTerms: plans.get(slot.taskId).terms.length,
      elapsedMs: result?.elapsedMs ?? null, payloadBytes: result?.payloadBytes ?? 0, error: result?.error ?? null,
      score: scoreSlot({ required, receipts: result?.receipts ?? [], status: result?.status ?? SLOT_STATUS.MISSING }) };
  });
  const complete = scored.every(slot => slot.score.status === SLOT_STATUS.COMPLETE);
  const report = { schema: REPORT_SCHEMA, identity, status: complete ? "MEASURED" : "INCOMPLETE", sessions, byDriver: aggregate(scored), slots: scored,
    notClaimed: "Retrieval recall only: no answer, no repair and no agent success is measured here." };
  await writeJson(path.join(out, "report.json"), report);
  return report;
}

async function main(args, { signal }) {
  const options = cliOptions(args, ["--dataset", "--tasks", "--gold", "--schedule", "--drivers", "--inputs", "--out"]);
  for (const name of ["dataset", "tasks", "gold", "schedule", "drivers", "inputs", "out"]) requireValue(options[name], `--${name} is required`);
  const report = await runRetrieval({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    scheduleFile: path.resolve(options.schedule), driversFile: path.resolve(options.drivers), inputsFile: path.resolve(options.inputs), out: path.resolve(options.out), signal });
  console.log(JSON.stringify({ status: report.status, identity: { datasetDigest: report.identity.datasetDigest, scheduleSha256: report.identity.scheduleSha256 }, byDriver: report.byDriver }, null, 2));
  process.exitCode = report.status === "MEASURED" ? 0 : 1;
}

if (isMain(import.meta.url)) runCli(context => main(process.argv.slice(2), context));
