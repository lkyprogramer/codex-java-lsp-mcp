import assert from "node:assert/strict";
import test from "node:test";
import { searchDocumentId, type SearchDocument } from "../../discovery/search-document.js";
import type { EntityRecord } from "../entity-search.js";
import { close, openIndexDb, withTransaction, type IndexDatabase } from "./driver.js";
import { replaceAllEntities, replaceEntitiesForPath, withEntitySearchDelta, writeEntityRecord } from "./entity-tokens.js";
import { SqlEntitySearch } from "./entity-search.js";
import { ensureSchema } from "./schema.js";
import { commitSearchDocStats, deleteSearchDocumentsForPath, rebuildSearchDocDf, replaceSearchDocuments, replaceSearchDocumentsForSource } from "./search-docs.js";
import { symId } from "./sym.js";

function entity(name: string, tokens: string[]): EntityRecord {
  return { entityId: `type:demo.${name}`, kind: "type", fqn: `demo.${name}`, simpleName: name, relativePath: `${name}.java`,
    identifierTokens: tokens, chunkTokens: [...tokens, ...tokens] };
}
function doc(owner: EntityRecord, source: string, text: string): SearchDocument {
  const identity = { declarationId: owner.entityId, sourceKind: "comment" as const, representationVersion: 2 as const,
    source: { relativePath: source, contentHash: `hash-${text}`, startLine: 2, endLine: 3 } };
  return { ...identity, documentId: searchDocumentId(identity), path: source, contentHash: identity.source.contentHash,
    startLine: 2, endLine: 3, normalizedText: text };
}
type OwnedDoc = { ownerPath: string; document: SearchDocument };
function database() { const db = openIndexDb(":memory:"); ensureSchema(db); return db; }
function state(db: IndexDatabase) {
  return {
    entityPostings: db.prepare("SELECT e.text AS entity,d.field,s.text AS token,d.tf FROM entity_token d JOIN sym e ON e.id=d.entity_sym JOIN sym s ON s.id=d.token_sym ORDER BY e.text,d.field,s.text").all(),
    documentPostings: db.prepare("SELECT e.text AS entity,p.text AS path,d.kind,d.start_line,d.end_line,s.text AS token,t.tf FROM search_doc_token t JOIN search_doc d ON d.id=t.doc_id JOIN sym e ON e.id=d.declaration_sym JOIN sym p ON p.id=d.source_path_sym JOIN sym s ON s.id=t.token_sym ORDER BY e.text,p.text,d.kind,d.start_line,d.end_line,s.text").all(),
    entityDf: db.prepare("SELECT d.field,s.text,d.df FROM entity_df d JOIN sym s ON s.id=d.token_sym ORDER BY d.field,s.text").all(),
    documentDf: db.prepare("SELECT s.text,d.df FROM search_doc_df d JOIN sym s ON s.id=d.token_sym ORDER BY s.text").all(),
    stats: db.prepare("SELECT key,value FROM meta WHERE key IN ('entityStats:identifier','entityStats:chunk','searchDocStats') ORDER BY key").all(),
    queries: ["orchid", "violet", "azalea", "shared"].map(query => new SqlEntitySearch(db).searchDetailed(query, 10, "text", { budget: { maxPostings: 100 } }).hits)
  };
}
function equivalent(db: IndexDatabase, entities: EntityRecord[], documents: OwnedDoc[]) {
  const cold = database();
  try {
    replaceAllEntities(cold, [...entities].reverse());
    for (const ownerPath of new Set(documents.map(item => item.ownerPath))) {
      replaceSearchDocuments(cold, ownerPath, documents.filter(item => item.ownerPath === ownerPath).map(item => item.document).reverse(), true);
    }
    rebuildSearchDocDf(cold); commitSearchDocStats(cold);
    assert.deepEqual(state(db), state(cold), "local DF/stats and scored evidence equal a fresh rebuild");
  } finally { close(cold); }
}
function remove(db: IndexDatabase, record: EntityRecord) {
  const id = symId(db, record.entityId)!;
  db.prepare("DELETE FROM entity_token WHERE entity_sym=?").run(id);
  db.prepare("DELETE FROM entity WHERE sym=?").run(id);
}

test("posting deltas replace old/new tokens and delete Java-owner and XML-source documents", () => {
  const db = database();
  const a = entity("A", ["orchid", "shared"]), b = entity("B", ["orchid", "shared"]);
  const nextA = entity("A", ["violet", "shared"]);
  const aDoc = { ownerPath: a.relativePath, document: doc(a, "A.java", "orchid shared") };
  const bDoc = { ownerPath: b.relativePath, document: doc(b, "Mapper.xml", "orchid shared") };
  try {
    replaceAllEntities(db, [a, b]);
    replaceSearchDocuments(db, a.relativePath, [aDoc.document]);
    replaceSearchDocumentsForSource(db, "Mapper.xml", [bDoc]);
    equivalent(db, [a, b], [aDoc, bDoc]);
    const nextDoc = { ownerPath: a.relativePath, document: doc(a, "A.java", "violet shared") };
    withEntitySearchDelta(db, [a.relativePath, a.relativePath], () => writeEntityRecord(db, nextA));
    replaceSearchDocuments(db, a.relativePath, [nextDoc.document]);
    equivalent(db, [nextA, b], [nextDoc, bDoc]);
    replaceSearchDocumentsForSource(db, "Mapper.xml", []);
    equivalent(db, [nextA, b], [nextDoc]);
    withEntitySearchDelta(db, [a.relativePath], () => remove(db, nextA));
    deleteSearchDocumentsForPath(db, a.relativePath);
    equivalent(db, [b], []);
    withEntitySearchDelta(db, [b.relativePath], () => remove(db, b));
    equivalent(db, [], []);
  } finally { close(db); }
});

test("posting deltas initialize absent stats and maintain an empty corpus", () => {
  const db = database();
  const a = entity("A", ["azalea", "shared"]);
  const document = doc(a, "A.java", "azalea shared");
  try {
    withEntitySearchDelta(db, [a.relativePath], () => writeEntityRecord(db, a));
    replaceSearchDocuments(db, a.relativePath, [document]);
    equivalent(db, [a], [{ ownerPath: a.relativePath, document }]);
    db.exec("DELETE FROM meta WHERE key IN ('entityStats:identifier','entityStats:chunk','searchDocStats')");
    withEntitySearchDelta(db, [a.relativePath], () => remove(db, a));
    deleteSearchDocumentsForPath(db, a.relativePath);
    equivalent(db, [], []);
  } finally { close(db); }
});

test("failed delta callbacks roll back postings, DF, stats and query evidence together", () => {
  const db = database();
  const a = entity("A", ["orchid", "shared"]);
  const document = doc(a, "Mapper.xml", "orchid shared");
  try {
    replaceAllEntities(db, [a]);
    replaceSearchDocumentsForSource(db, "Mapper.xml", [{ ownerPath: a.relativePath, document }]);
    const before = state(db);
    assert.throws(() => withEntitySearchDelta(db, [a.relativePath], () => {
      writeEntityRecord(db, entity("A", ["violet"]));
      replaceSearchDocumentsForSource(db, "Mapper.xml", [{ ownerPath: a.relativePath, document: doc(a, "Mapper.xml", "violet") }]);
      throw new Error("abort delta");
    }), /abort delta/);
    assert.deepEqual(state(db), before);
    // Validation fails after deleting existing documents and inserting a valid
    // replacement. The standalone document transaction must undo both writes.
    assert.throws(() => replaceSearchDocumentsForSource(db, "Mapper.xml", [
      { ownerPath: a.relativePath, document: doc(a, "Mapper.xml", "violet") },
      { ownerPath: a.relativePath, document: doc(a, "Other.xml", "azalea") }
    ]), /not sourced/);
    assert.deepEqual(state(db), before);
    equivalent(db, [a], [{ ownerPath: a.relativePath, document }]);
    assert.throws(()=>withTransaction(db,()=>{
      withEntitySearchDelta(db,[a.relativePath],()=>writeEntityRecord(db,entity("A",["violet"])));
      replaceSearchDocumentsForSource(db,"Mapper.xml",[{ownerPath:a.relativePath,document:doc(a,"Mapper.xml","violet")}]);
      throw new Error("abort after DF updates");
    }),/abort after DF updates/);
    assert.deepEqual(state(db),before);
  } finally { close(db); }
});


test("zero posting-count deltas avoid global counts and DF writes despite TF/hash changes", () => {
  const db=database();const statements:string[]=[];const prepare=db.prepare.bind(db);
  db.prepare=((sql:string)=>{
    const statement=prepare(sql);
    for(const method of ["get","run"] as const){
      const invoke=statement[method].bind(statement);
      Object.defineProperty(statement,method,{value:(...args:unknown[])=>{statements.push(sql);return Reflect.apply(invoke,statement,args);}});
    }
    return statement;
  }) as typeof db.prepare;
  const a=entity("A",["shared","orchid"]),b=entity("B",["shared","violet"]);
  const aTf=entity("A",["shared","shared","orchid"]),bTf=entity("B",["shared","violet","violet"]);
  const aDoc=doc(a,"Mapper.xml","shared orchid"),bDoc=doc(b,"Mapper.xml","shared violet");
  try{
    replaceAllEntities(db,[a,b]);replaceSearchDocumentsForSource(db,"Mapper.xml",[{ownerPath:a.relativePath,document:aDoc},{ownerPath:b.relativePath,document:bDoc}]);
    statements.length=0;
    withEntitySearchDelta(db,[a.relativePath,b.relativePath],()=>{writeEntityRecord(db,aTf);writeEntityRecord(db,bTf);});
    const nextA={...aDoc,contentHash:"new-hash",source:{...aDoc.source,contentHash:"new-hash"}};
    nextA.documentId=searchDocumentId(nextA);
    const nextB=doc(b,"Mapper.xml","shared violet violet");
    replaceSearchDocumentsForSource(db,"Mapper.xml",[{ownerPath:a.relativePath,document:nextA},{ownerPath:b.relativePath,document:nextB}]);
    assert.deepEqual(statements.filter(sql=>/count\(\*\).*FROM (?:entity_token|search_doc_token) WHERE/i.test(sql)),[],"zero delta must not recount the global posting lists");
    assert.deepEqual(statements.filter(sql=>/^(?:INSERT INTO|UPDATE|DELETE FROM) (?:entity_df|search_doc_df)\b/i.test(sql)),[],"zero delta must not issue DF writes");
    equivalent(db,[aTf,bTf],[{ownerPath:a.relativePath,document:nextA},{ownerPath:b.relativePath,document:nextB}]);
    const renamed={...aTf,relativePath:"Renamed.java"};
    withEntitySearchDelta(db,[a.relativePath,renamed.relativePath],()=>writeEntityRecord(db,renamed));
    equivalent(db,[renamed,bTf],[{ownerPath:a.relativePath,document:nextA},{ownerPath:b.relativePath,document:nextB}]);
    statements.length=0;
    const c=entity("C",["shared","azalea"]);
    withEntitySearchDelta(db,[renamed.relativePath,c.relativePath],()=>{remove(db,renamed);writeEntityRecord(db,c);});
    replaceSearchDocumentsForSource(db,"Mapper.xml",[{ownerPath:b.relativePath,document:nextB}]);
    assert.deepEqual(statements.filter(sql=>/count\(\*\).*FROM (?:entity_token|search_doc_token) WHERE/i.test(sql)),[],"nonzero deltas must also avoid global posting counts");
    equivalent(db,[c,bTf],[{ownerPath:b.relativePath,document:nextB}]);
  }finally{close(db);}
});

test("per-file entity and document replacement writes only changed postings and equals a rebuild", () => {
  const db = database();
  const a = entity("A", ["orchid", "shared"]), b = entity("B", ["violet", "shared"]);
  const sibling = { ...entity("A2", ["azalea"]), relativePath: a.relativePath };
  const aDoc = doc(a, "A.java", "orchid shared");
  try {
    withEntitySearchDelta(db, [a.relativePath, b.relativePath], () => {
      replaceEntitiesForPath(db, a.relativePath, [a, sibling]);
      replaceEntitiesForPath(db, b.relativePath, [b]);
    });
    replaceSearchDocuments(db, a.relativePath, [aDoc]);
    equivalent(db, [a, sibling, b], [{ ownerPath: a.relativePath, document: aDoc }]);
    const changes = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    let before = changes();
    withEntitySearchDelta(db, [a.relativePath], () => replaceEntitiesForPath(db, a.relativePath, [a, sibling]));
    // The document moved two lines: one row update, no posting written.
    const moved = { ...aDoc, source: { ...aDoc.source, startLine: 4, endLine: 5 }, startLine: 4, endLine: 5 };
    replaceSearchDocuments(db, a.relativePath, [moved]);
    assert.equal(changes() - before, 1);
    before = changes();
    const nextA = entity("A", ["orchid", "tulip"]);
    withEntitySearchDelta(db, [a.relativePath], () => replaceEntitiesForPath(db, a.relativePath, [nextA]));
    equivalent(db, [nextA, b], [{ ownerPath: a.relativePath, document: moved }]);
    assert.ok(changes() - before > 0);
  } finally { close(db); }
});
