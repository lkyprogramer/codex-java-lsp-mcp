#!/usr/bin/env node
// input: A private, dependency-free Maven fixture (a detached clone from run-isolated-jdt-benchmark),
//        the frozen JDT/JDK toolchain and a registered run root.
// output: Fail-closed K26 position/references/enablement, K28 real shared-waiter evidence and a
//         same-URI two-worktree isolation check, all through the stdio relay to one isolated owner.
// pos: Release integration oracle (MAC-14): real JDT runs only inside the unique owner daemon; no
//      in-process session, fake transport or model credentials.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runLocatorProbe } from './jdt-locator-probe.mjs';
import { candidateIdentity } from './run-release-contracts.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
export const fixtureSources = {
  'pom.xml': '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>probe</groupId><artifactId>release-contracts</artifactId><version>1.0</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties></project>\n',
  'src/main/java/probe/Target.java': 'package probe;\n\npublic class Target {\n    @Deprecated\n    public static int compute(int value) {\n        return value + 1;\n    }\n}\n',
  'src/main/java/probe/Caller.java': 'package probe;\n\npublic class Caller {\n    public int run() {\n        return Target.compute(41);\n    }\n}\n'
};
// The second worktree changes the same relative paths: the parameter type, at the same line/column.
export const isolationSources = {
  'src/main/java/probe/Target.java': 'package probe;\n\npublic class Target {\n    @Deprecated\n    public static int compute(long value) {\n        return (int) value + 2;\n    }\n}\n',
  'src/main/java/probe/Caller.java': 'package probe;\n\npublic class Caller {\n    public int run() {\n        return Target.compute(41L);\n    }\n}\n'
};
export const fixtureDigest = sha(JSON.stringify([fixtureSources, isolationSources]));
const TARGET = 'src/main/java/probe/Target.java';
const CALLER = 'src/main/java/probe/Caller.java';

export function prepareFixture(root) {
  for (const [file, source] of Object.entries(fixtureSources)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
}
export function assertReferenceOracle(references) {
  const caller = references.groups?.flatMap(group => group.files ?? []).find(file => file.path === CALLER);
  assert.ok(caller?.positions?.some(position => position.line === 5 && position.column === 23), 'MCP references must bind Caller.java:5:23');
}
export function assertSharedOracle({ shortCode, whileShortExited, longOutcome, settled }) {
  assert.equal(shortCode, 'DEADLINE_EXCEEDED', 'short waiter must actually exit by deadline');
  assert.equal(whileShortExited.inflight, 1, 'real shared work must still be pending after short caller exits');
  assert.equal(whileShortExited.sharedJoins - whileShortExited.base.sharedJoins, 1);
  assert.equal(whileShortExited.abortedNoWaiters - whileShortExited.base.abortedNoWaiters, 0);
  assert.equal(longOutcome.completion, 'COMPLETE');
  assert.equal(settled.inflight, 0);
  assert.equal(settled.completeWrites - whileShortExited.base.completeWrites, 1, 'same request must execute once on the real backend');
  assert.equal(settled.abortedNoWaiters - whileShortExited.base.abortedNoWaiters, 0);
}
const hoverText = position => typeof position.hover === 'string' ? position.hover : JSON.stringify(position.hover ?? '');
/** Each worktree's hover names its own parameter type and never the other's, at the same relative path. */
export function assertIsolationOracle({ a, b }) {
  assert.match(hoverText(a), /compute\(int value\)/); assert.doesNotMatch(hoverText(a), /compute\(long value\)/);
  assert.match(hoverText(b), /compute\(long value\)/); assert.doesNotMatch(hoverText(b), /compute\(int value\)/);
}

async function frozenToolchain() {
  const file = process.env.ILV2_TOOLCHAINS;
  if (!file) throw new Error('ILV2_TOOLCHAINS is required: real JDT runs only the frozen toolchain');
  const frozen = JSON.parse(await readFile(file, 'utf8'));
  for (const entry of frozen.files) assert.equal(sha(await readFile(entry.path)), entry.sha256, `toolchain drift: ${entry.path}`);
  return frozen;
}

const STARTING = /JDT_NOT_READY|import is in progress|deadline exceeded/i;
/**
 * Retry only while the semantic path is still starting (import in progress, or a cold first request
 * that ran out of its budget); between attempts poll java_status until the session reports READY.
 */
async function untilSemantic(action, status, boundMs = 180_000) {
  const deadline = Date.now() + boundMs;
  for (;;) {
    try { return await action(); }
    catch (error) {
      if (Date.now() >= deadline || !STARTING.test(String(error?.message))) throw error;
      while (Date.now() < deadline && (await status()).state !== 'READY') await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function contracts(repo) {
  const { startOwner, stdioClient } = await import('./ilv2-mac-mcp-owner-fixture.mjs');
  const frozen = await frozenToolchain();
  const cleanups = [];
  const shim = { after: fn => cleanups.push(fn) };
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  try {
    const roots = {};
    const owner = await startOwner(shim, 'jdt-contracts', {
      async prepare(root) {
        // Main worktree (a), a linked worktree of the same family with the same relative paths and
        // different content (b), and a disabled copy (off).
        roots.a = path.join(root, 'wt-a'); roots.b = path.join(root, 'wt-b'); roots.off = path.join(root, 'off');
        await cp(repo, roots.a, { recursive: true });
        git(roots.a, 'worktree', 'add', '-q', '--detach', roots.b);
        for (const [file, source] of Object.entries(isolationSources)) await writeFile(path.join(roots.b, file), source);
        await cp(repo, roots.off, { recursive: true });
        return [roots.a, roots.b, roots.off];
      },
      projects: ([a, b, off]) => ({ aliases: [{ id: 'wt-a', root: a, lspEnabled: true }, { id: 'wt-b', root: b, lspEnabled: true }, { id: 'off', root: off, lspEnabled: false }], defaults: {} }),
      env: root => ({ JDTLS_BIN: frozen.jdtlsBin, JAVA_HOME: frozen.javaHome, JDTLS_JAVA_HOME: frozen.javaHome,
        JDTLS_EXTRA_ARGS: `--jvm-arg=-Duser.home=${path.join(root, 'home')}`, MAVEN_USER_HOME: path.join(root, 'service-state', 'maven-home') })
    });
    const clients = {};
    for (const name of ['a', 'b', 'off']) {
      const { client } = await stdioClient(owner, roots[name]);
      const raw = (tool, args) => client.callTool({ name: tool, arguments: { repoRoot: roots[name], ...args } }, undefined, { timeout: 600_000 });
      const call = async (tool, args) => {
        const response = await raw(tool, args);
        const text = response.content?.find(item => item.type === 'text')?.text ?? '';
        if (response.isError) throw new Error(text.slice(0, 400));
        return JSON.parse(text);
      };
      clients[name] = { raw, call };
    }
    const gateway = async name => (await clients[name].call('java_status', { start: false, detail: 'diagnostic' })).semanticGateway;
    const references = { operation: 'references', file: TARGET, line: 5, column: 23 };

    // K28: start the real session, then join one pending reference request from a short caller.
    const { a } = clients;
    const ready = name => () => clients[name].call('java_status', { start: false });
    await untilSemantic(() => a.call('java_symbol', { operation: 'position', file: CALLER, line: 5, column: 23, semanticTimeoutMs: 10_000 }), ready('a'));
    // The short caller must reach the gateway and join before its own deadline: a 1 ms budget dies
    // before the handler. Each attempt uses another column inside the same identifier (a distinct
    // request key for the same symbol, so no cached result) and a longer short budget; the first
    // attempt in which the short caller joined and exited while the shared work was in flight is judged.
    const attempts = [];
    let k28;
    for (const [index, shortMs] of [30, 60, 100, 150, 250, 400, 700].entries()) {
      const request = { ...references, column: 23 + index, detail: 'diagnostic' };
      const base = await gateway('a');
      const longPromise = a.call('java_symbol', { ...request, semanticTimeoutMs: 10_000 });
      const shortResult = await a.raw('java_symbol', { ...request, semanticTimeoutMs: shortMs });
      const shortMessage = shortResult.content?.find(item => item.type === 'text')?.text ?? '';
      const shortCode = shortResult.isError && /DEADLINE_EXCEEDED|deadline exceeded/i.test(shortMessage) ? 'DEADLINE_EXCEEDED' : shortMessage.slice(0, 200);
      const whileShortExited = { ...(await gateway('a')), base };
      const long = await longPromise;
      const settled = await gateway('a');
      const attempt = { shortMs, column: request.column, shortCode, shortMessage: shortMessage.slice(0, 400), whileShortExited,
        longOutcome: { completion: long.groups ? 'COMPLETE' : 'MISSING', references: long }, settled };
      attempts.push({ ...attempt, longOutcome: { completion: attempt.longOutcome.completion } });
      const joined = shortCode === 'DEADLINE_EXCEEDED' && whileShortExited.inflight === 1 && whileShortExited.sharedJoins - base.sharedJoins === 1;
      if (joined) { k28 = { ...attempt, attempts }; break; }
    }
    assert.ok(k28, `no attempt observed a joined short caller exiting by deadline: ${JSON.stringify(attempts)}`);
    assertSharedOracle(k28);

    // K26 disabled: the position request names the enable flag; status shows LSP off and unstarted.
    const off = await clients.off.raw('java_symbol', { operation: 'position', file: TARGET, line: 5, column: 23 });
    const offMessage = off.content?.find(item => item.type === 'text')?.text ?? '';
    assert.equal(off.isError, true); assert.match(offMessage, /--enable-lsp/);
    const disabled = { isError: off.isError, message: offMessage, status: await clients.off.call('java_status', {}) };
    assert.equal(disabled.status.lsp?.enabled, false); assert.equal(disabled.status.started, false);

    // K26 enabled: declaration selections resolve; references bind the real caller position.
    const locator = await runLocatorProbe({ repoRoot: roots.a, queries: ['compute'], call: a.call });
    const enabledReferences = await a.call('java_symbol', { ...references, semanticTimeoutMs: 10_000, detail: 'diagnostic' });
    assertReferenceOracle(enabledReferences);

    // Same-URI isolation: both worktrees answer concurrently, each from its own content.
    const position = name => untilSemantic(() => clients[name].call('java_symbol', { operation: 'position', file: TARGET, line: 5, column: 23, semanticTimeoutMs: 10_000 }), ready(name));
    const [pa, pb] = await Promise.all([position('a'), position('b')]);
    const [ra, rb] = await Promise.all(['a', 'b'].map(name => untilSemantic(() => clients[name].call('java_symbol', { ...references, semanticTimeoutMs: 10_000 }), ready(name))));
    assertIsolationOracle({ a: pa, b: pb });
    assertReferenceOracle(ra); assertReferenceOracle(rb);
    const isolation = { family: 'linked git worktrees, same relative paths', a: { hover: hoverText(pa).slice(0, 400), definitions: pa.definitions, sha256: sha(fixtureSources[TARGET]) },
      b: { hover: hoverText(pb).slice(0, 400), definitions: pb.definitions, sha256: sha(isolationSources[TARGET]) }, references: { a: ra, b: rb },
      sessions: { a: await clients.a.call('java_status', { start: false }), b: await clients.b.call('java_status', { start: false }) } };
    assert.notEqual(isolation.sessions.a.repoHash, isolation.sessions.b.repoHash, 'each worktree has its own session');

    const enabled = { locator, references: enabledReferences, status: await a.call('java_status', {}), isolation };
    return { K26: { status: 'PASS', evidence: { disabled, enabled } }, K28: { status: 'PASS', evidence: k28 },
      owner: { pid: owner.daemon.pid, transport: 'stdio relay -> owner HTTP' }, toolchain: { filesDigest: frozen.filesDigest, jdtVersion: frozen.jdtVersion, javaHome: frozen.javaHome } };
  } finally {
    for (const fn of cleanups.reverse()) await fn();
  }
}

async function main() {
  const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  if (arg('--prepare-fixture')) { prepareFixture(path.resolve(arg('--prepare-fixture'))); return; }
  if (!arg('--repo-root')) throw new Error('--repo-root is required');
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== '1' || process.env.JAVA_LSP_ISOLATED_REPO_WORKTREE !== '1' || !process.env.ILV2_RUN_ROOT) throw new Error('run inside run-isolated-jdt-benchmark under a registered run root');
  const repoRoot = path.resolve(arg('--repo-root'));
  const identity = candidateIdentity();
  for (const [file, source] of Object.entries(fixtureSources)) assert.equal(readFileSync(path.join(repoRoot, file), 'utf8'), source, `fixture drift: ${file}`);
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const native = JSON.parse(readFileSync(path.join(projectDir, 'dist/native/manifest.json'), 'utf8'));
  const result = await contracts(repoRoot);
  assert.equal(candidateIdentity().sourceDigest, identity.sourceDigest, 'candidate changed during JDT measurement');
  const output = JSON.stringify({ schema: 'release-real-jdt-evidence/v2', candidateIdentity: identity, nativeBinarySha256: native.binarySha256, nativeSourceDigest: native.sourceDigest,
    fixtureDigest, ...result }, null, 2);
  if (arg('--output')) writeFileSync(path.resolve(arg('--output')), output + '\n');
  console.log(output);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
