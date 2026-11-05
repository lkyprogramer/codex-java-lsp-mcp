import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {openIndexDb,close,forgetPrepared,type IndexDatabase} from "../java-index/sql/driver.js";
import {assertIndexInvariants} from "../java-index/sql/index-invariants.js";
import {ensureSchema} from "../java-index/sql/schema.js";
import {logicalDigest,exportLogical,diffLogical} from "../java-index/sql/logical-export.js";
import {runSqlColdBuild} from "./cold-build.js";
import {applyBuilderJob} from "./incremental.js";

test("delta-body-edit-is-local-and-df-equals-full", async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-"));const db=openIndexDb(":memory:"),full=openIndexDb(":memory:");ensureSchema(db);ensureSchema(full);
 try {
  await mkdir(path.join(repo,"src/main/java"),{recursive:true});
  await writeFile(path.join(repo,"src/main/java/A.java"),"class A { Peer value(Peer p) { return p; } }");
  await writeFile(path.join(repo,"src/main/java/B.java"),"class B { Peer call(A a, Peer p) { return a.value(p); } }");
  await writeFile(path.join(repo,"src/main/java/Peer.java"),"class Peer {}");
  await runSqlColdBuild({repoRoot:repo,db});
  await writeFile(path.join(repo,"src/main/java/A.java"),"class A { Peer value(Peer p) { return new Peer(); } }");
  const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:["src/main/java/A.java"]}});
  assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");assert.equal(result.stages?.parse.files,1);assert.equal(result.stages?.graphSearch.files,1);
  assert.deepEqual([result.stages?.graphSearch.graphFiles,result.stages?.graphSearch.documentFiles],[1,1]);
  await runSqlColdBuild({repoRoot:repo,db:full});
  assert.equal(logicalDigest(db).digest,logicalDigest(full).digest);
 }finally{close(db);close(full);await rm(repo,{recursive:true,force:true});}
});
test("delta-comment-with-nested-types-keeps-dependent-closure-local",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-nested-"));const db=openIndexDb(":memory:"),full=openIndexDb(":memory:");ensureSchema(db);ensureSchema(full);
 const source="package demo; class A { void first() {} class Nested { void nested() {} } void last() {} }";
 try{
 await mkdir(path.join(repo,"src/main/java"),{recursive:true});await writeFile(path.join(repo,"src/main/java/A.java"),source);await writeFile(path.join(repo,"src/main/java/B.java"),"package demo; class B { void call(A a) { a.first(); } }");
 await runSqlColdBuild({repoRoot:repo,db});await writeFile(path.join(repo,"src/main/java/A.java"),source+"\n// comment only\n");
 const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:["src/main/java/A.java"]}});
 assert.equal(result.ok,true,result.error);assert.equal(result.stages?.resolve.files,1);assert.equal(result.stages?.graphSearch.files,1);
 await runSqlColdBuild({repoRoot:repo,db:full});assert.equal(logicalDigest(db).digest,logicalDigest(full).digest);
 }finally{close(db);close(full);await rm(repo,{recursive:true,force:true});}
});
test("delta-preserves-valid-files-while-repairing-recorded-gap",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-gap-"));const db=openIndexDb(":memory:");ensureSchema(db);
 try{
 await mkdir(path.join(repo,"src/main/java"),{recursive:true});await writeFile(path.join(repo,"src/main/java/A.java"),"class A {}");await writeFile(path.join(repo,"src/main/java/Bad.java"),"@#$ !!!");
 await runSqlColdBuild({repoRoot:repo,db});await writeFile(path.join(repo,"src/main/java/Bad.java"),"class Bad {}");
 const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"reconcile"}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");assert.equal(result.stages?.parse.files,1);
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("interrupted-committed-phase-cannot-be-reused-as-delta-base",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-interrupt-"));const db=openIndexDb(":memory:"),oracle=openIndexDb(":memory:");ensureSchema(db);ensureSchema(oracle);
 try{await mkdir(path.join(repo,"src/main/java"),{recursive:true});await writeFile(path.join(repo,"src/main/java/A.java"),"class A {}");await runSqlColdBuild({repoRoot:repo,db});
 await writeFile(path.join(repo,"src/main/java/A.java"),"class A { void newer() {} }");
 const failed=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:["src/main/java/A.java"]},staged:true,onStage:async name=>{if(name==="parse-declare") throw new Error("injected phase failure");}});
 assert.equal(failed.ok,false);assert.equal(failed.censusComplete,false);
 const next=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[]}});assert.equal(next.ok,true,next.error);assert.equal(next.stages?.mode,"full");
 await runSqlColdBuild({repoRoot:repo,db:oracle});assert.equal(logicalDigest(db).digest,logicalDigest(oracle).digest);
 }finally{close(db);close(oracle);await rm(repo,{recursive:true,force:true});}
});
test("declaration-closure-rename-delete-and-xml-deltas-equal-full",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-closure-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java="src/main/java/";const resource="app/src/main/resources/Mapper.xml";
 const write=async(p:string,text:string)=>{await mkdir(path.dirname(path.join(repo,p)),{recursive:true});await writeFile(path.join(repo,p),text);};
 const compare=async()=>{assertIndexInvariants(db);const oracle=openIndexDb(":memory:");ensureSchema(oracle);try{await runSqlColdBuild({repoRoot:repo,db:oracle});assertIndexInvariants(oracle);assert.equal(logicalDigest(db).digest,logicalDigest(oracle).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(oracle))));}finally{close(oracle);}};
 try{
 await write(`base/${java}Base.java`,"package demo; public class Base { public int value() { return 1; } }");
 await write(`sub/${java}Child.java`,"package demo; public class Child extends Base {}");
 await write(`app/${java}Use.java`,"package demo; class Use { int call(Child c) { return c.value(); } }");
 await write(`app/${java}Mapper.java`,"package demo; interface Mapper { int find(); }");
 await write(resource,'<mapper namespace="demo.Mapper"><select id="find">select 1</select></mapper>');
 await runSqlColdBuild({repoRoot:repo,db});
 await write(`base/${java}Base.java`,"package demo; public class Base { public int renamed() { return 1; } }");
 await write(`app/${java}NewCaller.java`,"package demo; class NewCaller { int call(Child c) { return c.renamed(); } }");
 let result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[`base/${java}Base.java`,`app/${java}NewCaller.java`]}});assert.equal(result.ok,true,result.error);assert.ok(result.stages!.resolve.files>=3);await compare();
 await write(resource,'<mapper namespace="demo.Mapper"><select id="find">select 2</select></mapper>');
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"resources",changed:[resource]}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.parse.xmlFiles,1);assert.ok(result.stages!.sql.elapsedMs>0);await compare();
 await rm(path.join(repo,resource));result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"resources",deleted:[resource]}});assert.equal(result.ok,true,result.error);await compare();
 await write(resource,'<mapper namespace="demo.Mapper"><select id="find">select 3</select></mapper>');
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"resources",changed:[resource]}});assert.equal(result.ok,true,result.error);await compare();
 // The mapper stops binding the XML: rows its binding derived must go with it.
 await write(`app/${java}Mapper.java`,"package other; interface Mapper { int find(); }");
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[`app/${java}Mapper.java`]}});assert.equal(result.ok,true,result.error);await compare();
 await write(`app/${java}Mapper.java`,"package demo; interface Mapper { int find(); }");
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[`app/${java}Mapper.java`]}});assert.equal(result.ok,true,result.error);await compare();
 // A second caller of the same virtual target, then the first caller's removal.
 await write(`app/${java}Second.java`,"package demo; class Second { int call(Child c) { return c.renamed(); } }");
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[`app/${java}Second.java`]}});assert.equal(result.ok,true,result.error);await compare();
 await rm(path.join(repo,`app/${java}NewCaller.java`));
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",deleted:[`app/${java}NewCaller.java`]}});assert.equal(result.ok,true,result.error);await compare();
 await write(`base/${java}Renamed.java`,"package demo; public class Renamed {}");await rm(path.join(repo,`base/${java}Base.java`));
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[`base/${java}Renamed.java`],deleted:[`base/${java}Base.java`]}});assert.equal(result.ok,true,result.error);await compare();
 await write(`base/${java}Renamed.java`,"@#$ !!!");await write(`app/${java}StillGood.java`,"package demo; class StillGood {}");
 result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[`base/${java}Renamed.java`,`app/${java}StillGood.java`]}});assert.equal(result.ok,true,result.error);assert.ok(result.census?.some(f=>f.state==="failed"));await compare();
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("legacy-live-reader-never-observes-mixed-phase-facts-and-search",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-reader-"));const file=path.join(repo,"facts.sqlite");const db=openIndexDb(file);ensureSchema(db);
 try{await mkdir(path.join(repo,"src/main/java"),{recursive:true});await writeFile(path.join(repo,"src/main/java/A.java"),"package demo; class A { void oldMethod() {} }");await runSqlColdBuild({repoRoot:repo,db});
 const {readBundle}=await import("../java-index/sql/rows.js");const {SqlEntitySearch}=await import("../java-index/sql/entity-search.js");
 const original=readBundle(db,"src/main/java/A.java")!.file.contentHash;let observed=0;
 await writeFile(path.join(repo,"src/main/java/A.java"),"package demo; class A { void newMethod() {} }");
 const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:["src/main/java/A.java"]},onStage:async()=>{
 const reader=openIndexDb(file,{readOnly:true});try{observed++;assert.equal(readBundle(reader,"src/main/java/A.java")!.file.contentHash,original);assert.equal(new SqlEntitySearch(reader).searchDetailed("demo.A#newMethod",10,"exact").hits.length,0);}finally{close(reader);}}});
 assert.equal(result.ok,true,result.error);assert.ok(observed>=3);
 const reader=openIndexDb(file,{readOnly:true});try{assert.notEqual(readBundle(reader,"src/main/java/A.java")!.file.contentHash,original);assert.equal(new SqlEntitySearch(reader).searchDetailed("demo.A#newMethod",10,"exact").hits.length,1);}finally{close(reader);}
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});
test("missing-row-census-gap-forces-full-instead-of-false-complete",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-gap-row-"));const db=openIndexDb(":memory:");ensureSchema(db);
 try{await mkdir(path.join(repo,"src/main/java"),{recursive:true});await writeFile(path.join(repo,"src/main/java/A.java"),"class A {}");await writeFile(path.join(repo,"src/main/java/B.java"),"class B {}");await runSqlColdBuild({repoRoot:repo,db});
 // A recorded full census of two files with only one indexed row models a
 // nonfatal parser failure whose file row could not be emitted.
 db.prepare("DELETE FROM file WHERE path=?").run("src/main/java/B.java");
 const {writeMeta,readSourceRootCounts}=await import("./progress.js");
 const counts=readSourceRootCounts(db);counts["src/main/java"].indexedFiles=1;writeMeta(db,"sourceRootCounts",JSON.stringify(counts));writeMeta(db,"buildState","DEGRADED");
 const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:["src/main/java/A.java"]}});
 assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"full");assert.equal(result.files,2);
 assert.equal(readSourceRootCounts(db)["src/main/java"].discoveredFiles,2);
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

type Write={table:string;changes:number};
/** Records the rows each statement changed, per target table. Cached statements are dropped so every write is seen. */
function recordWrites(db:IndexDatabase):Write[] {
 const writes:Write[]=[];const prepare=db.prepare.bind(db);
 db.prepare=((sql:string)=>{
  const statement=prepare(sql);const target=/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(sql)?.[1];
  if(target){const run=statement.run.bind(statement);Object.defineProperty(statement,"run",{value:(...args:unknown[])=>{const result=Reflect.apply(run,statement,args) as {changes:number|bigint};writes.push({table:target,changes:Number(result.changes)});return result;}});}
  return statement;
 }) as typeof db.prepare;
 forgetPrepared(db);
 return writes;
}
function changed(writes:readonly Write[]):Record<string,number> {
 const out:Record<string,number>={};for(const write of writes) if(write.changes>0) out[write.table]=(out[write.table]??0)+write.changes;return out;
}

test("a line-shift-only delta rewrites no graph row, entity, posting or type-name row",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-shift-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const a="package demo; /** Pays. */ class A { int pay(B b) { return b.total(); } }";
 try{
 await mkdir(path.join(repo,"src/main/java"),{recursive:true});await writeFile(path.join(repo,"src/main/java/A.java"),a);
 await writeFile(path.join(repo,"src/main/java/B.java"),"package demo; class B { int total() { return 1; } }");
 await runSqlColdBuild({repoRoot:repo,db});
 await writeFile(path.join(repo,"src/main/java/A.java"),`\n\n${a}`);
 const writes=recordWrites(db);
 const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:["src/main/java/A.java"]}});assert.equal(result.ok,true,result.error);
 const tables=changed(writes);
 for(const table of ["kg_node","kg_node_owner","kg_edge","kg_edge_owner","entity","entity_token","entity_df","search_doc_token","search_doc_df","type_ref_name"]) assert.equal(tables[table],undefined,`${table}: ${JSON.stringify(tables)}`);
 assert.ok(tables.file && tables.search_doc,"the moved ranges are still written");
 assertIndexInvariants(db);
 const full=openIndexDb(":memory:");ensureSchema(full);try{await runSqlColdBuild({repoRoot:repo,db:full});assert.equal(logicalDigest(db).digest,logicalDigest(full).digest);}finally{close(full);}
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("xml-only-type-users-and-transitive-subtypes-deltas-equal-full",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-dependents-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java="src/main/java/demo/";const resource="src/main/resources/Mapper.xml";
 const write=async(p:string,text:string)=>{await mkdir(path.dirname(path.join(repo,p)),{recursive:true});await writeFile(path.join(repo,p),text);};
 const compare=async()=>{assertIndexInvariants(db);const oracle=openIndexDb(":memory:");ensureSchema(oracle);try{await runSqlColdBuild({repoRoot:repo,db:oracle});assertIndexInvariants(oracle);assert.equal(logicalDigest(db).digest,logicalDigest(oracle).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(oracle))));}finally{close(oracle);}};
 const delta=async(job:{changed?:string[];deleted?:string[]})=>{const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",...job}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta",result.stages?.reason);await compare();};
 try{
 // The mapper's Java never names Dto: only its XML resultType does.
 await write(`${java}Mapper.java`,"package demo; interface Mapper { Object find(); }");
 await write(`${java}Dto.java`,"package demo; public class Dto {}");
 await write(resource,'<mapper namespace="demo.Mapper"><select id="find" resultType="demo.Dto">select 1</select></mapper>');
 // A three-level chain: D and C reach A only through B.
 await write(`${java}A.java`,"package demo; public class A { }");
 await write(`${java}B.java`,"package demo; public class B extends A { }");
 await write(`${java}C.java`,"package demo; public class C extends B { public int value() { return 3; } }");
 await write(`${java}D.java`,"package demo; public class D extends B { int run() { return value(); } }");
 await write(`${java}Use.java`,"package demo; class Use { int call(A a) { return a.value(); } }");
 // A second source root from the start: moving Dto into it keeps the layout (a new root is a build-input change).
 await write(`model/${java}Model.java`,"package demo; class Model {}");
 await runSqlColdBuild({repoRoot:repo,db});
 // A gains the method: D's unqualified call, the base-typed receiver in Use and C's override all bind to it.
 await write(`${java}A.java`,"package demo; public class A { public int value() { return 1; } }");
 await delta({changed:[`${java}A.java`]});
 const bound=db.prepare(`SELECT count(*) AS n FROM kg_edge e JOIN sym f ON f.id=e.from_sym JOIN sym t ON t.id=e.to_sym
   WHERE f.text LIKE ? AND t.text LIKE ?`).get(`${java}D.java#demo.D#run#%`,`${java}A.java#demo.A#value#%`) as {n:number};
 assert.equal(Number(bound.n),1,"D's unqualified call binds through B to the method A gained");
 await write(`${java}A.java`,"package demo; public class A { }");
 await delta({changed:[`${java}A.java`]});
 // Dto moves to the other source root with the same FQN, then gains a duplicate.
 await write(`model/${java}Dto.java`,"package demo; public class Dto {}");await rm(path.join(repo,`${java}Dto.java`));
 await delta({changed:[`model/${java}Dto.java`],deleted:[`${java}Dto.java`]});
 await write(`${java}Dto.java`,"package demo; public class Dto { int id; }");
 await delta({changed:[`${java}Dto.java`]});
 await rm(path.join(repo,`model/${java}Dto.java`));
 await delta({deleted:[`model/${java}Dto.java`]});
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("an empty resources job publishes its generation as an empty refresh does",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-empty-job-"));const db=openIndexDb(":memory:");ensureSchema(db);
 try{
 await mkdir(path.join(repo,"src/main/java"),{recursive:true});await writeFile(path.join(repo,"src/main/java/A.java"),"class A {}");
 await runSqlColdBuild({repoRoot:repo,db});
 for(const [kind,generation] of [["refresh",2],["resources",3]] as const){
  const result=await applyBuilderJob({repoRoot:repo,db,job:{kind,changed:[],generation}});
  assert.equal(result.ok,true,result.error);assert.equal(result.indexedGeneration,generation,kind);
 }
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("framework edges to a local type name the type's graph node",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-local-type-"));const db=openIndexDb(":memory:");ensureSchema(db);
 try{
 await mkdir(path.join(repo,"src/main/java/demo"),{recursive:true});
 // Local types have no FQN; Svc's only constructor injects the local Dep.
 await writeFile(path.join(repo,"src/main/java/demo/Outer.java"),"package demo; class Outer { void run() { class Dep {} class Svc { Svc(Dep dep) {} } } }");
 await runSqlColdBuild({repoRoot:repo,db});
 assertIndexInvariants(db);
 const injected=db.prepare(`SELECT count(*) AS n FROM kg_edge e JOIN sym k ON k.id=e.kind_sym JOIN kg_node n ON n.sym=e.to_sym
   WHERE k.text='SPRING_INJECTS' AND n.simple_name='Dep'`).get() as {n:number};
 assert.equal(Number(injected.n),1);
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("dispatch dependents are the callers of the changed methods' names, not every user of the parent type",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-dispatch-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java=(name:string)=>`src/main/java/demo/${name}.java`;
 const write=async(name:string,text:string)=>{await mkdir(path.dirname(path.join(repo,java(name))),{recursive:true});await writeFile(path.join(repo,java(name)),text);};
 const compare=async()=>{assertIndexInvariants(db);const oracle=openIndexDb(":memory:");ensureSchema(oracle);try{await runSqlColdBuild({repoRoot:repo,db:oracle});assert.equal(logicalDigest(db).digest,logicalDigest(oracle).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(oracle))));}finally{close(oracle);}};
 const delta=async(name:string)=>{const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[java(name)]}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta",result.stages?.reason);await compare();return result.stages!;};
 try{
 await write("Gen","package demo; public interface Gen { long next(); void reset(); }");
 await write("Impl","package demo; public class Impl implements Gen { public long next() { return 1; } public void reset() {} }");
 // Twelve callers of next(), and holders whose `gen` variables share the type's name up to case.
 for(let index=0;index<12;index+=1) await write(`Use${index}`,`package demo; class Use${index} { long f(Gen g) { return g.next(); } }`);
 await write("Resetter","package demo; class Resetter { void f(Gen g) { g.reset(); } }");
 await write("Holder","package demo; class Holder { void f(Object gen) { gen.toString(); } }");
 await runSqlColdBuild({repoRoot:repo,db});
 // Impl's export shape changes, but neither next() nor reset() does: no caller is re-graphed.
 await write("Impl","package demo; public class Impl implements Gen { public long next() { return 1; } public void reset() {} void extra() {} }");
 let stages=await delta("Impl");
 assert.equal(stages.graphSearch.files,1,JSON.stringify(stages.resolve));
 assert.deepEqual([stages.resolve.edgeFiles,stages.graphSearch.documentFiles],[1,1]);
 assert.equal(stages.graphSearch.graphFiles,1);
 // reset() stops overriding (arity): only reset()'s caller loses its DISPATCHES_TO edge.
 await write("Impl","package demo; public class Impl implements Gen { public long next() { return 1; } public void reset(int depth) {} void extra() {} }");
 stages=await delta("Impl");
 assert.equal(stages.graphSearch.files,2,JSON.stringify(stages.resolve));
 // Resetter re-graphs only: its facts and static edges read nothing that moved.
 assert.deepEqual([stages.resolve.edgeFiles,stages.graphSearch.documentFiles],[1,1]);
 assert.equal(stages.graphSearch.graphFiles,2);
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("a declared name re-resolves the files it can bind in, not every file spelling it",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-names-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java=(name:string)=>`src/main/java/${name}.java`;
 const write=async(name:string,text:string)=>{await mkdir(path.dirname(path.join(repo,java(name))),{recursive:true});await writeFile(path.join(repo,java(name)),text);};
 const compare=async()=>{assertIndexInvariants(db);const oracle=openIndexDb(":memory:");ensureSchema(oracle);try{await runSqlColdBuild({repoRoot:repo,db:oracle});assert.equal(logicalDigest(db).digest,logicalDigest(oracle).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(oracle))));}finally{close(oracle);}};
 const delta=async(job:{changed?:string[];deleted?:string[]})=>{const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",...job}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta",result.stages?.reason);await compare();return {...result.stages!.resolve,documentFiles:result.stages!.graphSearch.documentFiles};};
 try{
 await write("p1/Dup","package p1; public class Dup {}");
 await write("q/UseWild","package q; import p1.*; class UseWild { Dup d; }");
 await write("q/UseQualified","package q; class UseQualified { p1.Dup d; }");
 // Binds its own nested Dup first: no declaration elsewhere can change that.
 await write("r/Other","package r; class Other { static class Dup {} Dup d; }");
 // No import: the repo-wide fallback leaves Dup AMBIGUOUS here, and `new Dup()` binds from text.
 await write("s/Loose","package s; class Loose { Dup d; }");
 await write("t/Ctor","package t; class Ctor { Object f() { return new Dup(); } }");
 await runSqlColdBuild({repoRoot:repo,db});
 // q.Dup shadows the on-demand import in q and joins the fallback candidates.
 await write("q/Dup","package q; public class Dup {}");
 let resolve=await delta({changed:[java("q/Dup")]});
 assert.deepEqual(resolve.closure,{changed:1,names:4},"UseWild, UseQualified (package q), Loose and Ctor (fallback); not Other");
 // Every re-resolved file rebuilds its edges (Ctor's CONSTRUCTS moves without its facts);
 // only q/Dup, UseWild and Loose (now AMBIGUOUS) re-document.
 assert.deepEqual([resolve.edgeFiles,resolve.documentFiles],[5,3]);
 await rm(path.join(repo,java("p1/Dup")));
 resolve=await delta({deleted:[java("p1/Dup")]});
 assert.deepEqual(resolve.closure,{names:4},"UseQualified, UseWild (imports p1), Loose and Ctor enter by names before resolved reference propagation; not Other");
 assert.deepEqual([resolve.edgeFiles,resolve.documentFiles],[4,2],"UseQualified (now unresolved) and Loose (q.Dup unique) re-document");
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("names bound by text or by a repo-wide lookup re-resolve when a declaration of the name moves",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-text-names-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java=(name:string)=>`src/main/java/${name}.java`;
 const write=async(name:string,text:string)=>{await mkdir(path.dirname(path.join(repo,java(name))),{recursive:true});await writeFile(path.join(repo,java(name)),text);};
 const compare=async()=>{assertIndexInvariants(db);const oracle=openIndexDb(":memory:");ensureSchema(oracle);try{await runSqlColdBuild({repoRoot:repo,db:oracle});assert.equal(logicalDigest(db).digest,logicalDigest(oracle).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(oracle))));}finally{close(oracle);}};
 const delta=async(name:string)=>{const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[java(name)]}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta",result.stages?.reason);await compare();return result.stages!.resolve.closure;};
 try{
 // An annotation is bound from its text; ext.* is not in the repo.
 await write("u/Use","package u; import ext.*; @Marker class Use {}");
 // A repository's entity argument is looked up by simple name when its FQN is not a repo type.
 await write("r/UserRepository","package r; import ext.User; import ext.Repo; interface UserRepository extends Repo<User> {}");
 // Only the repo-wide fallback can bind Widget here.
 await write("t/Loose","package t; class Loose { Widget w; }");
 await write("s/Host","package s; class Host { void f() { } }");
 await runSqlColdBuild({repoRoot:repo,db});
 await write("qq/Marker","package qq; public @interface Marker {}");
 assert.deepEqual(await delta("qq/Marker"),{changed:1,names:1},"u/Use");
 await write("qq/User","package qq; public class User {}");
 assert.deepEqual(await delta("qq/User"),{changed:1,names:1},"r/UserRepository");
 // Local types count per name: one binds Loose, two leave it AMBIGUOUS, and back.
 await write("s/Host","package s; class Host { void f() { class Widget {} } }");
 assert.deepEqual(await delta("s/Host"),{changed:1,names:1},"t/Loose");
 await write("s/Host","package s; class Host { void f() { class Widget {} } void g() { class Widget {} } }");
 await delta("s/Host");
 // AMBIGUOUS leaves no edge to follow: only the per-name count moved.
 await write("s/Host","package s; class Host { void f() { class Widget {} } }");
 assert.deepEqual(await delta("s/Host"),{changed:1,names:1},"t/Loose");
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("two deltas applied in either order publish the same index as a full build",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-order-"));const ab=openIndexDb(":memory:"),ba=openIndexDb(":memory:"),full=openIndexDb(":memory:");
 for(const db of [ab,ba,full]) ensureSchema(db);
 const java=(name:string)=>`src/main/java/${name}.java`;
 const write=(name:string,text:string)=>writeFile(path.join(repo,java(name)),text);
 try{
 await mkdir(path.join(repo,"src/main/java"),{recursive:true});
 await write("Base","package demo; public abstract class Base { public abstract int value(); }");
 await write("Impl","package demo; public class Impl extends Base { public int value() { return 1; } }");
 await write("A","package demo; class A { int a(Base b) { return b.value(); } }");
 await write("C","package demo; class C { int c(Impl i) { return 0; } }");
 await runSqlColdBuild({repoRoot:repo,db:ab});await runSqlColdBuild({repoRoot:repo,db:ba});
 // Both edits make C a second caller and A a caller of a new target.
 await write("A","package demo; class A { int a(Base b) { return b.value() + new Impl().value(); } }");
 await write("C","package demo; class C { int c(Impl i) { return i.value(); } }");
 for(const [db,order] of [[ab,["A","C"]],[ba,["C","A"]]] as const) for(const name of order) {
  const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[java(name)]}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");
 }
 await runSqlColdBuild({repoRoot:repo,db:full});
 for(const db of [ab,ba,full]) assertIndexInvariants(db);
 assert.equal(logicalDigest(ab).digest,logicalDigest(full).digest,JSON.stringify(diffLogical(exportLogical(ab),exportLogical(full))));
 assert.equal(logicalDigest(ba).digest,logicalDigest(full).digest,JSON.stringify(diffLogical(exportLogical(ba),exportLogical(full))));
 }finally{for(const db of [ab,ba,full]) close(db);await rm(repo,{recursive:true,force:true});}
});


test("dispatch top-16 membership, promotion, reparenting and batches remain full-equivalent",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-dispatch-limit-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java=(name:string)=>`src/main/java/demo/${name}.java`;
 const write=async(name:string,text:string)=>{await mkdir(path.dirname(path.join(repo,java(name))),{recursive:true});await writeFile(path.join(repo,java(name)),`package demo; ${text}`);};
 const impl=(name:string,parent="Gen",method="public int value() { return 1; }")=>`public class ${name} implements ${parent} { ${method} }`;
 const targets=()=> (db.prepare(`SELECT DISTINCT t.text AS target FROM kg_edge e JOIN sym k ON k.id=e.kind_sym JOIN sym f ON f.id=e.from_sym JOIN sym t ON t.id=e.to_sym WHERE k.text='DISPATCHES_TO' AND f.text LIKE ? ORDER BY t.text`).all(`${java("Gen")}#demo.Gen#value#%`) as Array<{target:string}>).map(row=>/demo\.(I\d+)#/.exec(row.target)?.[1]);
 const compare=async()=>{assertIndexInvariants(db);const full=openIndexDb(":memory:");ensureSchema(full);try{await runSqlColdBuild({repoRoot:repo,db:full});assertIndexInvariants(full);assert.equal(logicalDigest(db).digest,logicalDigest(full).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(full))));}finally{close(full);}};
 const delta=async(changed:string[]=[],deleted:string[]=[])=>{const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:changed.map(java),deleted:deleted.map(java)}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");await compare();return result.stages!;};
 const ids=Array.from({length:18},(_,index)=>`I${String(index).padStart(2,"0")}`);
 try{
 await write("Gen","public interface Gen { int value(); }");await write("Other","public interface Other { int value(); }");
 for(const name of ids) await write(name,impl(name));
 await write("BaseCaller","class BaseCaller { int run(Gen g) { return g.value(); } }");
 await write("DirectCaller","class DirectCaller { int run(I17 g) { return g.value(); } }");
 await runSqlColdBuild({repoRoot:repo,db});assert.deepEqual(targets(),ids.slice(0,16));
 // An implementation outside the selected set must still update its direct caller.
 await write("I17",impl("I17","Gen","public int value(int n) { return n; }"));
 let stages=await delta(["I17"]);assert.deepEqual(targets(),ids.slice(0,16));
 assert.equal(stages.graphSearch.graphFiles,2,"only I17 and its direct caller re-graph");
 assert.equal(stages.graphSearch.documentFiles,1,"a changed static call edge does not change the caller's search documents");
 await write("I17",impl("I17"));await delta(["I17"]);
 // The 16th changes shape; the 17th is initially excluded, then promoted by deletion.
 await write("I15",impl("I15","Gen","public int value(int n) { return n; }"));
 stages=await delta(["I15"]);assert.deepEqual(targets(),ids.slice(0,15));assert.equal(stages.graphSearch.documentFiles,1);assert.equal(stages.graphSearch.graphFiles,2);
 await rm(path.join(repo,java("I00")));await delta([], ["I00"]);assert.deepEqual(targets(),[...ids.slice(1,15),"I16"]);
 // Reparenting the promoted implementation removes it and brings I17 into the bounded set.
 await write("I16",impl("I16","Other"));await delta(["I16"]);assert.deepEqual(targets(),[...ids.slice(1,15),"I17"]);
 // Batch membership changes reconstruct the pre-job set, rather than considering each edit alone.
 await write("I00",impl("I00"));await write("I16",impl("I16"));await rm(path.join(repo,java("I01")));await rm(path.join(repo,java("I02")));
 await delta(["I00","I16"],["I01","I02"]);assert.deepEqual(targets(),["I00",...ids.slice(3,15),"I16","I17"]);
 // Adding a new earlier identity demotes the former last member.
 await write("I01",impl("I01"));await delta(["I01"]);assert.deepEqual(targets(),["I00","I01",...ids.slice(3,15),"I16"]);
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("unchanged captured input preserves graph and document rows while visiting only the input",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-cutoff-"));const db=openIndexDb(":memory:"),full=openIndexDb(":memory:");ensureSchema(db);ensureSchema(full);
 const relative="src/main/java/A.java";
 try{
 await mkdir(path.dirname(path.join(repo,relative)),{recursive:true});await writeFile(path.join(repo,relative),"class A { int value() { return 1; } }");await writeFile(path.join(repo,"src/main/java/B.java"),"class B { int call(A a) { return a.value(); } }");await runSqlColdBuild({repoRoot:repo,db});
 const writes=recordWrites(db);const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[relative]}});
 assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");assert.deepEqual([result.stages?.graphSearch.graphFiles,result.stages?.graphSearch.documentFiles],[1,1]);
 const tables=changed(writes);for(const table of ["kg_node","kg_node_owner","kg_edge","kg_edge_owner","entity","search_doc","search_doc_token"]) assert.equal(tables[table],undefined,table);
 // Export changes enqueue B, but its resolved facts/static edges are identical: only A rewrites.
 await writeFile(path.join(repo,relative),"class A { int value() { return 1; } void extra() {} }");
 const moved=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[relative]}});assert.equal(moved.ok,true,moved.error);assert.equal(moved.stages?.resolve.files,2);assert.deepEqual([moved.stages?.graphSearch.graphFiles,moved.stages?.graphSearch.documentFiles],[1,1]);
 await runSqlColdBuild({repoRoot:repo,db:full});assert.equal(logicalDigest(db).digest,logicalDigest(full).digest);assertIndexInvariants(db);
 }finally{close(db);close(full);await rm(repo,{recursive:true,force:true});}
});

test("a changed member invalidates its callers without visiting unrelated declarations",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-member-closure-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java=(name:string)=>`src/main/java/demo/${name}.java`;
 const write=async(name:string,text:string)=>{await mkdir(path.dirname(path.join(repo,java(name))),{recursive:true});await writeFile(path.join(repo,java(name)),`package demo; ${text}`);};
 try{
 await write("Api","public class Api { public int foo() { return 1; } public int bar() { return 2; } }");
 await write("FooCaller","class FooCaller { long call(Api a) { return a.foo(); } }");
 await write("BarCaller","class BarCaller { int call(Api a) { return a.bar(); } }");
 await write("ImportOnly","import demo.Api; class ImportOnly {}");
 await runSqlColdBuild({repoRoot:repo,db});
 await write("Api","public class Api { public long foo() { return 1; } public int bar() { return 2; } }");
 const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[java("Api")]}});
 assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");
 assert.deepEqual(result.stages?.resolve.closure,{changed:1,references:1});
 assert.equal(result.stages?.resolve.files,2);
 const full=openIndexDb(":memory:");ensureSchema(full);try{await runSqlColdBuild({repoRoot:repo,db:full});assertIndexInvariants(db);assert.equal(logicalDigest(db).digest,logicalDigest(full).digest);}finally{close(full);}
 await write("Api","import java.util.List; public class Api { public long foo() { List<String> values = List.of(); return values.size(); } public int bar() { return 2; } }");
 const bodyImport=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[java("Api")]}});
 assert.equal(bodyImport.ok,true,bodyImport.error);assert.deepEqual(bodyImport.stages?.resolve.closure,{changed:1},"an implementation-only import does not change an exported binding");
 const afterImport=openIndexDb(":memory:");ensureSchema(afterImport);try{await runSqlColdBuild({repoRoot:repo,db:afterImport});assertIndexInvariants(db);assert.equal(logicalDigest(db).digest,logicalDigest(afterImport).digest);}finally{close(afterImport);}
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("member additions, owner modifiers and import-only changes keep dependent graphs full-equivalent",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-member-safety-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const java=(name:string)=>`src/main/java/${name}.java`;
 const write=async(name:string,text:string)=>{await mkdir(path.dirname(path.join(repo,java(name))),{recursive:true});await writeFile(path.join(repo,java(name)),text);};
 const compare=async()=>{assertIndexInvariants(db);const full=openIndexDb(":memory:");ensureSchema(full);try{await runSqlColdBuild({repoRoot:repo,db:full});assert.equal(logicalDigest(db).digest,logicalDigest(full).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(full))));}finally{close(full);}};
 const delta=async(name:string)=>{const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[java(name)]}});assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");await compare();return result.stages!;};
 const calls=()=>db.prepare("SELECT COUNT(*) AS n FROM edge e JOIN sym k ON k.id=e.kind_sym JOIN file f ON f.id=e.file_id WHERE k.text='CALLS' AND f.path=?").get(java("Use")) as {n:number};
 const callKinds=()=>db.prepare("SELECT k.text AS kind FROM kg_edge e JOIN sym k ON k.id=e.kind_sym JOIN kg_edge_owner o ON o.edge_id=e.id JOIN sym p ON p.id=o.owner_sym WHERE p.text=? AND k.text IN ('CALLS_EXACT','CALLS_VIRTUAL') ORDER BY k.text").all(java("Use")).map(row=>row.kind);
 try{
 await write("p/Api","package p; public abstract class Api { public int value(int n) { return n; } }");
 await write("Use","class Use { int call(p.Api a) { return a.value(1); } }");
 await write("a/Peer","package a; public class Peer {}");await write("b/Peer","package b; public class Peer {}");
 await write("p/Holder","package p; import a.Peer; public class Holder { public Peer value(Peer p) { return p; } }");
 await write("HolderUse","class HolderUse { void call(p.Holder h, a.Peer p) { h.value(p); } }");
 await runSqlColdBuild({repoRoot:repo,db});assert.equal(calls().n,1);assert.deepEqual(callKinds(),["CALLS_VIRTUAL"]);
 await write("p/Api","package p; public abstract class Api { public int value(int n) { return n; } public int value(String s) { return 0; } }");
 await delta("p/Api");assert.equal(calls().n,0,"new same-arity overload makes the existing call ambiguous");
 await write("p/Api","package p; public abstract class Api { public int value(int n) { return n; } }");await delta("p/Api");assert.equal(calls().n,1);
 await write("p/Api","package p; public final class Api { public int value(int n) { return n; } }");
 await delta("p/Api");assert.deepEqual(callKinds(),["CALLS_EXACT"],"qualified receiver has no import edge to the owner");
 await write("p/Holder","package p; import b.Peer; public class Holder { public Peer value(Peer p) { return p; } }");
 const imports=await delta("p/Holder");assert.ok((imports.resolve.closure?.references??0)>=1,"import rebinding still propagates the changed resolved declaration");
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

test("refresh uses the full census source roots and ignored directory rules",async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"pipeline-source-membership-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const included="src/main/java/A.java",excluded=["src/integrationTest/java/Integration.java","src/smartDoc/java/Docs.java","src/main/java/build/Generated.java","src/main/java/target/Generated.java"];
 const write=async(relative:string,text:string)=>{await mkdir(path.dirname(path.join(repo,relative)),{recursive:true});await writeFile(path.join(repo,relative),text);};
 try{
 await write(included,"class A {}");for(const relative of excluded)await write(relative,"class Ignored {}");await runSqlColdBuild({repoRoot:repo,db});
 // A row left by an older explicit refresh must also leave the published index.
 const {readBundle,writeBundle}=await import("../java-index/sql/rows.js");const {javaFileId}=await import("../java-index/stable-id.js");
 writeBundle(db,{file:{...readBundle(db,included)!.file,fileId:javaFileId(excluded[0]),relativePath:excluded[0],sourceRoot:"src/integrationTest/java"},types:[],methods:[],fields:[],edges:[]});
 await write(included,"class A { void updated() {} }");for(const relative of excluded)await write(relative,"@#$ invalid ignored Java");
 const result=await applyBuilderJob({repoRoot:repo,db,job:{kind:"refresh",changed:[included,...excluded]}});
 assert.equal(result.ok,true,result.error);assert.equal(result.stages?.mode,"delta");assert.equal(result.stages?.parse.files,1,"explicit paths must not bypass the full source census");assert.equal(result.files,1);
 const full=openIndexDb(":memory:");ensureSchema(full);try{await runSqlColdBuild({repoRoot:repo,db:full});assertIndexInvariants(db);assert.equal(logicalDigest(db).digest,logicalDigest(full).digest,JSON.stringify(diffLogical(exportLogical(db),exportLogical(full))));}finally{close(full);}
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});
