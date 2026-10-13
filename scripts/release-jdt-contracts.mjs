#!/usr/bin/env node
// input: A private, dependency-free Maven fixture, inside isolated JDT validation.
// output: Fail-closed K26 position/references and K28 real shared-waiter evidence.
// pos: Release integration oracle; no fake transport or model credentials.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runLocatorProbe } from './jdt-locator-probe.mjs';
import { candidateIdentity } from './run-release-contracts.mjs';

export const fixtureSources = {
  'pom.xml': '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>probe</groupId><artifactId>release-contracts</artifactId><version>1.0</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties></project>\n',
  'src/main/java/probe/Target.java': 'package probe;\n\npublic class Target {\n    @Deprecated\n    public static int compute(int value) {\n        return value + 1;\n    }\n}\n',
  'src/main/java/probe/Caller.java': 'package probe;\n\npublic class Caller {\n    public int run() {\n        return Target.compute(41);\n    }\n}\n'
};
export function prepareFixture(root) {
  for (const [file, source] of Object.entries(fixtureSources)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
}
export function assertReferenceOracle(references) {
  const caller = references.groups?.flatMap(group => group.files ?? []).find(file => file.path === 'src/main/java/probe/Caller.java');
  assert.ok(caller?.positions?.some(position => position.line === 5 && position.column === 23), 'MCP references must bind Caller.java:5:23');
}
export function assertSharedOracle({ shortCode, whileShortExited, longOutcome, settled, backendCalls }) {
  assert.equal(shortCode, 'DEADLINE_EXCEEDED', 'short waiter must actually exit by deadline');
  assert.equal(whileShortExited.inflight, 1, 'real shared work must still be pending after short caller exits');
  assert.equal(whileShortExited.sharedJoins, 1);
  assert.equal(whileShortExited.abortedNoWaiters, 0);
  assert.equal(longOutcome.completion, 'COMPLETE');
  assert.equal(backendCalls, 1, 'same request must execute once on the real backend');
  assert.equal(settled.inflight, 0);
  assert.equal(settled.completeWrites, 1);
  assert.equal(settled.abortedNoWaiters, 0);
}

async function realSharedWaiter(repoRoot) {
  const [{ JdtlsSession }, { SemanticGateway }, { createJdtlsSemanticBackend }, { DeadlineBudget }, { repoHash }] = await Promise.all([
    import('../dist/jdtls-session.js'), import('../dist/semantic-gateway.js'), import('../dist/jdtls-semantic-backend.js'), import('../dist/runtime/deadline-budget.js'), import('../dist/path-utils.js')
  ]);
  const session = new JdtlsSession(repoRoot);
  // Cold startup keeps the real request in flight while the short waiter exits.
  // The wider cap permits import; the implementation and transport are production.
  const backend = createJdtlsSemanticBackend(session);
  let backendCalls = 0;
  const gateway = new SemanticGateway({ execute: (...args) => { backendCalls++; return backend.execute(...args); } }, { absoluteCapMs: 180_000 });
  const file = path.join(repoRoot, 'src/main/java/probe/Target.java');
  const key = { repoHash: repoHash(repoRoot), generation: 1, operation: 'references', file, fileFingerprint: createHash('sha256').update(readFileSync(file)).digest('hex'), line: 5, column: 23, optionsKey: 'includeDeclaration=false' };
  try {
    const longPromise = gateway.execute(key, DeadlineBudget.fromTimeout(180_000), 180_000);
    let shortCode;
    try { await gateway.execute(key, DeadlineBudget.fromTimeout(30), 180_000); }
    catch (error) { shortCode = error.code; }
    const whileShortExited = gateway.status();
    const longOutcome = await longPromise;
    const settled = gateway.status();
    const result = { shortCode, whileShortExited, longOutcome, settled, backendCalls };
    assertSharedOracle(result);
    return { ...result, status: session.status(), coldStartup: true, operationCapMs: 180_000, shortCallerMs: 30 };
  } finally {
    gateway.clear();
    await session.stop();
    assert.equal(session.status().state, 'STOPPED');
  }
}

async function mcpContracts(repoRoot) {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  async function withClient(enabled, body) {
    writeFileSync(process.env.JAVA_LSP_PROJECTS_JSON, `${JSON.stringify({ aliases: [{ id: 'release-contracts', root: repoRoot, lspEnabled: enabled }], defaults: {} })}\n`);
    const client = new Client({ name: 'release-jdt-contracts', version: '1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectDir, 'dist/server.js')], cwd: projectDir, env: { ...process.env, JAVA_LSP_REPO_ROOT: repoRoot }, stderr: 'inherit' });
    const rawCall = (name, args) => client.callTool({ name, arguments: { repoRoot, ...args } }, undefined, { timeout: 600_000 });
    const call = async (name, args) => {
      const response = await rawCall(name, args);
      const text = response.content?.find(item => item.type === 'text')?.text ?? '';
      if (response.isError) throw new Error(text.slice(0, 400));
      return JSON.parse(text);
    };
    try { await client.connect(transport); return await body(call, rawCall); }
    finally { try { await call('java_runtime', { action: 'shutdown' }); } finally { await client.close(); } }
  }
  const disabled = await withClient(false, async (call, rawCall) => {
    const result = await rawCall('java_symbol', { operation: 'position', file: 'src/main/java/probe/Target.java', line: 5, column: 23 });
    const message = result.content?.find(item => item.type === 'text')?.text ?? '';
    assert.equal(result.isError, true);
    assert.match(message, /--enable-lsp/);
    return { isError: result.isError, message, status: await call('java_status', {}) };
  });
  assert.equal(disabled.status.lsp?.enabled, false);
  assert.equal(disabled.status.started, false);
  const enabled = await withClient(true, async call => {
    const locator = await runLocatorProbe({ repoRoot, queries: ['compute'], call });
    const references = await call('java_symbol', { operation: 'references', file: 'src/main/java/probe/Target.java', line: 5, column: 23, semanticTimeoutMs: 10_000, detail: 'diagnostic' });
    // Public references are grouped by path. Assert a real caller position.
    assertReferenceOracle(references);
    return { locator, references, status: await call('java_status', {}) };
  });
  return { disabled, enabled };
}

async function main() {
  const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (arg('--prepare-fixture')) { prepareFixture(path.resolve(arg('--prepare-fixture'))); return; }
  if (!arg('--repo-root')) throw new Error('--repo-root is required');
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== '1' || process.env.JAVA_LSP_ISOLATED_REPO_WORKTREE !== '1' || !process.env.JAVA_LSP_PROJECTS_JSON) throw new Error('run inside run-isolated-jdt-benchmark');
  const repoRoot = path.resolve(arg('--repo-root'));
  const identity = candidateIdentity();
  for (const [file, source] of Object.entries(fixtureSources)) assert.equal(readFileSync(path.join(repoRoot, file), 'utf8'), source, `fixture drift: ${file}`);
  const k28 = await realSharedWaiter(repoRoot);
  const k26 = await mcpContracts(repoRoot);
  assert.equal(candidateIdentity().sourceDigest, identity.sourceDigest, 'candidate changed during JDT measurement');
  const output = JSON.stringify({ candidateIdentity: identity, K26: { status: 'PASS', evidence: k26 }, K28: { status: 'PASS', evidence: k28 }, runtimeJavaHome: process.env.JDTLS_JAVA_HOME ?? process.env.JAVA_HOME, projectJavaHome: process.env.JAVA_LSP_PROJECT_JAVA_HOME }, null, 2);
  if (arg('--output')) writeFileSync(path.resolve(arg('--output')), output + '\n');
  console.log(output);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
