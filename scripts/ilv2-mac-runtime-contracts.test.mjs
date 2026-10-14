import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bindCandidateNodeCommand, expandCandidateTestGlobs } from "./isolation-utils.mjs";
import { bindCommandToIsolatedRepository } from "./run-isolated-jdt-benchmark.mjs";
import { captureCandidatePatch, matrixNativeBuildArguments } from "./run-three-repo-cold-matrix.mjs";
import { buildMacNative } from "./build-macos-native.mjs";
import { sha256, verifyRuntime } from "./ilv2-mac-contracts.mjs";
import { runOwnedHttpSmoke } from "./run-v4-http-smoke.mjs";
import { inspectFixtureSlots } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT } from "./ilv2-mac-contracts.mjs";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function foreignNode(directory) {
  const value = process.env.ILV2_FOREIGN_NODE_BIN;
  if (value) { assert.ok(path.isAbsolute(value), "alternate test Node must be absolute"); return value; }
  // Ordinary full/installation tests need only the frozen runtime. A private
  // executable copy exposes PATH selection through execPath without requiring
  // a second installed Node. G02A records a real alternate version separately.
  const copy = path.join(directory, "alternate-node");
  await cp(process.execPath, copy);
  return copy;
}
async function temporary(t) { const directory = await mkdtemp(path.join(os.tmpdir(), "mac-runtime-contract-")); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

test("reject-runtime-drift", async t => {
  const directory = await temporary(t);
  const runtime = JSON.parse(await readFile(process.env.ILV2_RUNTIME_MANIFEST, "utf8"));
  const manifest = path.join(directory, "runtime.json");
  await writeFile(manifest, JSON.stringify({ ...runtime, versions: { ...runtime.versions, sqlite: "wrong" } }));
  await assert.rejects(execute("/bin/sh", ["scripts/run-isolated-node.sh", "scripts/ilv2-mac-runtime.mjs", "--identity"], { cwd: root,
    env: { ...process.env, ILV2_NODE_BIN: process.execPath, ILV2_RUNTIME_MANIFEST: manifest } }), error => /runtime drift: versions/.test(error.stderr));
});

test("installer-preflight-uses-frozen-node-and-sqlite", async t => {
  const directory = await temporary(t);
  const alternate = await foreignNode(directory);
  const hostile = path.join(directory, "bin"); await mkdir(hostile); await symlink(alternate, path.join(hostile, "node"));
  const env = { ...process.env, PATH: `${hostile}:${process.env.PATH}`, ILV2_NODE_BIN: process.execPath, NODE_BIN: alternate };
  const result = await execute("/bin/bash", ["install-runtime.sh", "--preflight-runtime"], { cwd: root, env });
  assert.deepEqual(JSON.parse(result.stdout), await verifyRuntime());
  await assert.rejects(execute("/bin/bash", ["install-runtime.sh", "--preflight-runtime"], { cwd: root, env: { ...env, ILV2_NODE_BIN: alternate } }), error => /runtime drift: execPath/.test(error.stderr));
});

test("nested-broker-binds-current-executable", async t => {
  const directory = await temporary(t);
  const foreign = await foreignNode(directory);
  const hostile = path.join(directory, "bin"); await mkdir(hostile); await symlink(foreign, path.join(hostile, "node"));
  await writeFile(path.join(directory, "probe.mjs"), 'console.log(JSON.stringify({execPath:process.execPath,versions:process.versions}))\n');
  const env = { ...process.env, PATH: `${hostile}:${process.env.PATH}` };
  const baseline = JSON.parse((await execute("node", ["probe.mjs"], { cwd: directory, env })).stdout);
  assert.notEqual(baseline.execPath, process.execPath);
  for (const command of [bindCandidateNodeCommand(["node", "probe.mjs"], { candidateRoot: directory, stateRoot: directory }),
    bindCommandToIsolatedRepository(["node", "probe.mjs", "--repo-root", "{repo}"], directory)]) {
    const actual = JSON.parse((await execute(command[0], command.slice(1), { cwd: directory, env })).stdout);
    assert.equal(actual.execPath, process.execPath); assert.deepEqual(actual.versions, { ...process.versions });
  }
  assert.equal(bindCandidateNodeCommand(["node", "scripts/run-isolated-jdt-benchmark.mjs", "--repo-root", "/input"], { candidateRoot: directory, stateRoot: directory })[0], process.execPath);
});

test("quoted-glob-is-expanded-in-candidate", async t => {
  const directory = await temporary(t);
  await mkdir(path.join(directory, "dist/nested"), { recursive: true });
  await writeFile(path.join(directory, "dist/nested/actual.test.js"), "");
  assert.deepEqual(expandCandidateTestGlobs(["--test", "dist/**/*.test.js"], directory), ["--test", "dist/nested/actual.test.js"]);
  await rm(path.join(directory, "dist/nested/actual.test.js"));
  assert.throws(() => expandCandidateTestGlobs(["dist/**/*.test.js"], directory), /no matches/);
});

test("native-untracked-input-is-captured", async t => {
  const directory = await temporary(t);
  await execute("git", ["init", "--quiet", directory]);
  await execute("git", ["-C", directory, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  await mkdir(path.join(directory, "native/macos"), { recursive: true });
  await writeFile(path.join(directory, "native/macos/new.c"), "int fixture;\n");
  const first = await captureCandidatePatch(directory);
  assert.equal(first.untrackedInputs.length, 1); assert.match(first.patch, /native\/macos\/new\.c/);
  await writeFile(path.join(directory, "native/macos/new.c"), "int changed;\n");
  const second = await captureCandidatePatch(directory);
  assert.notEqual(first.untrackedInputs[0].sha256, second.untrackedInputs[0].sha256);
});

test("matrix-requires-current-native-and-keeps-frozen-legacy-baseline", async t => {
  const directory = await temporary(t);
  assert.throws(() => matrixNativeBuildArguments(directory), /inputs missing/);
  assert.deepEqual(matrixNativeBuildArguments(directory, { legacyBaseline: true }), []);
  await mkdir(path.join(directory, "native/macos"), { recursive: true });
  await writeFile(path.join(directory, "native/macos/ilv2-mac.c"), "int fixture;\n");
  assert.throws(() => matrixNativeBuildArguments(directory, { legacyBaseline: true }), /inputs missing/);
});

test("native-compile-failure-blocks-pass", async t => {
  const directory = await temporary(t);
  await mkdir(path.join(directory, "native/macos"), { recursive: true });
  await mkdir(path.join(directory, "scripts"));
  await cp(path.join(root, "scripts/build-macos-native.mjs"), path.join(directory, "scripts/build-macos-native.mjs"));
  await writeFile(path.join(directory, "native/macos/ilv2-mac.c"), "#error deliberate fixture compile failure\n");
  await mkdir(path.join(directory, "dist/native"), { recursive: true });
  await writeFile(path.join(directory, "dist/native/manifest.json"), "stale");
  await assert.rejects(buildMacNative(directory));
  await assert.rejects(readFile(path.join(directory, "dist/native/manifest.json")), { code: "ENOENT" });
});

test("release-smoke-binds-owned-port-and-reaps", async () => {
  const result = await runOwnedHttpSmoke();
  assert.equal(result.status, "PASS"); assert.notEqual(result.identity.port, 38456);
  assert.equal(result.identity.runtime.execPath, process.execPath);
  assert.throws(() => process.kill(-result.pgid, 0), { code: "ESRCH" });
  // An actual bind failure cannot attach the smoke to the existing listener.
  const { createServer } = await import("node:net");
  const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  try { await assert.rejects(runOwnedHttpSmoke({ port: listener.address().port, timeoutMs: 15000 }), /failed or timed out/); }
  finally { await new Promise(resolve => listener.close(resolve)); }
});

test("release-smoke-cancellation-reaps-before-releasing-quota", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  const started = performance.now();
  try { await assert.rejects(runOwnedHttpSmoke({ signal: controller.signal }), /failed or timed out|aborted/); }
  finally { clearTimeout(timer); }
  assert.ok(performance.now() - started < 6000);
  assert.equal(inspectFixtureSlots(MAC_WORK_ROOT).filter(row => row.pid === process.pid).length, 0);
});

test("targeted-pr-release-k-descendants-ignore-host-path", async t => {
  // This is a runtime-dispatch fixture. Its generated TAP does not certify any
  // product K/PR/release contract or Java query; those gates remain separate.
  const directory = await temporary(t), fixture = path.join(directory, "candidate");
  await execute("git", ["clone", "--shared", "--no-checkout", root, fixture]);
  await execute("git", ["-C", fixture, "checkout", "--detach", "HEAD"]);
  for (const name of ["scripts", "native", "docs/java-specialist-release-audit-v1.1/contracts"]) await cp(path.join(root, name), path.join(fixture, name), { recursive: true, force: true });
  await cp(path.join(root, "node_modules"), path.join(fixture, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true });
  await rm(path.join(fixture, "src"), { recursive: true }); await mkdir(path.join(fixture, "src/java-index/sql"), { recursive: true });
  for (const name of await readdir(path.join(fixture, "scripts"))) if (name.endsWith(".test.mjs")) await rm(path.join(fixture, "scripts", name));
  const trace = `import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';export function record(role:string){console.log(JSON.stringify({fixtureRuntime:true,role,execPath:process.execPath,versions:process.versions,nodeSha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex')}));}\n`;
  await writeFile(path.join(fixture, "src/trace.ts"), trace);
  await writeFile(path.join(fixture, "src/unit.test.ts"), "import test from 'node:test';import {record} from './trace.js';test('runtime unit',()=>record('unit'));\n");
  await writeFile(path.join(fixture, "src/java-index/sql/rows.test.ts"), "import test from 'node:test';import {record} from '../../trace.js';test('T02: parser-produced same-FQN runtime fixture',()=>record('k-dispatch'));\n");
  await writeFile(path.join(fixture, "src/resource-defaults.ts"), "export function resourceDefaults(){return {idleTtlMs:1,importConcurrency:1,jdtlsXmx:'1m',maxActiveRepos:1};}\n");
  await writeFile(path.join(fixture, "src/smoke.ts"), "import {record} from './trace.js';record('stdio-client');\n");
  await writeFile(path.join(fixture, "src/smoke-http.ts"), "import {record} from './trace.js';record('http-client');\n");
  await writeFile(path.join(fixture, "src/http-server.ts"), "import {createServer,Server} from 'node:http';export class JavaLspHttpServer {s:Server;constructor(public options:{port:number,instanceId:string}){this.s=createServer((_q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({instanceId:options.instanceId}));});}async start(){await new Promise<void>(r=>this.s.listen(this.options.port,'127.0.0.1',r));const port=(this.s.address() as {port:number}).port;return {port,url:`http://127.0.0.1:${port}/mcp`};}async shutdown(){await new Promise<void>((r,j)=>this.s.close(e=>e?j(e):r()));}}export function installDaemonSignalHandling(_s:JavaLspHttpServer){}\n");
  await writeFile(path.join(fixture, "scripts/runtime-only.test.mjs"), "import test from 'node:test';import {record} from '../dist/trace.js';test('runtime script',()=>record('script'));\n");
  // Make dist in the source intentionally stale. Brokers must rebuild their
  // candidate and expand globs there; no source-only test can enter the run.
  await mkdir(path.join(fixture, "dist")); await writeFile(path.join(fixture, "dist/stale.test.js"), "throw new Error('stale source dist executed')");
  const hostile = path.join(directory, "bin"); await mkdir(hostile); await symlink(await foreignNode(directory), path.join(hostile, "node"));
  const env = { ...process.env, PATH: `${hostile}:${process.env.PATH}`, ILV2_NODE_BIN: process.execPath };
  const expected = await verifyRuntime();
  for (const profile of ["pr", "release"]) {
    const result = await execute(process.execPath, ["scripts/run-v4-gates.mjs", "--profile", profile], { cwd: fixture, env, maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
    const rows = [];
    function collect(value) { if (!value || typeof value !== "object") return; if (value.fixtureRuntime) rows.push(value); else for (const child of Object.values(value)) collect(child); }
    for (const line of result.stdout.split('\n')) { try { collect(JSON.parse(line.replace(/^# /,''))); } catch { /* TAP prose */ } }
    t.diagnostic(JSON.stringify({ wrapper: profile, runtimeSamples: rows }));
    assert.ok(rows.length >= (profile === "pr" ? 2 : 4));
    for (const row of rows) { assert.equal(row.execPath, expected.execPath); assert.equal(row.nodeSha256, expected.nodeSha256); assert.deepEqual(row.versions, expected.versions); }
    if (profile === "release") assert.equal(rows.filter(row => row.role === "http-client").length, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /stale source dist executed/);
  }
  // K dispatch uses its real wrapper with a synthetic one-row oracle. This
  // proves the executable identity, not formal K01 business behavior.
  let result;
  try { result = await execute(process.execPath, ["scripts/run-isolated-validation.mjs", "--keep", "--profile", "targeted", "--", "node", "scripts/run-release-contracts.mjs", "--isolated", "--cases", "K01", "--output", "{state}/k-proof"], { cwd: fixture, env, maxBuffer: 8 * 1024 * 1024, timeout: 120000 }); }
  catch (error) { assert.equal(error.code, 1, error.stderr); result = error; }
  assert.match(result.stdout, /"K01"/);
  assert.doesNotMatch(result.stderr, /runtime drift/);
  const descriptor = JSON.parse(result.stdout.split('\n').findLast(line => line.startsWith('{"validationRoot"')));
  const state = descriptor.validationRoot;
  assert.ok(state.startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(state, { recursive: true, force: true }));
  const log = await readFile(path.join(state, "k-proof/raw/K01.stdout.log"), "utf8");
  const row = JSON.parse(log.split('\n').find(line => line.includes('"fixtureRuntime":true')).replace(/^# /,''));
  assert.equal(row.execPath, expected.execPath); assert.equal(row.nodeSha256, expected.nodeSha256); assert.deepEqual(row.versions, expected.versions);
});
