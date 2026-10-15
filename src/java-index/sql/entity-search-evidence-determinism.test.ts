import assert from "node:assert/strict";
import test from "node:test";
import { searchDocumentId, type SearchDocument } from "../../discovery/search-document.js";
import { close, openIndexDb } from "./driver.js";
import { replaceAllEntities } from "./entity-tokens.js";
import { SqlEntitySearch } from "./entity-search.js";
import { ensureSchema } from "./schema.js";
import { encodeFacts } from "./rows.js";
import { commitSearchDocStats, deleteSearchDocumentsForPath, rebuildSearchDocDf, replaceSearchDocuments } from "./search-docs.js";
import { internSym } from "./sym.js";

function document(overrides: Partial<SearchDocument["source"]> = {}, sourceKind: SearchDocument["sourceKind"] = "comment"): SearchDocument {
  const source = { relativePath: "src/A.java", contentHash: "aaa", startLine: 2, endLine: 3, ...overrides };
  const identity = { declarationId: "type:demo.Service", sourceKind, source, representationVersion: 2 as const };
  return { ...identity, documentId: searchDocumentId(identity), path: source.relativePath, contentHash: source.contentHash,
    startLine: source.startLine, endLine: source.endLine, normalizedText: "zqxrefund" };
}

for (const [dimension, later] of [
  ["kind", document({}, "signature")],
  ["source path", document({ relativePath: "src/Z.java" })],
  ["start line", document({ startLine: 10, endLine: 11 })],
  ["end line", document({ endLine: 10 })]
  // A source has one content hash (the evidence reads it from the source
  // row, schema v13), so the hash cannot separate two documents.
] as const) {
  test(`document evidence uses logical ${dimension} across cold and incremental insertion orders`, () => {
    const first = document();
    let expected: unknown;
    for (const order of [[first, later], [later, first]]) {
      const db = openIndexDb(":memory:");
      try {
        ensureSchema(db);
        // Pre-intern the losing path: sym allocation must not decide the tie.
        internSym(db, later.source.relativePath);
        for (const source of new Set([first.source.relativePath, later.source.relativePath])) {
          db.prepare("INSERT INTO file(path, content_hash, generation, facts) VALUES (?, ?, 1, ?)").run(source, first.source.contentHash, encodeFacts({}));
        }
        replaceAllEntities(db, [{ entityId: first.declarationId, kind: "type", fqn: "demo.Service", simpleName: "Service",
          relativePath: "Service.java", identifierTokens: ["service"], chunkTokens: [] }]);
        const publish = (documents: SearchDocument[]) => {
          replaceSearchDocuments(db, "Service.java", documents);
          rebuildSearchDocDf(db);
          commitSearchDocStats(db);
        };
        const read = () => {
          const search = new SqlEntitySearch(db);
          const hits = search.search("zqxrefund", 5, "text").filter(hit => hit.layer === "DOCUMENT");
          assert.equal(hits.length, 1);
          assert.deepEqual(hits[0]!.evidence, { relativePath: first.source.relativePath, contentHash: first.source.contentHash,
            startLine: first.source.startLine, endLine: first.source.endLine, sourceKind: first.sourceKind });
          const detailed = search.searchDetailed("zqxrefund", 5, "text", { budget: { maxPostings: 10 } });
          assert.equal(detailed.truncated, false);
          assert.deepEqual(detailed.hits.filter(hit => hit.layer === "DOCUMENT"), hits);
          return hits;
        };
        publish(order);
        const cold = read();
        expected ??= cold;
        assert.deepEqual(cold, expected);
        // Re-indexing from scratch allocates fresh IDs in the opposite order
        // (an in-place replacement keeps the unchanged rows and their IDs).
        deleteSearchDocumentsForPath(db, "Service.java");
        publish([...order].reverse());
        assert.deepEqual(read(), cold);
      } finally { close(db); }
    }
  });
}
