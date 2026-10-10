#!/usr/bin/env node
// input:  --repo-root <Java repo> --queries a,b,c (declaration names). Runs
//         only inside run-isolated-jdt-benchmark.mjs (private JDT/cache state).
// output: JSON on stdout: for each static java_symbol candidate, what real JDT
//         returns (hover, definitions) at the candidate's selection (the
//         declaration name) and at its declaration's first line (the pre-fix
//         locator, typically an annotation).
// pos:    A2 locator follow-up: the static locator must be a position JDT
//         resolves to the same declaration (java_symbol position, java_impact).
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const repoRoot = path.resolve(arg("--repo-root") ?? "");
const queries = (arg("--queries") ?? "").split(",").filter(Boolean);
if (!arg("--repo-root") || queries.length === 0) {
  process.stderr.write("usage: jdt-locator-probe.mjs --repo-root <repo> --queries Name1,Name2\n");
  process.exit(2);
}
if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1" || !process.env.JAVA_LSP_PROJECTS_JSON) throw new Error("run inside run-isolated-validation / run-isolated-jdt-benchmark");
// JDT runs only for an LSP-enabled alias; register the detached clone in the
// isolated runner's private alias file (never the user's registry).
writeFileSync(process.env.JAVA_LSP_PROJECTS_JSON, `${JSON.stringify({ aliases: [{ id: "jdt-locator-probe", root: repoRoot, lspEnabled: true }], defaults: {} })}\n`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectDir, "dist", "server.js")],
  cwd: projectDir,
  env: { ...process.env, JAVA_LSP_REPO_ROOT: repoRoot },
  stderr: "inherit"
});
const client = new Client({ name: "jdt-locator-probe", version: "0.1.0" });
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: { repoRoot, ...args } }, undefined, { timeout: 600_000 });
  const text = result.content?.find(entry => entry.type === "text")?.text ?? "";
  if (result.isError) return { error: text.slice(0, 400) };
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
};

/** First non-blank column (1-based) of a line: where the pre-fix locator pointed. */
function headColumn(relativePath, line) {
  const text = readFileSync(path.join(repoRoot, relativePath), "utf8").split("\n")[line - 1] ?? "";
  return text.length - text.trimStart().length + 1;
}

const summarize = (position, candidate) => {
  if (position.error) return { error: position.error };
  const hover = typeof position.hover === "string" ? position.hover : JSON.stringify(position.hover ?? "");
  const definitions = (position.definitions ?? []).map(entry => ({ path: entry.path, line: entry.line, column: entry.column }));
  return {
    hoverHead: hover.split("\n").find(line => line.trim() && !line.startsWith("```"))?.slice(0, 160) ?? "",
    hoverNamesDeclaration: hover.includes(candidate.declaration.name),
    definitions,
    definitionIsDeclaration: definitions.some(entry => entry.path === candidate.declaration.relativePath && entry.line === candidate.declaration.selection.line)
  };
};

try {
  await client.connect(transport);
  const rows = [];
  let warm = false;
  for (const query of queries) {
    const found = await call("java_symbol", { query, searchMode: "exact", preview: "none" });
    for (const candidate of found.candidates ?? []) {
      const { selection, range, relativePath } = candidate.declaration;
      if (!range) {
        rows.push({ query, id: candidate.declaration.id, error: "no declaration range" });
        continue;
      }
      const old = { line: range.startLine, column: headColumn(relativePath, range.startLine) };
      // The first JDT request starts and imports the project; retry until it answers.
      let atSelection;
      for (let attempt = 0; attempt < (warm ? 1 : 12); attempt += 1) {
        atSelection = await call("java_symbol", { operation: "position", file: relativePath, ...selection, semanticTimeoutMs: 10_000 });
        if (!atSelection.error && (atSelection.hover || atSelection.definitions?.length)) break;
        await new Promise(resolve => setTimeout(resolve, 10_000));
      }
      warm = true;
      const atOld = await call("java_symbol", { operation: "position", file: relativePath, ...old, semanticTimeoutMs: 10_000 });
      rows.push({
        query,
        id: candidate.declaration.id,
        kind: candidate.declaration.kind,
        relativePath,
        selection,
        range,
        oldLocator: old,
        oldLocatorText: readFileSync(path.join(repoRoot, relativePath), "utf8").split("\n")[old.line - 1]?.trim().slice(0, 80),
        jdtAtSelection: summarize(atSelection, candidate),
        jdtAtOldLocator: summarize(atOld, candidate)
      });
    }
  }
  const annotated = rows.filter(row => row.selection && row.range && row.range.startLine < row.selection.line);
  const summary = {
    candidates: rows.length,
    annotated: annotated.length,
    selectionResolvesDeclaration: rows.filter(row => row.jdtAtSelection?.definitionIsDeclaration || row.jdtAtSelection?.hoverNamesDeclaration).length,
    annotatedOldLocatorResolvesDeclaration: annotated.filter(row => row.jdtAtOldLocator?.definitionIsDeclaration).length,
    errors: rows.filter(row => row.error || row.jdtAtSelection?.error).length
  };
  process.stdout.write(`${JSON.stringify({ repoRoot, queries, summary, rows }, null, 1)}\n`);
  await call("java_runtime", { action: "shutdown" }).catch(() => undefined);
} finally {
  await client.close();
}
