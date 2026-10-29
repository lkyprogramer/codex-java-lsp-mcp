#!/usr/bin/env node
// input: a candidate checkout (tracked + untracked, non-ignored files) and the D01–D13 deletion ledger below.
// output: removed-paths.json — per ledger item CODE/PLAN, every remaining occurrence of a historical name
//         with its explanation, and the production reachability of each file that still names it.
// pos: MAC-14 (ledger §4). PASS only when every occurrence is explained and no production-reachable file
//      calls a removed path; "the file is still there but never called" is not an explanation.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha = value => createHash("sha256").update(value).digest("hex");
export const SCHEMA = "ilv2-mac-removed-paths/v1";
/** Production entries: what the installer starts (install-runtime.sh) and what they fork or load as workers. */
export const PRODUCTION_ENTRIES = ["src/server.ts", "src/http-server.ts", "src/smoke-http.ts", "src/build-stamp.ts"];
const SCANNED = /^(src\/|scripts\/|native\/|package\.json$|install-runtime\.sh$)/;

/**
 * Allowed explanation kinds for a remaining occurrence. Only `comment`, `negative-assertion` and
 * `error-text` may sit in production-reachable code: they name the old path without calling it.
 */
export const KINDS = Object.freeze({
  "comment": "history note in a comment; no code path",
  "negative-assertion": "a test or guard that asserts the old path is absent or rejected",
  "error-text": "matches an old error message so historical telemetry still classifies; calls nothing",
  "offline-driver": "offline benchmark/replay/diagnostic tool or its test, run by hand on frozen inputs, never installed as a runtime path",
  "test-only": "test fixture or test-only harness, imported only by tests and offline drivers",
  "installer-migration": "installer migration step still invoked by install-runtime.sh; its removal is owned by a later card",
  "unused-dependency": "declared package dependency with no import left; removal is owned by a later card"
});
const PRODUCTION_SAFE = new Set(["comment", "negative-assertion", "error-text"]);

export const LEDGER = [
  { id: "D01", type: "CODE", owner: "MAC-07, MAC-08", names: ["findSiblingDb", "scanFamilySiblingIndex", "siblingDbPath", "copySibling", "retargetCopiedDb", "copiedSchemaMatches", "vacuum-into", /VACUUM\s+INTO/i],
    replacement: "sealed snapshot candidates with manifest and lease (snapshot-store.ts, index-owner.ts seedCandidates)",
    explain: { "src/telemetry/impact-telemetry.ts": "error-text" } },
  { id: "D02", type: "CODE", owner: "MAC-05", names: [/\brecovering\b/], replacement: "explicit FullPlan/DeltaPlan builder jobs (incremental.ts BuilderJob kinds full/refresh)" },
  { id: "D03", type: "CODE", owner: "MAC-03, MAC-05", names: [], replacement: "search text derived from the parsed bytes; preview checks the captured hash",
    evidence: ["G03 parse-then-edit injection", "G05 delta/full logical equality", "K20 publish-does-not-upgrade-held-view (sourceChanged gap)"] },
  { id: "D04", type: "CODE", owner: "MAC-06, MAC-08", names: ["familyGates", "startFamilyCreate", "BuilderSupervisor", "LocalBuilder", "SqlJavaIndexClient"],
    replacement: "one scheduler in IndexOwner; builders only via build-process.ts under the owner",
    explain: {
      "src/java-index/local-builder.ts": "test-only", "src/java-index/local-index.ts": "test-only", "src/java-index/sql/sql-client.ts": "test-only",
      "src/README.md": "comment"
    },
    explainPattern: [[/^src\/benchmark\//, "offline-driver"], [/^scripts\/(run-jin-|run-fsr|run-memory-benchmark|attribute-impact-payload|diff-index-impl|replay-entity-entry|verify-facts-digest)/, "offline-driver"]] },
  { id: "D05", type: "CODE", owner: "MAC-08, MAC-17", names: ["extract-stdio-project-jdk-env", "verify-stdio-ownership-handoff"],
    replacement: "stdio only relays to the owner (MAC-08B); the installer handshake goes with the MAC-17 installer",
    explain: {
      "install-runtime.sh": "installer-migration", "scripts/extract-stdio-project-jdk-env.mjs": "installer-migration", "scripts/verify-stdio-ownership-handoff.mjs": "installer-migration",
      "scripts/extract-stdio-project-jdk-env.test.mjs": "installer-migration", "scripts/verify-stdio-ownership-handoff.test.mjs": "installer-migration", "scripts/runtime-artifacts.test.mjs": "installer-migration"
    } },
  { id: "D06", type: "PLAN", owner: "manual, MAC-02A", names: ["COPYFILE_FICLONE", /\bcp -c\b/], replacement: "clonefile primitive with explicit success/failure (mac-platform/clonefile.ts)",
    plan: "old manual cp -c / COPYFILE_FICLONE guarantee and copy fallback; no matching implementation existed in src/scripts" },
  { id: "D07", type: "CODE", owner: "MAC-03, MAC-08B", names: [/\bfs\.watch\b/, "chokidar", "repo-fs-watch", "repo-change-coordinator"],
    replacement: "native FSEvents tracker with confirmed watermarks (workspace-tracker.ts)",
    explain: {
      "src/java-index/snapshot/workspace-tracker.ts": "comment", "src/benchmark/task36-mutation-matrix.ts": "comment", "scripts/task36-multiprocess-smoke.mjs": "comment",
      "src/path-utils.ts": "comment", "scripts/edit-to-visible-benchmark.mjs": "comment", "scripts/run-storm-gate.mjs": "comment", "package.json": "unused-dependency"
    } },
  { id: "D08", type: "CODE", owner: "MAC-04, MAC-07, MAC-08B, MAC-13", names: ["v1AliasIds"], replacement: "one schema format, BLOB hash identity, context name resolution to real declaration IDs" },
  { id: "D09", type: "CODE", owner: "MAC-08B, MAC-13", names: ["IDLE_WARMING"], replacement: "request view acquires after prepare; held-view labels (request-view.ts)" },
  { id: "D10", type: "CODE", owner: "MAC-08, MAC-14, MAC-17", names: ["JAVA_LSP_BUILDER_IDLE_MS"], replacement: "no builder idle serve; canonical config only" },
  { id: "D11", type: "PLAN", owner: "manual, MAC-16", names: [], replacement: "dedicated JDT session per worktree; K26 same-URI two-worktree isolation",
    plan: "old P3 family-shared JDT same-URI overlay was a plan, never an implementation" },
  { id: "D12", type: "PLAN", owner: "manual; code sub-item MAC-10", names: [], replacement: "comparator with real diff inputs (ilv2-mac-paired-compare.mjs)",
    plan: "old P0→v9→v10 forced order and stage tasks withdrawn; the comparator's implicit pilot input was existing code, replaced in MAC-10" },
  { id: "D13", type: "CODE", owner: "MAC-05", names: ["kg_summary", "fillMethodSummaries", "summariesByMethodId", "method-summary"],
    replacement: "kg_node_owner/kg_edge_owner relations; search_doc evidence hash read from file/mybatis_resource",
    explain: { "src/java-index/sql/schema.ts": "comment" },
    checks: [{ name: "search_doc has no content_hash column", file: "src/java-index/sql/schema.ts", absent: /CREATE TABLE search_doc\([^;]*content_hash/ }] }
];

function candidateFiles(root) {
  const result = spawnSync("git", ["--no-optional-locks", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("cannot list candidate files");
  return [...new Set(result.stdout.split("\0").filter(Boolean))].filter(file => SCANNED.test(file) && existsSync(path.join(root, file))).sort();
}

const IMPORT = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bimport\s*\(\s*|\bnew URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
/** Files reachable from the production entries through relative static/dynamic imports and worker URLs. */
export function productionReachable(root, files) {
  const known = new Set(files);
  const resolve = (from, spec) => {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    for (const candidate of [target.replace(/\.js$/, ".ts"), target, target + ".ts", target + "/index.ts"]) if (known.has(candidate)) return candidate;
    return undefined;
  };
  const seen = new Set();
  const queue = PRODUCTION_ENTRIES.filter(entry => known.has(entry));
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const next = resolve(file, match[1]);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const matcher = name => typeof name === "string" ? (text => text.includes(name)) : (text => name.test(text));
const label = name => typeof name === "string" ? name : String(name);

export function removedPaths(root) {
  const files = candidateFiles(root);
  const reachable = productionReachable(root, files.filter(file => file.endsWith(".ts")));
  const texts = new Map(files.map(file => [file, readFileSync(path.join(root, file), "utf8")]));
  const items = LEDGER.map(item => {
    const occurrences = [];
    for (const name of item.names) {
      const test = matcher(name);
      for (const [file, text] of texts) {
        if (file === "scripts/ilv2-mac-removed-paths.mjs" || file === "scripts/ilv2-mac-removed-paths.test.mjs") continue;
        const lines = text.split("\n").map((line, index) => [index + 1, line]).filter(([, line]) => test(line));
        if (!lines.length) continue;
        const kind = item.explain?.[file] ?? item.explainPattern?.find(([pattern]) => pattern.test(file))?.[1] ?? (/\.test\.(ts|mjs)$/.test(file) ? "test-only" : undefined);
        const production = reachable.has(file);
        const ok = kind !== undefined && KINDS[kind] !== undefined && (!production || PRODUCTION_SAFE.has(kind));
        occurrences.push({ name: label(name), file, lines: lines.map(([line]) => line), kind: kind ?? null, productionReachable: production, ok });
      }
    }
    const checks = (item.checks ?? []).map(check => ({ name: check.name, file: check.file, ok: !check.absent.test(texts.get(check.file) ?? "") }));
    const productionCallers = occurrences.filter(entry => entry.productionReachable && !PRODUCTION_SAFE.has(entry.kind)).map(entry => entry.file);
    const ok = occurrences.every(entry => entry.ok) && checks.every(check => check.ok);
    return { id: item.id, type: item.type, owner: item.owner, replacement: item.replacement, ...(item.plan ? { plan: item.plan } : {}), ...(item.evidence ? { evidence: item.evidence } : {}),
      names: item.names.map(label), occurrences, checks, productionCallers: [...new Set(productionCallers)], status: ok ? "PASS" : "FAIL" };
  });
  return { schema: SCHEMA, generatedAt: new Date().toISOString(), productionEntries: PRODUCTION_ENTRIES, productionFiles: reachable.size, kinds: KINDS, items,
    summary: { items: items.length, code: items.filter(item => item.type === "CODE").length, plan: items.filter(item => item.type === "PLAN").length,
      unexplained: items.flatMap(item => item.occurrences.filter(entry => !entry.ok)).length, productionCallers: items.flatMap(item => item.productionCallers).length },
    status: items.every(item => item.status === "PASS") ? "PASS" : "FAIL" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const root = path.resolve(arg("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const report = removedPaths(root);
  const text = JSON.stringify(report, null, 2) + "\n";
  if (arg("--out")) writeFileSync(path.resolve(arg("--out")), text);
  console.log(JSON.stringify({ status: report.status, summary: report.summary, sha256: sha(text) }));
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
