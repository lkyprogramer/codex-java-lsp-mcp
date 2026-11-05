import { classifyPath } from "../../repo-layout.js";
import type { EvidenceSourcesResult, EvidenceSource } from "../java-index-client-api.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { prepareCached, withReadSnapshot, type IndexDatabase } from "./driver.js";
import { SqlFactsStore } from "./facts-store.js";
import { inflateRawSync } from "node:zlib";
import { symId } from "./sym.js";

/** Experimental read surface: no writes, no declaration search/ranking changes. */
export function queryEvidenceSources(db: IndexDatabase, file: string, line: number, column: number, remainingMs?: () => number): EvidenceSourcesResult {
  return withReadSnapshot(db, () => {
    const generation = Number(prepareCached(db, "SELECT value FROM meta WHERE key='indexedGeneration'").get()?.value ?? 0);
    const out: EvidenceSourcesResult = { generation, sources: [], partial: false, reasons: [] };
    const partial = (reason: string) => { out.partial = true; if (!out.reasons.includes(reason)) out.reasons.push(reason); };
    const expired = () => remainingMs !== undefined && remainingMs() <= 0;
    const resourceFacts = (facts: unknown): MyBatisMapperResourceFacts | undefined => {
      if (!(facts instanceof Uint8Array) || facts.byteLength > 65536) { partial("RESOURCE_FACT_CAP"); return undefined; }
      try {
        const resource = JSON.parse(inflateRawSync(facts, { maxOutputLength: 262144 }).toString("utf8")) as MyBatisMapperResourceFacts | null;
        const validRange = (range: MyBatisMapperResourceFacts["statements"][number]["range"]) => range === undefined || !!range?.start && !!range.end && Number.isInteger(range.start.line) && Number.isInteger(range.end.line) && range.start.line > 0 && range.end.line >= range.start.line;
        if (!resource || (resource.parseState !== "COMPLETE" && resource.parseState !== "FAILED") || typeof resource.namespace !== "string" || typeof resource.relativePath !== "string" || typeof resource.contentHash !== "string" || !Array.isArray(resource.statements) || !Array.isArray(resource.resultMaps)
          || !resource.statements.every(statement => !!statement && typeof statement.id === "string" && validRange(statement.range))
          || !resource.resultMaps.every(map => !!map && (map.type === undefined || typeof map.type === "string") && validRange(map.range))) throw new Error("invalid resource facts");
        return resource;
      }
      catch { partial("RESOURCE_FACT_INVALID"); return undefined; }
    };
    if (expired()) { partial("DEADLINE_EXCEEDED"); return out; }
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) { partial("INVALID_LOCATOR"); return out; }
    // Fresh store prevents cached facts from a prior generation entering this snapshot.
    const store = new SqlFactsStore(db);
    const anchor = store.anchor(file, line, column);
    if (!anchor || (anchor.symbolKind !== "TYPE" && anchor.symbolKind !== "METHOD")) { partial("ANCHOR_UNRESOLVED"); return out; }
    out.anchor = { declarationId: anchor.symbolId, kind: anchor.symbolKind, relativePath: file, contentHash: anchor.file.contentHash, line, column };
    if (anchor.file.parseState !== "COMPLETE") partial("ANCHOR_PARSE_INCOMPLETE");
    const buildState = prepareCached(db, "SELECT value FROM meta WHERE key='buildState'").get()?.value;
    const coverage = prepareCached(db, "SELECT state,generation FROM source_root_coverage WHERE root=?").get(anchor.file.sourceRoot);
    if (buildState !== "READY" || coverage?.state !== "COMPLETE" || Number(coverage?.generation) !== generation) partial("INDEX_COVERAGE_INCOMPLETE");
    const seen = new Set<string>();
    const add = (source: EvidenceSource) => {
      const key = [source.relativePath, source.contentHash, source.startLine, source.endLine].join("|");
      if (seen.has(key)) return;
      seen.add(key);
      if (out.sources.length >= 8) { partial("SOURCE_CAP"); return; }
      out.sources.push(source);
    };
    // FAILED facts lose their namespace and documents, so an XML document
    // point lookup alone cannot establish complete absence for either anchor.
    function* resources(): Generator<MyBatisMapperResourceFacts> {
      let scanned = 0;
      for (const row of prepareCached(db, "SELECT path,facts FROM mybatis_resource ORDER BY path LIMIT 257").iterate()) {
        if (expired()) { partial("DEADLINE_EXCEEDED"); break; }
        if (++scanned > 256) { partial("RESOURCE_SCAN_CAP"); break; }
        const resource = resourceFacts(row.facts);
        if (!resource) continue;
        if (resource.parseState !== "COMPLETE") { partial("RESOURCE_PARSE_INCOMPLETE"); continue; }
        yield resource;
      }
    }
    if (anchor.symbolKind === "METHOD") {
      for (const resource of resources()) {
        // Fully parsed resources with a known binding but no located element
        // also must not disappear behind the source-document table.
        if (resource.namespace === anchor.type?.fqn) {
          if (resource.statements.some(statement => statement.id === anchor.method?.name && !statement.range)) partial("SOURCE_RANGE_UNRESOLVED");
        }
      }
      const declaration = symId(db, anchor.symbolId);
      if (declaration !== undefined) {
        let n = 0;
        for (const row of prepareCached(db, `SELECT p.text AS path,d.start_line,d.end_line,d.kind,r.facts AS resource_facts FROM search_doc d JOIN sym p ON p.id=d.source_path_sym JOIN mybatis_resource r ON r.path=p.text WHERE d.declaration_sym=? ORDER BY p.text,d.start_line,d.end_line,d.kind LIMIT 65`).iterate(declaration)) {
          if (expired()) { partial("DEADLINE_EXCEEDED"); break; }
          if (++n > 64) { partial("DOCUMENT_SCAN_CAP"); break; }
          const resource = resourceFacts(row.resource_facts);
          if (!resource) continue;
          if (resource.parseState !== "COMPLETE") { partial("RESOURCE_PARSE_INCOMPLETE"); continue; }
          add({ relativePath: String(row.path), contentHash: resource.contentHash, startLine: Number(row.start_line), endLine: Number(row.end_line), sourceKind: String(row.kind), relation: "declaration-document" });
        }
      }
    } else if (anchor.type?.fqn) {
      const fqn = anchor.type.fqn;
      const declarations = prepareCached(db, `SELECT s.text AS id,f.path,f.module FROM type t JOIN sym s ON s.id=t.sym JOIN file f ON f.id=t.file_id WHERE t.fqn=? ORDER BY f.path LIMIT 65`).all(fqn);
      if (declarations.length > 64) { partial("TYPE_SCAN_CAP"); return out; }
      for (const resource of resources()) {
        for (const map of resource.resultMaps) {
          if (expired()) { partial("DEADLINE_EXCEEDED"); break; }
          // Aliases have no persisted binding proof. They may name this anchor;
          // never treat an unsupported spelling as a proven absence.
          if (!map.type || !map.type.includes(".")) { partial("RESULT_MAP_TYPE_UNSUPPORTED"); continue; }
          if (map.type !== fqn) continue;
          let visible = declarations;
          if (declarations.length > 1) {
            const match = /^(?:(.*)\/)?src\/(main|test)\/resources\//.exec(resource.relativePath);
            const base = match?.[1];
            const module = match ? (classifyPath("/evidence-repo", `/evidence-repo/${resource.relativePath}`).module ?? "") : undefined;
            visible = module === undefined ? [] : declarations.filter(item => item.module === module && String(item.path).startsWith(base ? `${base}/` : "src/"));
          }
          if (visible.length !== 1) { partial("RESULT_MAP_TYPE_AMBIGUOUS"); continue; }
          if (visible[0]?.id !== anchor.symbolId) continue;
          if (!map.range) { partial("SOURCE_RANGE_UNRESOLVED"); continue; }
          add({ relativePath: resource.relativePath, contentHash: resource.contentHash, startLine: map.range.start.line, endLine: map.range.end.line, sourceKind: "mybatis-result-map", relation: "result-map-type" });
        }
      }
    } else partial("ANCHOR_TYPE_UNRESOLVED");
    return out;
  });
}
