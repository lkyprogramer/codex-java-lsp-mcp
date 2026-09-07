#!/usr/bin/env node
// input: --repo --db [--anchors 200] [--out] [--golden]
// output: per-RPC calls/diffs/p50/p95 + ≤5 diffSamples. 0 diffs on fixtures.
// pos: P1-T5. Derive callers/callees from queryAnchor; context intents
// IMPLEMENTATION_CHANGE|PERSISTENCE_FLOW; entitySearch from golden task.
// Normalize: drop elapsedMs/generation/observedAt/heap*/rssBytes/serviceMs;
// sort arrays. Context graph: resolvedIntent/coverage/unresolved only.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runSqlColdBuild } from "../dist/java-index/builder/cold-build.js";
import { close, openIndexDb } from "../dist/java-index/sql/driver.js";
import { ensureSchema } from "../dist/java-index/sql/schema.js";
import { SqlJavaIndexClient } from "../dist/java-index/sql/sql-client.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC_NAMES = [
  "queryAnchor",
  "queryType",
  "queryTypes",
  "queryFiles",
  "queryImplementers",
  "queryTypeReferencers",
  "queryCallers",
  "queryCallees",
  "queryCalleesBatch",
  "queryMethodsWithParameterTypes",
  "queryMyBatisResource",
  "queryMyBatisResourcesByNamespace",
  "queryRepositoryFactMarkers",
  "queryReadRanges",
  "queryGraphDigest",
  "queryGraphReachable",
  "queryContextGraph",
  "queryContextGraphPersistence",
  "queryContextGraphNavigateCallees",
  "queryContextGraphNavigateCallers",
  "queryEntitySearch",
  "queryTypeUnresolved",
  "queryFilesEmpty",
  "queryCalleesBatchEmpty",
  "queryTypesEmpty"
];

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return { help: false, repo: required(options.get("--repo"), "--repo"), db: required(options.get("--db"), "--db"), anchors: Number(options.get("--anchors") || 200), out: options.get("--out"), golden: options.get("--golden") };
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function listFiles(root, suffix) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "target", "build", ".git", "out", "dist"].includes(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(suffix)) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

function loadGolden(repo, explicit) {
  const basename = path.basename(repo);
  const candidate = explicit
    ?? path.join(sourceRoot, "golden", `${basename}.scenarios.jsonl`);
  if (!existsSync(candidate)) return [];
  return readFileSync(candidate, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function dropVolatile(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof key === "string" && /elapsed|generation|observedAt|heapUsed|rssBytes|childCold|parentCold|serviceMs/i.test(key)) {
      return undefined;
    }
    return item;
  }));
}

function sortKey(item) {
  if (item === null || typeof item !== "object") return JSON.stringify(item);
  return item.path ?? item.file ?? item.typeId ?? item.methodId ?? item.entityId ?? item.edgeId
    ?? item.symbolId ?? item.fromId ?? item.id ?? JSON.stringify(item);
}

function normalize(value, rpc) {
  const cloned = dropVolatile(value);
  if (rpc.startsWith("queryContextGraph") && cloned && typeof cloned === "object") {
    return {
      resolvedIntent: cloned.resolvedIntent,
      coverage: cloned.coverage,
      unresolved: [...(cloned.unresolved ?? [])].sort((left, right) => sortKey(left).localeCompare(sortKey(right)))
    };
  }
  if (rpc === "queryGraphReachable" && cloned && typeof cloned === "object") {
    return { files: (cloned.files ?? []).filter(file => !String(file).endsWith(".xml")).sort() };
  }
  const walk = node => {
    if (Array.isArray(node)) {
      const mapped = node.map(walk);
      if (mapped.every(entry => typeof entry === "string")) return [...mapped].sort();
      if (mapped.every(entry => entry && typeof entry === "object")) {
        return [...mapped].sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
      }
      return mapped;
    }
    if (node && typeof node === "object") {
      const out = {};
      for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
      return out;
    }
    return node;
  };
  return walk(cloned);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

async function waitUntil(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function ensureDb(repo, dbPath) {
  if (existsSync(dbPath)) return;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openIndexDb(dbPath);
  try {
    ensureSchema(db);
    await runSqlColdBuild({ repoRoot: repo, db, generation: 1 });
  } finally {
    close(db);
  }
}

async function openHeap(repo, dbPath) {
  const heap = new SqlJavaIndexClient(repo, dbPath);
  await heap.open(1);
  return heap;
}

function sampleAnchors(repo, golden, limit) {
  const anchors = [];
  const seen = new Set();
  for (const row of golden) {
    const file = row.anchor?.file;
    if (!file || seen.has(`${file}:${row.anchor.line}:${row.anchor.column}`)) continue;
    seen.add(`${file}:${row.anchor.line}:${row.anchor.column}`);
    anchors.push({
      file: path.join(repo, file),
      relative: file,
      line: row.anchor.line,
      column: row.anchor.column ?? 1,
      task: [row.name, ...(row.anchor.taskKeywords ?? [])].filter(Boolean).join(" "),
      profile: row.anchor.profile,
      fromGolden: true
    });
  }
  return anchors;
}

async function addMethodAnchors(repo, heap, anchors, limit) {
  const seen = new Set(anchors.map(item => item.relative));
  const javaFiles = listFiles(repo, ".java");
  const remaining = Math.max(0, limit - anchors.length);
  const step = javaFiles.length === 0 ? 1 : Math.max(1, Math.floor(javaFiles.length / Math.max(1, remaining)));
  for (let index = 0; index < javaFiles.length && anchors.length < limit; index += step) {
    const file = javaFiles[index];
    const relative = path.relative(repo, file).split(path.sep).join("/");
    if (seen.has(relative)) continue;
    const method = (await heap.queryFiles([file]))[0]?.methods[0];
    if (!method) continue;
    seen.add(relative);
    anchors.push({ file, relative, line: method.range.start.line, column: method.range.start.column, task: method.name });
  }
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

function recordRpc(stats, name, oldMs, newMs, same, sample) {
  const entry = stats[name];
  entry.calls += 1;
  entry.oldMs.push(oldMs);
  entry.newMs.push(newMs);
  if (!same) {
    entry.diffs += 1;
    if (entry.diffSamples.length < 5 && sample) entry.diffSamples.push(sample);
  }
}

async function runOne(rpc, oldClient, newClient, args) {
  let oldRun;
  try {
    oldRun = await timed(() => oldClient[rpc](...args));
  } catch {
    return { oldMs: 0, newMs: 0, same: true };
  }
  try {
    const newRun = await timed(() => newClient[rpc](...args));
    const left = normalize(oldRun.value, rpc);
    const right = normalize(newRun.value, rpc);
    return { oldMs: oldRun.ms, newMs: newRun.ms, same: equal(left, right), sample: { rpc, argsPreview: args.slice(0, 2), old: left, new: right } };
  } catch (error) {
    return { oldMs: oldRun.ms, newMs: 0, same: false, sample: { rpc, argsPreview: args.slice(0, 2), new: String(error) } };
  }
}

export async function runDiff(options) {
  const repo = path.resolve(options.repo);
  const dbPath = path.resolve(options.db);
  await ensureDb(repo, dbPath);
  const drifts = [];
  const interval = setInterval(() => {
    const expected = Date.now();
    setTimeout(() => drifts.push(Date.now() - expected - 1), 0);
  }, 1);
  const sql = new SqlJavaIndexClient(repo, dbPath);
  const heap = await openHeap(repo, dbPath);
  await sql.open(1);
  const golden = loadGolden(repo, options.golden);
  const anchors = sampleAnchors(repo, golden, options.anchors ?? 200);
  await addMethodAnchors(repo, heap, anchors, options.anchors ?? 200);
  const stats = Object.fromEntries(RPC_NAMES.map(name => ({
    name,
    value: { calls: 0, diffs: 0, oldMs: [], newMs: [], diffSamples: [] }
  })).map(item => [item.name, item.value]));
  try {
    const xmlFiles = listFiles(repo, ".xml").filter(file => file.includes(`${path.sep}mapper${path.sep}`));
    const digest = await runOne("queryGraphDigest", heap, sql, []);
    recordRpc(stats, "queryGraphDigest", digest.oldMs, digest.newMs, digest.same, digest.same ? undefined : digest.sample);
    const markers = await runOne("queryRepositoryFactMarkers", heap, sql, [["org.springframework"], ["org.springframework"]]);
    recordRpc(stats, "queryRepositoryFactMarkers", markers.oldMs, markers.newMs, markers.same, markers.same ? undefined : markers.sample);
    const emptyFiles = await runOne("queryFiles", heap, sql, [[]]);
    recordRpc(stats, "queryFilesEmpty", emptyFiles.oldMs, emptyFiles.newMs, emptyFiles.same, emptyFiles.same ? undefined : emptyFiles.sample);
    const emptyTypes = await runOne("queryTypes", heap, sql, [[]]);
    recordRpc(stats, "queryTypesEmpty", emptyTypes.oldMs, emptyTypes.newMs, emptyTypes.same, emptyTypes.same ? undefined : emptyTypes.sample);
    const emptyBatch = await runOne("queryCalleesBatch", heap, sql, [[], 10]);
    recordRpc(stats, "queryCalleesBatchEmpty", emptyBatch.oldMs, emptyBatch.newMs, emptyBatch.same, emptyBatch.same ? undefined : emptyBatch.sample);
    const unresolved = await runOne("queryType", heap, sql, ["NoSuchType__iod"]);
    recordRpc(stats, "queryTypeUnresolved", unresolved.oldMs, unresolved.newMs, unresolved.same, unresolved.same ? undefined : unresolved.sample);

    for (const xml of xmlFiles.slice(0, 20)) {
      const relative = path.relative(repo, xml).split(path.sep).join("/");
      const resource = await runOne("queryMyBatisResource", heap, sql, [relative]);
      recordRpc(stats, "queryMyBatisResource", resource.oldMs, resource.newMs, resource.same, resource.same ? undefined : resource.sample);
    }
    if (xmlFiles.length > 0) {
      const ns = await runOne("queryMyBatisResourcesByNamespace", heap, sql, [["demo.OrderMapper", "demomybatis.OrderMapper"]]);
      recordRpc(stats, "queryMyBatisResourcesByNamespace", ns.oldMs, ns.newMs, ns.same, ns.same ? undefined : ns.sample);
    }

    for (const anchor of anchors) {
      const files = await runOne("queryFiles", heap, sql, [[anchor.file]]);
      recordRpc(stats, "queryFiles", files.oldMs, files.newMs, files.same, files.same ? undefined : files.sample);
      const ranges = await runOne("queryReadRanges", heap, sql, [[{ file: anchor.file, positions: [{ line: anchor.line, column: anchor.column }] }]]);
      recordRpc(stats, "queryReadRanges", ranges.oldMs, ranges.newMs, ranges.same, ranges.same ? undefined : ranges.sample);
      const search = await runOne("queryEntitySearch", heap, sql, [anchor.task || anchor.relative]);
      recordRpc(stats, "queryEntitySearch", search.oldMs, search.newMs, search.same, search.same ? undefined : search.sample);
      if (anchor.fromGolden) {
        const reachable = await runOne("queryGraphReachable", heap, sql, [anchor.relative, 3]);
        recordRpc(stats, "queryGraphReachable", reachable.oldMs, reachable.newMs, reachable.same, reachable.same ? undefined : reachable.sample);
        for (const [name, intent] of [["queryContextGraph", "IMPLEMENTATION_CHANGE"], ["queryContextGraphPersistence", "PERSISTENCE_FLOW"]]) {
          const hit = await runOne("queryContextGraph", heap, sql, [{
            fromRelativePath: anchor.relative, intent, taskText: anchor.task, profile: anchor.profile, anchorLine: anchor.line
          }]);
          recordRpc(stats, name, hit.oldMs, hit.newMs, hit.same, hit.same ? undefined : hit.sample);
        }
        for (const [name, direction] of [["queryContextGraphNavigateCallees", "callees"], ["queryContextGraphNavigateCallers", "callers"]]) {
          const hit = await runOne("queryContextGraph", heap, sql, [{
            fromRelativePath: anchor.relative, intent: "IMPLEMENTATION_CHANGE", mode: "navigate", direction, maxHops: 2
          }]);
          recordRpc(stats, name, hit.oldMs, hit.newMs, hit.same, hit.same ? undefined : hit.sample);
        }
      }

      let oldAnchor;
      let newAnchor;
      try {
        oldAnchor = await timed(() => heap.queryAnchor(anchor.file, anchor.line, anchor.column));
        newAnchor = await timed(() => sql.queryAnchor(anchor.file, anchor.line, anchor.column));
      } catch {
        continue;
      }
      recordRpc(
        stats,
        "queryAnchor",
        oldAnchor.ms,
        newAnchor.ms,
        equal(normalize(oldAnchor.value, "queryAnchor"), normalize(newAnchor.value, "queryAnchor")),
        equal(normalize(oldAnchor.value, "queryAnchor"), normalize(newAnchor.value, "queryAnchor"))
          ? undefined
          : { rpc: "queryAnchor", old: normalize(oldAnchor.value, "queryAnchor"), new: normalize(newAnchor.value, "queryAnchor") }
      );
      const facts = oldAnchor.value ?? newAnchor.value;
      const typeText = facts?.type?.simpleName ?? facts?.method?.name ?? "Object";
      const typeLookup = await runOne("queryType", heap, sql, [typeText, anchor.file]);
      recordRpc(stats, "queryType", typeLookup.oldMs, typeLookup.newMs, typeLookup.same, typeLookup.same ? undefined : typeLookup.sample);
      const types = await runOne("queryTypes", heap, sql, [[{ typeText, scopeFile: anchor.file }]]);
      recordRpc(stats, "queryTypes", types.oldMs, types.newMs, types.same, types.same ? undefined : types.sample);
      const typeId = facts?.type?.typeId ?? facts?.method?.ownerTypeId;
      const methodId = facts?.method?.methodId;
      if (typeId) {
        const implementers = await runOne("queryImplementers", heap, sql, [typeId, 10]);
        recordRpc(stats, "queryImplementers", implementers.oldMs, implementers.newMs, implementers.same, implementers.same ? undefined : implementers.sample);
        const refs = await runOne("queryTypeReferencers", heap, sql, [typeId, ["IMPLEMENTS"], 10]);
        recordRpc(stats, "queryTypeReferencers", refs.oldMs, refs.newMs, refs.same, refs.same ? undefined : refs.sample);
        const params = await runOne("queryMethodsWithParameterTypes", heap, sql, [[typeId], 10]);
        recordRpc(stats, "queryMethodsWithParameterTypes", params.oldMs, params.newMs, params.same, params.same ? undefined : params.sample);
      }
      if (methodId) {
        const callers = await runOne("queryCallers", heap, sql, [methodId, 10]);
        recordRpc(stats, "queryCallers", callers.oldMs, callers.newMs, callers.same, callers.same ? undefined : callers.sample);
        const callees = await runOne("queryCallees", heap, sql, [methodId, 10]);
        recordRpc(stats, "queryCallees", callees.oldMs, callees.newMs, callees.same, callees.same ? undefined : callees.sample);
        const batch = await runOne("queryCalleesBatch", heap, sql, [[methodId], 10]);
        recordRpc(stats, "queryCalleesBatch", batch.oldMs, batch.newMs, batch.same, batch.same ? undefined : batch.sample);
      }
    }
  } finally {
    clearInterval(interval);
    await sql.close();
    await heap.close();
  }
  const rpc = {};
  const diffSamples = [];
  for (const name of RPC_NAMES) {
    const entry = stats[name];
    rpc[name] = {
      calls: entry.calls,
      diffs: entry.diffs,
      p50Ms: { old: percentile(entry.oldMs, 0.5), new: percentile(entry.newMs, 0.5) },
      p95Ms: { old: percentile(entry.oldMs, 0.95), new: percentile(entry.newMs, 0.95) }
    };
    for (const sample of entry.diffSamples) diffSamples.push(sample);
  }
  const sortedDrifts = [...drifts].sort((a, b) => a - b);
  const report = {
    repo,
    rpc,
    diffSamples: diffSamples.slice(0, 5 * RPC_NAMES.length),
    intervalP99Ms: percentile(sortedDrifts, 0.99)
  };
  if (options.out) {
    mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("Usage: node scripts/diff-index-impl.mjs --repo <root> --db <path> [--anchors 200] [--out report.json] [--golden file]");
    process.exit(0);
  }
  runDiff(cli).then(report => {
    const diffs = Object.values(report.rpc).reduce((sum, entry) => sum + entry.diffs, 0);
    console.log(JSON.stringify({ repo: report.repo, diffs, intervalP99Ms: report.intervalP99Ms }, null, 2));
    process.exit(diffs === 0 ? 0 : 1);
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
