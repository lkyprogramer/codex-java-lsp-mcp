/** Function-level regression contract against REAL SUT exports.
 * Transpiles to a private temporary directory; does NOT type-check or start JDT.
 * Exit 1 means a product contract failed; exit 2 means probe infrastructure failed.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const argv=process.argv.slice(2);
function option(name){const i=argv.indexOf(name);return i<0?undefined:argv[i+1];}
const project=option('--project'),tsPath=option('--typescript');
if(!project){console.error('Usage: node adapters/probe-source.mjs --project /checkout [--typescript /path/typescript.js]');process.exit(2);}
let tmp;
try {
 const req=createRequire(path.resolve(project,'package.json'));
 const ts=tsPath?req(path.resolve(tsPath)):req('typescript');
 tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'java-product-probe-'));
 await fsp.writeFile(path.join(tmp,'package.json'),'{"type":"module"}');
 const source=path.resolve(project,'src');
 async function transpile(dir){
  for(const e of await fsp.readdir(dir,{withFileTypes:true})){
   const p=path.join(dir,e.name);
   if(e.isDirectory())await transpile(p);
   else if(e.name.endsWith('.ts')&&!e.name.endsWith('.d.ts')&&!e.name.endsWith('.test.ts')){
    const dest=path.join(tmp,path.relative(source,p)).replace(/\.ts$/,'.js');
    await fsp.mkdir(path.dirname(dest),{recursive:true});
    const text=ts.transpileModule(await fsp.readFile(p,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
    await fsp.writeFile(dest,text);
   }
  }
 }
 await transpile(source);
 const imp=f=>import(pathToFileURL(path.join(tmp,f)).href);
 const ids=await imp('java-index/stable-id.js');
 const {openIndexDb,close}=await imp('java-index/sql/driver.js');
 const {ensureSchema}=await imp('java-index/sql/schema.js');
 const {writeBundle}=await imp('java-index/sql/rows.js');
 const {replaceAllEntities}=await imp('java-index/sql/entity-tokens.js');
 const {SqlEntitySearch}=await imp('java-index/sql/entity-search.js');
 const {queryReadRanges}=await imp('java-index/sql/sql-read-ranges.js');
 const range=(a,b)=>({start:{line:a,column:1},end:{line:b,column:2}});
 const rows=[];
 async function check(id,fn){try{const result=await fn();rows.push({id,pass:result.pass,actual:result.actual});}catch(e){rows.push({id,pass:false,error:String(e)});}}
 const A='modules/a/src/main/java/demo/Shared.java',B='modules/b/src/main/java/demo/Shared.java';
 const type=p=>ids.javaTypeId({fqn:'demo.Shared',relativePath:p,range:range(1,9)});
 await check('C1-ID-PATH',()=>({pass:type(A)!==type(B),actual:[type(A),type(B)]}));
 await check('C1-ID-LINE-STABLE',()=>({pass:type(A)===ids.javaTypeId({fqn:'demo.Shared',relativePath:A,range:range(4,12)}),actual:'line insertion'}));
 await check('C1-METHOD-OWNER',()=>({pass:ids.javaMethodId(type(A),'save()')!==ids.javaMethodId(type(B),'save()'),actual:'owner-scoped method IDs'}));
 const bundle=p=>({file:{fileId:ids.javaFileId(p),relativePath:p,sourceRoot:'modules',module:p.split('/')[1],sourceSet:'main',packageName:'demo',imports:[],topLevelTypeIds:[type(p)],allTypeIds:[type(p)],contentHash:'fixture',size:50,mtimeMs:1,parseState:'COMPLETE',parseErrorCount:0,generation:1},types:[{typeId:type(p),fqn:'demo.Shared',simpleName:'Shared',kind:'class',fileId:ids.javaFileId(p),range:range(1,9),modifiers:[],annotations:[],typeParameters:[],extends:[],implements:[],permits:[],fieldIds:[],methodIds:[],confidence:1}],fields:[],methods:[],edges:[]});
 for(const reverse of [false,true])await check('C1-SQL-WRITE-'+(reverse?'BA':'AB'),()=>{
   const db=openIndexDb(':memory:');try{ensureSchema(db);for(const p of reverse?[B,A]:[A,B])writeBundle(db,bundle(p));
   const n=db.prepare('SELECT count(*) AS n FROM type').get().n;
   return {pass:Number(n)===2,actual:{type_rows:Number(n),file_rows:db.prepare('SELECT count(*) AS n FROM file').get().n}};
   }finally{close(db);}
 });
 const records=[{entityId:'type:demo.OrderService',kind:'type',fqn:'demo.OrderService',simpleName:'OrderService',relativePath:'OrderService.java',identifierTokens:['order','service'],chunkTokens:['accept']},
 {entityId:'method:demo.OrderService#reverseDuplicateCharge',kind:'method',fqn:'demo.OrderService#reverseDuplicateCharge',simpleName:'reverseDuplicateCharge',relativePath:'OrderService.java',identifierTokens:['reverse','duplicate','charge'],chunkTokens:['rollback','refund']}];
 for(const q of ['demo.OrderService#reverseDuplicateCharge','rollback refund','OrderService rollback refund'])await check('C2-QUERY-'+q,()=>{
  const db=openIndexDb(':memory:');try{ensureSchema(db);replaceAllEntities(db,records);const hits=new SqlEntitySearch(db).search(q,10);return {pass:hits.some(x=>x.kind==='method'),actual:hits.map(x=>({name:x.simpleName,layer:x.layer}))};}finally{close(db);}
 });
 const repo=path.join(tmp,'fixture');await fsp.mkdir(repo);
 for(const ending of ['LF','CRLF']){
  const lines=['class LongService {','  void action() {',...Array.from({length:418},(_,i)=>`    int value${i} = ${i};`),'  }','}'];
  const file=`Long${ending}.java`;await fsp.writeFile(path.join(repo,file),lines.join(ending==='LF'?'\n':'\r\n')+'\n');
  const method={methodId:'method:long#action()',ownerTypeId:'type:long',name:'action',constructor:false,signatureKey:'action()',range:range(2,421),bodyRange:range(2,421),modifiers:[],annotations:[],parameters:[],typeParameters:[],throws:[],callSites:[],localTypes:[]};
  const b={...bundle(file),types:[{typeId:'type:long',range:range(1,422)}],methods:[method]};
  const deps={repoRoot:repo,toRelative:x=>x,store:{files:()=>[b],myBatisResource:()=>undefined}};
  for(const positions of [[{line:201,column:5}],[{line:100,column:5},{line:350,column:5}]])await check('C3-RANGES-'+ending+'-'+positions.map(x=>x.line).join(','),async()=>{
    const out=await queryReadRanges(deps,[{file,positions}]);const rs=out[0]?.ranges??[];
    return {pass:positions.every(p=>rs.some(r=>r.startLine<=p.line&&p.line<=r.endLine)),actual:rs.map(r=>[r.startLine,r.endLine])};
  });
 }
 const selected=option('--group')?rows.filter(r=>r.id.startsWith(option('--group'))):rows;
 if(!selected.length)throw new Error('empty probe group');
 const out={schema:'product-regression-probe/v1',mode:'real-source-functions-with-constructed-facts',typecheck:'NOT_RUN',jdt:'NOT_RUN',source_dir:path.resolve(project),typescript:ts.version,rows:selected,passed:selected.filter(r=>r.pass).length,failed:selected.filter(r=>!r.pass).length};
 console.log(JSON.stringify(out,null,2));process.exitCode=out.failed?1:0;
}catch(e){console.error(e);process.exitCode=2;}
finally{if(tmp)await fsp.rm(tmp,{force:true,recursive:true});}
