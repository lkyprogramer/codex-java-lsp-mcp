import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { normalizeResult, validateConfig, makePhase, normalEvidence } from './ilv2-mac-install-canary.mjs';
import { sha256 } from './ilv2-mac-contracts.mjs';
import { evaluateOracle } from './ilv2-mac-slo-report.mjs';
const now=Date.parse('2026-10-31T00:00:00Z');
const hash='a'.repeat(64);
const oracle={relativePath:'src/Example.java',classHash:hash,shape:{fqn:'sample.Example',name:'Example'}};
const expected={workspaceId:'w-private',repoRoot:'/private/tmp/main',relativePath:oracle.relativePath,sourceHash:hash,name:'Example',fqn:'sample.Example'};
const raw=()=>({scopeState:'READY',indexView:{state:'FRESH',workspaceId:'w-private',snapshotId:'s-private'},candidates:[{declaration:{relativePath:oracle.relativePath,contentHash:hash,name:'Example',fqn:'sample.Example'}}]});
test('actual MCP facts normalize and wrong workspace/hash cannot satisfy oracle',()=>{
  const value=normalizeResult(raw(),'query',expected);
  assert.equal(value.raw.candidates[0].declaration.contentHash,hash);
  assert.ok(evaluateOracle(value,{workspaceId:expected.workspaceId,sourceHash:hash,match:{name:'Example',fqn:'sample.Example',relativePath:oracle.relativePath}}));
  const wrongWorkspace=raw(); wrongWorkspace.indexView.workspaceId='w-other';
  assert.throws(()=>normalizeResult(wrongWorkspace,'query',expected),/workspace mismatch/);
  const wrongHash=raw(); wrongHash.candidates[0].declaration.contentHash='b'.repeat(64);
  assert.throws(()=>normalizeResult(wrongHash,'query',expected),/source hash mismatch/);
  const unready=raw(); unready.indexView.state='STALE';
  assert.equal(normalizeResult(unready,'query',expected).status,'NOT_READY');
  assert.throws(()=>normalizeResult({repoRoot:'/other',started:false},'status',expected),/workspace/);
  assert.throws(()=>normalizeResult({repoRoot:expected.repoRoot,started:true},'status',expected),/start/);
});
function config(){
  const runRoot='/private/tmp/canary-registration';
  const plan={schema:'ilv2-mac-install-canary/v1',runRoot,label:'com.lky.ilv2-mac17.unit',durationMs:7200000,normalRequests:1000,deadline:'2026-11-03T18:00:00+08:00',
    input:{repoRoot:path.join(os.userInfo().homedir,'Developer/inputs/frozen')},oracle,identity:{candidateFiles:Object.fromEntries(['dist/http-server.js','dist/build-stamp.json','dist/native/ilv2-mac','dist/native/manifest.json','package.json'].map(file=>[file,hash])),runtimeManifestSha256:hash,nodeSha256:hash}};
  return {runRoot,plan,options:{port:'38457',candidate:'/private/tmp/frozen-candidate',out:runRoot+'/raw/new',work:runRoot+'/tmp/new'}};
}
test('formal admission rejects production attachment, reused hierarchy and reduced gates',()=>{
  const c=config(); validateConfig(c.plan,c.options,c.runRoot,now);
  for(const [key,value] of [['port','38456'],['out','/private/tmp/out'],['work',c.options.out]])assert.throws(()=>validateConfig(c.plan,{...c.options,[key]:value},c.runRoot,now));
  assert.throws(()=>validateConfig({...c.plan,durationMs:1000},c.options,c.runRoot,now),/two-hour/);
  assert.throws(()=>validateConfig({...c.plan,normalRequests:999},c.options,c.runRoot,now),/1000/);
  assert.throws(()=>validateConfig({...c.plan,label:'com.lky.codex-java-lsp-mcp'},c.options,c.runRoot,now),/label/);
  assert.throws(()=>validateConfig({...c.plan,oracle:{...oracle,relativePath:'../outside.java'}},c.options,c.runRoot,now),/relative/);
});
function phases(){
  const original='package sample; public class Example {}\n';
  const main={repoRoot:'/private/tmp/main',workspaceId:'w-main',sourceHash:sha256(original)};
  const seed={repoRoot:'/private/tmp/seed',workspaceId:'w-seed'};
  const one=makePhase({phase:1,durationMs:3600000,normalRequests:500,main,seed,oracle,original,seedBefore:original});
  const two=makePhase({phase:2,durationMs:3600000,normalRequests:500,main,seed,oracle,original,seedBefore:one.seedAfter});
  return [one.plan,two.plan];
}
test('two phases contain 20 chained real edits and 1000 normal requests spanning both hours',()=>{
  const plans=phases(); const edits=plans.flatMap(p=>p.slots.filter(s=>s.edit));
  assert.equal(edits.length,20); assert.equal(new Set(edits.map(s=>s.parameters.query)).size,20);
  for(let i=1;i<edits.length;i++)assert.equal(edits[i].edit.beforeHash,sha256(edits[i-1].edit.utf8));
  for(const plan of plans){assert.equal(plan.slots.filter(s=>!s.edit).length,500);assert.equal(plan.slots.filter(s=>s.operation==='status').length,50);assert.equal(plan.slots.at(-1).atMs,3600000);}
  assert.equal(normalEvidence(plans,[],7200000,1000).status,'FAIL');
});
function calls(plans){return plans.flatMap((plan,p)=>plan.slots.map((slot,i)=>{
  const start=BigInt(Math.round((slot.atMs+p*3601000)*1e6)); const elapsedMs=slot.operation==='status'?10:20;
  return {...slot,kind:'slot',slotId:slot.id,sampleId:`${p}-${i}`,startedAt:'2026-11-01T00:00:00Z',startMonoNs:String(start),endMonoNs:String(start+BigInt(elapsedMs*1e6)),elapsedMs,maxAttemptMs:elapsedMs,firstCorrectMs:slot.operation==='query'?20:null,readOnly:slot.operation==='status',status:'PASS',response:slot.operation==='query'?{status:'OK',workspaceId:slot.workspaceId,sourceHash:slot.expected.sourceHash,snapshotId:'s-test',...slot.expected.match}:{status:'OK'}};
}));}
test('normal denominator excludes edits/faults and cannot certify compressed span or slow edits',()=>{
  const plans=phases(); const samples=calls(plans); const result=normalEvidence(plans,samples,7200000,1000);
  assert.equal(result.status,'PASS'); assert.equal(result.normalRequests,1000);assert.equal(result.edits,20);
  assert.equal(normalEvidence(plans,samples,9000000,1000).status,'FAIL');
  const slow=samples.map(row=>row.slotId.includes('-edit-')?{...row,firstCorrectMs:4000}:row);
  assert.equal(normalEvidence(plans,slow,7200000,1000).status,'FAIL');
  assert.equal(normalEvidence(plans,samples.filter(row=>!row.slotId.endsWith('normal-499')),7200000,1000).status,'FAIL');
});
