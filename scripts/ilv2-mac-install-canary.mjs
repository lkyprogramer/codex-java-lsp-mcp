#!/usr/bin/env node
// MAC17 only: one registered private launchd owner, real MCP, no production attachment.
import { cp, mkdir, readFile, readdir, realpath, writeFile, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONTRACT_VERSION, MAC_WORK_ROOT, cliOptions, contains, execute, isMain, managedPath, readJson, requireUnprotectedRoot, requireValue, runCli, sha256, verifyFrozenInput, verifyRuntime, writeJson } from './ilv2-mac-contracts.mjs';
import { acquireLaunchdFixtureSlot, ISOLATED_LAUNCHD_LABEL } from './ilv2-mac-fixture-quota.mjs';
import { prepareOwnerBundle, verifyOwnerBundle } from './managed-owner-launcher.mjs';
import { renderLaunchAgent } from './render-launch-agent-plist.mjs';
import { replay } from './ilv2-mac-burst-replay.mjs';
import { evaluateOracle, percentile, readCalls, summarize, validatePlan } from './ilv2-mac-slo-report.mjs';

export function validateConfig(plan, options, runRoot, now = Date.now()) {
  requireValue(plan.schema === 'ilv2-mac-install-canary/v1' && plan.runRoot === runRoot, 'registered canary plan required');
  requireValue(Number(options.port ?? 38457) === 38457, 'isolated port must be 38457');
  requireValue(ISOLATED_LAUNCHD_LABEL.test(plan.label), 'isolated label required');
  requireValue(Number.isFinite(plan.durationMs) && plan.durationMs >= 7200000 && plan.durationMs <= 9000000, 'two-hour minimum duration required');
  requireValue(Number.isInteger(plan.normalRequests) && plan.normalRequests >= 1000, '1000 normal requests required');
  requireValue(Date.parse(plan.deadline) <= Date.parse('2026-11-03T18:00:00+08:00') && Date.parse(plan.deadline) > now + plan.durationMs + 660000, 'deadline cannot cover canary');
  for (const [key, dir] of [['out', 'raw'], ['work', 'tmp']]) requireValue(path.isAbsolute(options[key]) && contains(path.join(runRoot, dir), options[key]) && options[key] !== path.join(runRoot, dir), `private ${key} required`);
  requireValue(!contains(options.work, options.out) && !contains(options.out, options.work), 'disjoint output/work required');
  requireValue(path.isAbsolute(options.candidate) && !contains(options.work, options.candidate) && !contains(options.candidate, options.work), 'immutable candidate required');
  requireValue(plan.input?.repoRoot?.startsWith(path.join(os.userInfo().homedir, 'Developer') + path.sep) && plan.input.repoRoot.includes('/inputs/'), 'frozen Developer input required');
  requireValue(typeof plan.oracle?.relativePath === 'string' && plan.oracle.relativePath.endsWith('.java') && !path.isAbsolute(plan.oracle.relativePath) && !plan.oracle.relativePath.split('/').includes('..'), 'relative Java oracle required');
  requireValue(/^[a-f0-9]{64}$/.test(plan.oracle.classHash) && plan.oracle.shape?.fqn && plan.oracle.shape?.name, 'source-linked oracle required');
  const required = ['dist/http-server.js', 'dist/build-stamp.json', 'dist/native/ilv2-mac', 'dist/native/manifest.json', 'package.json'];
  requireValue(required.every(file => /^[a-f0-9]{64}$/.test(plan.identity?.candidateFiles?.[file] ?? '')), 'candidate identity hashes required');
  requireValue(/^[a-f0-9]{64}$/.test(plan.identity.runtimeManifestSha256 ?? '') && /^[a-f0-9]{64}$/.test(plan.identity.nodeSha256 ?? ''), 'runtime identity required');
  return plan;
}

// Projection uses exclusively returned facts. Requests never supply missing response identity.
export function normalizeResult(raw, operation, expected) {
  if (operation === 'status') {
    requireValue(raw.repoRoot === expected.repoRoot && raw.started === false, 'status workspace/start mismatch');
    return { status: 'OK', raw };
  }
  const view = raw.indexView;
  const declarations = (raw.candidates ?? []).map(row => row.declaration);
  const declaration = declarations.find(row => row?.relativePath === expected.relativePath && row?.name === expected.name && row?.fqn === expected.fqn);
  if (!declaration || view?.state !== 'FRESH' || raw.scopeState !== 'READY') return { status: 'NOT_READY', raw };
  requireValue(view.workspaceId === expected.workspaceId, 'returned workspace mismatch');
  requireValue(declaration.contentHash === expected.sourceHash, 'returned source hash mismatch');
  requireValue(typeof view.snapshotId === 'string' && view.snapshotId.length > 0, 'returned snapshot required');
  return { status: 'OK', workspaceId: view.workspaceId, sourceHash: declaration.contentHash, snapshotId: view.snapshotId,
    relativePath: declaration.relativePath, name: declaration.name, fqn: declaration.fqn, raw };
}

export function makePhase({ phase, durationMs, normalRequests, main, seed, oracle, original, seedBefore }) {
  requireValue(Number.isInteger(normalRequests) && normalRequests >= 50 && durationMs >= 1000, 'invalid phase generation');
  const expected = target => ({ workspaceId: target.workspaceId, sourceHash: target.sourceHash,
    match: { relativePath: oracle.relativePath, name: target.name ?? oracle.shape.name, fqn: target.fqn ?? oracle.shape.fqn } });
  const slots = Array.from({ length: normalRequests }, (_, index) => ({ id: `p${phase}-normal-${index}`, atMs: index * durationMs / (normalRequests - 1), operation: index % 10 === 0 ? 'status' : 'query', window: 'normal', workspaceId: main.workspaceId,
    parameters: { repoRoot: main.repoRoot, query: oracle.shape.fqn }, expected: expected(main), deadlineMs: 15000, stopAfterMs: 15000 }));
  let previous = seedBefore;
  for (let index = 0; index < 10; index++) {
    const token = `mac17CanaryP${phase}Edit${index}`;
    const brace = original.lastIndexOf('}');
    requireValue(brace > 0, 'oracle class closing brace required');
    const utf8 = `${original.slice(0, brace)}\n public void ${token}() {}\n${original.slice(brace)}`;
    const target = { ...seed, sourceHash: sha256(utf8), name: token, fqn: `${oracle.shape.fqn}#${token}` };
    slots.push({ id: `p${phase}-edit-${index}`, atMs: (index + 0.5) * durationMs / 10, operation: 'query', window: 'normal', workspaceId: seed.workspaceId,
      parameters: { repoRoot: seed.repoRoot, query: target.fqn, allowPolling: true }, expected: expected(target), deadlineMs: 15000, stopAfterMs: 15000, pollMs: 150,
      edit: { path: path.join(seed.repoRoot, oracle.relativePath), beforeHash: sha256(previous), utf8 } });
    previous = utf8;
  }
  const plan = validatePlan({ contractVersion: CONTRACT_VERSION, concurrency: 2, slots: slots.sort((a, b) => a.atMs - b.atMs), slos: [
    { id: 'status-p99', operation: 'status', window: 'normal', metric: 'elapsedMs', percentile: 0.99, limitMs: 200, minSamples: Math.ceil(normalRequests / 10) },
    { id: 'query-first-correct-p95', operation: 'query', window: 'normal', metric: 'firstCorrectMs', percentile: 0.95, limitMs: 3000, minSamples: 10 }
  ] });
  return { plan, seedAfter: previous };
}

export function normalEvidence(plans, calls, durationMs, minimum) {
  const normal = calls.filter(row => row.kind === 'slot' && row.window === 'normal' && !row.slotId.includes('-edit-'));
  const starts = normal.map(row => BigInt(row.startMonoNs));
  const ends = normal.map(row => BigInt(row.endMonoNs));
  const spanMs = starts.length ? Number(ends.reduce((a,b) => a>b?a:b) - starts.reduce((a,b) => a<b?a:b)) / 1e6 : 0;
  const edits = calls.filter(row => row.kind === 'slot' && row.slotId.includes('-edit-'));
  const editValues = edits.filter(row => row.status === 'PASS' && Number.isFinite(row.firstCorrectMs)).map(row => row.firstCorrectMs);
  const editP95 = editValues.length ? percentile(editValues, 0.95) : null;
  const reports = plans.map(plan => summarize(plan, calls.filter(row => plan.slots.some(slot => slot.id === row.slotId))));
  return { status: normal.length >= minimum && spanMs >= durationMs && edits.length === 20 && editValues.length === 20 && editP95 <= 3000 && reports.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL', normalRequests: normal.length, spanMs, edits: edits.length, editP95, reports };
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(38457, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function candidateIdentity(root, expected) {
  const actual = {};
  for (const [relative, digest] of Object.entries(expected)) {
    requireValue(relative && !path.isAbsolute(relative) && contains(root, path.resolve(root, relative)), 'unsafe candidate inventory path');
    actual[relative] = sha256(await readFile(await managedPath(root, path.join(root, relative))));
    requireValue(actual[relative] === digest, `candidate hash mismatch: ${relative}`);
  }
  return actual;
}
async function workspace(repoRoot) {
  const info = await stat(repoRoot);
  return { repoRoot, workspaceId: `w-${sha256(`${repoRoot}\0${info.dev}\0${info.dev}\0${info.ino}`).slice(0,40)}` };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch(error) { if (error.code === 'ESRCH') return false; throw error; } };
async function poll(body, ms, signal) {
  const end = performance.now() + ms;
  do { signal?.throwIfAborted(); const value = await body(Math.max(1,Math.floor(end-performance.now()))); if (value) return value; await delay(Math.max(0,Math.min(150,end-performance.now())), undefined, { signal }); } while (performance.now() < end);
  throw new Error('bounded polling expired');
}

export async function runCanary(options, outerSignal) {
  const runRoot = await realpath(process.env.ILV2_RUN_ROOT);
  requireValue((await readFile(path.join(runRoot,'run-root.txt'),'utf8')).trim() === runRoot, 'registered run root required');
  const config = validateConfig(await readJson(options.plan), options, runRoot);
  for (const key of ['out','work']) { requireUnprotectedRoot(options[key], key); requireValue(await managedPath(runRoot, options[key]) === options[key], 'canonical paths required'); }
  requireUnprotectedRoot(options.candidate, 'candidate'); requireValue(await realpath(options.candidate) === options.candidate, 'canonical candidate required');
  const controller = new AbortController();
  const signal = AbortSignal.any([outerSignal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error('three-hour canary limit')), Math.min(10800000, Date.parse(config.deadline) - Date.now()));
  let lease, client, firstFailure, closeout;
  const actions = [];
  let outCreated = false;
  const action = async (type, value) => { const row = { type, at: new Date().toISOString(), ...value }; actions.push(row); await appendFile(path.join(options.out,'actions.jsonl'), `${JSON.stringify(row)}\n`); };
  try {
    await mkdir(options.out, { mode: 0o700 }); outCreated = true;
    await mkdir(options.work, { mode: 0o700 });
    await reservePort();
    const runtime = await verifyRuntime();
    requireValue(runtime.runtimeManifestSha256 === config.identity.runtimeManifestSha256 && runtime.nodeSha256 === config.identity.nodeSha256, 'runtime identity mismatch');
    await writeJson(path.join(options.out,'input-before.json'), await verifyFrozenInput(config.input, { signal }));
    const candidateBefore = await candidateIdentity(options.candidate, config.identity.candidateFiles);
    const release = path.join(options.work,'release');
    // Dereference dependencies: a copied relative node_modules symlink must not retarget.
    await cp(options.candidate, release, { recursive:true, dereference:true, filter: source => path.basename(source) !== '.git' });
    await candidateIdentity(release, config.identity.candidateFiles);
    const serviceRoot = path.join(options.work,'service');
    const cache = path.join(serviceRoot,'cache'), state = path.join(serviceRoot,'state');
    for (const directory of [serviceRoot, cache, state, path.join(serviceRoot,'home'), path.join(serviceRoot,'tmp'), path.join(serviceRoot,'logs'), path.join(options.work,'runtime')]) await mkdir(directory, { recursive:true, mode:0o700 });
    const launcher = path.join(options.work,'runtime/launcher');
    const native = await prepareOwnerBundle(release, launcher, { runtime });
    const mainRoot = path.join(options.work,'main');
    await cp(config.input.repoRoot, mainRoot, { recursive:true, dereference:true });
    const git = args => execute('git',['--no-optional-locks','-C',mainRoot,...args],{ signal, timeout:60000, maxBuffer:16*1024*1024 });
    requireValue((await git(['rev-parse','--show-toplevel'])).stdout.trim() === mainRoot, 'private git copy required');
    requireValue(contains(mainRoot,await realpath((await git(['rev-parse','--absolute-git-dir'])).stdout.trim())), 'private git metadata required');
    const seedRoot = path.join(options.work,'seed');
    await git(['worktree','add','--detach',seedRoot,config.input.head]);
    const main = { ...await workspace(mainRoot), sourceHash:config.oracle.classHash };
    const seed = await workspace(seedRoot);
    const original = await readFile(path.join(mainRoot,config.oracle.relativePath),'utf8');
    requireValue(sha256(original) === config.oracle.classHash, 'oracle input hash mismatch');
    const instanceId = `mac17-${randomUUID()}`;
    const entry = path.join(release,'dist/http-server.js');
    const environment = { PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME:path.join(serviceRoot,'home'), TMPDIR:path.join(serviceRoot,'tmp'),
      ILV2_RUNTIME_MANIFEST:process.env.ILV2_RUNTIME_MANIFEST, JAVA_LSP_CACHE_ROOT:cache, JAVA_LSP_OWNERSHIP_BASE:cache,
      JAVA_LSP_SERVICE_STATE_ROOT:state, GRADLE_USER_HOME:path.join(state,'jdt-gradle-home'), JAVA_LSP_PROJECTS_JSON:path.join(serviceRoot,'projects.json'),
      JDTLS_BIN:'/usr/bin/false', JAVA_LSP_ISOLATED_VALIDATION:'1', JAVA_LSP_HTTP_PORT:'38457', JAVA_LSP_HTTP_INSTANCE_ID:instanceId,
      JAVA_LSP_OWNER_TELEMETRY:path.join(options.out,'owner-telemetry.jsonl'), JAVA_LSP_OWNER_CPU_PROFILE:'0' };
    await writeJson(environment.JAVA_LSP_PROJECTS_JSON,{ aliases:[], defaults:{} });
    const plist = path.join(serviceRoot,'owner.plist');
    const binary = path.join(launcher,'dist/native/ilv2-mac');
    await writeFile(plist, renderLaunchAgent(await readFile(new URL('../macos/com.lky.codex-java-lsp-mcp.plist.template',import.meta.url),'utf8'),
      { label:config.label, runner:binary, runtimeDir:serviceRoot, logDir:path.join(serviceRoot,'logs'), cacheRoot:cache, serverEntry:entry, environment }), { mode:0o600 });
    const readback = JSON.parse((await execute('/usr/bin/plutil',['-convert','json','-o','-',plist])).stdout);
    requireValue(readback.Program === binary && readback.WorkingDirectory === serviceRoot && readback.ProgramArguments.includes(entry) && readback.AbandonProcessGroup === false && readback.ThrottleInterval === 1, 'plist readback mismatch');
    await writeJson(path.join(options.out,'plist-readback.json'), readback);
    await writeJson(path.join(options.out,'identity.json'), { config, planSha256:sha256(await readFile(options.plan)), candidateBefore, runtime, native, buildStamp:await readJson(path.join(release,'dist/build-stamp.json')), evidenceSources:{ runtime:'verifyRuntime', native:'actual fixed bundle codesign/manifest/binary', source:'candidate file hashes', process:'launchctl PID + endpoint + ps readback' } });
    lease = await acquireLaunchdFixtureSlot(MAC_WORK_ROOT,{ runRoot:serviceRoot,label:config.label,signal });
    const service = `gui/${process.getuid()}/${config.label}`;
    async function observe() {
      const printed = (await execute('/bin/launchctl',['print',service],{ timeout:5000 })).stdout;
      const pid = Number(/^\s*pid = (\d+)$/m.exec(printed)?.[1]);
      if (!pid) return false;
      const pgid = Number((await execute('/bin/ps',['-p',String(pid),'-o','pgid='],{ timeout:5000 })).stdout.trim());
      lease.observe(pid,pgid,'launchctl');
      const endpoint = await readJson(path.join(cache,'owner-endpoint.json')).catch(error => { if(error.code === 'ENOENT') return null; throw error; });
      if (!endpoint || endpoint.pid !== pid) return false;
      requireValue(endpoint.url === 'http://127.0.0.1:38457/mcp', 'endpoint URL mismatch');
      const comm = (await execute('/bin/ps',['-p',String(pid),'-o','comm='],{ timeout:5000 })).stdout.trim();
      const args = (await execute('/bin/ps',['-p',String(pid),'-o','args='],{ timeout:5000 })).stdout.trim();
      requireValue(comm === runtime.execPath || comm === runtime.nodeRealpath, 'owned PID is not frozen node');
      requireValue(args.includes(entry) && args.includes('owner-lock-guard.js'), 'owned PID entry/guard mismatch');
      requireValue(pgid === pid, 'owner does not lead process group');
      lease.observe(pid,pgid,'owner-ready');
      await verifyOwnerBundle(launcher,{ runtime }); await candidateIdentity(release,config.identity.candidateFiles);
      const healthResponse = await fetch('http://127.0.0.1:38457/healthz',{signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
      const health = await healthResponse.json();
      requireValue(healthResponse.ok && health.instanceId === instanceId && health.buildSha === (await readJson(path.join(release,'dist/build-stamp.json'))).gitSha,'health instance/build mismatch');
      const identity = { pid,pgid,comm,args,endpoint,health,launchctl:{ pid, state:/^\s*state = (.+)$/m.exec(printed)?.[1] } };
      await action('incarnation',identity); return identity;
    }
    let current;
    async function connect() { current = await poll(observe,30000,signal); client = new Client({ name:'mac17-canary',version:'1.0.0' }); await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:38457/mcp')), { signal, timeout:15000 }); }
    async function request(operation, parameters, callOptions = {}) {
      const expected = { repoRoot:parameters.repoRoot, workspaceId:parameters.workspaceId, relativePath:config.oracle.relativePath,
        name:parameters.query?.split('#')[1] ?? config.oracle.shape.name, fqn:parameters.query, sourceHash:parameters.sourceHash ?? main.sourceHash };
      const args = operation === 'status' ? {repoRoot:parameters.repoRoot,start:false} : {repoRoot:parameters.repoRoot,operation:'query',query:parameters.query,searchMode:'exact',preview:'none'};
      const result = await client.callTool({name:operation === 'status'?'java_status':'java_symbol',arguments:args},undefined,{signal:callOptions.signal ?? signal,timeout:callOptions.timeoutMs ?? 15000});
      requireValue(!result.isError,'MCP tool error: '+JSON.stringify(result.content));
      const raw = result.structuredContent ?? JSON.parse(result.content.find(row => row.type === 'text').text);
      const value = normalizeResult(raw,operation,expected);
      if (value.status !== 'OK' && !parameters.allowPolling) throw new Error('stable request returned unready result');
      return {value,payloadBytes:Buffer.byteLength(JSON.stringify(result))};
    }
    async function ready(target, query, sourceHash, budget, label) {
      const expected = { workspaceId:target.workspaceId,sourceHash,match:{relativePath:config.oracle.relativePath,name:query.split('#')[1] ?? config.oracle.shape.name,fqn:query} };
      await poll(async remainingMs => {
        const started = performance.now();
        let response,error;
        try { response = await request('query',{...target,query,sourceHash,allowPolling:true},{timeoutMs:Math.min(15000,remainingMs)}); }
        catch(failure) { error = failure.message; }
        await action(label,{elapsedMs:performance.now()-started,response,error});
        return response && evaluateOracle(response.value,expected);
      },budget,signal);
    }
    await lease.bootstrap(plist); await connect();
    await ready(main,config.oracle.shape.fqn,main.sourceHash,600000,'cold-full');
    const seedToken = 'mac17CanarySeed';
    const brace = original.lastIndexOf('}'); requireValue(brace>0,'oracle class closing brace required');
    let seedBytes = `${original.slice(0,brace)}\n public void ${seedToken}() {}\n${original.slice(brace)}`;
    await writeFile(path.join(seedRoot,config.oracle.relativePath),seedBytes);
    await ready(seed,`${config.oracle.shape.fqn}#${seedToken}`,sha256(seedBytes),600000,'seed-delta');
    const plans=[],allCalls=[],cacheObservations=[];
    async function metadata(stage) {
      const files=[];
      async function visit(dir,relative='') { for(const entry of await readdir(dir,{withFileTypes:true})) { const rel=path.join(relative,entry.name); if(entry.isDirectory()) await visit(path.join(dir,entry.name),rel); else if(entry.isFile()) { const info=await stat(path.join(dir,entry.name)); files.push({path:rel,size:info.size,mtimeMs:info.mtimeMs,...(entry.name==='binding.json'?{binding:await readJson(path.join(dir,entry.name))}:{})}); } } }
      await visit(cache); cacheObservations.push({stage,files}); await writeJson(path.join(options.out,`cache-${stage}.json`),files);
    }
    const telemetry = async () => (await readFile(environment.JAVA_LSP_OWNER_TELEMETRY,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
    const initialEvents=await telemetry();
    requireValue(initialEvents.some(row=>row.type==='round' && row.workspaceId===main.workspaceId && row.outcome==='published' && row.kind==='full'),'cold full publication telemetry missing');
    requireValue(initialEvents.some(row=>row.workspaceId===seed.workspaceId && row.seedFrom),'seedFrom telemetry missing');
    await metadata('initial');
    for (let phase=1;phase<=2;phase++) {
      const generated=makePhase({phase,durationMs:config.durationMs/2,normalRequests:Math.ceil(config.normalRequests/2),main,seed,oracle:config.oracle,original,seedBefore:seedBytes});
      const phaseOut=path.join(options.out,`phase-${phase}`); await mkdir(phaseOut);
      for(const slot of generated.plan.slots) if(slot.operation==='query') slot.parameters.sourceHash=slot.expected.sourceHash;
      await writeJson(path.join(phaseOut,'plan.json'),generated.plan); plans.push(generated.plan);
      const driver={driverDigest:sha256(JSON.stringify({instanceId,phase})),request:async(operation,parameters,opts)=>{
        const result=await request(operation,parameters,opts);
        // Stable oracle failures must abort this batch, rather than consuming the rest of its hour.
        if(!parameters.allowPolling && operation==='query') requireValue(evaluateOracle(result.value,{workspaceId:parameters.workspaceId,sourceHash:parameters.sourceHash,match:{relativePath:config.oracle.relativePath,name:config.oracle.shape.name,fqn:parameters.query}}),'stable oracle mismatch');
        return result;
      }};
      // replay records errors itself; abort the batch immediately on a nonpolling failure.
      const batch=new AbortController();
      const guarded={...driver,request:async(operation,parameters,opts)=>{try{return await driver.request(operation,parameters,opts);}catch(error){if(!parameters.allowPolling)batch.abort(error);throw error;}}};
      const result=await replay(generated.plan,guarded,{out:phaseOut,runRoot,signal:AbortSignal.any([signal,batch.signal])});
      allCalls.push(...await readCalls(path.join(phaseOut,'calls.jsonl'))); requireValue(result.status==='PASS',`phase ${phase} SLO failed`);
      seedBytes=generated.seedAfter;
      await action('phase-complete',{phase,result}); await metadata(`phase-${phase}`);
      if(phase===1){
        await client.close(); client=undefined;
        await action('planned-restart-before',{...current,window:'fault'});
        await execute('/bin/launchctl',['bootout',service],{timeout:10000});
        await poll(()=>!alive(current.pid)&&!alive(-current.pgid),10000,signal);
        await execute('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plist],{timeout:10000});
        const old=current; await connect(); requireValue(current.pid!==old.pid,'restart PID not changed');
        await ready(main,config.oracle.shape.fqn,main.sourceHash,30000,'restart-recovery');
        await action('planned-restart-after',{...current,window:'fault'});
      }
    }
    await writeFile(path.join(options.out,'calls.jsonl'),allCalls.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
    const result=normalEvidence(plans,allCalls,config.durationMs,config.normalRequests);
    const finalEvents=await telemetry();
    const sweeps=finalEvents.filter(row=>row.type==='sweep');
    const reclaimed=sweeps.flatMap(row=>row.report?.snapshots ?? []);
    const initialSnapshots=new Set(cacheObservations[0].files.filter(row=>row.path.startsWith('mac1/snapshots/')).map(row=>row.path.split('/')[2]));
    const finalSnapshots=new Set(cacheObservations.at(-1).files.filter(row=>row.path.startsWith('mac1/snapshots/')).map(row=>row.path.split('/')[2]));
    await writeJson(path.join(options.out,'resource-observations.json'),{sweeps,reclaimed,initialSnapshots:[...initialSnapshots],finalSnapshots:[...finalSnapshots],retiredThenGone:[...initialSnapshots].filter(id=>!finalSnapshots.has(id)),holdLease:'UNVERIFIED in this MCP run; reuse G14 invariant evidence separately',gcStatus:reclaimed.length?'OBSERVED':'UNVERIFIED'});
    await writeJson(path.join(options.out,'slo-result.json'),result); requireValue(result.status==='PASS','normal count/span/SLO failure');
    await candidateIdentity(options.candidate,config.identity.candidateFiles);
    requireValue(sha256(await readFile(path.join(mainRoot,config.oracle.relativePath))) === main.sourceHash,'main source drift');
    await action('candidate-after',{candidateFiles:config.identity.candidateFiles});
  } catch(error) { firstFailure={message:error.message,stack:error.stack}; }
  finally {
    if(client) try{await client.close();}catch(error){firstFailure??={message:error.message};}
    if(lease) try{closeout=await lease.close();}catch(error){closeout={status:'FAIL',message:error.message,...error.fixtureCloseout}; if(closeout.printObservation) closeout.printObservation={exitCode:closeout.printObservation.exitCode};firstFailure??={message:error.message};}
    if(outCreated){
      try{await writeJson(path.join(options.out,'input-after.json'),await verifyFrozenInput(config.input,{signal:AbortSignal.timeout(120000)}));}catch(error){firstFailure??={message:error.message};}
      await writeJson(path.join(options.out,'closeout.json'),{status:firstFailure?'FAIL':'PASS',firstFailure,closeout,endedAt:new Date().toISOString(),observations:{leaseAndGc:'UNVERIFIED: inspect actual owner-telemetry.jsonl and cache metadata; no synthetic hold lease'}});
    }
    clearTimeout(timer);
  }
  if(firstFailure)throw new Error(firstFailure.message);
}
if(isMain(import.meta.url))runCli(({signal})=>runCanary(cliOptions(process.argv.slice(2),['--candidate','--plan','--out','--work','--port']),signal));
