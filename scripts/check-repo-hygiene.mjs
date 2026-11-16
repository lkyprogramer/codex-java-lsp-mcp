#!/usr/bin/env node
// input: the repository worktree and scripts/repo-hygiene-baseline.json.
// output: a JSON summary; exit 1 when the tree adds a hygiene violation that the baseline does not hold.
// pos: docs/code-quality-audit-2026-11-16.md §7.3 (step 1, baseline mode). Existing debt is frozen, never admitted:
//   1. no new tracked file that .gitignore ignores (E1);
//   2. a new production .ts file stays within 600 lines; a file already over 800 lines does not grow;
//   3. a new production module is imported directly by at least one src test;
//   4. a new script is referenced by package.json, scripts/README.md or another script (E4);
//   5. a test file does not add `setTimeout(` calls (E7) unless the line says `hygiene: allow-timer`.
// `--write-baseline` rewrites the baseline from the current tree: only for an intentional, reviewed reset.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { countProductionTs } from "./count-production-ts.mjs";

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_FILE = "scripts/repo-hygiene-baseline.json";
export const SCHEMA = "repo-hygiene-baseline/v1";
export const LIMITS = Object.freeze({ newProductionLoc: 600, frozenProductionLoc: 800 });
const TIMER_ALLOW = "hygiene: allow-timer";

async function walk(root, dir, keep, out = []) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, rel, keep, out);
    else if (entry.isFile() && keep(rel)) out.push(rel);
  }
  return out;
}

/** Relative specifiers a TypeScript test imports (static, re-export, dynamic), resolved to src .ts paths. */
export function importedModules(testPath, text) {
  const out = new Set();
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(testPath), match[1]));
    out.add(resolved.replace(/\.(?:js|mjs)$/, ".ts"));
  }
  return out;
}

/** Lines that call setTimeout, minus explicitly allowed ones. */
export const timerCount = text => text.split("\n").filter(line => line.includes("setTimeout(") && !line.includes(TIMER_ALLOW)).length;

/** Scripts (non-test .mjs/.sh under scripts/) whose file name no other script, package.json or scripts/README.md mentions. */
export function unreferencedScripts(scripts, texts) {
  return scripts.filter(file => {
    const name = path.posix.basename(file);
    const ownTest = file.replace(/\.mjs$/, ".test.mjs");
    return !Object.entries(texts).some(([other, text]) => other !== file && other !== ownTest && text.includes(name));
  }).sort();
}

/** The facts the checks compare, from the current worktree. */
export async function collect(root = repoRoot) {
  const { stdout } = await exec("git", ["ls-files", "-ci", "--exclude-standard"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const ignoredTracked = stdout.split("\n").filter(Boolean).sort();
  const production = await countProductionTs({ root });
  const productionLoc = Object.fromEntries(production.files.map(file => [file.path, file.loc]).sort(([a], [b]) => a.localeCompare(b)));
  const srcTests = await walk(root, "src", rel => rel.endsWith(".test.ts"));
  const imported = new Set();
  const testTimers = {};
  for (const test of srcTests) {
    const text = await readFile(path.join(root, test), "utf8");
    for (const module of importedModules(test, text)) imported.add(module);
    const timers = timerCount(text);
    if (timers > 0) testTimers[test] = timers;
  }
  const scriptFiles = (await walk(root, "scripts", rel => /\.(?:mjs|sh)$/.test(rel))).sort();
  for (const test of scriptFiles.filter(file => file.endsWith(".test.mjs"))) {
    const timers = timerCount(await readFile(path.join(root, test), "utf8"));
    if (timers > 0) testTimers[test] = timers;
  }
  const texts = {};
  for (const file of scriptFiles) texts[file] = await readFile(path.join(root, file), "utf8");
  texts["package.json"] = await readFile(path.join(root, "package.json"), "utf8");
  if (existsSync(path.join(root, "scripts/README.md"))) texts["scripts/README.md"] = await readFile(path.join(root, "scripts/README.md"), "utf8");
  return {
    ignoredTracked,
    productionLoc,
    untestedProduction: Object.keys(productionLoc).filter(file => !imported.has(file)).sort(),
    unreferencedScripts: unreferencedScripts(scriptFiles.filter(file => !file.endsWith(".test.mjs")), texts),
    testTimers: Object.fromEntries(Object.entries(testTimers).sort(([a], [b]) => a.localeCompare(b)))
  };
}

/** Violations of the current facts against the baseline: only what is new relative to it. */
export function check(baseline, current) {
  const violations = [];
  const known = new Set(baseline.ignoredTracked);
  for (const file of current.ignoredTracked) if (!known.has(file)) violations.push({ rule: "ignored-tracked", file });
  for (const [file, loc] of Object.entries(current.productionLoc)) {
    const before = baseline.productionLoc[file];
    if (before === undefined && loc > LIMITS.newProductionLoc) violations.push({ rule: "new-production-size", file, loc, limit: LIMITS.newProductionLoc });
    if (before !== undefined && before > LIMITS.frozenProductionLoc && loc > before) violations.push({ rule: "frozen-production-growth", file, loc, limit: before });
  }
  for (const file of current.untestedProduction) {
    if (baseline.productionLoc[file] === undefined) violations.push({ rule: "new-production-untested", file });
  }
  const unreferenced = new Set(baseline.unreferencedScripts);
  for (const file of current.unreferencedScripts) if (!unreferenced.has(file)) violations.push({ rule: "unreferenced-script", file });
  for (const [file, count] of Object.entries(current.testTimers)) {
    const limit = baseline.testTimers[file] ?? 0;
    if (count > limit) violations.push({ rule: "test-timer", file, count, limit });
  }
  return violations;
}

export const toBaseline = current => ({ schema: SCHEMA, limits: LIMITS, ...current });

async function main(args) {
  const write = args.includes("--write-baseline");
  for (const arg of args) if (arg !== "--write-baseline") throw new Error(`unknown argument: ${arg}`);
  const current = await collect();
  const file = path.join(repoRoot, BASELINE_FILE);
  if (write) {
    await writeFile(file, `${JSON.stringify(toBaseline(current), null, 1)}\n`);
    console.log(JSON.stringify({ wrote: BASELINE_FILE }));
    return;
  }
  const baseline = JSON.parse(await readFile(file, "utf8"));
  if (baseline.schema !== SCHEMA) throw new Error(`${BASELINE_FILE} is not ${SCHEMA}`);
  const violations = check(baseline, current);
  console.log(JSON.stringify({ status: violations.length === 0 ? "PASS" : "FAIL", violations,
    debt: { ignoredTracked: current.ignoredTracked.length, untestedProduction: current.untestedProduction.length,
      unreferencedScripts: current.unreferencedScripts.length, testTimerFiles: Object.keys(current.testTimers).length } }, null, 2));
  if (violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
