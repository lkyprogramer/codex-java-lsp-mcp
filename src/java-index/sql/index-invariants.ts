// input: a facts database at rest (after any full or delta publication).
// output: the structural invariants every published state must satisfy,
//         each with its violation count and a bounded sample.
// pos: MAC-05 correctness layer. A logicalDigest equal to a fresh full proves
//      one state; these hold for every state, including ones no oracle built.
import { createHash } from "node:crypto";
import { REVERSE_EDGE_KIND } from "../../java-knowledge/edge-kinds.js";
import { KNOWLEDGE_REPOSITORY_ID, knowledgeEdgeId } from "../../java-knowledge/entity-id.js";
import type { IndexDatabase } from "./driver.js";
import { ENTITY_STATS_KEYS } from "./entity-tokens.js";
import { SEARCH_DOC_STATS_KEY } from "./search-docs.js";
import { symId } from "./sym.js";

export type InvariantResult = { name: string; violations: number; sample: unknown[] };
export type InvariantReport = { ok: boolean; checks: InvariantResult[] };

const SAMPLE = 5;
// Kinds a Java file declares: each node is owned by (at least) its own file.
const DECLARATION_KINDS = ["FILE", "TYPE", "METHOD", "CONSTRUCTOR", "FIELD"] as const;

function count(db: IndexDatabase, name: string, sql: string, ...params: Array<number | string>): InvariantResult {
  const n = Number((db.prepare(`SELECT count(*) AS n FROM (${sql})`).get(...params) as { n: number | bigint }).n);
  const sample = n === 0 ? [] : db.prepare(`${sql} LIMIT ${SAMPLE}`).all(...params) as unknown[];
  return { name, violations: n, sample };
}

function metaValue(db: IndexDatabase, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value?: string } | undefined)?.value;
}

function xorOf(values: Iterable<string>): Buffer {
  const out = Buffer.alloc(32);
  for (const value of values) {
    const item = createHash("sha256").update(value, "utf8").digest();
    for (let index = 0; index < 32; index += 1) out[index] = out[index]! ^ item[index]!;
  }
  return out;
}

export function checkGraphInvariants(db: IndexDatabase): InvariantResult[] {
  const out: InvariantResult[] = [];
  const reverseSym = symId(db, "CALLED_BY");
  const forward = Object.keys(REVERSE_EDGE_KIND).map(kind => symId(db, kind)).filter((sym): sym is number => sym !== undefined);
  if (reverseSym !== undefined && forward.length > 0) {
    const kinds = forward.join(",");
    // Each owner of a forward call edge owns its CALLED_BY reverse (ordinal 0).
    out.push(count(db, "graph.reverse-owned-by-every-forward-owner", `
      SELECT fs.text AS fromId, ks.text AS kind, ts.text AS toId, os.text AS owner
      FROM kg_edge e JOIN kg_edge_owner o ON o.edge_id=e.id
      JOIN sym fs ON fs.id=e.from_sym JOIN sym ts ON ts.id=e.to_sym JOIN sym ks ON ks.id=e.kind_sym JOIN sym os ON os.id=o.owner_sym
      WHERE e.kind_sym IN (${kinds}) AND NOT EXISTS (
        SELECT 1 FROM kg_edge r JOIN kg_edge_owner ro ON ro.edge_id=r.id
        WHERE r.from_sym=e.to_sym AND r.kind_sym=? AND r.to_sym=e.from_sym AND r.ordinal=0 AND ro.owner_sym=o.owner_sym)`, reverseSym));
    // A reverse is owned only by owners of some forward edge it mirrors.
    out.push(count(db, "graph.reverse-owner-has-forward", `
      SELECT fs.text AS fromId, ts.text AS toId, os.text AS owner
      FROM kg_edge r JOIN kg_edge_owner ro ON ro.edge_id=r.id
      JOIN sym fs ON fs.id=r.from_sym JOIN sym ts ON ts.id=r.to_sym JOIN sym os ON os.id=ro.owner_sym
      WHERE r.kind_sym=? AND NOT EXISTS (
        SELECT 1 FROM kg_edge e JOIN kg_edge_owner o ON o.edge_id=e.id
        WHERE e.from_sym=r.to_sym AND e.to_sym=r.from_sym AND e.kind_sym IN (${kinds}) AND o.owner_sym=ro.owner_sym)`, reverseSym));
  } else if (forward.length > 0) {
    // No CALLED_BY symbol: the reverse checks above cannot run, so any forward edge is unmirrored.
    out.push(count(db, "graph.reverse-owned-by-every-forward-owner",
      `SELECT e.id FROM kg_edge e WHERE e.kind_sym IN (${forward.join(",")})`));
  }
  // Only external (`ext:`) endpoints may name a node no file declares.
  out.push(count(db, "graph.edge-endpoint-is-node", `
    SELECT ks.text AS kind, s.text AS endpoint FROM (SELECT kind_sym, from_sym AS sym FROM kg_edge UNION ALL SELECT kind_sym, to_sym FROM kg_edge) e
    JOIN sym s ON s.id=e.sym JOIN sym ks ON ks.id=e.kind_sym
    WHERE substr(s.text, 1, 4)<>'ext:' AND NOT EXISTS (SELECT 1 FROM kg_node n WHERE n.sym=e.sym)`));
  const kindSyms = DECLARATION_KINDS.map(kind => symId(db, kind)).filter((sym): sym is number => sym !== undefined);
  if (kindSyms.length > 0) {
    out.push(count(db, "graph.declaration-owned-by-its-file", `
      SELECT ns.text AS id, ks.text AS kind, ps.text AS path FROM kg_node n JOIN sym ns ON ns.id=n.sym JOIN sym ks ON ks.id=n.kind_sym
      LEFT JOIN sym ps ON ps.id=n.path_sym
      WHERE n.kind_sym IN (${kindSyms.join(",")}) AND substr(ns.text, 1, 4)<>'ext:'
        AND (n.path_sym IS NULL OR NOT EXISTS (SELECT 1 FROM kg_node_owner o WHERE o.node_sym=n.sym AND o.owner_sym=n.path_sym))`));
  }
  out.push(fileNodeCheck(db));
  out.push(count(db, "graph.edge-has-owner",
    "SELECT e.id FROM kg_edge e WHERE NOT EXISTS (SELECT 1 FROM kg_edge_owner o WHERE o.edge_id=e.id)"));
  const repository = symId(db, KNOWLEDGE_REPOSITORY_ID) ?? -1;
  out.push(count(db, "graph.node-has-owner", `
    SELECT s.text AS id FROM kg_node n JOIN sym s ON s.id=n.sym
    WHERE n.sym<>? AND NOT EXISTS (SELECT 1 FROM kg_node_owner o WHERE o.node_sym=n.sym)`, repository));
  out.push(count(db, "graph.owner-is-indexed-file", `
    SELECT DISTINCT s.text AS owner FROM (SELECT owner_sym FROM kg_node_owner UNION SELECT owner_sym FROM kg_edge_owner) o
    JOIN sym s ON s.id=o.owner_sym WHERE NOT EXISTS (SELECT 1 FROM file f WHERE f.path=s.text)`));
  const nodeRows = db.prepare("SELECT ns.text AS id, ks.text AS kind FROM kg_node n JOIN sym ns ON ns.id=n.sym JOIN sym ks ON ks.id=n.kind_sym").iterate() as Iterable<{ id: string; kind: string }>;
  const nodeXor = xorOf((function* () { for (const row of nodeRows) yield `n:${row.id}:${row.kind}`; })());
  const edgeRows = db.prepare("SELECT fs.text AS fromId, ks.text AS kind, ts.text AS toId, e.ordinal AS ordinal FROM kg_edge e JOIN sym fs ON fs.id=e.from_sym JOIN sym ks ON ks.id=e.kind_sym JOIN sym ts ON ts.id=e.to_sym").iterate() as Iterable<{ fromId: string; kind: string; toId: string; ordinal: number }>;
  const edgeXor = xorOf((function* () { for (const row of edgeRows) yield `e:${knowledgeEdgeId({ kind: row.kind, fromId: row.fromId, toId: row.toId, ordinal: Number(row.ordinal) })}`; })());
  const stored = { node: metaValue(db, "graphNodeXor") ?? "0".repeat(64), edge: metaValue(db, "graphEdgeXor") ?? "0".repeat(64) };
  const mismatched = [
    ...(stored.node === nodeXor.toString("hex") ? [] : [{ digest: "graphNodeXor", stored: stored.node, rows: nodeXor.toString("hex") }]),
    ...(stored.edge === edgeXor.toString("hex") ? [] : [{ digest: "graphEdgeXor", stored: stored.edge, rows: edgeXor.toString("hex") }])
  ];
  out.push({ name: "graph.digest-equals-rows", violations: mismatched.length, sample: mismatched });
  return out;
}

/** Every indexed file has its FILE node, owned by that file. */
function fileNodeCheck(db: IndexDatabase): InvariantResult {
  const fileKind = symId(db, "FILE");
  const present = new Set<string>();
  if (fileKind !== undefined) {
    const rows = db.prepare(`SELECT s.text AS path FROM kg_node n JOIN sym s ON s.id=n.sym
      WHERE n.kind_sym=? AND n.path_sym=n.sym AND EXISTS (SELECT 1 FROM kg_node_owner o WHERE o.node_sym=n.sym AND o.owner_sym=n.sym)`).iterate(fileKind) as Iterable<{ path: string }>;
    for (const row of rows) present.add(row.path);
  }
  const missing: string[] = [];
  for (const row of db.prepare("SELECT path FROM file ORDER BY path").iterate() as Iterable<{ path: string }>) {
    if (!present.has(row.path)) missing.push(row.path);
  }
  return { name: "graph.file-has-own-file-node", violations: missing.length, sample: missing.slice(0, SAMPLE) };
}

function statsCheck(db: IndexDatabase, name: string, key: string, sql: string): InvariantResult {
  const row = db.prepare(sql).get() as { c: number | bigint; t: number | bigint };
  const expected = `${Number(row.c)}:${Number(row.t)}`;
  const stored = metaValue(db, key);
  return { name, violations: stored === expected ? 0 : 1, sample: stored === expected ? [] : [{ key, stored, expected }] };
}

function searchChecks(db: IndexDatabase): InvariantResult[] {
  return [
    count(db, "entity.df-equals-postings", `
      SELECT p.field, p.token_sym, p.n AS postings, d.df FROM (SELECT field, token_sym, count(*) AS n FROM entity_token GROUP BY field, token_sym) p
      LEFT JOIN entity_df d ON d.field=p.field AND d.token_sym=p.token_sym WHERE d.df IS NOT p.n
      UNION ALL SELECT d.field, d.token_sym, 0, d.df FROM entity_df d
      WHERE NOT EXISTS (SELECT 1 FROM entity_token t WHERE t.field=d.field AND t.token_sym=d.token_sym)`),
    count(db, "search-doc.df-equals-postings", `
      SELECT p.token_sym, p.n AS postings, d.df FROM (SELECT token_sym, count(*) AS n FROM search_doc_token GROUP BY token_sym) p
      LEFT JOIN search_doc_df d ON d.token_sym=p.token_sym WHERE d.df IS NOT p.n
      UNION ALL SELECT d.token_sym, 0, d.df FROM search_doc_df d
      WHERE NOT EXISTS (SELECT 1 FROM search_doc_token t WHERE t.token_sym=d.token_sym)`),
    statsCheck(db, "entity.identifier-stats", ENTITY_STATS_KEYS.identifier, "SELECT count(*) AS c, coalesce(sum(ident_len), 0) AS t FROM entity"),
    statsCheck(db, "entity.chunk-stats", ENTITY_STATS_KEYS.chunk, "SELECT count(*) AS c, coalesce(sum(chunk_len), 0) AS t FROM entity"),
    statsCheck(db, "search-doc.stats", SEARCH_DOC_STATS_KEY, "SELECT count(*) AS c, coalesce(sum(token_len), 0) AS t FROM search_doc"),
    count(db, "entity.owner-is-indexed-file", `
      SELECT es.text AS entity, os.text AS owner FROM entity e JOIN sym es ON es.id=e.sym JOIN sym os ON os.id=e.owner_sym
      WHERE NOT EXISTS (SELECT 1 FROM file f WHERE f.path=os.text)`),
    // The evidence hash is read from the source row, so every document needs one.
    count(db, "search-doc.source-row-exists", `
      SELECT ds.text AS declaration, ps.text AS source FROM search_doc d JOIN sym ds ON ds.id=d.declaration_sym JOIN sym ps ON ps.id=d.source_path_sym
      WHERE NOT EXISTS (SELECT 1 FROM file f WHERE f.path=ps.text) AND NOT EXISTS (SELECT 1 FROM mybatis_resource r WHERE r.path=ps.text AND r.content_hash IS NOT NULL)`),
    count(db, "search-doc.owner-is-indexed-file", `
      SELECT ds.text AS declaration, os.text AS owner FROM search_doc d JOIN sym ds ON ds.id=d.declaration_sym JOIN sym os ON os.id=d.path_sym
      WHERE NOT EXISTS (SELECT 1 FROM file f WHERE f.path=os.text)`),
    count(db, "search-doc.token-has-document",
      "SELECT t.doc_id FROM search_doc_token t WHERE NOT EXISTS (SELECT 1 FROM search_doc d WHERE d.id=t.doc_id)"),
    count(db, "entity.token-has-entity",
      "SELECT t.entity_sym FROM entity_token t WHERE NOT EXISTS (SELECT 1 FROM entity e WHERE e.sym=t.entity_sym)")
  ];
}

/** Every check runs; `ok` is false when any reports a violation. */
export function checkIndexInvariants(db: IndexDatabase): InvariantReport {
  const checks = [...checkGraphInvariants(db), ...searchChecks(db)];
  return { ok: checks.every(item => item.violations === 0), checks };
}

export function assertIndexInvariants(db: IndexDatabase): void {
  const report = checkIndexInvariants(db);
  if (report.ok) return;
  throw new Error(`index invariants violated: ${JSON.stringify(report.checks.filter(item => item.violations > 0))}`);
}
