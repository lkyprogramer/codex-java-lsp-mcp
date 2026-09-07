import { prepareCached, type IndexDatabase } from "./driver.js";

const INTERN_LIMIT = 65_536;
const READ_LIMIT = 4_096;

type Caches = {
  intern: Map<string, number>;
  byText: Map<string, number>;
  byId: Map<number, string>;
};

const caches = new WeakMap<IndexDatabase, Caches>();

function cacheOf(db: IndexDatabase): Caches {
  let cache = caches.get(db);
  if (!cache) {
    cache = { intern: new Map(), byText: new Map(), byId: new Map() };
    caches.set(db, cache);
  }
  return cache;
}

function asId(value: unknown): number {
  const id = typeof value === "bigint" ? Number(value) : value;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error(`invalid sym id ${String(value)}`);
  }
  return id;
}

function lruTouch<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function remember(cache: Caches, text: string, id: number, intern: boolean): void {
  if (intern) lruTouch(cache.intern, text, id, INTERN_LIMIT);
  lruTouch(cache.byText, text, id, READ_LIMIT);
  lruTouch(cache.byId, id, text, READ_LIMIT);
}

const INSERT_SQL =
  "INSERT INTO sym(text) VALUES (?) ON CONFLICT(text) DO UPDATE SET text=excluded.text RETURNING id";

export function internSym(db: IndexDatabase, text: string): number {
  const cache = cacheOf(db);
  const hit = cache.intern.get(text) ?? cache.byText.get(text);
  if (hit !== undefined) {
    remember(cache, text, hit, true);
    return hit;
  }
  const row = prepareCached(db, INSERT_SQL).get(text) as { id: number | bigint } | undefined;
  const id = asId(row?.id);
  remember(cache, text, id, true);
  return id;
}

export function internSymNullable(db: IndexDatabase, text: string | null | undefined): number | null {
  return text == null ? null : internSym(db, text);
}

export function symId(db: IndexDatabase, text: string): number | undefined {
  const cache = cacheOf(db);
  const hit = cache.intern.get(text) ?? cache.byText.get(text);
  if (hit !== undefined) {
    remember(cache, text, hit, false);
    return hit;
  }
  const row = prepareCached(db, "SELECT id FROM sym WHERE text=?").get(text) as { id?: unknown } | undefined;
  if (row?.id === undefined || row.id === null) return undefined;
  const id = asId(row.id);
  remember(cache, text, id, false);
  return id;
}

export function symText(db: IndexDatabase, id: number): string {
  const cache = cacheOf(db);
  const hit = cache.byId.get(id);
  if (hit !== undefined) {
    lruTouch(cache.byId, id, hit, READ_LIMIT);
    lruTouch(cache.byText, hit, id, READ_LIMIT);
    return hit;
  }
  const row = prepareCached(db, "SELECT text FROM sym WHERE id=?").get(id) as { text?: unknown } | undefined;
  if (typeof row?.text !== "string") throw new Error(`missing sym ${id}`);
  remember(cache, row.text, id, false);
  return row.text;
}
