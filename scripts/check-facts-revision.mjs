#!/usr/bin/env node
// input: a git base ref (default origin/main; compared from its merge-base with HEAD) and the working tree incl. untracked files.
// output: exit 1 when code that writes static-index facts changed but no facts version moved.
// pos: manual pre-merge gate (no CI in this repo). A delta keeps every row its base wrote; when the
//      code that writes rows changes without JAVA_FACTS_REVISION / SCHEMA_VERSION / STABLE_ID_VERSION
//      moving, old snapshots stay delta bases and one snapshot mixes rows of two code versions
//      (docs/review-2026-11-11-architecture.md F2). A change that provably keeps every row identical
//      is acknowledged with --ack "<why>".
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Directories whose code can decide fact rows (extraction, resolution, edges, graph, search documents,
 * schema, the builder pipeline). Broad on purpose: a false alarm costs an --ack, a miss a mixed snapshot.
 */
const FACT_WRITERS = [
  /^src\/java-index\/(?!snapshot\/).*\.ts$/,
  /^src\/java-knowledge\/.*\.ts$/,
  /^src\/index-builder\/.*\.ts$/,
  /^src\/discovery\/search-document\.ts$/
];
const TEST_FILE = /\.test\.ts$/;

/** The versions a fact-writer change must move (any one). */
const VERSIONS = [
  { file: "src/java-index/build-fingerprint.ts", name: "JAVA_FACTS_REVISION" },
  { file: "src/java-index/sql/schema.ts", name: "SCHEMA_VERSION" },
  { file: "src/java-index/stable-id.ts", name: "STABLE_ID_VERSION" }
];

const args = process.argv.slice(2);
let baseRef = "origin/main";
let ack;
const usage = message => { console.error(message); process.exit(2); };
for (let index = 0; index < args.length; index += 1) {
  const value = () => args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : usage(`${args[index]} needs a value`);
  if (args[index] === "--base") baseRef = value();
  else if (args[index] === "--ack") ack = value();
  else usage(`unknown argument ${args[index]}`);
}

// Exit 2, not 1, when git itself fails: a tool error is not a gate failure.
const git = (...argv) => {
  try { return execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { return usage(`git ${argv.join(" ")} failed: ${error.stderr || error.message}`); }
};
const top = git("rev-parse", "--show-toplevel").trim();
// Against the fork point: main moving on after the branch was cut neither hides nor adds changes.
const base = git("merge-base", baseRef, "HEAD").trim();
const lines = text => text.split("\n").filter(Boolean);
const changed = [...new Set([
  ...lines(git("-C", top, "diff", "--name-only", base, "--")),
  ...lines(git("-C", top, "ls-files", "--others", "--exclude-standard"))
])];
const writers = changed.filter(file => !TEST_FILE.test(file) && FACT_WRITERS.some(pattern => pattern.test(file)));
if (writers.length === 0) {
  console.log("no fact-writing code changed");
  process.exit(0);
}
const valueOf = (text, name) => new RegExp(`export const ${name} = (\\d+);`).exec(text)?.[1];
const moved = VERSIONS.filter(({ file, name }) => {
  let before;
  try { before = valueOf(execFileSync("git", ["-C", top, "show", `${base}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), name); }
  catch { before = undefined; }
  return before !== valueOf(readFileSync(path.join(top, file), "utf8"), name);
});
if (moved.length > 0) {
  console.log(`fact-writing code changed and ${moved.map(version => version.name).join(", ")} moved`);
  process.exit(0);
}
console.error(`fact-writing code changed since ${baseRef} (merge-base ${base.slice(0, 12)}) but no facts version moved:\n  ${writers.join("\n  ")}`);
if (ack) {
  console.error(`acknowledged: ${ack}`);
  process.exit(0);
}
console.error(`bump JAVA_FACTS_REVISION (src/java-index/build-fingerprint.ts), or rerun with --ack "<why every row is unchanged>"`);
process.exit(1);
