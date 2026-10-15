#!/usr/bin/env node
// Test-only direct full/delta driver. Source is an owned isolated clone; no publisher or tracker claim.
//
// Contract (verification.md §5.5 "MAC-05 full/delta runner"):
//  - the source copy must equal the frozen input worktree (an absent --repo is
//    materialized from it first), and the edit load is
//    its real history: tier `cap` reverts the Java files of a deterministic
//    first-parent range HEAD~k..HEAD that changes at most `cap` of them, with
//    the additions, deletions and modifications the range has; XML and build
//    files stay at HEAD and are counted, not applied;
//  - checks run in cost order and the first failure stops the run; every value
//    is written to full-delta-progress.json as soon as it exists, and steps
//    never reached are NOT_RUN;
//  - a timed window holds the job, checkpoint and its first correct query: stage
//    snapshots run only in the diagnostic mode, whose delta timings are not
//    gated;
//  - a timing is valid only on an idle host (load1/cpu <= 1.0 at start and
//    end); within 5% of its threshold it is re-measured to a median of 3;
//  - every published state passes the index invariants, and correctness is a
//    chain: base -> D(small) -> D(small->large) and base -> D(large) both equal
//    one fresh full of the large tree; two fulls of HEAD are equal;
//  - a carried-over sealed base is reused only under the same base key
//    (schema, facts revision, dist digest, node, input census);
//  - correctness-only disables cost gates and repeats, and may reuse a same-key base;
//    correctness PASS never certifies G05 or timing;
//  - only a gate run (tiers 20,200, fresh full, no diagnostic or cost-only
//    mode) can PASS; any other run ends FAIL, INVALID_EXPERIMENT or
//    DIAGNOSTIC_ONLY. Each run takes fresh (absent or empty) out/work dirs;
//    a timed full must be a fresh full and a delta must stay a delta.
import assert from 'node:assert/strict';
import {constants as fsConstants} from 'node:fs';
import {copyFile,mkdtemp,mkdir,readdir,readFile,realpath,rm,rmdir,stat,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliOptions,execute,isMain,relevantInput,requireUnprotectedRoot,runCli,sha256,writeJson} from './ilv2-mac-contracts.mjs';
import {cloneSealedDatabase} from '../dist/mac-platform/clonefile.js';
import {createHash} from 'node:crypto';
import {pageDiff} from './ilv2-mac-snapshot-equivalence.mjs';

const modules=async()=>Object.assign({},...await Promise.all(['sql/driver','sql/schema','sql/logical-export','sql/entity-search','sql/rows','sql/index-invariants','build-fingerprint'].map(name=>import(new URL(`../dist/java-index/${name}.js`,import.meta.url)))),await import('../dist/index-builder/cold-build.js'),await import('../dist/index-builder/incremental.js'));

export const LIMITS={fullMs:327900,noopMs:2500,deltaMs:{20:5000,200:15000},pageRatio:{20:0.1,200:0.3}};
const IDLE_LOAD_PER_CPU=1.0,BAND=0.05,SAMPLES=3,TIER_FILL=0.5;
export const GATE_CHANGES=[20,200];

export function hostLoad(){const [load1]=os.loadavg();const cpus=os.availableParallelism?.() ?? os.cpus().length;return {load1,cpus,perCpu:load1/cpus};}

/** PASS/FAIL against a limit; `strict` limits fail at equality (the noop budget). */
/** Why a job's metrics are not a delta (an escalated or fallback full), or undefined. */
export function deltaModeFault(stages){
 if(stages?.mode==='delta') return undefined;
 return `ESCALATED_FULL: ${stages?.reason ?? 'job reported no pipeline metrics'}`;
}

/** Why a cold build's metrics are not one fresh full of every captured file, or undefined. */
export function freshFullFault(stages){
 if(stages?.mode!=='full') return `not a full: ${stages?.mode}`;
 if(stages.parse?.files!==stages.capture?.files) return `resumed full: parsed ${stages.parse?.files} of ${stages.capture?.files} captured files`;
 return undefined;
}

export function timingVerdict(samples,limit,{strict=false}={}){
 const sorted=samples.map(sample=>sample.ms).sort((a,b)=>a-b);const median=sorted[Math.floor(sorted.length/2)];
 if(!Number.isFinite(limit)) return {verdict:'UNBOUNDED',median};
 if(samples.some(sample=>!sample.idle)) return {verdict:'INVALID_EXPERIMENT',reason:'host load/cpu above the idle limit at a window edge'};
 if(samples.length<SAMPLES && (samples.length>1 || Math.abs(median-limit)<=limit*BAND)) return {verdict:'INCONCLUSIVE',median};
 return {verdict:(strict?median<limit:median<=limit)?'PASS':'FAIL',median};
}

const git=(root,args,encoding='utf8')=>execute('git',['--no-optional-locks','-C',root,...args],{maxBuffer:512*1024*1024,encoding}).then(result=>result.stdout);
const nul=text=>text.split('\0').filter(Boolean);
/** Java paths that differ from HEAD, including tabs/newlines in NUL-delimited names. */
async function javaRange(history,from){
 const parts=nul(await git(history,['diff','--no-renames','--name-status','-z',from,'HEAD','--','*.java']));
 const rows=[];for(let index=0;index<parts.length;index+=2) rows.push({path:parts[index+1],absent:parts[index]==='A',headAbsent:parts[index]==='D'});
 return rows;
}

/** A private index and checkout apply Git's filters without changing the frozen input's index or worktree. */
export async function historyTierState(history,tier){
 const present=tier.rows.filter(row=>!row.absent);
 if(!present.length) return new Map(tier.rows.map(row=>[row.path,null]));
 const temporary=await mkdtemp(path.join(os.tmpdir(),'ilv2-history-tier-'));
 let failure;
 try{
  const tree=path.join(temporary,'tree');await mkdir(tree);
  const options={env:{...process.env,GIT_INDEX_FILE:path.join(temporary,'index')},maxBuffer:512*1024*1024};
  await execute('git',['--no-optional-locks','-C',history,'read-tree',tier.commit],options);
  const request=Buffer.from(present.map(row=>{
   assert.ok(!row.path.includes('\0'),'tier path contains NUL');return `${row.path}\0`;
  }).join(''));
  const operation=execute('git',['--no-optional-locks','-C',history,'-c','core.symlinks=false','checkout-index',`--prefix=${tree}${path.sep}`,'--stdin','-z'],options);
  let inputError;
  operation.child.stdin.on('error',error=>{inputError??=error;});
  try{operation.child.stdin.end(request);}catch(error){inputError??=error;}
  // Await the real process close even on EPIPE; a Git failure takes precedence over its stdin error.
  await operation;
  if(inputError) throw inputError;
  return new Map(await Promise.all(tier.rows.map(async row=>[row.path,row.absent?null:await readFile(path.join(tree,row.path))])));
 }catch(error){failure=error;throw error;}
 finally{
  await rm(temporary,{recursive:true,force:true}).catch(error=>{
   if(!failure) throw error;
   console.error(JSON.stringify({phase:'history-tier-cleanup-failed',error:String(error)}));
  });
 }
}

/** Exponential probes and binary search select a deterministic range within
 * each cap. Net diffs need not be monotone: this does not prove the longest
 * possible range, and an undersized selection cannot certify the gate. */
export async function historyTiers(history,caps){
 const commits=(await git(history,['rev-list','--first-parent','HEAD'])).trim().split('\n');
 const sizes=new Map();
 const size=async depth=>{if(!sizes.has(depth)) sizes.set(depth,(await javaRange(history,commits[depth])).length);return sizes.get(depth);};
 const tiers=[];
 for(const cap of caps){
  let lo=0,hi=1;
  while(hi<commits.length && await size(hi)<=cap){lo=hi;hi*=2;}
  hi=Math.min(hi,commits.length);
  while(hi-lo>1){const mid=(lo+hi)>>1;if(await size(mid)<=cap) lo=mid;else hi=mid;}
  const rows=await javaRange(history,commits[lo]);const floor=tiers.at(-1)?.cap??0;
  assert.ok(rows.length>floor,`selected first-parent range has ${rows.length} Java files; requires more than ${floor} and at most ${cap}`);
  const held={xml:0,build:0};
  for(const file of nul(await git(history,['diff','--no-renames','--name-only','-z',commits[lo],'HEAD']))){
   if(file.endsWith('.java')) continue;
   if(file.endsWith('.xml')) held.xml+=1;else if(relevantInput(file)) held.build+=1;
  }
  tiers.push({cap,depth:lo,commit:commits[lo],head:commits[0],rows,heldAtHead:held});
 }
 return tiers;
}

async function listFiles(root,keep,relative=''){
 const out=[];
 for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
  const name=relative?`${relative}/${entry.name}`:entry.name;
  if(entry.isDirectory()){if(!(relative==='' && entry.name==='.git')) out.push(...await listFiles(root,keep,name));}
  else if(entry.isFile() && keep(name)) out.push(name);
 }
 return relative?out:out.sort();
}

/** The copy holds exactly the frozen worktree's build inputs, byte for byte. */
async function verifyCopy(history,repo){
 const [frozen,copy]=await Promise.all([listFiles(history,relevantInput),listFiles(repo,relevantInput)]);
 assert.deepEqual(copy,frozen,'source copy census differs from the frozen input');
 const census=createHash('sha256');
 for(const file of frozen){
  const [left,right]=await Promise.all([readFile(path.join(history,file)),readFile(path.join(repo,file))]);
  assert.ok(left.equals(right),`source copy differs from the frozen input at ${file}`);census.update(`${file}\0${sha256(right)}\n`);
 }
 return {head:(await git(history,['rev-parse','HEAD^{commit}'])).trim(),files:frozen.length,census:census.digest('hex')};
}

async function materializeCopy(history,repo){
 for(const file of await listFiles(history,relevantInput)){const target=path.join(repo,file);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(history,file),target);}
}

/** Builder runtime under dist/: exclude tests, maps, declarations and the broker-only generated build stamp. */
async function distDigest(){
 const dist=fileURLToPath(new URL('../dist/',import.meta.url));const hash=createHash('sha256');
 const runtime=name=>name!=='build-stamp.json' && !/\.test\.[cm]?js$/.test(name) && !name.endsWith('.map') && !name.endsWith('.d.ts');
 for(const file of await listFiles(dist,runtime)) hash.update(`${file}\0${sha256(await readFile(path.join(dist,file)))}\n`);
 return hash.digest('hex');
}

const readOrNull=file=>readFile(file).catch(error=>{if(error.code==='ENOENT') return null;throw error;});
const unlinkIfPresent=file=>unlink(file).catch(error=>{if(error.code!=='ENOENT') throw error;});
const exists=file=>stat(file).then(()=>true,error=>{if(error.code==='ENOENT') return false;throw error;});
const requireFresh=async directory=>{const entries=await readdir(directory).catch(error=>{if(error.code==='ENOENT') return [];throw error;});assert.equal(entries.length,0,`${directory} must be absent or empty; give each run fresh --out/--work dirs`);};

export async function runFullDelta({repo,history,out,work=out,changes=GATE_CHANGES,resumeBase,costOnly=false,correctnessOnly=false,diagnostic=false,limits=LIMITS,idleLoadPerCpu=IDLE_LOAD_PER_CPU}) {
 assert.ok(history,'history is the frozen input git worktree the copy was taken from');
 history=await realpath(history);out=path.resolve(out);work=path.resolve(work);
 const run=await realpath(process.env.ILV2_RUN_ROOT);
 const requested=path.resolve(repo);
 if(!(await exists(path.dirname(requested)))){
  assert.ok([run,path.resolve(process.env.ILV2_RUN_ROOT)].some(root=>requested.startsWith(`${root}/tmp/`)),'driver inputs and outputs must stay inside the registered run');
  await mkdir(path.dirname(requested),{recursive:true});
 }
 repo=path.join(await realpath(path.dirname(requested)),path.basename(requested));
 // Databases live in run tmp (staged commits require it, and they are bulk, not evidence); reports go to `out`.
 assert.ok(repo.startsWith(`${run}/tmp/`) && work.startsWith(`${run}/tmp/`) && out.startsWith(`${run}/`),'driver inputs and outputs must stay inside the registered run');
 const materialized=!(await exists(repo));
 if(materialized) await materializeCopy(history,repo);
 repo=await realpath(repo);
 assert.ok(!history.startsWith(`${run}/`) || history.startsWith(`${run}/tmp/`),'history root is a read-only input');
 assert.ok(changes.length>=1 && changes.length<=2 && changes.every(n=>Number.isInteger(n) && n>0) && (changes.length<2 || changes[0]<changes[1]),'changes are one cap or a small,large pair');
 assert.ok(!costOnly || resumeBase,'cost-only requires an explicit sealed base');
 assert.ok(!(costOnly && correctnessOnly),'cost-only and correctness-only are mutually exclusive');
 assert.ok(!resumeBase || costOnly || correctnessOnly,'a carried-over base only feeds a cost-only or correctness-only run');
 requireUnprotectedRoot(repo);requireUnprotectedRoot(history);
 await requireFresh(out);await requireFresh(work);await mkdir(out,{recursive:true});await mkdir(work,{recursive:true});
 const notGated=[...(correctnessOnly?['correctness-only']:[]),...(costOnly?['cost-only']:[]),...(diagnostic?['diagnostic: stage snapshots inside delta windows']:[]),...(resumeBase?['carried-over base: no fresh full']:[]),...(changes.join(',')===GATE_CHANGES.join(',')?[]:[`changes ${changes.join(',')} are not the gate tiers ${GATE_CHANGES.join(',')}`]),
  ...(JSON.stringify(limits)===JSON.stringify(LIMITS)?[]:['limits differ from the gate limits']),...(idleLoadPerCpu===IDLE_LOAD_PER_CPU?[]:[`idle load limit ${idleLoadPerCpu} is not ${IDLE_LOAD_PER_CPU}`])];
 const copyMode=correctnessOnly?'BYTE_COPY_NOT_NATIVE':'NATIVE_CLONE';
 const notClaimed=[...(correctnessOnly?['BYTE_COPY_NOT_NATIVE']:[]),'physical COW','publisher','tracker','JDT','production','XML and build-file deltas on the real repos (held at HEAD)'];
 const report={copyMode,notClaimed,mode:correctnessOnly?'correctness-only':costOnly?'cost-only':diagnostic?'diagnostic':notGated.length?'not-gated':'gate',notGated,limits,idleLoadPerCpu,steps:{},falsifiers:[],invalid:[]};
 const progress=path.join(out,'full-delta-progress.json');
 const record=async(name,value)=>{report.steps[name]=value;await writeJson(progress,report);return value;};
 const plan=['full-1','base-invariants','delta-reconcile','delta-empty',...changes.map(cap=>`delta-${cap}`),...(!costOnly && changes.length>1?[`chain-${changes.join('-')}`]:[]),...(!costOnly?['oracle-full','oracle-compare','full-2','full-determinism']:[])];
 let active='input',restoreOnFailure;
 const finish=async status=>{for(const name of plan) report.steps[name]??={status:'NOT_RUN'};report.status=status;await writeJson(progress,report);};
 const fail=async(name,message,value={})=>{active=name;await record(name,{...value,status:'FAIL',error:message});await finish('FAIL');throw new Error(`${name}: ${message}`);};
 try{
 const m=await modules();
 const checkpoint=db=>{
  const names=db.prepare('PRAGMA database_list').all().map(row=>row.name);
  for(const name of ['main','ws'].filter(name=>names.includes(name))){
   const result=db.prepare(`PRAGMA ${name}.wal_checkpoint(TRUNCATE)`).get();
   assert.equal(Number(result.busy),0,`${name} checkpoint busy`);
  }
 };
 const fileHash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
 const copyDatabase=async(source,target,root)=>{
  if(!correctnessOnly) return cloneSealedDatabase(source,target,root);
  // Explicit environment substitute, never a fallback from a failed native clone.
  await copyFile(source,target,fsConstants.COPYFILE_EXCL);
  assert.equal(await fileHash(target),await fileHash(source),'byte-copy database differs from its sealed source');
 };
 const inspect=file=>{const reader=m.openIndexDb(file,{readOnly:true});try{return {digest:m.logicalDigest(reader),invariants:m.checkIndexInvariants(reader)};}finally{m.close(reader);}};
 const violations=invariants=>invariants.checks.filter(item=>item.violations>0);
 const window=async fn=>{const start=hostLoad(),cpu=process.cpuUsage(),t0=performance.now();const value=await fn();const ms=performance.now()-t0,used=process.cpuUsage(cpu),end=hostLoad();
  return {value,sample:{ms,cpuMs:(used.user+used.system)/1000,host:{start,end},idle:start.perCpu<=idleLoadPerCpu && end.perCpu<=idleLoadPerCpu}};};
 const query=(db,candidates)=>{
  for(const relative of candidates){
   const bundle=m.readBundle(db,relative);const type=bundle?.types.find(type=>type.fqn);
   if(!type) continue;
   const hit=new m.SqlEntitySearch(db).searchDetailed(type.fqn.replace(/^\./,''),50,'exact').hits.find(hit=>hit.relativePath===relative);
   assert.ok(hit,'actual query missed changed declaration');assert.equal(hit.contentHash,bundle.file.contentHash);
   return {path:relative,hash:hit.contentHash,coverageGaps:Number(db.prepare("SELECT count(*) AS n FROM source_root_coverage WHERE state<>'COMPLETE'").get().n)};
  }
  assert.fail('no changed file declares a named type to query');
 };
 const build=async (name,file,injectionPath)=>{
  active=name;
  console.log(JSON.stringify({phase:"full-start",artifact:path.relative(work,file)}));
  const original=injectionPath ? await readFile(path.join(repo,injectionPath)) : undefined;
  let injected=false;
  // A new case directory: the build cannot resume or reuse an earlier database, WAL or stat store.
  await mkdir(path.dirname(file));
  const db=m.openIndexDb(file);m.ensureSchema(db);
  let timed;
  try{timed=await window(async()=>{
   const result=await m.runSqlColdBuild({repoRoot:repo,db,onStage:async stage=>{if(stage==='parse-declare' && original){await writeFile(path.join(repo,injectionPath),Buffer.concat([original,Buffer.from("\n// injected after parse\n")]));injected=true;}}});
   checkpoint(db);
   const probe=injectionPath ?? db.prepare("SELECT f.path FROM file f JOIN type t ON t.file_id=f.id WHERE t.fqn IS NOT NULL ORDER BY f.path LIMIT 1").get()?.path;
   assert.ok(probe,'full has no named type to query');
   const reader=m.openIndexDb(file,{readOnly:true});let hit;try{hit=query(reader,[probe]);}finally{m.close(reader);}
   // The injected edit must not leak into the captured snapshot. Its expected bytes are the pre-build input.
   const bytes=probe===injectionPath?original:await readFile(path.join(repo,probe));
   assert.equal(hit.hash,sha256(bytes),'full query hash differs from captured source');
   return {result,query:hit};
  });}
  finally{m.close(db);if(original) await writeFile(path.join(repo,injectionPath),original);}
  const fault=freshFullFault(timed.value.result.stages);
  if(fault) await fail(name,fault,{stages:timed.value.result.stages});
  return {file,result:timed.value.result,query:timed.value.query,elapsedMs:timed.sample.ms,sample:timed.sample,parseAfterEditInjected:injected};
 };
 const verifyFull=built=>{
  const started=performance.now(),state=inspect(built.file);
  return {...built,digest:state.digest,invariants:state.invariants,verificationMs:performance.now()-started};
 };
 const timedFull=async (name,injectionPath)=>{
  const samples=[];let first;
  for(;;){
   const built=await build(name,path.join(work,samples.length?`${name}-sample-${samples.length+1}`:name,'facts.sqlite'),injectionPath);
   first??=built;samples.push(built.sample);
   const timing=correctnessOnly?{verdict:'NOT_GATED',reason:'correctness-only',median:built.sample.ms}:timingVerdict(samples,limits.fullMs);
   if(timing.verdict==='INCONCLUSIVE') continue;
   await record(name,{status:timing.verdict,correctness:'NOT_RUN',elapsedMs:first.elapsedMs,query:first.query,samples,timing,stages:first.result.stages});
   if(timing.verdict==='FAIL'){
    const message=`${name} full ${timing.median.toFixed(0)} ms > ${limits.fullMs} ms`;
    report.falsifiers.push(message);await finish('FAIL');throw new Error(`${message}; remaining matrix NOT_RUN`);
   }
   if(timing.verdict==='INVALID_EXPERIMENT') report.invalid.push(name);
   return {...verifyFull(first),samples,timing};
  }
 };

 // 0. Input identity, edit tiers and the base key, all outside any timed window.
 const input=await verifyCopy(history,repo);
 const tiers=await historyTiers(history,changes);
 assert.ok(tiers.every(tier=>tier.head===input.head),'history moved while the tiers were chosen');
 for(const tier of tiers) for(const row of tier.rows) assert.equal(await readOrNull(path.join(repo,row.path))===null,row.headAbsent,`copy disagrees with HEAD presence of ${row.path}`);
 const baseKey={schema:m.SCHEMA_VERSION,factsRevision:m.JAVA_FACTS_REVISION,builder:await distDigest(),node:process.version,input:input.census};
 report.input={...input,history,materialized};report.baseKey=baseKey;
 report.tiers=tiers.map(({rows,...tier})=>({...tier,javaFiles:rows.length,absentAtTier:rows.filter(row=>row.absent).length,absentAtHead:rows.filter(row=>row.headAbsent).length}));
 // A coarse history can leave a tier far below its cap; its limit then judges a smaller change.
 for(const tier of tiers) if(tier.rows.length<tier.cap*TIER_FILL) notGated.push(`tier ${tier.cap} holds ${tier.rows.length} Java files (< ${TIER_FILL} of its cap)`);
 if(report.mode==='gate' && notGated.length) report.mode='not-gated';
 await writeJson(progress,report);

 // 1. Base full (or a sealed carry-over base) and its invariants.
 const [small,large]=tiers;
 const chainName=large?`chain-${small.cap}-${large.cap}`:undefined;

 active='full-1';
 const firstFile=path.join(work,'full-1','facts.sqlite');
 let first;
 if(resumeBase){
  resumeBase=await realpath(resumeBase);assert.ok(resumeBase.startsWith(`${run}/tmp/`),'resume base must be owned run tmp');
  first=JSON.parse(await readFile(path.join(resumeBase,'full-1.json'),'utf8'));
  assert.ok(first.digest?.digest,'resume requires a completed full');
  assert.deepEqual(first.baseKey,baseKey,'carried-over base was built under a different base key');
  assert.equal(await fileHash(path.join(resumeBase,'sealed/facts.sqlite')),await fileHash(path.join(resumeBase,'full-1/facts.sqlite')),'sealed facts differ from completed full');
  first={...first,timing:{verdict:'NOT_GATED',reason:'carried-over base: no fresh full'}};
  await record('full-1',{status:'CARRIED_OVER',from:resumeBase,elapsedMs:first.elapsedMs,timing:{verdict:'NOT_GATED',reason:'carried-over base: no fresh full'},digest:first.digest.digest});
 }else{
  first={...await timedFull('full-1'),baseKey};await writeJson(path.join(work,'full-1.json'),first);await writeJson(path.join(out,'full-1.json'),first);
  await record('full-1',{status:first.timing.verdict,correctness:'MEASURED',elapsedMs:first.elapsedMs,timing:first.timing,query:first.query,digest:first.digest.digest,stages:first.result.stages});
 }
 active='base-invariants';
 const sealed=path.join(work,'sealed');await mkdir(sealed);
 const sealedFacts=path.join(sealed,'facts.sqlite'),sealedStat=path.join(sealed,'workspace-stat.sqlite');
 const baseFacts=resumeBase?path.join(resumeBase,'sealed/facts.sqlite'):firstFile,baseStat=resumeBase?path.join(resumeBase,'sealed/workspace-stat.sqlite'):path.join(path.dirname(firstFile),'workspace-stat.sqlite');
 await copyDatabase(baseFacts,sealedFacts,run);await copyDatabase(baseStat,sealedStat,run);
 const baselineStatHash=await fileHash(sealedStat);
 assert.equal(baselineStatHash,await fileHash(baseStat));
 assert.equal(await fileHash(sealedFacts),await fileHash(baseFacts),'sealed facts bytes differ from completed full');
 const baseReader=m.openIndexDb(sealedFacts,{readOnly:true});let base;
 try{base={digest:first.digest,invariants:m.checkIndexInvariants(baseReader)};}finally{m.close(baseReader);}
 if(!base.invariants.ok) await fail('base-invariants','sealed base violates index invariants',{violations:violations(base.invariants)});
 await record('base-invariants',{status:'PASS',checks:base.invariants.checks.length});
 if(!resumeBase) await record('full-1',{...report.steps['full-1'],correctness:'PASS'});
 const baseline=m.openIndexDb(sealedFacts,{readOnly:true});
 const noopProbe=baseline.prepare(`SELECT f.path FROM file f WHERE f.parse_state='COMPLETE'
   AND EXISTS (SELECT 1 FROM type t WHERE t.file_id=f.id AND t.owner_sym IS NULL AND t.fqn IS NOT NULL)
   ORDER BY f.path LIMIT 1`).get()?.path;
 m.close(baseline);
 assert.ok(noopProbe,'base has no named top-level type to query');

 // Tree states: HEAD, or HEAD with one tier's Java paths at that tier's commit (null = absent).
 // Directories a tier creates are removed again, so HEAD's layout probe sees HEAD's tree.
 const originals=new Map(),createdDirs=new Set();let current=new Map();
 const ensureDir=async directory=>{for(let probe=directory;!(await exists(probe));probe=path.dirname(probe)) createdDirs.add(probe);await mkdir(directory,{recursive:true});};
 const restore=async()=>{
  for(const [relative,bytes] of originals){const file=path.join(repo,relative);if(bytes===null) await unlinkIfPresent(file);else await writeFile(file,bytes);}
  for(const directory of [...createdDirs].sort((a,b)=>b.length-a.length)) await rmdir(directory).catch(error=>{if(error.code!=='ENOENT') throw error;});
  originals.clear();createdDirs.clear();current=new Map();
 };
 restoreOnFailure=restore;
 const tierState=tier=>historyTierState(history,tier);
 /** Moves the tree to `target` (unlisted paths at HEAD) and returns the paths whose bytes changed. */
 const moveTo=async target=>{
  const changed=[];
  for(const relative of new Set([...current.keys(),...target.keys()])){
   const file=path.join(repo,relative),from=await readOrNull(file);
   if(!originals.has(relative)) originals.set(relative,from);
   const to=target.has(relative)?target.get(relative):originals.get(relative);
   if(from===null && to===null || from!==null && to!==null && from.equals(to)) continue;
   if(to===null) await unlinkIfPresent(file);else{await ensureDir(path.dirname(file));await writeFile(file,to);}
   changed.push(relative);
  }
  current=target;return changed.sort();
 };
 const present=paths=>paths.filter(relative=>!current.has(relative) || current.get(relative)!==null);

 /** One delta from a fresh clone of the sealed base; the window ends at the first correct query of a changed file. */
 const deltaSample=async(name,job,probes,sample)=>{
  active=name;
  const caseRoot=path.join(work,sample?`${name}-sample-${sample}`:name);await mkdir(caseRoot);
  const before=path.join(caseRoot,'before.sqlite'),after=path.join(caseRoot,'facts.sqlite');
  const statBefore=path.join(caseRoot,'stat-before.sqlite'),statAfter=path.join(caseRoot,'workspace-stat.sqlite');
  await copyDatabase(sealedFacts,before,work);await copyDatabase(sealedFacts,after,work);
  await copyDatabase(sealedStat,statBefore,work);await copyDatabase(sealedStat,statAfter,work);
  const initialStatHash=await fileHash(statAfter);
  assert.equal(initialStatHash,baselineStatHash);assert.equal(await fileHash(statBefore),baselineStatHash);
  const stageSnapshots=[];const db=m.openIndexDb(after);let timed;
  const onStage=diagnostic?async stage=>{checkpoint(db);const snapshot=path.join(caseRoot,`stage-${stage}-facts.sqlite`),statSnapshot=path.join(caseRoot,`stage-${stage}-stat.sqlite`);await copyDatabase(after,snapshot,work);await copyDatabase(statAfter,statSnapshot,work);stageSnapshots.push({name:stage,snapshot,statSnapshot});}:undefined;
  try{
   timed=await window(async()=>{
    const result=await m.applyBuilderJob({repoRoot:repo,db,job,staged:true,onStage});assert.equal(result.ok,true,result.error);
    // Before the query: an escalated job is reported as such, never timed as a delta.
    const fault=deltaModeFault(result.stages);if(fault) return {result,fault};
    checkpoint(db);
    const reader=m.openIndexDb(after,{readOnly:true});try{return {result,query:query(reader,probes)};}finally{m.close(reader);}
   });
  }finally{m.close(db);}
  if(timed.value.fault) await fail(name,timed.value.fault,{stages:timed.value.result.stages});
  const stages=timed.value.result.stages;
  const attributedMs=['capture','parse','resolve','graphSearch'].reduce((sum,key)=>sum+(stages?.[key]?.elapsedMs??0),0);
  return {caseRoot,before,after,statBefore,statAfter,initialStatHash,stageSnapshots,result:timed.value.result,query:timed.value.query,sample:{...timed.sample,attributedMs,unattributedMs:timed.sample.ms-attributedMs}};
 };
 const deltaStep=async(name,{job,probes,limit,strict,pageLimit,count,cap,noop=false})=>{
  console.log(JSON.stringify({phase:"delta-start",name}));
  const runs=[];let timing;
  for(;;){runs.push(await deltaSample(name,job,probes,runs.length?runs.length+1:undefined));timing=correctnessOnly?{verdict:'NOT_GATED',reason:'correctness-only',median:runs[0].sample.ms}:timingVerdict(runs.map(item=>item.sample),limit,{strict});if(timing.verdict!=='INCONCLUSIVE') break;}
  const slice=runs[0];
  assert.equal(slice.query.hash,createHash('sha256').update(await readFile(path.join(repo,slice.query.path))).digest('hex'),'query hash differs from the source on disk');
  const value={count,cap,inputMode:job.kind==='reconcile'?'verified-reconcile':'explicit-delta',firstCorrectQueryMs:timing.median??slice.sample.ms,samples:runs.map(item=>item.sample),timing,result:slice.result,query:slice.query,closure:slice.result.stages?.resolve?.files,initialStatHash:slice.initialStatHash,baselineStatHash};
  await record(name,{...value,status:timing.verdict==='FAIL'?'FAIL':'MEASURED'});
  if(timing.verdict==='FAIL'){report.falsifiers.push(`${name} first correct query ${timing.median.toFixed(0)} ms vs ${limit} ms`);await finish('FAIL');throw new Error(report.falsifiers.at(-1));}
  if(timing.verdict==='INVALID_EXPERIMENT') report.invalid.push(name);
  value.pages=await pageDiff(slice.before,slice.after);value.statPages=await pageDiff(slice.statBefore,slice.statAfter);
  if(!correctnessOnly && pageLimit!==undefined && value.pages.ratio>=pageLimit){report.falsifiers.push(`${name} pages ${value.pages.ratio.toFixed(3)} >= ${pageLimit}`);await fail(name,report.falsifiers.at(-1),value);}
  if(diagnostic){value.stagePages=[];let previous=slice.before,previousStat=slice.statBefore;for(const stage of slice.stageSnapshots){value.stagePages.push({name:stage.name,pages:await pageDiff(previous,stage.snapshot),statPages:await pageDiff(previousStat,stage.statSnapshot)});previous=stage.snapshot;previousStat=stage.statSnapshot;}}
  const state=inspect(slice.after);value.digest=state.digest;
  if(!state.invariants.ok) await fail(name,'delta state violates index invariants',{...value,violations:violations(state.invariants)});
  if(noop && state.digest.digest!==base.digest.digest) await fail(name,'a no-op job changed the logical index',{...value,base:base.digest.digest});
  await record(name,{...value,correctness:'PASS',status:timing.verdict==='UNBOUNDED'?'NOT_GATED':timing.verdict});
  await writeJson(path.join(out,`${name}.json`),value);
  return {...value,after:slice.after};
 };

 // 2. Cheapest timings first: a verified no-op reconcile and an empty delta.
 const slices=[];
 // Diagnostic stage snapshots sit inside the delta windows, so those timings are recorded, not gated.
 const deltaLimit=limit=>diagnostic?Infinity:limit;
 slices.push(await deltaStep('delta-reconcile',{job:{kind:'reconcile',changed:[]},probes:[noopProbe],limit:deltaLimit(limits.noopMs),strict:true,count:-1,noop:true}));
 slices.push(await deltaStep('delta-empty',{job:{kind:'refresh',changed:[]},probes:[noopProbe],limit:deltaLimit(limits.noopMs),strict:true,count:0,noop:true}));
 let restoreError;
 try{
  // 3. Tier slices, smallest first, each from the sealed base.
  const states=[];
  for(const tier of tiers){
   const target=await tierState(tier);states.push(target);await moveTo(target);
   const changed=tier.rows.map(row=>row.path).sort();
   slices.push(await deltaStep(`delta-${tier.cap}`,{job:{kind:'refresh',changed},probes:present(changed).filter(file=>file.endsWith('.java')).slice(0,10),limit:deltaLimit(limits.deltaMs[tier.cap]??Infinity),pageLimit:limits.pageRatio[tier.cap],count:changed.length,cap:tier.cap}));
  }
  // 4. Correctness chain: the small tier's state takes exactly the paths that differ on the large tier's tree.
  const finalDigests={[`delta-${tiers.at(-1).cap}`]:slices.at(-1).digest.digest};
  if(!costOnly){
  if(large){
   active=chainName;
   await moveTo(states[0]);const changed=await moveTo(states[1]);
   const chainDb=slices.find(slice=>slice.cap===small.cap).after;const db=m.openIndexDb(chainDb);let result;
   try{result=await m.applyBuilderJob({repoRoot:repo,db,job:{kind:'refresh',changed},staged:true});assert.equal(result.ok,true,result.error);checkpoint(db);}finally{m.close(db);}
   const fault=deltaModeFault(result.stages);if(fault) await fail(chainName,fault,{stages:result.stages});
   const state=inspect(chainDb);
   if(!state.invariants.ok) await fail(chainName,'chained delta state violates index invariants',{violations:violations(state.invariants)});
   finalDigests[chainName]=state.digest.digest;await record(chainName,{status:'PASS',files:changed.length,closure:result.stages?.resolve?.files,digest:state.digest.digest});
  }
  const oracle=verifyFull(await build('oracle-full',path.join(work,'oracle-full','facts.sqlite')));
  if(!oracle.invariants.ok) await fail('oracle-full','oracle full violates index invariants',{violations:violations(oracle.invariants)});
  await record('oracle-full',{status:'PASS',correctness:'PASS',timing:{verdict:'NOT_GATED',reason:'independent correctness oracle'},elapsedMs:oracle.elapsedMs,digest:oracle.digest.digest});
  active='oracle-compare';
  const mismatched=Object.entries(finalDigests).filter(([,digest])=>digest!==oracle.digest.digest).map(([name])=>name);
  if(mismatched.length) await fail('oracle-compare',`delta differs from independent full: ${mismatched.join(',')}`,{oracle:oracle.digest.digest,finalDigests});
  await record('oracle-compare',{status:'PASS',oracle:oracle.digest.digest,finalDigests});
  }
 }finally{
  // A failed restore must not hide the failure that ended the try; on success it stops the run (the copy is not HEAD).
  restoreOnFailure=undefined;
  await restore().catch(error=>{restoreError=error;report.restoreError={message:String(error)};console.error(JSON.stringify({phase:'restore-failed',error:String(error)}));});
 }
 if(restoreError) throw restoreError;
 if(costOnly){
  await finish(report.invalid.length?'INVALID_EXPERIMENT':'DIAGNOSTIC_ONLY');
  const result={diagnosticOnly:true,copyMode,notClaimed,notGated,resumedBase:resumeBase,baselineDigest:first.digest.digest,slices,notRun:['full','independent-oracle','chain','full2-parse-after-edit'],falsifiers:report.falsifiers,invalid:report.invalid};
  await writeJson(path.join(out,'delta-cost-result.json'),result);return result;
 }
 // 5. Full determinism on HEAD, with an edit injected after parse.
 const second=await timedFull('full-2',noopProbe);
 await writeJson(path.join(out,'full-2.json'),second);
 if(!second.parseAfterEditInjected) await fail('full-2','parse-after-edit was not injected');
 if(!second.invariants.ok) await fail('full-2','second full violates index invariants',{violations:violations(second.invariants)});
 await record('full-2',{status:second.timing.verdict,correctness:'PASS',timing:second.timing,elapsedMs:second.elapsedMs,query:second.query,digest:second.digest.digest,parseAfterEditInjected:true});
 if(first.digest.digest!==second.digest.digest) await fail('full-determinism','two full builds differ',{first:first.digest.digest,second:second.digest.digest});
 await record('full-determinism',{status:'PASS'});
 const status=report.falsifiers.length?'FAIL':report.invalid.length?'INVALID_EXPERIMENT':notGated.length?'DIAGNOSTIC_ONLY':'PASS';
 report.correctness='PASS';
 await finish(status);
 const result={status,correctness:'PASS',copyMode,notGated,fullDeterministic:true,falsifiers:report.falsifiers,invalid:report.invalid,input:report.input,tiers:report.tiers,workspaceStat:{sharedAcrossCases:false,baselineStatHash,baselinePairSealed:true,pageDiffScope:'facts and workspace-stat reported separately; facts ratio denominator unchanged',statStorePageCost:'MEASURED',cacheNote:'each case clones the sealed initial stat store; oracle/full2 stores are independent'},full:[first,second],slices,notClaimed};
 await writeJson(path.join(out,'full-delta-result.json'),result);return result;
 }catch(error){
  // Setup/copy/native errors are evidence too. Never replace the original failure with cleanup or reporting errors.
  if(restoreOnFailure) await restoreOnFailure().catch(restoreError=>{report.restoreError={message:String(restoreError)};});
  const blocked=['EACCES','EPERM','ENOSPC','ETIMEDOUT'].includes(error.code) || /native process deadline exceeded/.test(error.message);
  const status=report.status==='FAIL'?'FAIL':blocked?'BLOCKED_ENV':'FAIL';
  report.executionError={step:active,message:error.message,code:error.code,status};
  if(!['FAIL','BLOCKED_ENV'].includes(report.steps[active]?.status)) report.steps[active]={...report.steps[active],status,error:error.message};
  await finish(status).catch(reportError=>console.error(JSON.stringify({phase:'progress-write-failed',error:String(reportError)})));
  throw error;
 }
}
if(isMain(import.meta.url)) runCli(async()=>{
 const options=cliOptions(process.argv.slice(2),['--repo','--history','--out','--work','--changes','--resume-base','--cost-only','--correctness-only','--diagnostic']);
 // Defaults keep the copy in the run's tmp and the evidence in its raw tree.
 const name=path.basename(options.history??'');
 const result=await runFullDelta({repo:options.repo??path.join(process.env.ILV2_RUN_ROOT,'tmp','repos',name),history:options.history,out:options.out??path.join(process.env.ILV2_RUN_ROOT,'raw','full-delta',name),work:options.work??path.join(process.env.ILV2_RUN_ROOT,'tmp','full-delta',name),changes:options.changes?options.changes.split(',').map(Number):GATE_CHANGES,resumeBase:options["resume-base"],costOnly:options["cost-only"]==="true",correctnessOnly:options["correctness-only"]==="true",diagnostic:options.diagnostic==="true"});
 console.log(JSON.stringify({status:result.status??(result.diagnosticOnly?'DIAGNOSTIC_ONLY':undefined),notGated:result.notGated,falsifiers:result.falsifiers,invalid:result.invalid,fullMs:result.full?.map(r=>r.elapsedMs),slices:result.slices.map(s=>({name:s.inputMode,changes:s.count,firstCorrectQueryMs:s.firstCorrectQueryMs,verdict:s.timing.verdict,closure:s.closure,cpuMs:s.samples[0].cpuMs,unattributedMs:s.samples[0].unattributedMs}))}));
});
