#!/usr/bin/env node
// Inspect exact index blobs. Findings contain only paths, rule IDs and counts.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { execute, isMain, cliOptions, runCli, sha256, requireValue } from "./ilv2-mac-contracts.mjs";

const DEFAULT_RULES = [
  { id: "private-key", source: "-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----" },
  { id: "access-token", source: "(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})" },
  { id: "business-package", source: "(?:com\\.lishu(?:\\.|\\b)|com\\.hhtele(?:\\.|\\b))" },
  { id: "mapper-namespace", source: "<mapper\\s+namespace\\s*=\\s*[\"'](?!fixture\\.)[^\"']+" }
];
const SAFE_EXTENSIONS = new Set([".ts", ".mjs", ".js", ".json", ".jsonl", ".md", ".sh", ".c", ".h", ".toml", ".yml", ".yaml", ".txt", ".mdc", ".plist"]);
export async function scanStaged(repoRoot, { rules = [], exclusions = [] } = {}) {
  const git = args => execute("git", ["--no-optional-locks", "-C", repoRoot, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const names = (await git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])).stdout.toString().split("\0").filter(Boolean);
  const allRules = [...DEFAULT_RULES, ...rules];
  requireValue(new Set(allRules.map(rule => rule.id)).size === allRules.length, "duplicate scan rule");
  let compiled;
  try { compiled = allRules.map(rule => ({ ...rule, expression: new RegExp(rule.source, "g") })); }
  catch { throw new Error("invalid scanner rule"); }
  const findings = [];
  const blobs = [];
  const usedExclusions = new Set();
  for (const name of names) {
    const bytes = (await git(["show", `:${name}`])).stdout;
    const digest = sha256(bytes);
    blobs.push({ path: name, sha256: digest, bytes: bytes.length });
    const add = (rule, count) => {
      const index = exclusions.findIndex(item => item.path === name && item.blobSha256 === digest && item.rule === rule && item.count === count && typeof item.reason === "string" && item.reason.trim().length > 0);
      if (index >= 0) usedExclusions.add(index);
      else findings.push({ path: name, rule, count });
    };
    const hard = rule => findings.push({ path: name, rule, count: 1 });
    if (bytes.length > 1024 * 1024) hard("file-size");
    if (!SAFE_EXTENSIONS.has(path.extname(name)) && !name.endsWith(".plist.template") && !["LICENSE", ".gitignore"].includes(path.basename(name))) hard("file-type");
    const mode = (await git(["ls-files", "--stage", "--", name])).stdout.toString().slice(0, 6);
    if (!["100644", "100755"].includes(mode)) hard("non-regular-blob");
    let validUtf8 = true;
    try { new TextDecoder("utf8", { fatal: true }).decode(bytes); } catch { validUtf8 = false; }
    if (!validUtf8 || bytes.includes(0) || /\.(?:gz|zip|sqlite|db|png|jpg|tar|bin)$/.test(name)) hard("binary-or-raw");
    if (/(?:^|\/)(?:tasks|gold|oracle|calls|requests|responses)\.(?:json|jsonl)$/.test(name)) hard("private-task-or-raw");
    const text = bytes.toString("utf8");
    for (const rule of compiled) {
      const count = [...text.matchAll(rule.expression)].length;
      if (count) add(rule.id, count);
    }
  }
  requireValue(exclusions.every((_, index) => usedExclusions.has(index)), "unused or stale scan exclusion");
  return { status: findings.length ? "FAIL" : "PASS", files: blobs, findings };
}
if (isMain(import.meta.url)) runCli(async () => {
  const options = cliOptions(process.argv.slice(2), ["--repo", "--policy"]);
  const policy = options.policy ? JSON.parse(await readFile(options.policy, "utf8")) : {};
  const result = await scanStaged(path.resolve(options.repo ?? "."), policy);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "PASS" ? 0 : 1;
});
