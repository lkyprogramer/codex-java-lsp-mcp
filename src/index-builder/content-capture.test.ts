import { captureSource, hashSourceWithin } from "../java-index/source-capture.js";
import { applyBuilderJob } from "./incremental.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile, open, chmod, symlink, utimes } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { ParseTreeCache } from "../java-index/builder/parse-cache.js";
import { buildSearchDocuments } from "../discovery/search-document.js";
import { RequestSourceReader, runStaticDiscovery } from "../discovery/query.js";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema, schemaVersionsMatch } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "./cold-build.js";
import { readMeta } from "./progress.js";
import { readBundle } from "../java-index/sql/rows.js";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
 const repo = await mkdtemp(path.join(tmpdir(), "capture-"));
 await mkdir(path.join(repo, "src/main/java"), { recursive: true });
 const file = path.join(repo, "src/main/java/A.java");
 return { repo, file };
}
test("parse-search-use-identical-bytes", async () => {
 const f = await fixture(); const original = "class A { void originalMethod() {} }";
 const db = openIndexDb(":memory:"); ensureSchema(db);
 try {
  await writeFile(f.file, original);
  await runSqlColdBuild({repoRoot: f.repo, db, onProgress(p) {
   if (p.phase === "declare") writeFileSync(f.file, "class A { void changedMethod() {} }");
  }});
  const bundle = readBundle(db, "src/main/java/A.java")!;
  const docs = buildSearchDocuments({bundle});
  const stored = db.prepare("SELECT DISTINCT s.text AS normalized_text FROM search_doc_token t JOIN sym s ON s.id=t.token_sym").all() as Array<{normalized_text:string}>;
  assert.ok(stored.some(d=>d.normalized_text.includes("originalmethod")));
  assert.ok(stored.every(d=>!d.normalized_text.includes("changedmethod")));
  assert.equal(bundle.file.contentHash, sha(original));
  assert.ok(docs.some(d => d.normalizedText.includes("originalMethod")));
  assert.ok(docs.every(d => !d.normalizedText.includes("changedMethod") && d.contentHash === sha(original)));
  assert.notEqual(sha(await readFile(f.file)), bundle.file.contentHash);
 } finally {close(db); await rm(f.repo,{recursive:true,force:true});}
});
test("preview-rejects-live-hash-mismatch", async () => {
 const f = await fixture();
 try {
  await writeFile(f.file, "class A {}"); const indexed = sha(await readFile(f.file));
  await writeFile(f.file,"class B {}");
  const read = await new RequestSourceReader(f.repo).read("src/main/java/A.java");
  assert.ok(read.state === "ok"); assert.notEqual(read.contentHash, indexed);
  const client = {status:async()=>({state:"READY",indexedGeneration:1,coverage:[],resourceCoverage:[]}),querySearch:async()=>({hits:[{entityId:"type:A",kind:"type",fqn:"A",simpleName:"A",relativePath:"src/main/java/A.java",layer:"FQN",score:1,line:1,column:1,contentHash:indexed}],generation:1,truncated:false,selectionLimited:false,work:{postings:0}})};
  const result = await runStaticDiscovery(client as unknown as Parameters<typeof runStaticDiscovery>[0],{repoRoot:f.repo,query:"A",searchMode:"text"});
  assert.equal(result.scopeState,"PARTIAL"); assert.equal(result.droppedStale,1); assert.equal(result.candidates.length,0);
 } finally {await rm(f.repo,{recursive:true,force:true});}
});
test("source-root-may-use-another-volume", async () => {
 // No clone/stat.dev comparison with the database: independent source/cache roots.
 const f = await fixture(); const db = openIndexDb(":memory:"); ensureSchema(db);
 try {await writeFile(f.file,"class A {}"); await runSqlColdBuild({repoRoot:f.repo,db}); assert.equal(readBundle(db,"src/main/java/A.java")?.types[0]?.simpleName,"A");}
 finally {close(db);await rm(f.repo,{recursive:true,force:true});}
});
test("capture-hashes-original-malformed-utf8-and-survives-edit-during-parse", async () => {
 const f = await fixture(); const backend = await createJavaParserBackend(); const cache = new ParseTreeCache();
 const bytes = Buffer.concat([Buffer.from("// "),Buffer.from([255]),Buffer.from("\nclass A {}")]);
 try {
  await writeFile(f.file,bytes);
  const wrapped = Object.create(backend) as typeof backend;
  wrapped.parse = (...args: Parameters<typeof backend.parse>) => {writeFileSync(f.file,"class B {}");return backend.parse(...args);};
  const bundle = await parseJavaSourceFile({repoRoot:f.repo,resolvedRepoRoot:f.repo,inputPath:f.file,generation:1,backend:wrapped,cache});
  assert.equal(bundle.file.contentHash,sha(bytes)); assert.equal(bundle.types[0]?.simpleName,"A");
  const read = await new RequestSourceReader(f.repo).read("src/main/java/A.java");
  assert.equal(read.state,"ok"); if(read.state === "ok") assert.notEqual(read.contentHash,bundle.file.contentHash);
 } finally {cache.clear();await rm(f.repo,{recursive:true,force:true});}
});
test("tracker-hash-matches-capture-and-stays-within-the-canonical-root", async () => {
 const f = await fixture(); const outside = await mkdtemp(path.join(tmpdir(), "capture-outside-"));
 const bytes = Buffer.concat([Buffer.from("// "),Buffer.from([255]),Buffer.from("\nclass A {}")]);
 try {
  const root = await realpath(f.repo);
  await writeFile(f.file,bytes);
  assert.equal(await hashSourceWithin(root,path.join(root,"src/main/java/A.java")),(await captureSource(f.repo,f.file)).contentHash);
  await writeFile(path.join(outside,"B.java"),"class B {}");
  await symlink(path.join(outside,"B.java"),path.join(root,"src/main/java/B.java"));
  await assert.rejects(hashSourceWithin(root,path.join(root,"src/main/java/B.java")),/outside repo root/);
 } finally {await rm(f.repo,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test("v11-facts-without-captured-signatures-are-invalidated", () => {
 const db = openIndexDb(":memory:"); ensureSchema(db);
 try {db.prepare("UPDATE meta SET value='11' WHERE key='schemaVersion'").run();assert.equal(schemaVersionsMatch(db),false);ensureSchema(db);assert.equal(schemaVersionsMatch(db),true);}
 finally {close(db);}
});

 test("capture-census-includes-failed-java-nonmapper-xml-and-deletions", async () => {
 const f = await fixture(); const db = openIndexDb(":memory:"); ensureSchema(db);
 try {
  await writeFile(f.file,"class A {}");
  await writeFile(path.join(f.repo,"src/main/java/Bad.java"),"@#$ !!!");
  await mkdir(path.join(f.repo,"src/main/resources"),{recursive:true});
  await writeFile(path.join(f.repo,"src/main/resources/plain.xml"),"<plain/>");
  const cold = await runSqlColdBuild({repoRoot:f.repo,db});
  assert.equal(cold.census.find(r=>r.relativePath.endsWith("Bad.java"))?.state,"failed");
  assert.ok(cold.census.find(r=>r.relativePath.endsWith("plain.xml"))?.contentHash);
  await rm(f.file);
  const {applyBuilderJob} = await import("./incremental.js");
  const delta = await applyBuilderJob({repoRoot:f.repo,db,job:{kind:"reconcile"}});
  assert.equal(delta.ok,true,delta.error);
  assert.equal(delta.census?.find(r=>r.relativePath.endsWith("A.java"))?.state,"deleted");
 } finally {close(db);await rm(f.repo,{recursive:true,force:true});}
 });

for (const kind of ["java", "resources"] as const) {
 // The tracker's census never follows a symlinked root, so capture must not either: the root is
 // skipped and reported as a coverage gap. Failing instead would retry forever (NOT_READY, no label).
 test(`capture-skips-${kind}-source-root-symlink-escape-as-a-coverage-gap`, async () => {
  const f = await fixture(); const outside = await mkdtemp(path.join(tmpdir(),"capture-outside-"));
  const db = openIndexDb(":memory:"); ensureSchema(db);
  try {
   await writeFile(f.file,"class A {}");
   await runSqlColdBuild({repoRoot:f.repo,db});
   const root = `src/main/${kind}`;
   const source = path.join(f.repo,root);
   await rm(source,{recursive:true,force:true});
   await writeFile(path.join(outside,kind === "java" ? "A.java" : "Mapper.xml"),kind === "java" ? "class Escaped {}" : '<mapper namespace="Escaped"/>');
   await symlink(outside,source);
   const result = await applyBuilderJob({repoRoot:f.repo,db,job:{kind:"reconcile"}});
   assert.equal(result.ok,true,result.error);
   assert.equal(result.census?.some(row => row.relativePath.startsWith(`${root}/`) && row.state !== "deleted"),false,"nothing behind the link is captured");
   assert.equal((db.prepare("SELECT count(*) AS n FROM type WHERE simple_name='Escaped'").get() as {n:number}).n,0,"escaped content is never indexed");
   if (kind === "java") assert.equal(readBundle(db,"src/main/java/A.java"),undefined,"the replaced root's old facts are not claimed either");
   else assert.equal(readBundle(db,"src/main/java/A.java")?.types[0]?.simpleName,"A","the untouched java root keeps its facts");
   assert.equal((db.prepare("SELECT state FROM source_root_coverage WHERE root=?").get(root) as {state:string}|undefined)?.state,"DEGRADED");
   assert.equal(readMeta(db,"buildState"),"DEGRADED");
  } finally {close(db);await rm(f.repo,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
 });
}
for (const blocked of ["src/main/java/pkg", "src/main", "pom.xml"]) {
test(`unreadable-indexed-input-is-not-deletion: ${blocked}`, async () => {
 const f=await fixture();const db=openIndexDb(":memory:");ensureSchema(db);
 const sub=path.join(f.repo,"src/main/java/pkg"); const target=path.join(f.repo,blocked);
 try {
  await mkdir(sub);await writeFile(path.join(sub,"B.java"),"class B {}");
  await writeFile(path.join(f.repo,"pom.xml"),"<project><modules><module>child</module></modules></project>");
  await mkdir(path.join(f.repo,"child/src/main/java"),{recursive:true});
  await writeFile(path.join(f.repo,"child/src/main/java/C.java"),"class C {}");
  await runSqlColdBuild({repoRoot:f.repo,db});
  await chmod(target,0);
  const result=await applyBuilderJob({repoRoot:f.repo,db,job:{kind:"reconcile"}});
  assert.equal(result.ok,false);assert.equal(result.censusComplete,false);assert.match(result.error!,/EACCES/);
  assert.ok(readBundle(db,"src/main/java/pkg/B.java"));
  assert.ok(readBundle(db,"child/src/main/java/C.java"));
 }finally{await chmod(target,blocked === "pom.xml" ? 0o600 : 0o700);close(db);await rm(f.repo,{recursive:true,force:true});}
});
}
test("missing-repo-root-is-not-complete-empty-census",async()=>{
 const f=await fixture();const db=openIndexDb(":memory:");ensureSchema(db);
 try{await writeFile(f.file,"class A {}");await runSqlColdBuild({repoRoot:f.repo,db});await rm(f.repo,{recursive:true,force:true});
 const result=await applyBuilderJob({repoRoot:f.repo,db,job:{kind:"reconcile"}});assert.equal(result.ok,false);assert.equal(result.censusComplete,false);assert.ok(readBundle(db,"src/main/java/A.java"));}
 finally{close(db);await rm(f.repo,{recursive:true,force:true});}
});
test("capture-does-not-stamp-file-modified-before-after-stat", async t => {
 const f=await fixture();let probe: Awaited<ReturnType<typeof open>> | undefined;
 try {
  await writeFile(f.file,"class A {}");probe=await open(f.file,"r");
  const prototype=Object.getPrototypeOf(probe) as {stat: typeof probe.stat};const original=prototype.stat;
  let stats=0;
  t.mock.method(prototype,"stat",async function(this:typeof probe,...args:Parameters<typeof original>){
   stats++;if(stats === 2) await writeFile(f.file,"class ModifiedAfterRead {}");
   return original.apply(this,args);
  });
  const capture=await captureSource(f.repo,f.file);
  assert.equal(stats,2);assert.equal(capture.bytes.toString(),"class A {}");assert.equal(capture.observed,undefined);
 }finally{t.mock.restoreAll();await probe?.close();await rm(f.repo,{recursive:true,force:true});}
});

for (const kind of ["java", "resource"] as const) {
 test(`reconcile-hashes-same-size-same-mtime-${kind}-edit`, async () => {
  // Ledger D07: a stat row with equal size+mtime must not skip the hash; ctime/inode still moved.
  const f = await fixture(); const db = openIndexDb(":memory:"); ensureSchema(db);
  const target = kind === "java" ? f.file : path.join(f.repo, "src/main/resources/mapper/M.xml");
  const [from, to] = kind === "java" ? ["class A { void alpha() {} }", "class A { void omega() {} }"] : ['<mapper namespace="demo.Alpha"/>', '<mapper namespace="demo.Omega"/>'];
  try {
   await mkdir(path.dirname(target), { recursive: true });
   if (kind === "resource") await writeFile(f.file, "class A {}");
   await writeFile(target, from);
   const second = Math.floor(Date.now() / 1000) - 60;
   await utimes(target, second, second);
   await runSqlColdBuild({ repoRoot: f.repo, db });
   const before = await lstat(target);
   await writeFile(target, to); await utimes(target, second, second);
   const after = await lstat(target);
   assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs]);
   const result = await applyBuilderJob({ repoRoot: f.repo, db, job: { kind: "reconcile" } });
   assert.equal(result.ok, true, result.error);
   const relative = path.relative(f.repo, target);
   if (kind === "java") assert.equal(readBundle(db, relative)!.file.contentHash, sha(to));
   else assert.equal((db.prepare("SELECT content_hash AS h FROM resource_scan WHERE path=?").get(relative) as { h: string }).h, sha(to));
  } finally { close(db); await rm(f.repo, { recursive: true, force: true }); }
 });
}
