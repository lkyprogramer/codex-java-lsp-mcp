#!/usr/bin/env node
// input: Declaration names in an isolated Java repository.
// output: Real JDT definition assertions at verified static name selections.
// pos: A2 locator regression probe; any missing/error/wrong binding fails closed.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { splitSourceLines } from './eval-tool-wire.mjs';

function checked(result) {
  if (!result || result.error || result.isError || result.raw) throw new Error(result?.error ?? result?.raw ?? 'invalid tool response');
  return result;
}

function summarize(position, declaration) {
  checked(position);
  const hover = typeof position.hover === 'string' ? position.hover : JSON.stringify(position.hover ?? '');
  const definitions = (position.definitions ?? []).map(({ path, line, column }) => ({ path, line, column }));
  return {
    hoverHead: hover.split('\n').find(line => line.trim() && !line.startsWith('```'))?.slice(0, 160) ?? '',
    hoverNamesDeclaration: hover.includes(declaration.name),
    definitions,
    // Public locations normalize LocationLink.targetSelectionRange, or Location.range.
    definitionIsDeclaration: definitions.some(entry => entry.path === declaration.relativePath && entry.line === declaration.selection.line && entry.column === declaration.selection.column)
  };
}

export async function runLocatorProbe({ repoRoot, queries, call, readSource = file => readFileSync(path.join(repoRoot, file), 'utf8'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!queries.length) throw new Error('no queries');
  const rows = [];
  let warm = false;
  for (const query of queries) {
    const found = checked(await call('java_symbol', { query, searchMode: 'exact', preview: 'head' }));
    if (!Array.isArray(found.candidates) || !found.candidates.length) throw new Error(`no candidates for ${query}`);
    for (const candidate of found.candidates) {
      const { declaration, evidenceRange } = candidate;
      if (!declaration?.selection || !evidenceRange || evidenceRange.relativePath !== declaration.relativePath) throw new Error(`missing declaration evidence for ${query}`);
      const { selection, relativePath } = declaration;
      const source = readSource(relativePath);
      const lines = splitSourceLines(source);
      const { startLine, endLine } = evidenceRange;
      if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > lines.length ||
          createHash('sha256').update(source).digest('hex') !== evidenceRange.contentHash ||
          lines.slice(startLine - 1, endLine).join('') !== candidate.preview) throw new Error(`invalid or stale evidence for ${query}`);
      if (!Number.isInteger(selection.line) || !Number.isInteger(selection.column) || selection.column < 1 ||
          !lines[selection.line - 1]?.slice(selection.column - 1).startsWith(declaration.name)) throw new Error(`invalid declaration selection for ${query}`);
      const oldLine = lines[startLine - 1];
      const old = { line: startLine, column: oldLine.length - oldLine.trimStart().length + 1 };
      let atSelection;
      for (let attempt = 0; attempt < (warm ? 1 : 12); attempt++) {
        atSelection = checked(await call('java_symbol', { operation: 'position', file: relativePath, ...selection, semanticTimeoutMs: 10_000 }));
        if (atSelection.definitions?.length) break;
        if (!warm && attempt < 11) await sleep(10_000);
      }
      warm = true;
      const selected = summarize(atSelection, declaration);
      if (!selected.definitionIsDeclaration) throw new Error(`definition does not bind to ${declaration.id} at ${relativePath}:${selection.line}:${selection.column}`);
      const atOld = checked(await call('java_symbol', { operation: 'position', file: relativePath, ...old, semanticTimeoutMs: 10_000 }));
      rows.push({ query, id: declaration.id, kind: declaration.kind, relativePath, selection, evidenceRange, oldLocator: old,
        oldLocatorText: oldLine.trim().slice(0, 80), jdtAtSelection: selected, jdtAtOldLocator: summarize(atOld, declaration) });
    }
  }
  const annotated = rows.filter(row => row.evidenceRange.startLine < row.selection.line);
  return { repoRoot, queries, summary: { candidates: rows.length, annotated: annotated.length,
    selectionResolvesDeclaration: rows.filter(row => row.jdtAtSelection.definitionIsDeclaration).length,
    annotatedOldLocatorResolvesDeclaration: annotated.filter(row => row.jdtAtOldLocator.definitionIsDeclaration).length, errors: 0 }, rows };
}

async function main() {
  const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const queries = (arg('--queries') ?? '').split(',').filter(Boolean);
  if (!arg('--repo-root') || !queries.length) throw new Error('usage: jdt-locator-probe.mjs --repo-root <repo> --queries Name1,Name2');
  const repoRoot = path.resolve(arg('--repo-root'));
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== '1' || process.env.JAVA_LSP_ISOLATED_REPO_WORKTREE !== '1' || !process.env.JAVA_LSP_PROJECTS_JSON) throw new Error('run inside run-isolated-jdt-benchmark');
  writeFileSync(process.env.JAVA_LSP_PROJECTS_JSON, `${JSON.stringify({ aliases: [{ id: 'jdt-locator-probe', root: repoRoot, lspEnabled: true }], defaults: {} })}\n`);
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectDir, 'dist/server.js')], cwd: projectDir, env: { ...process.env, JAVA_LSP_REPO_ROOT: repoRoot }, stderr: 'inherit' });
  const client = new Client({ name: 'jdt-locator-probe', version: '0.2.0' });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: { repoRoot, ...args } }, undefined, { timeout: 600_000 });
    const text = result.content?.find(entry => entry.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(text.slice(0, 400));
    return JSON.parse(text);
  };
  try {
    await client.connect(transport);
    const result = await runLocatorProbe({ repoRoot, queries, call });
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  } finally {
    try { await call('java_runtime', { action: 'shutdown' }); }
    finally { await client.close(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
