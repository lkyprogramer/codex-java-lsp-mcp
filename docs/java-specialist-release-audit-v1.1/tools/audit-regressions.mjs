/** Offline, read-only audit of actual product exports. No network or live model. */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
if(process.argv.length !== 5) throw new Error('Usage: node audit-regressions.mjs PROJECT COMPILED OUTPUT');
const [project, compiled, output] = process.argv.slice(2).map(p=>path.resolve(p));
globalThis.fetch=async()=>{throw new Error('NETWORK_FORBIDDEN_IN_AUDIT');};
if (!project || !compiled || !output) throw new Error('project compiled output are required');
const load=async(rel)=>import(pathToFileURL(path.join(project,rel)).href);
const code=async(rel)=>import(pathToFileURL(path.join(compiled,rel)).href);
const {runLiveAgentTask}=await load('scripts/run-agent-trace-live.mjs');
const {createRecorder,scoreQaAnswer,scoreRunOutcome,assemblePack,EVAL_SYSTEM_PROMPT}=await load('scripts/evaluate-java-task.mjs');
const {EmbeddingProvider,DenseDiscoveryIndex}=await load('experiments/semantic-discovery/provider.mjs');
const {runStaticDiscovery}=await code('discovery/query.js');
const {buildSearchDocuments}=await code('discovery/search-document.js');
const {buildTypeRegistryView,JavaNameResolver}=await code('java-index/name-resolver.js');
const {openIndexDb,close}=await code('java-index/sql/driver.js');
const {ensureSchema}=await code('java-index/sql/schema.js');
const {replaceAllEntities}=await code('java-index/sql/entity-tokens.js');
const {SqlEntitySearch}=await code('java-index/sql/entity-search.js');
const {filterHitsByScope}=await code('java-index/entity-search.js');
const hash=(s)=>createHash('sha256').update(s).digest('hex');
const temp=mkdtempSync(path.join(os.tmpdir(),'java-audit-'));
const requested = new Set((process.env.AUDIT_CASES ?? '').split(',').filter(Boolean));
const rows=[]; let current;
const observe=(x)=>{current.observed=x;return x;};
async function check(id, title, fn) {
 if(requested.size && !requested.has(id)) return;
 current={id,title,status:'RUNNING'};
 try {await fn();current.status='PASS';} catch(e) {current.status=e?.code==='ERR_ASSERTION'?'FAIL':'ERROR';current.error=String(e.stack??e);}
 rows.push(current);console.log(`${current.status} ${id}: ${title}`);
}
function outputFile(rel,text) {const p=path.join(temp,rel);mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,text);return p;}
async function wire(name,raw) {
 const recorder=createRecorder();let step=0,received;
 const task={taskId:'sentinel',taskText:'Return the source value.',projectId:'fixture',anchor:{file:'A.java',line:1,column:1},requiredContextFiles:[]};
 const run=await runLiveAgentTask({task,systemPrompt:'Use the supplied tools. Return JSON.',maxRounds:2,
 tools:[{type:'function',function:{name,parameters:{type:'object'}}}],
 invoke:async(n,args)=>{recorder.recordToolResult({callId:'c1',toolName:n,result:raw});return raw;},
 chat:async req=>{
  if(step++===0)return {choices:[{message:{tool_calls:[{id:'c1',type:'function',function:{name,arguments:'{}'}}]},finish_reason:'tool_calls'}]};
  received=structuredClone(req.messages.filter(m=>m.role==='tool'));
  return {choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]};
 }});
 assert.notEqual(run.stopReason,'FAILED_RUNTIME',run.error);
 return {received,events:recorder.events(),stopReason:run.stopReason};
}
await check('W01','read source survives final model-message boundary',async()=>{
 const raw={path:'A.java',text:'int auditSentinel=73619;\n',startLine:1,endLine:1};const r=observe(await wire('read',raw));
 assert.ok(JSON.stringify(r.received).includes('auditSentinel=73619'));
});
await check('W02','java_symbol candidates survive final model-message boundary',async()=>{
 const r=observe(await wire('java_symbol',{schemaVersion:'java-discovery/v1',candidates:[{declaration:{name:'auditSentinelMethod',relativePath:'A.java'}}]}));
 assert.ok(JSON.stringify(r.received).includes('auditSentinelMethod'));
});
await check('W03','write acknowledgement survives final model-message boundary',async()=>{
 const r=observe(await wire('write_file',{path:'A.java',written:true,bytes:61}));assert.ok(JSON.stringify(r.received).includes('written'));
});
await check('W04','SOURCE_RECEIVED cannot precede a lossy projection',async()=>{
 const r=observe(await wire('read',{path:'A.java',text:'auditPayload();\n',startLine:1,endLine:1}));
 assert.ok(r.events.length===0 || JSON.stringify(r.received).includes('auditPayload'));
});
await check('W05','evaluation prompt does not restrict to an unavailable tool',async()=>{
 observe({systemPrompt:EVAL_SYSTEM_PROMPT});assert.ok(!EVAL_SYSTEM_PROMPT.includes('with the java_impact tool only'));
});
await check('E01','strict QA types do not coerce string to boolean',async()=>{
 const r=observe(scoreQaAnswer({ok:true},'{"ok":"true"}'));assert.equal(r.correct,false);
});
await check('E02','strict QA rejects extra keys',async()=>{
 const r=observe(scoreQaAnswer({ok:true},'{"ok":true,"extra":0}'));assert.equal(r.correct,false);
});
await check('E03','strict QA rejects duplicate keys',async()=>{
 const r=observe(scoreQaAnswer({ok:true},'{"ok":false,"ok":true}'));assert.equal(r.correct,false);
});
await check('E04','contract QA cannot succeed with no received required source',async()=>{
 const r=observe(scoreRunOutcome({task:{kind:'qa'},goldRow:{answer:{ok:true},required_evidence:[{path:'A.java',start_line:1,end_line:1}]},run:{stopReason:'MODEL_STOP',finalContent:'{"ok":true}',sourceReceived:[]}}));
 assert.notEqual(r.taskSuccess,true);
});
await check('E05','failed scheduled runs remain in success-rate denominator',async()=>{
 const r=observe(assemblePack({status:'MEASURED',arms:['product'],repeats:1,runs:[{taskId:'a',arm:'product',repeat:1,taskSuccess:true},{taskId:'b',arm:'product',repeat:1,taskSuccess:null,stopReason:'FAILED_RUNTIME'}]}));
 assert.equal(r.denominator,2);assert.equal(r.taskSuccessRate,0.5);
});
await check('E06','wrong QA answer is rejected (positive guard)',async()=>{
 const r=observe(scoreQaAnswer({n:2},'{"n":3}'));assert.equal(r.correct,false);
});
const source='class A { void alpha() {} void beta() {} }\n'; outputFile('A.java',source);
const facts=[{relativePath:'A.java',declarationId:'alpha',contentHash:hash(source),startLine:1,endLine:1,text:'alpha unique'},{relativePath:'A.java',declarationId:'beta',contentHash:hash(source),startLine:1,endLine:1,text:'beta distinct'}];
function provider(opts={}) {
 return new EmbeddingProvider({apiKey:'OFFLINE_FAKE_KEY',model:'audit-model',maxRetries:0,timeoutMs:50,
 fetchImpl:async(_u,o)=>({ok:true,json:async()=>({data:JSON.parse(o.body).input.map((t,i)=>({index:i,embedding:t.includes('alpha')?[1,0]:[0,1]}))})}),...opts});
}
await check('D01','two declarations in one file retain vectors after cache reload',async()=>{
 const cacheFile=path.join(temp,'cache.json');const a=new DenseDiscoveryIndex({provider:provider({cacheFile}),facts,corpusHash:'corpus',repoRoot:temp});await a.build();
 const b=new DenseDiscoveryIndex({provider:provider({cacheFile}),facts,corpusHash:'corpus',repoRoot:temp});await b.build();
 observe({cold:a.vectors,reloaded:b.vectors,cache:JSON.parse(readFileSync(cacheFile))});assert.deepEqual(b.vectors,a.vectors);
});
await check('D02','provider identity includes endpoint',async()=>{
 const a=new DenseDiscoveryIndex({provider:provider({baseUrl:'https://one.invalid/v1'}),facts,corpusHash:'corpus',repoRoot:temp});
 const b=new DenseDiscoveryIndex({provider:provider({baseUrl:'https://two.invalid/v1'}),facts,corpusHash:'corpus',repoRoot:temp});
 observe({a:a.providerIndexIdentity,b:b.providerIndexIdentity});assert.notEqual(a.providerIndexIdentity,b.providerIndexIdentity);
});
await check('D03','stale dense hints do not carry actionable stale line ranges',async()=>{
 const a=new DenseDiscoveryIndex({provider:provider(),facts:[{...facts[0],contentHash:'0'.repeat(64)}],corpusHash:'corpus',repoRoot:temp});await a.build();
 const hits=observe(a.search([1,0]));assert.ok(hits.every(h=>h.indexedContentHash || (h.startLine==null && h.endLine==null)));
});
await check('D04','body-read time is covered by embedding deadline',async()=>{
 let aborted=false;
 const p=provider({timeoutMs:15,fetchImpl:async(_u,o)=>{o.signal.addEventListener('abort',()=>{aborted=true});return {ok:true,json:()=>new Promise(res=>setTimeout(()=>res({data:[{index:0,embedding:[1,0]}]}),80))};}});
 let succeeded=false;try{await p.embed(['alpha']);succeeded=true;}catch{}
 observe({succeeded,aborted});assert.equal(succeeded,false);
});
function dbFor(records) {const db=openIndexDb(':memory:');ensureSchema(db);replaceAllEntities(db,records);return db;}
function record(id,relativePath, simpleName='OrderService') {return {entityId:id,kind:'type',fqn:'demo.'+simpleName,simpleName,relativePath,identifierTokens:['demo','order','service','orderservice'],chunkTokens:['refund']};}
await check('Q01','scope is applied before route result cap',async()=>{
 const db=dbFor([record('a','a/src/main/java/demo/OrderService.java'),record('z','z/src/main/java/demo/OrderService.java')]);
 try{const r=observe(new SqlEntitySearch(db).searchDetailed('OrderService',1,'exact',{scope:{sourceRoots:['z']}}));assert.equal(r.hits.length,1);assert.ok(r.hits[0].relativePath.startsWith('z/'));}finally{close(db);}
});
await check('Q02','unknown exact FQN does not fall back to fuzzy BM25',async()=>{
 const db=dbFor([record('a','A.java')]);try{const r=observe(new SqlEntitySearch(db).searchDetailed('demo.MissingService',8,'exact'));assert.equal(r.hits.length,0);}finally{close(db);}
});
await check('Q03','expired exact request reports deadline rather than success',async()=>{
 const db=dbFor([record('a','A.java')]);try{const r=observe(new SqlEntitySearch(db).searchDetailed('demo.OrderService',8,'exact',{budget:{remainingMs:()=>0}}));assert.equal(r.stopReason,'deadline');}finally{close(db);}
});
await check('Q04','20 requested candidates are not silently capped at 10 as complete',async()=>{
 const db=dbFor(Array.from({length:21},(_,i)=>record('e'+String(i).padStart(2,'0'),`${i}/A.java`)));
 try{const r=observe(new SqlEntitySearch(db).searchDetailed('refund',20,'text'));assert.ok(r.hits.length===20 || r.truncated);}finally{close(db);}
});
async function captureQuery(args) {let request;const client={querySearch:async(task,options)=>{request={task,options};return {hits:[],generation:1,truncated:false,work:{postings:0}};},status:async()=>({state:'READY'})};await runStaticDiscovery(client,{repoRoot:temp,query:'OrderService rollback',...args});return request;}
await check('Q05','explicit expansion terms supplement rather than replace query',async()=>{
 const r=observe(await captureQuery({terms:['refund']}));assert.ok(r.task.includes('OrderService') && r.task.includes('refund'));
});
await check('Q06','module and sourceSet combine as AND, not union',async()=>{
 mkdirSync(path.join(temp,'m/src/main'),{recursive:true});const r=await captureQuery({module:'m',sourceSet:'test'});
 const matches=filterHitsByScope([{relativePath:'m/src/main/java/A.java'},{relativePath:'m/src/test/java/A.java'},{relativePath:'src/test/java/X.java'}],r.options.scope);
 observe({request:r,matches});assert.deepEqual(matches.map(h=>h.relativePath),['m/src/test/java/A.java']);
});
await check('Q07','unknown module is not silently widened to whole repository',async()=>{
 let r;try{r=await captureQuery({module:'does-not-exist'});}catch(e){observe({rejected:String(e)});return;}
 observe(r);assert.ok(r.options.scope?.sourceRoots?.length);
});
function hitFor(text) {return {entityId:'type:v2:A.java#demo.A',simpleName:'A',kind:'type',fqn:'demo.A',relativePath:'A.java',line:1,column:7,contentHash:hash(text),layer:'FQN',score:1};}
await check('Q08','file changed after index cannot remain READY with stale locator',async()=>{
 const h=hitFor('old');const client={querySearch:async()=>({hits:[h],generation:1,truncated:false,work:{postings:0}}),status:async()=>({state:'READY'})};
 const r=observe(await runStaticDiscovery(client,{repoRoot:temp,query:'demo.A',searchMode:'exact'}));
 assert.ok(r.scopeState==='PARTIAL' || r.candidates.length===0 || r.candidates[0].declaration.contentHash===hash(source));
});
await check('Q09','preview has a byte cap, not just a line cap',async()=>{
 const text='class A { String x="'+'x'.repeat(100000)+'"; }\n';outputFile('A.java',text);
 const client={querySearch:async()=>({hits:[hitFor(text)],generation:1,truncated:false,work:{postings:0}}),status:async()=>({state:'READY'})};
 const r=await runStaticDiscovery(client,{repoRoot:temp,query:'demo.A',searchMode:'exact'});
 const bytes=Buffer.byteLength(r.candidates[0]?.preview??'');observe({bytes,scopeState:r.scopeState});assert.ok(bytes<=16384, 'safety sentinel: one preview must not exceed 16 KiB; production default may be stricter');
});
await check('N01','duplicate FQN with unknown compilation context stays ambiguous',async()=>{
 const t=p=>({typeId:`type:v2:${p}#demo.Shared`,fileId:p,fqn:'demo.Shared',simpleName:'Shared',annotations:[],typeParameters:[]});
 const reg=buildTypeRegistryView([t('a/Shared.java'),t('b/Shared.java')]);
 const r=observe(new JavaNameResolver(reg).resolveTypeText('demo.Shared',{packageName:'client',imports:[],enclosingTypeIds:[],typeParameterNames:new Set()}));
 assert.equal(r.resolution.state,'AMBIGUOUS');
});
await check('P01','MyBatis evidence uses XML path/hash rather than Java path with XML lines',async()=>{
 const range=(a,b)=>({start:{line:a,column:1},end:{line:b,column:1}});
 const type={typeId:'type',fqn:'demo.Mapper',simpleName:'Mapper',annotations:[],range:range(1,5)};
 const method={methodId:'method',ownerTypeId:'type',name:'load',annotations:[],range:range(3,4)};
 const bundle={file:{relativePath:'src/main/java/demo/Mapper.java',contentHash:'j'.repeat(64)},types:[type],methods:[method],fields:[]};
 const xml={namespace:'demo.Mapper',relativePath:'src/main/resources/Mapper.xml',contentHash:'x'.repeat(64),statements:[{id:'load',statementId:'load',kind:'select',range:range(300,310)}]};
 const r=observe(buildSearchDocuments({bundle,myBatisResources:[xml]}));
 assert.equal(r[0].path,xml.relativePath);assert.equal(r[0].contentHash,xml.contentHash);
});

await check('J01','repair judge must not restore an allowed file deleted by the candidate',async()=>{
 const {judgeRepair}=await load('experiments/semantic-discovery/repair-judge.mjs');
 const fixture=path.join(temp,'repair-original'),candidate=path.join(temp,'repair-candidate');
 mkdirSync(path.join(fixture,'src'),{recursive:true});mkdirSync(path.join(candidate,'src'),{recursive:true});
 writeFileSync(path.join(fixture,'src/A.java'),'public class A { public static int value(){ return 9; } }\n');
 const frozen=outputFile('audit-frozen/FrozenTest.java','public class FrozenTest { public static void main(String[] args){ if(A.value()!=9) throw new AssertionError(); } }\n');
 const r=observe(await judgeRepair({task:{id:'audit-delete'},manifestEntry:{test_class:'FrozenTest',java_release:8,timeout_seconds:3,source_roots:['src'],allowed_edits:['src/A.java']},fixtureRoot:fixture,candidateRoot:candidate,workDir:path.join(temp,'repair-work'),testSourceFile:frozen}));
 assert.equal(r.passed,false);
});
mkdirSync(path.dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify({schemaVersion:'java-specialist-audit/v1',basis:'actual-source-exports; TypeScript transpilation NOT typecheck; unused SDK transport stubbed; fake chat/fetch only; no network',selectedCaseIds:[...requested],rows,summary:{total:rows.length,passed:rows.filter(r=>r.status==='PASS').length,failed:rows.filter(r=>r.status==='FAIL').length,errors:rows.filter(r=>r.status==='ERROR').length}},null,2));
rmSync(temp,{recursive:true,force:true});
process.exitCode=rows.some(r=>r.status!=='PASS')?1:0;
