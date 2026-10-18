import { computeBuildFingerprint } from "../java-index/build-fingerprint.js";
import { sqlStage, compatibleDeltaBase, pipelineMetrics, type PipelineMetrics } from "./execution-plan.js";
import { runSqlColdBuild } from "./cold-build.js";
import { captureSource, type SourceCapture } from "../java-index/source-capture.js";
import { captureCensus, finishCaptureCensus, type CaptureCensusEntry } from "./capture-census.js";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { repositoryEntityNames } from "../java-knowledge/persistence-edge-builder.js";
import { KnowledgeGraphBuilder } from "../java-knowledge/graph-builder.js";
import { buildStaticEdges, resolveFileRefs } from "../java-index/edge-builder.js";
import { MAX_DISPATCH, dispatchMethodShape, dispatchTypeShape } from "../java-knowledge/call-resolver.js";
import { recordsFromBundle } from "../java-index/entity-search.js";
import type { JavaFileBundle, JavaTypeFacts } from "../java-index/index-types.js";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { discoverJavaFiles, discoverMyBatisResourceFiles, javaSourceRoot } from "../java-index/manifest.js";
import { extractMyBatisMapperFacts } from "../java-index/mybatis-xml-extractor.js";
import type { MyBatisMapperResourceFacts } from "../java-index/mybatis-types.js";
import { JavaNameResolver } from "../java-index/name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../java-index/builder/parse-cache.js";
import { bindChunks, inClause, prepareCached, withTransaction, withAsyncTransaction, indexDbPath, isMemoryPath, type IndexDatabase } from "../java-index/sql/driver.js";
import { replaceEntitiesForPath, withEntitySearchDelta } from "../java-index/sql/entity-tokens.js";
import {
  commitSearchDocStats,
  deleteSearchDocumentsForPath,
  rebuildSearchDocDf,
  myBatisBindingFilter,
  replaceSearchDocuments,
  replaceSearchDocumentsForSource
} from "../java-index/sql/search-docs.js";
import { buildMyBatisSearchDocuments, buildSearchDocuments, type SearchDocument } from "../discovery/search-document.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { buildSqlRegistryView } from "../java-index/sql/registry-view.js";
import { deleteResourceScan, readBundle, readMyBatisResource, recordResourceScan, replaceBundleEdges, updateBundleFacts, writeBundle, writeMyBatisResource } from "../java-index/sql/rows.js";
import { symId } from "../java-index/sql/sym.js";
import { attachWorkspaceStat, deleteStats, observedStats, readStats, recordStats, statUnchanged, type StatRow } from "../java-index/sql/workspace-stat.js";
import { COVERAGE_GAP, coverageRoots, readIndexCounts, readMeta, refreshIndexCounts, publishIndexCoverage, writeBuildProgress, writeMeta, type CoverageRoots } from "./progress.js";

export type BuilderJobKind = "refresh" | "resources" | "reconcile" | "full";
export type BuilderJob = { id?: number; kind: BuilderJobKind; generation?: number; changed?: string[]; deleted?: string[] };
export type BuilderJobResult = { id: number; ok: boolean; indexedGeneration: number; files: number; census?: CaptureCensusEntry[]; censusComplete?: boolean; stages?: PipelineMetrics; error?: string;
  /** escalation "report": this delta needs a full; nothing was published. */
  escalation?: string;
  /** The committed job's content identity (the builder's own capture), reported by the build process. */
  contentManifestId?: string };

/** ILV2 §6.1: a closure above this many files is published as an explicit full, never a delta. */
export const DELTA_CLOSURE_LIMIT = 400;
const MAX_RESOLVE_ROUNDS = 16;

/** The delta cannot prove a bounded dependency closure; the job runs as a full instead. */
class DeltaEscalation extends Error {
  constructor(readonly reason: string) { super(reason); }
}
/** escalation "report": unwinds the delta's transaction so the scheduler can queue the full. */
class ReportedEscalation extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function asRepoRel(repoRoot: string, abs: string): string {
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path outside repo: ${abs}`);
  return rel.split(path.sep).join("/");
}

async function resolveInput(repoRoot: string, input: string): Promise<{ abs: string; rel: string; exists: boolean }> {
  const joined = path.resolve(path.isAbsolute(input) ? input : path.join(repoRoot, input));
  try {
    const abs = await realpath(joined);
    return { abs, rel: asRepoRel(repoRoot, abs), exists: true };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("path outside repo:")) throw err;
    if (errCode(err) !== "ENOENT") throw err;
    let cursor = path.dirname(joined);
    const tail = [path.basename(joined)];
    while (cursor !== path.dirname(cursor)) {
      try {
        const relBase = asRepoRel(repoRoot, await realpath(cursor));
        return { abs: joined, rel: [relBase, ...tail.slice().reverse()].join("/"), exists: false };
      } catch (parentError) {
        if (errCode(parentError) !== "ENOENT") throw parentError;
        tail.push(path.basename(cursor));
        cursor = path.dirname(cursor);
      }
    }
    if (errCode(err) === "ENOENT") return { abs: joined, rel: asRepoRel(repoRoot, joined), exists: false };
    throw err;
  }
}

function indexedGenerationOf(db: IndexDatabase): number {
  return Number(readMeta(db, "indexedGeneration") ?? "0") || 0;
}

function statusResult(db: IndexDatabase, id: number, ok: boolean, error?: string): BuilderJobResult {
  const counts = readIndexCounts(db) ?? refreshIndexCounts(db);
  return { id, ok, indexedGeneration: indexedGenerationOf(db), files: counts.files, ...(error ? { error } : {}) };
}

function dependentPaths(db: IndexDatabase, ids: readonly string[], exclude: ReadonlySet<string>): string[] {
  const syms = ids.map(id => symId(db, id)).filter((sym): sym is number => sym !== undefined);
  if (syms.length === 0) return [];
  const paths = new Set<string>();
  for (const chunk of bindChunks(syms)) {
    const rows = prepareCached(
      db,
      `SELECT DISTINCT f.path AS path FROM edge e JOIN file f ON f.id=e.file_id WHERE e.to_sym IN ${inClause(chunk.length)}`
    ).all(...chunk) as Array<{ path: string }>;
    for (const row of rows) {
      if (!exclude.has(row.path)) paths.add(row.path);
    }
  }
  return [...paths];
}

/** (fqn, path) of every named type a file declares, with its simple name.
 * Local types have no fqn but join the repo-wide simple-name lookups: they
 * count per name (`local:N#count`), as their ids move with every edit. */
function declaredTypes(db: IndexDatabase, relativePath: string): Map<string, string> {
  const rows = prepareCached(
    db,
    "SELECT t.fqn AS fqn, t.simple_name AS simpleName FROM type t JOIN file f ON f.id=t.file_id WHERE f.path=?"
  ).all(relativePath) as Array<{ fqn: string | null; simpleName: string }>;
  const declared = new Map<string, string>(), local = new Map<string, number>();
  for (const row of rows) {
    if (row.fqn !== null) declared.set(`${row.fqn}|${relativePath}`, row.simpleName);
    else if (row.simpleName) local.set(row.simpleName, (local.get(row.simpleName) ?? 0) + 1);
  }
  for (const [simpleName, count] of local) declared.set(`${LOCAL_DECLARATION}${simpleName}#${count}|${relativePath}`, simpleName);
  return declared;
}
const LOCAL_DECLARATION = "local:";

/**
 * R05 review: a reference left AMBIGUOUS (several visible declarations) has
 * no edge, and a reference bound to A has no edge to a newly added B, so
 * edge-based dependents miss them. When the set of (fqn, path) declarations
 * changes - added, removed or moved types - a file naming one of the changed
 * simple names in a type position is re-resolved if that declaration can
 * change what the name binds to there: the file is in the declaring package,
 * its facts name the package (an import, an on-demand import, a qualified
 * reference), or it binds the name by the resolver's repo-wide fallback
 * (unique simple name, AMBIGUOUS, UNRESOLVED, a type variable, a constructor
 * or annotation named by text, a repository's entity type argument).
 * A subtype of an enclosing type names that type, so the package rule covers
 * inherited member types. Postings are case-sensitive, as Java names are: a
 * `scope` variable is not a use of type `Scope`.
 */
function nameDependentPaths(
  db: IndexDatabase,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  packages: ReadonlyMap<string, string>,
  exclude: ReadonlySet<string>,
  read: (relativePath: string) => JavaFileBundle | undefined
): Map<string, ReadonlySet<string>> {
  const visibleFrom = new Map<string, Set<string>>();
  const add = (key: string, simpleName: string) => {
    const set = visibleFrom.get(simpleName) ?? new Set<string>();
    // A local type is visible by name only through the repo-wide fallback.
    if (!key.startsWith(LOCAL_DECLARATION)) set.add(packages.get(key) ?? "");
    visibleFrom.set(simpleName, set);
  };
  for (const [key, simpleName] of before) if (!after.has(key)) add(key, simpleName);
  for (const [key, simpleName] of after) if (!before.has(key)) add(key, simpleName);
  const candidates = new Map<string, { packageName: string; packages: Set<string>; names: Set<string> }>();
  for (const [name, declaredIn] of visibleFrom) {
    const nameSym = symId(db, name);
    if (nameSym === undefined) continue;
    for (const row of prepareCached(db, "SELECT f.path AS path, f.package AS packageName FROM type_ref_name r JOIN file f ON f.id=r.file_id WHERE r.name_sym=?")
      .all(nameSym) as Array<{ path: string; packageName: string | null }>) {
      if (exclude.has(row.path)) continue;
      const candidate = candidates.get(row.path) ?? { packageName: row.packageName ?? "", packages: new Set<string>(), names: new Set<string>() };
      for (const packageName of declaredIn) candidate.packages.add(packageName);
      candidate.names.add(name);
      candidates.set(row.path, candidate);
    }
  }
  // Package-visible candidates need no bundle read here. Repo-wide graph
  // lookups are checked after resolution, against both old and final facts.
  const paths = new Map<string, ReadonlySet<string>>();
  for (const [relativePath, candidate] of candidates) {
    if (candidate.packages.has(candidate.packageName) || candidate.packages.has("")) {
      paths.set(relativePath, candidate.names);
      continue;
    }
    const bundle = read(relativePath);
    const repoWide = [...candidate.names].some(name => bindsByRepoWideName(bundle, name));
    if (repoWide) { paths.set(relativePath, candidate.names); continue; }
    const text = JSON.stringify(bundle ?? null);
    if ([...candidate.packages].some(packageName => text.includes(`${packageName}.`) || text.includes(`"${packageName}"`))) paths.set(relativePath, candidate.names);
  }
  return paths;
}

/** Whether `bundle` binds `name` by a repo-wide simple-name lookup, or not at all: any declaration of `name` can change that. */
function bindsByRepoWideName(bundle: JavaFileBundle | undefined, name: string): boolean {
  const visit = (value: unknown, parentKey?: string): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(item => visit(item, parentKey));
    const record = value as Record<string, unknown>;
    const resolution = record.resolution as { state?: string; strategy?: string } | undefined;
    // Graph builders look up anything not bound in the repo or outside it by its simple name.
    if (resolution && record.simpleName === name
      && (resolution.state === "AMBIGUOUS" || resolution.state === "UNRESOLVED" || resolution.state === "TYPE_VARIABLE"
        || resolution.strategy === "REPO_UNIQUE_SIMPLE_NAME")) return true;
    // `new N()` and `@N` are resolved from their text when edges are built; the facts keep no resolution for them.
    if (record.kind === "CONSTRUCTOR_INVOCATION" && record.name === name) return true;
    if (parentKey === "annotations" && record.name === name && record.qualifiedName === undefined) return true;
    return Object.entries(record).some(([key, child]) => visit(child, key));
  };
  return bundle !== undefined && (visit([bundle.types, bundle.fields, bundle.methods]) || repositoryEntityNames(bundle).includes(name));
}

/** Files declaring a transitive subtype of `typeIds`, by resolved EXTENDS/IMPLEMENTS static edges. */
function descendantPaths(db: IndexDatabase, typeIds: readonly string[]): string[] {
  const kinds = ["EXTENDS", "IMPLEMENTS"].map(kind => symId(db, kind)).filter((sym): sym is number => sym !== undefined);
  let frontier = typeIds.map(id => symId(db, id)).filter((sym): sym is number => sym !== undefined);
  if (kinds.length === 0 || frontier.length === 0) return [];
  const seen = new Set(frontier);
  const paths = new Set<string>();
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const chunk of bindChunks(frontier)) {
      const rows = prepareCached(db,
        `SELECT e.from_sym AS sym, f.path AS path FROM edge e JOIN file f ON f.id=e.file_id
         WHERE e.to_sym IN ${inClause(chunk.length)} AND e.kind_sym IN ${inClause(kinds.length)}`
      ).all(...chunk, ...kinds) as Array<{ sym: number | bigint; path: string }>;
      for (const row of rows) {
        paths.add(row.path);
        const sym = Number(row.sym);
        if (!seen.has(sym)) { seen.add(sym); next.push(sym); }
      }
    }
    frontier = next;
  }
  return [...paths];
}

/** Files with a static edge to a method of `typeId` named in `names` ("*": any of its methods). */
function callerPaths(db: IndexDatabase, typeId: string, names: ReadonlySet<string> | "*", exclude: ReadonlySet<string>): string[] {
  const owner = typeof typeId === "string" ? symId(db, typeId) : undefined;
  if (owner === undefined || names !== "*" && names.size === 0) return [];
  const paths = new Set<string>();
  const collect = (rows: Array<{ path: string }>) => { for (const row of rows) if (!exclude.has(row.path)) paths.add(row.path); };
  const sql = "SELECT DISTINCT f.path AS path FROM method m JOIN edge e ON e.to_sym=m.sym JOIN file f ON f.id=e.file_id WHERE m.owner_sym=?";
  if (names === "*") collect(prepareCached(db, sql).all(owner) as Array<{ path: string }>);
  else for (const chunk of bindChunks([...names])) collect(prepareCached(db, `${sql} AND m.name IN ${inClause(chunk.length)}`).all(owner, ...chunk) as Array<{ path: string }>);
  return [...paths];
}

/**
 * Mapper files whose XML names (resultType, parameterType, resultMap type) a
 * type whose declarations changed: persistence edges resolve those names by
 * FQN or simple name, and the Java mapper need not reference the type at all.
 */
function xmlTypeDependentPaths(
  db: IndexDatabase,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  exclude: ReadonlySet<string>
): string[] {
  const fqns = new Set<string>(), simpleNames = new Set<string>();
  const add = (key: string, simpleName: string) => { fqns.add(key.slice(0, key.lastIndexOf("|"))); simpleNames.add(simpleName); };
  for (const [key, simpleName] of before) if (!after.has(key)) add(key, simpleName);
  for (const [key, simpleName] of after) if (!before.has(key)) add(key, simpleName);
  if (fqns.size === 0) return [];
  const namespaces = new Set<string>();
  for (const row of db.prepare("SELECT path, namespace FROM mybatis_resource WHERE namespace IS NOT NULL").all() as Array<{ path: string; namespace: string }>) {
    const resource = readMyBatisResource(db, row.path);
    if (!resource) continue;
    const names = [...resource.statements.flatMap(statement => [statement.resultType, statement.parameterType]), ...resource.resultMaps.map(map => map.type)];
    if (names.some(name => name && (fqns.has(name) || simpleNames.has(name.slice(name.lastIndexOf(".") + 1))))) namespaces.add(row.namespace);
  }
  const paths = new Set<string>();
  for (const namespace of namespaces) {
    for (const row of prepareCached(db, "SELECT DISTINCT f.path AS path FROM type t JOIN file f ON f.id=t.file_id WHERE t.fqn=?").all(namespace) as Array<{ path: string }>) {
      if (!exclude.has(row.path)) paths.add(row.path);
    }
  }
  return [...paths];
}

/** What other files' resolution reads from a declaration: all but its body and positions. */
const INTERFACE_IGNORED = new Set(["range", "nameRange", "bodyRange", "capturedSignature", "leadingComments", "callSites", "localTypes"]);

/** Re-resolves each file from `raw` (its facts as last written), in order;
 * returns the files whose rows changed. */
function resolveFacts(db: IndexDatabase, relativePaths: readonly string[], raw: (relativePath: string) => JavaFileBundle | undefined): Set<string> {
  const store = new SqlFactsStore(db);
  const view = buildSqlRegistryView(store);
  const resolver = new JavaNameResolver(view);
  const moved = new Set<string>();
  for (const relativePath of relativePaths) {
    const bundle = raw(relativePath);
    if (!bundle) continue;
    const resolved = resolveFileRefs(bundle, resolver, view);
    // These are exactly the facts updateBundleFacts persists. Edges and the
    // transient capture/stat data do not belong to this comparison.
    if (JSON.stringify([bundle.file, bundle.types, bundle.fields, bundle.methods])
      === JSON.stringify([resolved.file, resolved.types, resolved.fields, resolved.methods])) continue;
    if (!updateBundleFacts(db, { ...resolved, edges: [] })) continue;
    moved.add(relativePath);
    // Later files read this one's resolved facts, as after cold build's per-file clear.
    store.forgetFile(bundle);
  }
  return moved;
}

/** `star`/`names`: the type's resolved interface moved (all of it, or these
 * members). `dispatchStar`/`dispatchNames`: the part addCallEdges reads. */
type TypeChange = {
  star: boolean;
  names: Set<string>;
  dispatchStar: boolean;
  dispatchNames: Set<string>;
  parentsBefore: Set<string>;
  parentsAfter: Set<string>;
};
const TYPE_IGNORED = new Set([...INTERFACE_IGNORED, "methodIds", "fieldIds"]);
const shapeOf = (value: unknown, ignored: ReadonlySet<string>): string => JSON.stringify(value, (key, item) => ignored.has(key) ? undefined : item);
const repoParents = (type: JavaTypeFacts | undefined): Set<string> =>
  new Set((type ? [...type.extends, ...type.implements] : []).flatMap(ref => ref.resolution.state === "RESOLVED_REPO" ? [ref.resolution.typeId] : []));

/**
 * The declared types whose resolved interface differs between two versions
 * of one file: `star` when the type itself changed (added, removed,
 * modifiers, supertypes), otherwise the names of its changed members; the
 * dispatch fields keep only what call edges read (dispatchMethodShape).
 */
function typeChanges(before: JavaFileBundle | undefined, after: JavaFileBundle | undefined): Map<string, TypeChange> {
  const pairs = new Map<string, [JavaTypeFacts | undefined, JavaTypeFacts | undefined]>();
  for (const type of before?.types ?? []) pairs.set(type.typeId, [type, undefined]);
  for (const type of after?.types ?? []) pairs.set(type.typeId, [pairs.get(type.typeId)?.[0], type]);
  const changes = new Map<string, TypeChange>();
  const changeOf = (typeId: string, star: boolean): TypeChange => {
    const found = changes.get(typeId);
    if (found) { found.star ||= star; return found; }
    const [left, right] = pairs.get(typeId) ?? [undefined, undefined];
    const created = { star, names: new Set<string>(), dispatchStar: false, dispatchNames: new Set<string>(), parentsBefore: repoParents(left), parentsAfter: repoParents(right) };
    changes.set(typeId, created);
    return created;
  };
  for (const [typeId, [left, right]] of pairs) {
    if (left && right && shapeOf(left, TYPE_IGNORED) === shapeOf(right, TYPE_IGNORED)) continue;
    changeOf(typeId, true).dispatchStar ||= !left || !right || dispatchTypeShape(left) !== dispatchTypeShape(right);
  }
  type Member = { owner: string; name: string; shape: string; dispatch?: string };
  const members = (bundle: JavaFileBundle | undefined) => new Map<string, Member>([
    ...(bundle?.methods ?? []).map(method => [method.methodId, { owner: method.ownerTypeId, name: method.name, shape: shapeOf(method, INTERFACE_IGNORED), dispatch: dispatchMethodShape(method) }] as const),
    ...(bundle?.fields ?? []).map(field => [field.fieldId, { owner: field.ownerTypeId, name: field.name, shape: shapeOf(field, INTERFACE_IGNORED) }] as const)
  ]);
  const left = members(before), right = members(after);
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    const was = left.get(id), now = right.get(id);
    if (was && now && was.shape === now.shape && was.owner === now.owner) continue;
    const dispatchMoved = was?.dispatch !== now?.dispatch || was?.owner !== now?.owner;
    for (const member of [was, now]) {
      if (!member) continue;
      const change = changeOf(member.owner, false);
      change.names.add(member.name);
      if (dispatchMoved && member.dispatch !== undefined) change.dispatchNames.add(member.name);
    }
  }
  return changes;
}

/** Closure size by the rule that added each file, for the job's metrics and escalation reason. */
type ClosureLog = Record<string, number>;
function grow(rewritten: Set<string>, log: ClosureLog, rule: string, paths: Iterable<string>, pending?: Set<string>): void {
  for (const relativePath of paths) {
    pending?.add(relativePath);
    if (rewritten.has(relativePath)) continue;
    rewritten.add(relativePath);
    log[rule] = (log[rule] ?? 0) + 1;
  }
}
function closureSummary(rewritten: ReadonlySet<string>, log: ClosureLog): string {
  return `dependency closure ${rewritten.size} > ${DELTA_CLOSURE_LIMIT} files (${Object.entries(log).map(([rule, files]) => `${rule} ${files}`).join(", ")})`;
}

/**
 * Phase-1 resolution to a fixpoint: the transitive subtypes of each declared
 * type whose resolved interface moved re-resolve, since unqualified and super
 * calls, and inherited member types, walk it. `original` receives each
 * re-resolved file's facts as they were when the job started, `factsMoved`
 * the files whose rows this job rewrote (changed files are always rewritten).
 * Callers that only re-graph are found once edges are final
 * (dispatchDependents).
 * The unbounded transitive caller closure this replaces took 2223 of 5887
 * lishu-v2 files for a real 20-file change, and a name-based dispatch rule
 * 1175 (MAC-05).
 */
function resolveClosure(
  db: IndexDatabase,
  rewritten: Set<string>,
  before: ReadonlyMap<string, JavaFileBundle | undefined>,
  deleted: readonly string[],
  log: ClosureLog,
  original: Map<string, JavaFileBundle | undefined>,
  factsMoved: Set<string>,
  namedInputs: ReadonlyMap<string, JavaFileBundle | undefined>
): void {
  const gone = new Set(deleted);
  let pending = [...rewritten].sort();
  let previous: ReadonlyMap<string, JavaFileBundle | undefined> = before;
  let removed = [...deleted];
  for (let round = 0; pending.length > 0 || removed.length > 0; round += 1) {
    if (round >= MAX_RESOLVE_ROUNDS) throw new DeltaEscalation(`resolution did not settle in ${MAX_RESOLVE_ROUNDS} rounds`);
    const snapshot = new Map(pending.map(relativePath => [relativePath, previous.has(relativePath) ? previous.get(relativePath)
      : round === 0 && namedInputs.has(relativePath) ? namedInputs.get(relativePath) : readBundle(db, relativePath)]));
    for (const [relativePath, bundle] of snapshot) if (!original.has(relativePath)) original.set(relativePath, bundle);
    // `previous` holds published facts this job has since overwritten.
    const rewrote = resolveFacts(db, pending, relativePath => previous.has(relativePath) ? readBundle(db, relativePath) : snapshot.get(relativePath));
    for (const relativePath of rewrote) factsMoved.add(relativePath);
    const moved: Array<{ path: string; before?: JavaFileBundle; after?: JavaFileBundle; changes: Map<string, TypeChange> }> = [];
    for (const relativePath of removed) moved.push({ path: relativePath, before: previous.get(relativePath), changes: typeChanges(previous.get(relativePath), undefined) });
    for (const relativePath of pending) {
      // Rows this round left alone still hold the snapshot.
      if (!previous.has(relativePath) && !rewrote.has(relativePath)) continue;
      const after = readBundle(db, relativePath);
      const changes = typeChanges(snapshot.get(relativePath), after);
      if (changes.size > 0) moved.push({ path: relativePath, before: snapshot.get(relativePath), after, changes });
    }
    previous = new Map();
    removed = [];
    const next = new Set<string>();
    // Imports can move without changing any exported binding. Propagate the
    // resolved declaration differences, in the same fixpoint as inheritance,
    // rather than invalidating every declaration of an import-edited file.
    // Ordinary callers already in this round need no second facts pass:
    // facts resolution does not read other methods; their call edges are
    // built after the fixpoint. Inherited scopes re-enter via hierarchy below.
    const exports = moved.map(item => changedExportIds(item.before, item.after));
    grow(rewritten, log, "references", dependentPaths(db, exports.flatMap(item => [...item.oldIds, ...item.newIds]), new Set([...gone, ...pending])), next);
    const changedTypes = new Map<string, string>();
    for (const item of moved) for (const typeId of item.changes.keys()) changedTypes.set(typeId, item.path);
    grow(rewritten, log, "hierarchy", descendantPaths(db, [...changedTypes.keys()]).filter(relativePath => !gone.has(relativePath)), next);
    // A file that now extends a type moved in this same round may have
    // resolved before that type did; its new edge is not written yet.
    for (const item of moved) for (const type of item.after?.types ?? []) for (const ref of [...type.extends, ...type.implements]) {
      if (ref.resolution.state === "RESOLVED_REPO" && changedTypes.has(ref.resolution.typeId) && changedTypes.get(ref.resolution.typeId) !== item.path) next.add(item.path);
    }
    if (rewritten.size > DELTA_CLOSURE_LIMIT) throw new DeltaEscalation(closureSummary(rewritten, log));
    pending = [...next].filter(relativePath => !gone.has(relativePath)).sort();
  }
}

/**
 * Files whose call edges read a method or type that moved (addCallEdges):
 * the call kind and DISPATCHES_TO set of a call read the callee, its owner
 * type, and the methods of the owner's first MAX_DISPATCH direct
 * implementers by typeId. So callers of a changed type's dispatch-relevant
 * members re-graph, and so do callers of each direct supertype that the
 * type joins, leaves or keeps with changed members - only while it ranks
 * among that supertype's first MAX_DISPATCH implementers before or after the
 * job: the first MAX_DISPATCH of a set can only move with a member that
 * ranks there. Run after edges are rebuilt, so implementer sets are final;
 * the job-start sets are those minus joiners plus leavers.
 */
function dispatchDependents(db: IndexDatabase, changes: ReadonlyArray<Map<string, TypeChange>>, exclude: ReadonlySet<string>): Set<string> {
  const store = new SqlFactsStore(db, { factsAreImmutable: true });
  const joined = new Map<string, Set<string>>(), left = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, parent: string, typeId: string) => map.set(parent, (map.get(parent) ?? new Set()).add(typeId));
  for (const fileChanges of changes) for (const [typeId, change] of fileChanges) {
    for (const parent of change.parentsAfter) if (!change.parentsBefore.has(parent)) note(joined, parent, typeId);
    for (const parent of change.parentsBefore) if (!change.parentsAfter.has(parent)) note(left, parent, typeId);
  }
  const sets = new Map<string, { before: string[]; after: string[] }>();
  const implementerSets = (parent: string) => {
    let found = sets.get(parent);
    if (!found) {
      const after = store.implementers(parent, Number.POSITIVE_INFINITY).map(type => type.typeId);
      const joiners = joined.get(parent) ?? new Set<string>();
      found = { before: [...after.filter(typeId => !joiners.has(typeId)), ...(left.get(parent) ?? [])], after };
      sets.set(parent, found);
    }
    return found;
  };
  // addCallEdges orders implementers by JS string comparison of typeIds.
  const ranks = (members: readonly string[], typeId: string) => members.filter(other => other !== typeId && other < typeId).length < MAX_DISPATCH;
  const paths = new Set<string>();
  const callers = (typeId: string, names: ReadonlySet<string> | "*") => { for (const relativePath of callerPaths(db, typeId, names, exclude)) paths.add(relativePath); };
  for (const fileChanges of changes) for (const [typeId, change] of fileChanges) {
    callers(typeId, change.dispatchStar ? "*" : change.dispatchNames);
    for (const parent of new Set([...change.parentsBefore, ...change.parentsAfter])) {
      const was = change.parentsBefore.has(parent), is = change.parentsAfter.has(parent);
      const { before, after } = implementerSets(parent);
      if (!(was && ranks(before, typeId)) && !(is && ranks(after, typeId))) continue;
      callers(parent, was !== is ? "*" : change.dispatchNames);
    }
  }
  return paths;
}

/** Call resolution walks other files' inheritance facts. Finish all facts
 * before building edges, as cold build does, so file order cannot hide a
 * method inherited through a type that has not yet been resolved. This stage
 * writes edges only, so facts read for one file stay valid for the next.
 * `facts` gives each file's final facts; returns the files whose edges moved. */
function buildEdges(db: IndexDatabase, relativePaths: readonly string[], facts: (relativePath: string) => JavaFileBundle | undefined): Set<string> {
  const store = new SqlFactsStore(db, { factsAreImmutable: true });
  const view = buildSqlRegistryView(store);
  const resolver = new JavaNameResolver(view);
  const moved = new Set<string>();
  for (const relativePath of relativePaths) {
    const resolved = facts(relativePath);
    if (resolved && replaceBundleEdges(db, relativePath, buildStaticEdges(resolved, view, resolver))) moved.add(relativePath);
  }
  return moved;
}

/** Which rows of a rewritten file this job rebuilds, from what. */
type RewritePlan = {
  /** Its graph rows read something that moved. */
  graphs(relativePath: string): boolean;
  /** Its entities and search documents read only its own facts and the
   * mapper binding: rebuilt only where those moved. */
  documents(relativePath: string): boolean;
  /** Its final rows. */
  bundleOf(relativePath: string): JavaFileBundle | undefined;
};

function rewriteGraphAndEntities(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  deleted: readonly string[],
  rewritten: readonly string[],
  plan: RewritePlan
): { graphFiles: number; documentFiles: number } {
  const store = new SqlFactsStore(db, { factsAreImmutable: true });
  const graph = new SqlKnowledgeGraph(db);
  const builder = new KnowledgeGraphBuilder(graph);
  if (deleted.length > 0) graph.removeFiles(deleted);
  const documented = new Map<string, JavaFileBundle | undefined>();
  let graphFiles = 0;
  for (const relativePath of rewritten) {
    const graphs = plan.graphs(relativePath), documents = plan.documents(relativePath);
    if (!graphs && !documents) continue;
    const bundle = plan.bundleOf(relativePath);
    if (graphs && bundle) { builder.replaceFile(bundle, store, generation); graphFiles += 1; }
    if (documents || !bundle) documented.set(relativePath, bundle);
  }
  graph.flushMeta();
  withEntitySearchDelta(db,[...deleted,...documented.keys()],()=>{
  for (const relativePath of deleted) {
    replaceEntitiesForPath(db, relativePath, []);
    deleteSearchDocumentsForPath(db, relativePath);
  }
  const resources = listMyBatisResources(db);
  const bindsMyBatis = myBatisBindingFilter(db);
  for (const [relativePath, bundle] of documented) {
    if (!bundle) {
      replaceEntitiesForPath(db, relativePath, []);
      continue;
    }
    replaceEntitiesForPath(db, relativePath, recordsFromBundle(bundle));
    // Same-transaction document update keeps text and facts on one hash.
    replaceSearchDocuments(db, bundle.file.relativePath, buildSearchDocuments({ bundle, myBatisResources: resources, bindsMyBatis }));
  }
  });
  return { graphFiles, documentFiles: documented.size };
}

function listMyBatisResources(db: IndexDatabase): MyBatisMapperResourceFacts[] {
  const out: MyBatisMapperResourceFacts[] = [];
  for (const row of db.prepare("SELECT path FROM mybatis_resource").iterate() as Iterable<{ path: string }>) {
    const resource = readMyBatisResource(db, row.path);
    if (resource) out.push(resource);
  }
  return out;
}

function finishIndex(db: IndexDatabase, generation: number, roots: CoverageRoots): void {
  writeMeta(db,"pipelineComplete","1");
  publishIndexCoverage(db, generation, roots);
}

async function parseChanged(
  db: IndexDatabase,
  repoRoot: string,
  layout: LayoutContext,
  generation: number,
  absolutePaths: readonly string[],
  captures?: Map<string, SourceCapture>,
  stages?: PipelineMetrics
): Promise<{ bundles: JavaFileBundle[]; missing: string[] }> {
  const captureStart=performance.now();
  const fixed=captures ?? new Map<string,SourceCapture>();
  const capturedMissing=new Set<string>();
  let capturedFiles=0;
  for(const input of absolutePaths) if(!fixed.has(input)) {
    try {fixed.set(input,await captureSource(repoRoot,input));capturedFiles++;}
    catch(error) {if(errCode(error)==="ENOENT") capturedMissing.add(input);else throw error;}
  }
  if(stages) {stages.capture.files+=capturedFiles;stages.capture.elapsedMs+=performance.now()-captureStart;}
  const parseStart=performance.now();
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const bundles: JavaFileBundle[] = [];
  const missing: string[] = [];
  const total = Math.max(1, absolutePaths.length);
  for (const [index, inputPath] of absolutePaths.entries()) {
    writeBuildProgress(db, { phase: "declare", done: index, total });
    try {
      if(capturedMissing.has(inputPath)) {missing.push(asRepoRel(repoRoot,inputPath));continue;}
      const bundle = await parseJavaSourceFile({
        repoRoot, resolvedRepoRoot: repoRoot, inputPath, generation, backend, cache, layout, capture: fixed.get(inputPath)
      });
      cache.delete(bundle.file.relativePath);
      bundles.push(bundle);
    } catch (err) {
      if (errCode(err) === "ENOENT") missing.push(asRepoRel(repoRoot, inputPath));
      else throw err;
    }
  }
  writeBuildProgress(db, { phase: "declare", done: absolutePaths.length, total });
  if(stages) {stages.parse.files+=absolutePaths.length;stages.parse.javaFiles=absolutePaths.length;stages.parse.elapsedMs+=performance.now()-parseStart;}
  return { bundles, missing };
}

/** Compare the resolved interface of each declaration. Keeping methodIds and
 * fieldIds on its owner invalidates type users when overloads/members appear
 * or vanish, including callers whose ambiguous call has no method edge. */
function changedExportIds(before: JavaFileBundle | undefined, after: JavaFileBundle | undefined): { oldIds: string[]; newIds: string[] } {
  const declarations = (bundle: JavaFileBundle | undefined) => new Map([
    ...(bundle?.types ?? []).map(type => [type.typeId, shapeOf(type, INTERFACE_IGNORED)] as const),
    ...(bundle?.methods ?? []).map(method => [method.methodId, shapeOf(method, INTERFACE_IGNORED)] as const),
    ...(bundle?.fields ?? []).map(field => [field.fieldId, shapeOf(field, INTERFACE_IGNORED)] as const)
  ]);
  const left = declarations(before), right = declarations(after);
  const moved = new Set([...left.keys(), ...right.keys()].filter(id => left.get(id) !== right.get(id)));
  return { oldIds: [...left.keys()].filter(id => moved.has(id)), newIds: [...right.keys()].filter(id => moved.has(id)) };
}

async function applyParsedRefresh(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  roots: CoverageRoots,
  deleted: readonly string[],
  bundles: readonly JavaFileBundle[],
  discovered?: readonly { sourceRoot: string }[],
  stages?: PipelineMetrics
): Promise<void> {
  const changed = bundles.map(bundle => bundle.file.relativePath);
  const exclude = new Set([...deleted, ...changed]);
  // Published facts of every input path, read before this job writes anything.
  const before = new Map([...deleted, ...changed].map(relativePath => [relativePath, readBundle(db, relativePath)]));
  const ids = (bundle: JavaFileBundle | undefined) => [...(bundle?.types ?? []).map(type => type.typeId),
    ...(bundle?.methods ?? []).map(method => method.methodId), ...(bundle?.fields ?? []).map(field => field.fieldId)];
  const oldIds = [...before.values()].flatMap(ids), newIds = bundles.flatMap(ids);
  // Callers through a changed type are found once edges are final
  // (dispatchDependents), from the members that actually moved.
  const log: ClosureLog = {};
  const rewritten = new Set<string>();
  grow(rewritten, log, "changed", changed);
  const declaredBefore = new Map([...deleted, ...changed].flatMap(relativePath => [...declaredTypes(db, relativePath)]));
  const packageOf = (bundle: JavaFileBundle | undefined) => bundle ? [[bundle.file.relativePath, bundle.file.packageName ?? ""] as const] : [];
  const packagesBefore = new Map([...before.values()].flatMap(packageOf)), packagesAfter = new Map(bundles.flatMap(packageOf));
  let declaredAfter=new Map<string,string>();
  // Files whose search documents move without their own facts moving.
  const bindingMoved = new Set<string>(changed);
  // Files whose graph rows read something that moved, without their own rows moving.
  const regraph = new Set<string>();
  const namedInputs = new Map<string, JavaFileBundle | undefined>();
  let named = new Map<string, ReadonlySet<string>>();
  sqlStage(db, stages, () => {
    writeMeta(db,"pipelineComplete","0");
    writeMeta(db,"buildState","BUILDING");
    for (const relativePath of deleted) prepareCached(db, "DELETE FROM file WHERE path=?").run(relativePath);
    // buildEdges replaces every changed file's edges before publication.
    for (const bundle of bundles) writeBundle(db, bundle, { edges: "keep" });
    deleteStats(db, deleted);
    recordStats(db, "java", observedStats(bundles));
    // A reference to an id that appeared or vanished resolves to another
    // graph endpoint (a repo node, an external node or none).
    const oldSet = new Set(oldIds), newSet = new Set(newIds);
    for (const relativePath of dependentPaths(db, [...oldIds.filter(id => !newSet.has(id)), ...newIds.filter(id => !oldSet.has(id))], exclude)) regraph.add(relativePath);
    declaredAfter = new Map(changed.flatMap(relativePath => [...declaredTypes(db, relativePath)]));
    const packages = new Map<string, string>([
      ...[...declaredBefore.keys()].map(key => [key, packagesBefore.get(key.slice(key.lastIndexOf("|") + 1)) ?? ""] as const),
      ...[...declaredAfter.keys()].map(key => [key, packagesAfter.get(key.slice(key.lastIndexOf("|") + 1)) ?? ""] as const)
    ]);
    named = nameDependentPaths(db, declaredBefore, declaredAfter, packages, exclude, relativePath => {
      const bundle = readBundle(db, relativePath);
      namedInputs.set(relativePath, bundle);
      return bundle;
    });
    grow(rewritten, log, "names", named.keys());
    const xml = xmlTypeDependentPaths(db, declaredBefore, declaredAfter, exclude);
    grow(rewritten, log, "xml", xml);
    for (const relativePath of [...xml, ...namespaceDeclarers(db, declaredBefore, declaredAfter)]) bindingMoved.add(relativePath);
    if (rewritten.size > DELTA_CLOSURE_LIMIT) throw new DeltaEscalation(closureSummary(rewritten, log));
  });
  await stages?.onStage?.("parse-declare");
    const resolveStart=performance.now();
    let ordered: string[] = [], edged: string[] = [];
    // Facts at job start of every file that re-resolved, and the files whose
    // facts or static edges this job moved. The rest of the closure re-graphs
    // only (dispatchDependents).
    const original = new Map<string, JavaFileBundle | undefined>();
    const factsMoved = new Set<string>(), changedFiles = new Set(changed);
    const final = new Map<string, JavaFileBundle | undefined>();
    let edgesMoved = new Set<string>();
    sqlStage(db,stages,()=>{
      resolveClosure(db, rewritten, before, deleted, log, original, factsMoved, namedInputs);
      for (const relativePath of original.keys()) if (changedFiles.has(relativePath) || factsMoved.has(relativePath)) final.set(relativePath, readBundle(db, relativePath));
      for (const [relativePath, names] of named) {
        const prior = original.get(relativePath), current = final.has(relativePath) ? final.get(relativePath) : prior;
        if ([...names].some(name => bindsByRepoWideName(prior, name)
          || current !== prior && bindsByRepoWideName(current, name))) regraph.add(relativePath);
      }
      edged = [...original.keys()].sort();
      edgesMoved = buildEdges(db, edged, relativePath => final.has(relativePath) ? final.get(relativePath) : original.get(relativePath));
      const moves = [
        ...[...final].map(([relativePath, bundle]) => typeChanges(original.get(relativePath), bundle)),
        ...deleted.map(relativePath => typeChanges(before.get(relativePath), undefined))
      ];
      const dispatch = dispatchDependents(db, moves, new Set(deleted));
      grow(rewritten, log, "dispatch", dispatch);
      for (const relativePath of dispatch) regraph.add(relativePath);
      if (rewritten.size > DELTA_CLOSURE_LIMIT) throw new DeltaEscalation(closureSummary(rewritten, log));
      ordered=[...rewritten].sort();
    });
    if(stages) stages.resolve={files:ordered.length,elapsedMs:performance.now()-resolveStart,closure:log,edgeFiles:edged.length};
    await stages?.onStage?.("resolve");
    const graphStart=performance.now();
    const plan: RewritePlan = {
      graphs: relativePath => bindingMoved.has(relativePath) || factsMoved.has(relativePath) || edgesMoved.has(relativePath)
        || regraph.has(relativePath) || !original.has(relativePath),
      documents: relativePath => bindingMoved.has(relativePath) || factsMoved.has(relativePath),
      // `final` and `original` were read before edges were rebuilt.
      bundleOf: relativePath => edgesMoved.has(relativePath) || !original.has(relativePath) ? readBundle(db, relativePath)
        : final.has(relativePath) ? final.get(relativePath) : original.get(relativePath)
    };
    let rewrote = { graphFiles: 0, documentFiles: 0 };
    sqlStage(db,stages,()=>{rewrote=rewriteGraphAndEntities(db, repoRoot, generation, deleted, ordered, plan);
      rebindChangedNamespaces(db, declaredBefore, declaredAfter);
    });
    if(stages) {stages.graphSearch.files+=ordered.length;stages.graphSearch.javaFiles=ordered.length;stages.graphSearch.graphFiles=rewrote.graphFiles;stages.graphSearch.documentFiles=rewrote.documentFiles;stages.graphSearch.elapsedMs+=performance.now()-graphStart;}
    await stages?.onStage?.("graph-search");
    sqlStage(db,stages,()=>{
    writeMeta(db,"pipelineComplete","1");
    publishIndexCoverage(db, generation, roots, discovered);
  });
  if(stages) stages.sql.files=ordered.length;
  await stages?.onStage?.("publication-metadata");
}

/** Files declaring a mapper namespace whose declarations moved: their mapper
 * documents follow the binding filter (myBatisBindingFilter), not their facts. */
function namespaceDeclarers(db: IndexDatabase, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const fqns = new Set<string>();
  for (const key of before.keys()) if (!after.has(key)) fqns.add(key.slice(0, key.lastIndexOf("|")));
  for (const key of after.keys()) if (!before.has(key)) fqns.add(key.slice(0, key.lastIndexOf("|")));
  const paths: string[] = [];
  for (const fqn of fqns) {
    if (!prepareCached(db, "SELECT 1 FROM mybatis_resource WHERE namespace=? LIMIT 1").get(fqn)) continue;
    for (const row of prepareCached(db, "SELECT DISTINCT f.path AS path FROM type t JOIN file f ON f.id=t.file_id WHERE t.fqn=?").all(fqn) as Array<{ path: string }>) paths.push(row.path);
  }
  return paths;
}

/**
 * A declaration of a mapper namespace appeared, vanished or moved: the XML
 * binding visibility (myBatisBindingFilter) may change for owners that were
 * not rewritten, so every XML of that namespace rebinds from scratch.
 */
function rebindChangedNamespaces(db: IndexDatabase, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): void {
  const fqns = new Set<string>();
  for (const key of before.keys()) if (!after.has(key)) fqns.add(key.slice(0, key.lastIndexOf("|")));
  for (const key of after.keys()) if (!before.has(key)) fqns.add(key.slice(0, key.lastIndexOf("|")));
  for (const fqn of fqns) {
    for (const row of prepareCached(db, "SELECT path FROM mybatis_resource WHERE namespace=?").all(fqn) as Array<{ path: string }>) {
      replaceResourceDocuments(db, row.path, readMyBatisResource(db, row.path));
    }
  }
}

async function applyRefresh(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  changedInputs: readonly string[],
  deletedInputs: readonly string[],
  stages?: PipelineMetrics
): Promise<void> {
  const layout = probeLayout(repoRoot);
  const roots = coverageRoots(layout);
  const deleted: string[] = [];
  for (const input of deletedInputs) deleted.push((await resolveInput(repoRoot, input)).rel);
  const existing: string[] = [];
  for (const input of changedInputs) {
    const resolved = await resolveInput(repoRoot, input);
    const outsideCensus = resolved.rel.endsWith(".java") && javaSourceRoot(resolved.rel, layout) === undefined;
    if (resolved.exists && !outsideCensus) existing.push(resolved.abs);
    // Explicit watcher paths obey the same membership as a fresh full. Also
    // remove any previously indexed row that is now outside that census.
    else deleted.push(resolved.rel);
  }
  const uniqueDeleted = [...new Set(deleted)];
  if (existing.length === 0 && uniqueDeleted.length === 0) {
    sqlStage(db,stages,()=>finishIndex(db,generation,roots));
    return;
  }
  writeBuildProgress(db, { phase: "declare", done: 0, total: Math.max(1, existing.length) });
  const parsed = await parseChanged(db, repoRoot, layout, generation, existing, undefined, stages);
  writeBuildProgress(db, { phase: "resolve", done: 0, total: Math.max(1, parsed.bundles.length) });
  await applyParsedRefresh(db, repoRoot, generation, roots, [...uniqueDeleted, ...parsed.missing], parsed.bundles,undefined,stages);
}

function resyncNamespace(db: IndexDatabase, generation: number, namespace: string | undefined): number {
  if (!namespace) return 0;
  const store = new SqlFactsStore(db);
  // Every declaration of the namespace FQN is refreshed: resyncing more
  // files is safe, picking one of several would leave the others stale.
  const types = store.typesByFqn(namespace);
  if (types.length === 0) return 0;
  const graph = new SqlKnowledgeGraph(db);
  const builder = new KnowledgeGraphBuilder(graph);
  for (const type of types) {
    const relativePath = type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId;
    const bundle = readBundle(db, relativePath);
    if (bundle) builder.replaceFile(bundle, store, generation);
  }
  graph.flushMeta();
  return types.length;
}

/**
 * R08: an XML-only change replaces the documents SOURCED from that XML even
 * though no Java file changed: the old namespace's statements disappear, the
 * new ones bind to every Java declaration of the (new) namespace, each with
 * the XML path/hash/range as source.
 */
function replaceResourceDocuments(db: IndexDatabase, relativePath: string, resource: MyBatisMapperResourceFacts | undefined): void {
  const documents: Array<{ ownerPath: string; document: SearchDocument }> = [];
  if (resource?.namespace) {
    const store = new SqlFactsStore(db);
    const owners = new Set(store.typesByFqn(resource.namespace).map(type =>
      type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId));
    for (const ownerPath of [...owners].sort()) {
      const bundle = readBundle(db, ownerPath);
      if (!bundle) continue;
      for (const document of buildMyBatisSearchDocuments({ bundle, myBatisResources: [resource], bindsMyBatis: myBatisBindingFilter(db) })) {
        documents.push({ ownerPath, document });
      }
    }
  }
  replaceSearchDocumentsForSource(db, relativePath, documents);
}

async function applyResources(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  changedInputs: readonly string[],
  deletedInputs: readonly string[],
  options: { publish?: boolean; captures?: Map<string, SourceCapture>; stages?: PipelineMetrics } = {}
): Promise<void> {
  const layout = probeLayout(repoRoot);
  if(changedInputs.length===0 && deletedInputs.length===0) {
    // Nothing to apply; a job that publishes still publishes its generation, as an empty refresh does.
    if (options.publish !== false) sqlStage(db,options.stages,()=>finishIndex(db, generation, coverageRoots(layout)));
    return;
  }
  writeBuildProgress(db, { phase: "declare", done: 0, total: Math.max(1, changedInputs.length + deletedInputs.length) });
  const namespaces = new Set<string>();
  const deletePaths: string[] = [];
  for (const input of deletedInputs) deletePaths.push((await resolveInput(repoRoot, input)).rel);
  const writes: Array<{ relativePath: string; facts: ReturnType<typeof extractMyBatisMapperFacts> }> = [];
  const scans: StatRow[] = [];
  for (const relativePath of deletePaths) {
    const before = readMyBatisResource(db, relativePath);
    if (before?.namespace) namespaces.add(before.namespace);
  }
  const captureStarted=performance.now();
  let xmlParsed=0,xmlParseMs=0;
  for (const input of changedInputs) {
    const resolved = await resolveInput(repoRoot, input);
    const relativePath = resolved.rel;
    const before = readMyBatisResource(db, relativePath);
    try {
      const capture = options.captures?.get(resolved.abs) ?? await captureSource(repoRoot, resolved.abs);
      const bytes = capture.bytes;
      const content = bytes.toString("utf8");
      const contentHash = capture.contentHash;
      scans.push({ path: relativePath, contentHash, ...(capture.observed ?? {size:-1,mtimeNs:"-1",ctimeNs:"-1",ino:"0",dev:"0"}) });
      if (before?.contentHash === contentHash) continue;
      const parseStarted=performance.now();
      const facts = extractMyBatisMapperFacts({ relativePath, content, contentHash, generation });
      xmlParsed++;xmlParseMs+=performance.now()-parseStarted;
      // A non-mapper XML that was never indexed stays a no-op (reconcile
      // offers every resource XML; it must not rewrite df for each of them).
      if (!facts && !before) continue;
      writes.push({ relativePath, facts });
      if (before?.namespace) namespaces.add(before.namespace);
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
      deletePaths.push(relativePath);
      if (before?.namespace) namespaces.add(before.namespace);
    }
  }
  if(options.stages){if(!options.captures){options.stages.capture.files+=scans.length;options.stages.capture.xmlFiles=scans.length;}options.stages.capture.elapsedMs+=performance.now()-captureStarted-xmlParseMs;options.stages.parse.files+=xmlParsed;options.stages.parse.xmlFiles=xmlParsed;options.stages.parse.elapsedMs+=xmlParseMs;}
  await options.stages?.onStage?.("resource-capture-parse");
  sqlStage(db,options.stages, () => {
    writeMeta(db,"pipelineComplete","0");
    writeMeta(db,"buildState","BUILDING");
    for (const scan of scans) recordResourceScan(db, scan.path, scan.contentHash);
    recordStats(db, "resource", scans);
    for (const relativePath of deletePaths) deleteResourceScan(db, relativePath);
    deleteStats(db, deletePaths);
    for (const relativePath of deletePaths) prepareCached(db, "DELETE FROM mybatis_resource WHERE path=?").run(relativePath);
    for (const write of writes) {
      if (write.facts) {
        writeMyBatisResource(db, write.facts);
        if (write.facts.namespace) namespaces.add(write.facts.namespace);
      } else {
        prepareCached(db, "DELETE FROM mybatis_resource WHERE path=?").run(write.relativePath);
      }
    }
    const graphStarted=performance.now();
    // XML-derived graph rows are owned by the binding Java files, so the
    // namespace resync below is what replaces or drops them.
    let affected=0;
    for (const namespace of namespaces) affected+=resyncNamespace(db, generation, namespace);
    for (const relativePath of deletePaths) replaceResourceDocuments(db, relativePath, undefined);
    for (const write of writes) replaceResourceDocuments(db, write.relativePath, write.facts);
    if (options.stages) {options.stages.graphSearch.files+=affected;options.stages.graphSearch.elapsedMs+=performance.now()-graphStarted;}
    if (options.publish !== false) finishIndex(db, generation, coverageRoots(layout));
  });
  await options.stages?.onStage?.("resource-graph-search");
}

type IndexedFileRow = {
  path: string;
  size: number | null;
  contentHash: string;
  parseState: string | null;
};

async function contentHashOf(repoRoot: string, absolutePath: string, captures?: Map<string, SourceCapture>): Promise<string> {
  const capture = await captureSource(repoRoot, absolutePath);
  captures?.set(absolutePath, capture);
  return capture.contentHash;
}

/**
 * R08/K21: reconcile also covers resource XML. A worktree whose XML differs
 * from the copied sibling DB while every Java hash matches must still replace
 * the XML-sourced evidence before READY. Like Java: equal size+mtime skips,
 * otherwise the content hash decides (an mtime-only change is restamped, not
 * reparsed). Non-mapper XML is remembered in resource_scan, so it is not
 * reparsed on every reconcile.
 */
export async function changedResources(
  db: IndexDatabase,
  repoRoot: string,
  layout: LayoutContext
): Promise<{ changed: string[]; deleted: string[]; stamps: StatRow[]; captures: Map<string, SourceCapture>; discoveredFiles:number }> {
  const scanned = new Map(
    (prepareCached(db, "SELECT path, content_hash AS contentHash FROM resource_scan").all() as Array<{ path: string; contentHash: string }>)
      .map(row => [row.path, row.contentHash])
  );
  const stats = readStats(db, "resource");
  const known = new Set([
    ...scanned.keys(),
    ...(prepareCached(db, "SELECT path FROM mybatis_resource").all() as Array<{ path: string }>).map(row => row.path)
  ]);
  const captures = new Map<string, SourceCapture>();
  const changed: string[] = [];
  const stamps: StatRow[] = [];
  const seen = new Set<string>();
  for (const file of await discoverMyBatisResourceFiles(repoRoot, layout)) {
    seen.add(file.relativePath);
    const previous = scanned.get(file.relativePath);
    const info = await stat(file.absolutePath, { bigint: true });
    const stamp = stats.get(file.relativePath);
    if (previous && stamp?.contentHash === previous && statUnchanged(stamp, info)) continue;
    const hash = await contentHashOf(repoRoot, file.absolutePath, captures);
    if (previous && hash === previous) {
      const observed = captures.get(file.absolutePath)?.observed;
      if (observed) stamps.push({ path: file.relativePath, contentHash: hash, ...observed });
      captures.delete(file.absolutePath);
      continue;
    }
    changed.push(file.absolutePath);
  }
  const deleted = [...known].filter(relativePath => !seen.has(relativePath));
  return { changed, deleted, stamps, captures, discoveredFiles:seen.size };
}

async function applyReconcile(db: IndexDatabase, repoRoot: string, generation: number, stages?: PipelineMetrics): Promise<void> {
  const layout = probeLayout(repoRoot);
  const roots = coverageRoots(layout);
  writeBuildProgress(db, { phase: "declare", done: 0, total: 1 });
  // XML first, unpublished: the Java pass below is what publishes this
  // generation, so no reader sees generation N with the old XML evidence.
  const captureStart=performance.now();
  const resources = await changedResources(db, repoRoot, layout);
  const javaCapture=await captureJavaDelta(db,repoRoot,layout);
  if(stages) stages.capture={files:javaCapture.discovered.length+resources.discoveredFiles,javaFiles:javaCapture.discovered.length,xmlFiles:resources.discoveredFiles,elapsedMs:performance.now()-captureStart};
  await stages?.onStage?.("capture");
  if (resources.stamps.length > 0) sqlStage(db,stages, () => recordStats(db, "resource", resources.stamps));
  if (resources.changed.length > 0 || resources.deleted.length > 0) {
    await applyResources(db, repoRoot, generation, resources.changed, resources.deleted, { publish: false, captures: resources.captures, stages });
  }
  await applyJavaReconcile(db, repoRoot, generation, layout, roots, stages, javaCapture);
}

type JavaDeltaCapture = { discovered: Awaited<ReturnType<typeof discoverJavaFiles>>; changed:string[];deleted:string[];stamps:StatRow[];captures:Map<string,SourceCapture> };
async function captureJavaDelta(db:IndexDatabase,repoRoot:string,layout:LayoutContext):Promise<JavaDeltaCapture> {
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const indexed = new Map(
    (prepareCached(
      db,
      "SELECT path, size, content_hash AS contentHash, parse_state AS parseState FROM file"
    ).all() as IndexedFileRow[]).map(row => [row.path, row])
  );
  const stats = readStats(db, "java");
  const captures = new Map<string, SourceCapture>();
  const changed: string[] = [];
  const stamps: StatRow[] = [];
  const seen = new Set<string>();
  for (const file of discovered) {
    seen.add(file.relativePath);
    const previous = indexed.get(file.relativePath);
    if (!previous || previous.parseState === "FAILED") {
      changed.push(file.absolutePath);
      continue;
    }
    const info = await stat(file.absolutePath, { bigint: true });
    const stamp = stats.get(file.relativePath);
    // The stamp only stands in for hashing when it vouches for the hash the facts hold.
    if (stamp?.contentHash === previous.contentHash && statUnchanged(stamp, info)) continue;
    // git worktree add rewrites mtimes; an identical hash is restamped, not reparsed.
    const capturedHash = await contentHashOf(repoRoot, file.absolutePath, captures);
    if (Number(previous.size) === Number(info.size) && capturedHash === previous.contentHash) {
      const observed = captures.get(file.absolutePath)?.observed;
      if (observed) stamps.push({ path: file.relativePath, contentHash: previous.contentHash, ...observed });
      captures.delete(file.absolutePath);
      continue;
    }
    changed.push(file.absolutePath);
  }
  const deleted = [...indexed.keys()].filter(relativePath => !seen.has(relativePath));
  return {discovered,changed,deleted,stamps,captures};
}

async function applyJavaReconcile(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  layout: LayoutContext,
  roots: CoverageRoots,
  stages?: PipelineMetrics,
  input?: JavaDeltaCapture
): Promise<void> {
  const {discovered,changed,deleted,stamps,captures}=input ?? await captureJavaDelta(db,repoRoot,layout);
  if (changed.length === 0 && deleted.length === 0) {
    sqlStage(db,stages, () => {
      recordStats(db, "java", stamps);
      writeMeta(db,"pipelineComplete","1");
      publishIndexCoverage(db, generation, roots, discovered);
    });
    return;
  }
  if (stamps.length > 0) sqlStage(db,stages, () => recordStats(db, "java", stamps));
  const parsed = await parseChanged(db, repoRoot, layout, generation, changed, captures, stages);
  await applyParsedRefresh(db, repoRoot, generation, roots, [...deleted, ...parsed.missing], parsed.bundles, discovered,stages);
}

async function applyBuilderJobStages(options: {
  repoRoot: string;
  db: IndexDatabase;
  job: BuilderJob;
  onStage?: (name:string)=>Promise<void>;
  staged?: boolean;
  /** "full" (default) runs a needed full in this job; "report" returns
   * `escalation` instead, publishing nothing, so an owner scheduler can hold
   * the full to its own capacity. */
  escalation?: "full" | "report";
  /** Parser concurrency of a full (the scheduler's parser grant). */
  parallelism?: number;
}): Promise<BuilderJobResult> {
  const id = typeof options.job.id === "number" ? options.job.id : -1;
  if(!["full","refresh","resources","reconcile"].includes(options.job.kind)) return statusResult(options.db,id,false,`unknown kind ${String(options.job.kind)}`);
  let repoRoot = path.resolve(options.repoRoot);
  attachWorkspaceStat(options.db);
  const current = indexedGenerationOf(options.db);
  const generation = options.job.generation ?? current + 1;
  if (generation < current) return statusResult(options.db, id, true);
  const beforeCapture = captureCensus(options.db);
  const stages=pipelineMetrics("delta","compatible published base and bounded dependency closure");
  stages.onStage=options.onStage;
  try {
    repoRoot = await realpath(repoRoot);
    const layout=probeLayout(repoRoot);
    const fingerprint=await computeBuildFingerprint(repoRoot,layout);
    const baseCompatible=compatibleDeltaBase(options.db);
    const inputsMatch=readMeta(options.db,"buildFingerprint")===fingerprint;
    const full = async (reason: string): Promise<BuilderJobResult> => {
      const result = await runSqlColdBuild({repoRoot,db:options.db,generation,onStage:options.onStage,...(options.parallelism ? {parallelism:options.parallelism} : {})});
      return {...statusResult(options.db,id,true),census:result.census,censusComplete:true,stages:{...result.stages,reason}};
    };
    if (options.job.kind === "full" || !baseCompatible || !inputsMatch) {
      const reason = options.job.kind === "full" ? "explicit full" : baseCompatible && !inputsMatch ? "build/resolver inputs changed" : "no compatible published base";
      if (options.job.kind !== "full" && options.escalation === "report") return { ...statusResult(options.db, id, false, reason), escalation: reason };
      return await full(reason);
    }
    try {
      if (options.job.kind === "refresh") {
        await applyRefresh(options.db, repoRoot, generation, options.job.changed ?? [], options.job.deleted ?? [],stages);
      } else if (options.job.kind === "resources") {
        await applyResources(options.db, repoRoot, generation, options.job.changed ?? [], options.job.deleted ?? [],{stages});
      } else if (options.job.kind === "reconcile") {
        await applyReconcile(options.db, repoRoot, generation, stages);
      } else {
        return statusResult(options.db, id, false, `unknown kind ${String((options.job as BuilderJob).kind)}`);
      }
    } catch (error) {
      if (!(error instanceof DeltaEscalation)) throw error;
      const reason = `delta escalated to full: ${error.reason}`;
      // An atomic job rolls the delta back; a staged one leaves it DEGRADED for the full.
      if (options.escalation === "report" && !options.staged) throw new ReportedEscalation(reason);
      // Not BUILDING, so the full clears the abandoned delta instead of resuming it.
      writeMeta(options.db, "buildState", "DEGRADED");
      if (options.escalation === "report") return { ...statusResult(options.db, id, false, reason), escalation: reason };
      return await full(reason);
    }
    return { ...statusResult(options.db, id, true), census: finishCaptureCensus(options.db, beforeCapture), censusComplete: true, stages };
  } catch (err) {
    if(options.db.isTransaction || err instanceof ReportedEscalation) throw err;
    withTransaction(options.db, () => {
      writeMeta(options.db, "buildState", "DEGRADED");
      writeMeta(options.db, COVERAGE_GAP, "job-failed");
      options.db.prepare("UPDATE source_root_coverage SET state='DEGRADED'").run();
    });
    return { ...statusResult(options.db, id, false, err instanceof Error ? err.message : String(err)), census: finishCaptureCensus(options.db, beforeCapture), censusComplete: false, stages };
  }
}

/** Staged commits are reserved for a registered private test target. Legacy
 * callers keep the complete full/delta update atomic on their serving inode. */
export async function applyBuilderJob(options: Parameters<typeof applyBuilderJobStages>[0]): Promise<BuilderJobResult> {
  attachWorkspaceStat(options.db);
  const target=indexDbPath(options.db);
  if(options.staged) {
    if(target && !isMemoryPath(target)) {
      const registered=process.env.ILV2_RUN_ROOT;
      if(!registered) throw new Error("staged builder requires registered run root");
      const privateRoot=path.join(await realpath(registered),"tmp");
      const parent=await realpath(path.dirname(target));
      const relative=path.relative(privateRoot,parent);
      if(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("staged builder target escapes registered tmp");
    }
    return applyBuilderJobStages(options);
  }
  const started=performance.now();
  const before=Number((options.db.prepare("SELECT total_changes() AS n").get() as {n:number}).n);
  try {
    const result=await withAsyncTransaction(options.db,()=>applyBuilderJobStages(options));
    if(result.stages){result.stages.sql.elapsedMs=performance.now()-started;result.stages.sql.rows=Number((options.db.prepare("SELECT total_changes() AS n").get() as {n:number}).n)-before;result.stages.sql.measurement="atomic transaction wall; overlaps capture/parse/resolve/graph";}
    return result;
  } catch(error) {
    // Rolled back: the published index is as before this job.
    if (error instanceof ReportedEscalation) return { ...statusResult(options.db, options.job.id ?? -1, false, error.reason), escalation: error.reason };
    // The rollback restored the old completeness markers; only a full
    // traversal (reconcile/full) may clear the gap this lost job left.
    withTransaction(options.db,()=>{
      writeMeta(options.db,"buildState","DEGRADED");writeMeta(options.db,COVERAGE_GAP,"job-failed");
      options.db.prepare("UPDATE source_root_coverage SET state='DEGRADED'").run();
    });
    return {...statusResult(options.db,options.job.id ?? -1,false,error instanceof Error?error.message:String(error)),census:captureCensus(options.db),censusComplete:false};
  }
}
