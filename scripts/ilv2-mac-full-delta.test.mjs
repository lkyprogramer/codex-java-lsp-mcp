import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,readFile,readdir,rm,rmdir,stat,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {execute} from './ilv2-mac-contracts.mjs';
import {LIMITS,deltaModeFault,freshFullFault,historyTiers,historyTierState,runFullDelta,timingVerdict} from './ilv2-mac-full-delta.mjs';

const git=(cwd,...args)=>execute('git',['-C',cwd,'-c','user.name=ilv2','-c','user.email=ilv2@example.invalid','-c','commit.gpgsign=false','-c','init.defaultBranch=main',...args]);
// Oldest first; null deletes. Covers modify, add, delete, a signature change, a
// path changed in both tiers with different bytes, and a directory only the old tree has.
const HISTORY=[
 {'A.java':'class A { int value() { return 1; } }','B.java':'class B { int value() { return new A().value(); } }','C.java':'class C { int value() { return 1; } }','old/D.java':'package old; class D { int value() { return 1; } }'},
 {'A.java':'class A { int value() { return 2; } int extra() { return 0; } }','C.java':'class C extends A { int value() { return 15; } }','old/D.java':null,'E.java':'class E extends C { }'},
 {'A.java':'class A { long value() { return 3; } }','B.java':'class B { long value() { return new A().value() + new C().value(); } }'},
 {'F.java':'interface F { int value(); }','C.java':'class C { int value() { return new B().hashCode(); } }'}
];
const HEAD={'A.java':HISTORY[2]['A.java'],'B.java':HISTORY[2]['B.java'],'C.java':HISTORY[3]['C.java'],'E.java':HISTORY[1]['E.java'],'F.java':HISTORY[3]['F.java']};

async function historyRepo(root){
 const history=path.join(root,'history'),java=path.join(history,'src/main/java');await mkdir(java,{recursive:true});
 await git(history,'init','-q');
 for(const commit of HISTORY){
  for(const [name,text] of Object.entries(commit)){const file=path.join(java,name);if(text===null){await rm(file);if((await readdir(path.dirname(file))).length===0) await rmdir(path.dirname(file));}else{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}}
  await git(history,'add','-A');await git(history,'commit','-qm','step');
 }
 const repo=path.join(root,'repo');await cp(history,repo,{recursive:true,filter:source=>source!==path.join(history,'.git')});
 return {history,repo};
}
async function assertHeadTree(repo){
 const java=path.join(repo,'src/main/java');
 for(const [name,text] of Object.entries(HEAD)) assert.equal(await readFile(path.join(java,name),'utf8'),text,`${name} is restored`);
 await assert.rejects(stat(path.join(java,'old')),{code:'ENOENT'},'a directory only the old tree has is removed again');
}

test('history tiers select deterministic first-parent ranges within each cap and reject an empty tier',async()=>{
 const root=await mkdtemp(path.join(process.env.ILV2_RUN_ROOT,'tmp','driver-tiers-'));
 try{
  const {history}=await historyRepo(root);
  const tiers=await historyTiers(history,[2,6]);
  assert.deepEqual(tiers.map(tier=>[tier.cap,tier.depth,tier.rows.length]),[[2,1,2],[6,3,6]]);
  assert.deepEqual(tiers[1].rows.filter(row=>row.absent).map(row=>row.path).sort(),['src/main/java/E.java','src/main/java/F.java']);
  assert.deepEqual(tiers[1].rows.filter(row=>row.headAbsent).map(row=>row.path),['src/main/java/old/D.java']);
  await assert.rejects(historyTiers(history,[1]),/selected first-parent range has 0 Java files; requires more than 0 and at most 1/);
  await assert.rejects(historyTiers(history,[2,3]),/more than 2 and at most 3/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('history tier checkout preserves filtered bytes, unusual paths, symlink bytes and add/delete state',async()=>{
 const root=await mkdtemp(path.join(process.env.ILV2_RUN_ROOT,'tmp','driver-filtered-tier-'));
 try{
  const history=path.join(root,'history');await mkdir(history);
  await git(history,'init','-q');await git(history,'config','core.autocrlf','false');
  await writeFile(path.join(history,'.gitattributes'),'*.java text eol=crlf\n');
  const names=['space name.java','tab\tname.java','line\nname.java','deleted.java','empty.java'];
  for(const name of names) await writeFile(path.join(history,name),name==='empty.java'?'':'// original Ω\nclass Before {}\n');
  await symlink('space name.java',path.join(history,'linked.java'));
  await git(history,'add','-A');await git(history,'commit','-qm','before');
  for(const name of names) if(name==='deleted.java') await rm(path.join(history,name));else await writeFile(path.join(history,name),'class After {}\n');
  await rm(path.join(history,'linked.java'));await symlink('empty.java',path.join(history,'linked.java'));
  const added='added space\tand\nline.java';await writeFile(path.join(history,added),'class Added {}\n');
  await git(history,'add','-A');await git(history,'commit','-qm','after');
  const [tier]=await historyTiers(history,[7]);
  assert.deepEqual([tier.cap,tier.depth,tier.rows.length],[7,1,7]);
  const originalIndex=await readFile(path.join(history,'.git','index'));
  const state=await historyTierState(history,tier);
  assert.deepEqual(await readFile(path.join(history,'.git','index')),originalIndex,'the frozen input index is unchanged');
  assert.deepEqual(state.get('linked.java'),Buffer.from('space name.java'),'symlink target bytes are read without following the link');
  assert.deepEqual([...state.keys()],tier.rows.map(row=>row.path));
  assert.equal(state.get(added),null);assert.equal(tier.rows.find(row=>row.path==='deleted.java').headAbsent,true);
  for(const row of tier.rows){
   if(row.absent) continue;
   const expected=(await execute('git',['--no-optional-locks','-C',history,'cat-file','--filters',`${tier.commit}:${row.path}`],{encoding:'buffer'})).stdout;
   assert.deepEqual(state.get(row.path),expected,row.path);
   if(expected.length && row.path!=='linked.java') assert.ok(expected.includes(Buffer.from('\r\n')),'checkout filters apply CRLF');
  }
  assert.equal(state.get('empty.java').length,0,'empty files keep their bytes');
  const row=tier.rows.find(row=>!row.absent);
  await assert.rejects(historyTierState(history,{commit:'f'.repeat(tier.commit.length),rows:[row]}),'an invalid commit must fail');
  const blob=(await git(history,'rev-parse',`${tier.commit}:empty.java`)).stdout.trim();
  await assert.rejects(historyTierState(history,{commit:blob,rows:[row]}),'a non-tree object cannot initialize the temporary index');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('full-delta-driver-chains-history-tiers-to-one-oracle-and-records-every-step',async()=>{
 const root=await mkdtemp(path.join(process.env.ILV2_RUN_ROOT,'tmp','driver-smoke-'));
 try{
 const {history,repo}=await historyRepo(root);
 const result=await runFullDelta({repo,history,out:path.join(root,'matrix'),changes:[2,6]});
 assert.equal(result.copyMode,'NATIVE_CLONE');
 assert.equal(result.fullDeterministic,true);assert.equal(result.full[1].parseAfterEditInjected,true);assert.equal(result.falsifiers.length,0);
 // Tiers 2,6 are not the gate tiers: never PASS (a busy host makes it INVALID_EXPERIMENT); correctness holds either way.
 assert.ok(['DIAGNOSTIC_ONLY','INVALID_EXPERIMENT'].includes(result.status),result.status);
 assert.deepEqual(result.notGated,['changes 2,6 are not the gate tiers 20,200']);
 assert.deepEqual(result.tiers.map(tier=>[tier.cap,tier.javaFiles,tier.absentAtTier,tier.absentAtHead]),[[2,2,1,0],[6,6,2,1]]);
 assert.ok(result.slices.some(s=>s.inputMode==='verified-reconcile'));
 assert.equal(result.workspaceStat.sharedAcrossCases,false);
 assert.equal(result.workspaceStat.baselinePairSealed,true);
 for(const slice of result.slices){
  assert.equal(slice.initialStatHash,result.workspaceStat.baselineStatHash);
  assert.equal(slice.baselineStatHash,result.workspaceStat.baselineStatHash);
  assert.ok(Number.isFinite(slice.statPages.changed));
  assert.equal(slice.stagePages,undefined,'non-diagnostic windows take no stage snapshots');
  assert.ok(Number.isFinite(slice.samples[0].cpuMs) && Number.isFinite(slice.samples[0].unattributedMs));
  assert.equal(slice.samples[0].idle, [slice.samples[0].host.start.load1, slice.samples[0].host.end.load1].every(load1=>load1<20));
 }
 const progress=JSON.parse(await readFile(path.join(root,'matrix','full-delta-progress.json'),'utf8'));
 assert.equal(progress.idleLoad1Limit,20);
 assert.equal(progress.status,result.status);
 assert.deepEqual(Object.values(progress.steps).filter(step=>step.status==='NOT_RUN'),[]);
 assert.equal(progress.steps['delta-6'].status,'NOT_GATED','a tier without a limit is measured, not gated');
 for(const tier of progress.tiers) assert.equal(progress.notGated.some(reason=>reason.startsWith(`tier ${tier.cap} `)),tier.javaFiles<tier.cap/2,`tier ${tier.cap} fill`);
 assert.deepEqual(Object.keys(progress.steps['oracle-compare'].finalDigests).sort(),['chain-2-6','delta-6']);
 // A, B, C (both tiers, different bytes), D (re-created), E (removed); F is absent in both trees.
 assert.equal(progress.steps['chain-2-6'].files,5);
 assert.equal(progress.steps['full-determinism'].status,'PASS');
 for(const name of ['full-1','full-2']){assert.equal(progress.steps[name].correctness,'PASS');assert.ok(['PASS','INVALID_EXPERIMENT'].includes(progress.steps[name].timing.verdict));assert.ok(progress.steps[name].query.hash);}
 assert.equal(progress.steps['oracle-full'].timing.verdict,'NOT_GATED');
 const delta=result.slices.find(s=>s.cap===2);assert.equal(delta.result.stages.parse.javaFiles,1,'the added file of the small tier is deleted, one file is parsed');
 await assertHeadTree(repo);
 const resumed=await runFullDelta({repo,history,out:path.join(root,'resumed'),changes:[2],resumeBase:path.join(root,'matrix'),costOnly:true,diagnostic:true});
 assert.equal(resumed.diagnosticOnly,true);assert.ok(resumed.notGated.includes('carried-over base: no fresh full'));assert.equal(resumed.slices.filter(s=>s.count>0).length,1);
 assert.equal(resumed.slices.find(s=>s.cap===2).digest.digest,delta.digest.digest);assert.ok(resumed.notRun.includes('independent-oracle'));
 assert.ok(resumed.slices.find(s=>s.cap===2).stagePages.length>=3,'diagnostic mode keeps per-stage page costs');
 await assertHeadTree(repo);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('full-delta-driver-stops-at-the-first-falsifier-restores-the-tree-and-marks-the-rest-not-run',async()=>{
 const root=await mkdtemp(path.join(process.env.ILV2_RUN_ROOT,'tmp','driver-fail-'));
 try{
  const {history}=await historyRepo(root);const repo=path.join(root,'repos','materialized');
  await assert.rejects(runFullDelta({repo,history,out:path.join(root,'matrix'),work:path.join(root,'work'),changes:[2,6],limits:{...LIMITS,deltaMs:{2:LIMITS.deltaMs[20],6:0}},idleLoad1Limit:Infinity}),/delta-6 first correct query/);
  const progress=JSON.parse(await readFile(path.join(root,'matrix','full-delta-progress.json'),'utf8'));
  assert.equal(progress.status,'FAIL');assert.equal(progress.steps['delta-6'].status,'FAIL');assert.equal(progress.steps['delta-2'].status,'PASS');
  // Overridden limits can still falsify, never certify.
  assert.ok(progress.notGated.includes('limits differ from the gate limits')&&progress.notGated.includes('idle load1 limit Infinity is not 20'),JSON.stringify(progress.notGated));
  assert.equal(progress.input.materialized,true,'an absent copy is materialized from the frozen worktree');
  await stat(path.join(root,'work','sealed','facts.sqlite'));await assert.rejects(stat(path.join(root,'matrix','sealed')),{code:'ENOENT'},'databases stay in the work dir, reports in out');
  for(const step of ['chain-2-6','oracle-full','oracle-compare','full-2','full-determinism']) assert.equal(progress.steps[step].status,'NOT_RUN',step);
  await assertHeadTree(repo);
  await assert.rejects(runFullDelta({repo,history,out:path.join(root,'matrix'),work:path.join(root,'work-2'),changes:[2]}),/must be absent or empty/,'a rerun cannot reuse earlier outputs');
  await assert.rejects(runFullDelta({repo,history,out:path.join(root,'resumed'),changes:[2],resumeBase:path.join(root,'work')}),/only feeds a cost-only or correctness-only run/);
  await writeFile(path.join(repo,'src/main/java/A.java'),'class A { }');
  await assert.rejects(runFullDelta({repo,history,out:path.join(root,'drifted'),changes:[2]}),/source copy differs from the frozen input/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a timed full must be fresh and a delta job must stay a delta',()=>{
 const full={mode:'full',capture:{files:3},parse:{files:3}};
 assert.equal(freshFullFault(full),undefined);
 assert.match(freshFullFault({...full,parse:{files:1}}),/resumed full: parsed 1 of 3/);
 assert.match(freshFullFault({...full,mode:'delta'}),/not a full/);
 assert.equal(deltaModeFault({mode:'delta'}),undefined);
 assert.equal(deltaModeFault({mode:'full',reason:'delta escalated to full: dependency closure 401 > 400 files'}),'ESCALATED_FULL: delta escalated to full: dependency closure 401 > 400 files');
 assert.match(deltaModeFault(undefined),/^ESCALATED_FULL: job reported no pipeline metrics/);
});

test('timing verdicts need an idle host and re-measure near the threshold',()=>{
 const idle=ms=>({ms,idle:true});
 assert.equal(timingVerdict([{ms:1,idle:false}],100).verdict,'INVALID_EXPERIMENT');
 assert.equal(timingVerdict([idle(50)],100).verdict,'PASS');
 assert.equal(timingVerdict([idle(150)],100).verdict,'FAIL');
 assert.equal(timingVerdict([idle(97)],100).verdict,'INCONCLUSIVE');
 assert.equal(timingVerdict([idle(97),idle(120)],100).verdict,'INCONCLUSIVE','a near-limit first sample commits to all three samples');
 assert.equal(timingVerdict([idle(103),idle(50)],100).verdict,'INCONCLUSIVE','a fast second sample does not end a committed remeasurement');
 assert.deepEqual(timingVerdict([idle(97),idle(120),idle(99)],100),{verdict:'PASS',median:99});
 assert.equal(timingVerdict([idle(100),idle(100),idle(100)],100,{strict:true}).verdict,'FAIL');
 assert.equal(timingVerdict([idle(9e9)],Infinity).verdict,'UNBOUNDED');
});

 test('full cost failure stops before logical inspection and leaves later steps not run',async()=>{
 const root=await mkdtemp(path.join(process.env.ILV2_RUN_ROOT,'tmp','driver-full-fail-'));
 try{
  const {history,repo}=await historyRepo(root);
  await assert.rejects(runFullDelta({repo,history,out:path.join(root,'matrix'),work:path.join(root,'work'),changes:[2,6],limits:{...LIMITS,fullMs:0},idleLoad1Limit:Infinity}),/full .* ms > 0 ms/);
  const progress=JSON.parse(await readFile(path.join(root,'matrix','full-delta-progress.json'),'utf8'));
  const first=progress.steps['full-1'];
  assert.equal(first.status,'FAIL');assert.equal(first.correctness,'NOT_RUN');
  assert.equal(first.digest,undefined);assert.equal(first.verificationMs,undefined);
  assert.ok(first.query.hash,'the timed full did perform its first correct query');
  for(const step of ['base-invariants','delta-reconcile','delta-empty','delta-2','delta-6','oracle-full','full-2']) assert.equal(progress.steps[step].status,'NOT_RUN',step);
  await assertHeadTree(repo);
 }finally{await rm(root,{recursive:true,force:true});}
});

 test('unexpected execution errors finish the ledger and mark later steps not run',async()=>{
 const root=await mkdtemp(path.join(process.env.ILV2_RUN_ROOT,'tmp','driver-error-'));
 try{
  const {history,repo}=await historyRepo(root);
  await writeFile(path.join(repo,'src/main/java/A.java'),'class Drift {}');
  await assert.rejects(runFullDelta({repo,history,out:path.join(root,'matrix'),work:path.join(root,'work'),changes:[2,6]}),/source copy differs/);
  const progress=JSON.parse(await readFile(path.join(root,'matrix','full-delta-progress.json'),'utf8'));
  assert.equal(progress.status,'FAIL');assert.match(progress.executionError.message,/source copy differs/);
  for(const name of ['full-1','base-invariants','delta-reconcile','delta-2','delta-6','chain-2-6','oracle-full','full-2']) assert.equal(progress.steps[name].status,'NOT_RUN',name);
 }finally{await rm(root,{recursive:true,force:true});}
});

 test('correctness-only can reuse a matching sealed base without certifying timing or page costs',async()=>{
 const root=await mkdtemp(path.join(process.env.ILV2_RUN_ROOT,'tmp','driver-correctness-'));
 try{
  const {history,repo}=await historyRepo(root);
  const limits={...LIMITS,fullMs:0,noopMs:0,deltaMs:{2:0,6:0},pageRatio:{2:0,6:0}};
  const first=await runFullDelta({repo,history,out:path.join(root,'first'),work:path.join(root,'base'),changes:[2,6],correctnessOnly:true,limits});
  assert.equal(first.copyMode,'BYTE_COPY_NOT_NATIVE');
  assert.equal(first.status,'DIAGNOSTIC_ONLY');assert.equal(first.correctness,'PASS');assert.ok(first.notGated.includes('correctness-only'));
  const stamp=new URL('../dist/build-stamp.json',import.meta.url),stampBytes=await readFile(stamp);
  let result;
  try{
   await writeFile(stamp,JSON.stringify({...JSON.parse(stampBytes),generatedAt:'test-only-new-build-time'}));
   result=await runFullDelta({repo,history,out:path.join(root,'resumed'),work:path.join(root,'resumed-work'),changes:[2,6],resumeBase:path.join(root,'base'),correctnessOnly:true,limits});
  }finally{await writeFile(stamp,stampBytes);}
  const runtime=new URL('../dist/java-index/build-fingerprint.js',import.meta.url),runtimeBytes=await readFile(runtime);
  try{
   await writeFile(runtime,Buffer.concat([runtimeBytes,Buffer.from('\n// test-only changed runtime identity\n')]));
   await assert.rejects(runFullDelta({repo,history,out:path.join(root,'runtime-drift'),work:path.join(root,'runtime-drift-work'),changes:[2,6],resumeBase:path.join(root,'base'),correctnessOnly:true,limits}),/different base key/);
  }finally{await writeFile(runtime,runtimeBytes);}
  assert.equal(result.status,'DIAGNOSTIC_ONLY');assert.equal(result.correctness,'PASS');assert.equal(result.fullDeterministic,true);
  const progress=JSON.parse(await readFile(path.join(root,'resumed','full-delta-progress.json'),'utf8'));
  assert.equal(progress.copyMode,'BYTE_COPY_NOT_NATIVE');assert.equal(result.copyMode,'BYTE_COPY_NOT_NATIVE');
  assert.ok(progress.notClaimed.includes('BYTE_COPY_NOT_NATIVE'));assert.ok(result.notClaimed.includes('BYTE_COPY_NOT_NATIVE'));
  assert.equal(progress.correctness,'PASS');assert.equal(progress.steps['full-1'].status,'CARRIED_OVER');assert.equal(progress.steps['full-1'].timing.verdict,'NOT_GATED');
  assert.equal(progress.steps['full-2'].timing.verdict,'NOT_GATED');assert.equal(result.full[1].samples.length,1);
  for(const slice of result.slices){assert.equal(slice.timing.verdict,'NOT_GATED');assert.equal(slice.samples.length,1);assert.ok(Number.isFinite(slice.pages.ratio));}
  assert.equal(progress.steps['oracle-compare'].status,'PASS');assert.equal(progress.steps['full-determinism'].status,'PASS');
  await assertHeadTree(repo);
  await assert.rejects(runFullDelta({repo,history,out:path.join(root,'both'),work:path.join(root,'both-work'),changes:[2],resumeBase:path.join(root,'base'),correctnessOnly:true,costOnly:true}),/mutually exclusive/);
 }finally{await rm(root,{recursive:true,force:true});}
});
