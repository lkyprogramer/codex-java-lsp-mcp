import type { SQLOutputValue } from "node:sqlite";
import type {
  JavaFieldFacts,
  JavaFileBundle,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  StaticEdge
} from "../index-types.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { myBatisQualifiedId } from "../mybatis-types.js";
import { prepareCached, type IndexDatabase } from "./driver.js";
import { readBundle } from "./rows.js";

const LRU_LIMIT = 2048;

export type PointLookup<V> = {
  get(key: string): V | undefined;
  has(key: string): boolean;
  readonly size: number;
};

export function decodeFacts<T>(value: SQLOutputValue): T {
  if (typeof value !== "string") throw new Error("expected json(facts) text");
  return JSON.parse(value) as T;
}

export function asCount(row: Record<string, SQLOutputValue> | undefined): number {
  const value = row?.n;
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

class PointMap<V> implements PointLookup<V> {
  constructor(
    private readonly load: (key: string) => V | undefined,
    private readonly countKeys: () => number
  ) {}
  get(key: string): V | undefined { return this.load(key); }
  has(key: string): boolean { return this.load(key) !== undefined; }
  get size(): number { return this.countKeys(); }
}

export class SqlFactsStore {
  readonly typesById: PointLookup<JavaTypeFacts>;
  readonly methodsById: PointLookup<JavaMethodFacts>;
  readonly fieldsById: PointLookup<JavaFieldFacts>;
  readonly filesByPath: PointLookup<JavaFileFacts>;
  readonly typeIdByFqn: PointLookup<string>;
  readonly typeIdsBySimpleName: PointLookup<ReadonlySet<string>>;
  readonly methodIdsByOwnerAndName: PointLookup<ReadonlySet<string>>;
  private readonly db: IndexDatabase;
  private readonly lru = new Map<string, unknown>();

  constructor(db: IndexDatabase) {
    this.db = db;
    this.typesById = new PointMap(id => this.cached(`type:${id}`, () => this.selectFacts("type", "type_id", id)), () => this.countTable("type"));
    this.methodsById = new PointMap(id => this.cached(`method:${id}`, () => this.selectFacts("method", "method_id", id)), () => this.countTable("method"));
    this.fieldsById = new PointMap(id => this.cached(`field:${id}`, () => this.selectFacts("field", "field_id", id)), () => this.countTable("field"));
    this.filesByPath = new PointMap(path => this.cached(`file:${path}`, () => this.selectFacts("file", "path", path)), () => this.countTable("file"));
    this.typeIdByFqn = new PointMap(fqn => this.cached(`fqn:${fqn}`, () => {
      const row = prepareCached(this.db, "SELECT type_id AS id FROM type WHERE fqn=?").get(fqn);
      return typeof row?.id === "string" ? row.id : undefined;
    }), () => asCount(prepareCached(this.db, "SELECT count(DISTINCT fqn) AS n FROM type WHERE fqn IS NOT NULL").get()));
    this.typeIdsBySimpleName = new PointMap(
      name => this.loadIdSet(`simple:${name}`, "SELECT type_id AS id FROM type WHERE simple_name=?", name),
      () => asCount(prepareCached(this.db, "SELECT count(DISTINCT simple_name) AS n FROM type").get())
    );
    this.methodIdsByOwnerAndName = new PointMap(key => {
      const sep = key.indexOf("#");
      if (sep < 0) return undefined;
      return this.loadIdSet(
        `owner:${key}`,
        "SELECT method_id AS id FROM method WHERE owner_type_id=? AND name=?",
        key.slice(0, sep),
        key.slice(sep + 1)
      );
    }, () => asCount(prepareCached(this.db, "SELECT count(*) AS n FROM (SELECT 1 FROM method GROUP BY owner_type_id, name)").get()));
  }

  clearRequestCache(): void { this.lru.clear(); }

  private cached<T>(key: string, load: () => T | undefined): T | undefined {
    if (this.lru.has(key)) {
      const hit = this.lru.get(key) as T;
      this.lru.delete(key);
      this.lru.set(key, hit);
      return hit;
    }
    const value = load();
    if (value === undefined) return undefined;
    this.lru.set(key, value);
    if (this.lru.size > LRU_LIMIT) {
      const oldest = this.lru.keys().next().value;
      if (oldest !== undefined) this.lru.delete(oldest);
    }
    return value;
  }

  file(path: string): JavaFileFacts | undefined { return this.filesByPath.get(path); }

  files(paths: readonly string[]): JavaFileBundle[] {
    const results: JavaFileBundle[] = [];
    for (const path of paths) {
      const bundle = readBundle(this.db, path);
      if (bundle) results.push(bundle);
    }
    this.clearRequestCache();
    return results;
  }

  typeByFqn(fqn: string): JavaTypeFacts | undefined {
    const typeId = this.typeIdByFqn.get(fqn);
    return typeId ? this.typesById.get(typeId) : undefined;
  }

  methodsOfOwner(typeId: string): JavaMethodFacts[] {
    const type = this.typesById.get(typeId);
    if (!type) return [];
    const methods: JavaMethodFacts[] = [];
    for (const methodId of type.methodIds) {
      const method = this.methodsById.get(methodId);
      if (method) methods.push(method);
    }
    return methods;
  }

  myBatisResource(path: string): MyBatisMapperResourceFacts | undefined {
    const row = prepareCached(this.db, "SELECT json(facts) AS facts FROM mybatis_resource WHERE path=?").get(path);
    return row ? decodeFacts<MyBatisMapperResourceFacts>(row.facts) : undefined;
  }

  myBatisResourceForNamespace(ns: string): MyBatisMapperResourceFacts | undefined {
    const rows = prepareCached(this.db, "SELECT path FROM mybatis_resource WHERE namespace=?").all(ns);
    if (rows.length !== 1 || typeof rows[0]?.path !== "string") return undefined;
    return this.myBatisResource(rows[0].path);
  }

  myBatisStatement(qid: string): MyBatisMapperResourceFacts["statements"][number] | undefined {
    for (const row of prepareCached(this.db, "SELECT json(facts) AS facts FROM mybatis_resource").iterate()) {
      const resource = decodeFacts<MyBatisMapperResourceFacts>(row.facts);
      const hit = resource.statements.find(statement =>
        myBatisQualifiedId(resource.namespace, statement.id) === qid || statement.statementId === qid
      );
      if (hit) return hit;
    }
    return undefined;
  }

  *iterTypes(): IterableIterator<JavaTypeFacts> { yield* this.iterFacts("type"); }
  *iterFields(): IterableIterator<JavaFieldFacts> { yield* this.iterFacts("field"); }
  *iterMethods(): IterableIterator<JavaMethodFacts> { yield* this.iterFacts("method"); }
  *iterEdges(): IterableIterator<StaticEdge> { yield* this.iterFacts("edge"); }
  *iterFiles(): IterableIterator<JavaFileFacts> { yield* this.iterFacts("file"); }

  private *iterFacts<T>(table: string): IterableIterator<T> {
    for (const row of prepareCached(this.db, `SELECT json(facts) AS facts FROM ${table} ORDER BY rowid`).iterate()) {
      yield decodeFacts<T>(row.facts);
    }
  }

  private selectFacts<T>(table: string, column: string, key: string): T | undefined {
    const row = prepareCached(this.db, `SELECT json(facts) AS facts FROM ${table} WHERE ${column}=?`).get(key);
    return row ? decodeFacts<T>(row.facts) : undefined;
  }

  private countTable(table: string): number {
    return asCount(prepareCached(this.db, `SELECT count(*) AS n FROM ${table}`).get());
  }

  private loadIdSet(cacheKey: string, sql: string, ...params: string[]): ReadonlySet<string> | undefined {
    return this.cached(cacheKey, () => {
      const ids = new Set<string>();
      for (const row of prepareCached(this.db, sql).all(...params)) {
        if (typeof row.id === "string") ids.add(row.id);
      }
      return ids.size === 0 ? undefined : ids;
    });
  }
}
