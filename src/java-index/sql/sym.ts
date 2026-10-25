import { createHash } from "node:crypto";
import { BoundedCache } from "./bounded-cache.js";
import { onRollback, prepareCached, type IndexDatabase } from "./driver.js";

// sym rows are looked up by a fixed-length hash prefix and confirmed by the
// original text, so the table needs no long TEXT UNIQUE index and a hash
// collision stores two rows instead of merging two identities.
export const SYM_HASH_BYTES = 16;
export type SymHash = (text: string) => Uint8Array;
const defaultSymHash: SymHash = text => createHash("sha256").update(text).digest().subarray(0, SYM_HASH_BYTES);
const hashOverrides = new WeakMap<IndexDatabase, SymHash>();

/** Test hook: force collisions by replacing the lookup hash for one database. */
export function setSymHashForTesting(db: IndexDatabase, hash: SymHash | undefined): void {
  if (hash) hashOverrides.set(db, hash); else hashOverrides.delete(db);
}

function symHash(db: IndexDatabase, text: string): Uint8Array {
  const hash = (hashOverrides.get(db) ?? defaultSymHash)(text);
  if (hash.length !== SYM_HASH_BYTES) throw new Error(`sym hash must be ${SYM_HASH_BYTES} bytes`);
  return hash;
}

const INTERN_LIMIT = 65_536;
const READ_LIMIT = 4_096;

type Caches = {
  intern: BoundedCache<string, number>;
  byText: BoundedCache<string, number>;
  byId: BoundedCache<number, string>;
};

const caches = new WeakMap<IndexDatabase, Caches>();
const rollbackHooked = new WeakSet<IndexDatabase>();

function cacheOf(db: IndexDatabase): Caches {
  let cache = caches.get(db);
  if (!cache) {
    cache = { intern: new BoundedCache(INTERN_LIMIT), byText: new BoundedCache(READ_LIMIT), byId: new BoundedCache(READ_LIMIT) };
    caches.set(db, cache);
  }
  if (!rollbackHooked.has(db)) {
    // A rolled-back insert leaves no row: a cached id would later bind another
    // text that reuses the rowid, merging two identities. One hook per db: it
    // drops whichever cache is current.
    rollbackHooked.add(db);
    onRollback(db, () => caches.delete(db));
  }
  return cache;
}

function asId(value: unknown): number {
  if (typeof value === "bigint" && value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`unsafe sym id ${value}`);
  const id = typeof value === "bigint" ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`invalid sym id ${String(value)}`);
  }
  return id;
}

function remember(cache: Caches, text: string, id: number, intern: boolean): void {
  if (intern) cache.intern.set(text, id);
  cache.byText.set(text, id);
  cache.byId.set(id, text);
}

const LOOKUP_SQL = "SELECT id FROM sym WHERE hash=? AND text=?";
const INSERT_SQL = "INSERT INTO sym(hash, text) VALUES (?, ?) RETURNING id";

function lookup(db: IndexDatabase, text: string, hash: Uint8Array): number | undefined {
  const row = prepareCached(db, LOOKUP_SQL).get(hash, text) as { id?: unknown } | undefined;
  return row?.id === undefined || row.id === null ? undefined : asId(row.id);
}

export function internSym(db: IndexDatabase, text: string): number {
  const cache = cacheOf(db);
  const interned = cache.intern.get(text);
  if (interned !== undefined) return interned;
  const hit = cache.byText.get(text);
  if (hit !== undefined) {
    cache.intern.set(text, hit);
    return hit;
  }
  // Only the builder writes a facts database, so lookup-then-insert has no concurrent writer.
  const hash = symHash(db, text);
  const id = lookup(db, text, hash) ?? asId((prepareCached(db, INSERT_SQL).get(hash, text) as { id?: unknown } | undefined)?.id);
  remember(cache, text, id, true);
  return id;
}

/**
 * Text/id pairs a caller read from rows it is about to rewrite: the rewrite
 * interns the same texts, which then need no lookup. A sym row is never
 * deleted or renumbered, so a pair stays valid (a rollback drops the cache).
 */
export function rememberSyms(db: IndexDatabase, rows: Iterable<{ text: unknown; id: unknown }>): void {
  const cache = cacheOf(db);
  for (const row of rows) if (typeof row.text === "string") cache.intern.set(row.text, asId(row.id));
}

export function internSymNullable(db: IndexDatabase, text: string | null | undefined): number | null {
  return text == null ? null : internSym(db, text);
}

export function symId(db: IndexDatabase, text: string): number | undefined {
  const cache = cacheOf(db);
  const hit = cache.intern.get(text) ?? cache.byText.get(text);
  if (hit !== undefined) return hit;
  const id = lookup(db, text, symHash(db, text));
  if (id === undefined) return undefined;
  remember(cache, text, id, false);
  return id;
}

export function symText(db: IndexDatabase, id: number): string {
  const cache = cacheOf(db);
  const hit = cache.byId.get(id);
  if (hit !== undefined) return hit;
  const row = prepareCached(db, "SELECT text FROM sym WHERE id=?").get(id) as { text?: unknown } | undefined;
  if (typeof row?.text !== "string") throw new Error(`missing sym ${id}`);
  remember(cache, row.text, id, false);
  return row.text;
}
