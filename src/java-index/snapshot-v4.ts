// input: In-memory JavaIndex snapshot DTO (schema 3 facts).
// output: Segmented v4 bytes with per-segment gzip + crc32; files-only decode; rest reread from disk.
// pos: M3 P2 disk format. OPEN does not retain the snapshot Buffer (G1).
import { closeSync, openSync, readSync } from "node:fs";
import { crc32, gunzipSync, gzipSync } from "node:zlib";
import type { EntitySearchSnapshot } from "./entity-search.js";
import type {
  JavaFieldFacts,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  MyBatisResourceCoverage,
  SourceRootCoverage,
  StaticEdge
} from "./index-types.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";
import { jsonStringifyBounded } from "./bounded-json.js";

export const SNAPSHOT_V4_MAGIC = Buffer.from("CJV4");
/** Schema 5: chunked methods/edges/fields. Magic stays CJV4; old readers discard and rebuild. */
export const SNAPSHOT_V4_VERSION = 5;
export const SNAPSHOT_V4_CHUNK_ITEM_LIMIT = 5000;
export const SNAPSHOT_V4_CHUNK_JSON_BYTES = 32 * 1024 * 1024;

export const SNAPSHOT_V4_SEGMENT_KINDS = [
  "files",
  "types",
  "fields",
  "methods",
  "edges",
  "mybatis",
  "entitySearch"
] as const;

export type SnapshotV4SegmentKind = (typeof SNAPSHOT_V4_SEGMENT_KINDS)[number];
const CHUNKED_SEGMENT_KINDS = new Set<SnapshotV4SegmentKind>(["fields", "methods", "edges"]);

export type SnapshotV4Facts = {
  extractorVersion: string;
  stableIdVersion: number;
  canonicalRepoRoot: string;
  buildFingerprint: string;
  manifestFingerprint: string;
  indexedGeneration: number;
  createdAt: string;
  coverage: SourceRootCoverage[];
  resourceCoverage: MyBatisResourceCoverage[];
  files: JavaFileFacts[];
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
  edges: StaticEdge[];
  myBatisResources: MyBatisMapperResourceFacts[];
  entitySearch?: EntitySearchSnapshot;
};

type SegmentDirectoryEntry = {
  kind: SnapshotV4SegmentKind;
  part: number;
  crc32: number;
  offset: number;
  length: number;
};

export type V4Header = {
  schemaVersion: typeof SNAPSHOT_V4_VERSION;
  extractorVersion: string;
  stableIdVersion: number;
  canonicalRepoRoot: string;
  buildFingerprint: string;
  manifestFingerprint: string;
  indexedGeneration: number;
  createdAt: string;
  coverage: SourceRootCoverage[];
  resourceCoverage: MyBatisResourceCoverage[];
  segments: SegmentDirectoryEntry[];
};

export type SnapshotV4Rest = Pick<
  SnapshotV4Facts,
  "types" | "fields" | "methods" | "edges" | "myBatisResources" | "entitySearch"
>;

export type SnapshotV4View = {
  header: V4Header;
  files: JavaFileFacts[];
  /** True when rest segments are reread from disk and the original snapshot bytes were dropped. */
  restOnDisk: boolean;
  readRest(): SnapshotV4Rest;
  readSegment(kind: Exclude<SnapshotV4SegmentKind, "files">): unknown;
  readSegmentChunks(kind: Exclude<SnapshotV4SegmentKind, "files">): Iterable<unknown>;
  toFacts(): SnapshotV4Facts;
};

type RestSource =
  | { kind: "buffer"; payload: Buffer }
  | { kind: "file"; path: string; payloadStart: number };

export function isSnapshotV4(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(SNAPSHOT_V4_MAGIC);
}

function splitJsonChunks(items: unknown[]): unknown[][] {
  if (items.length === 0) return [items];
  const chunks: unknown[][] = [];
  let start = 0;
  while (start < items.length) {
    let end = Math.min(start + SNAPSHOT_V4_CHUNK_ITEM_LIMIT, items.length);
    while (end > start + 1) {
      const json = jsonStringifyBounded(items.slice(start, end), SNAPSHOT_V4_CHUNK_JSON_BYTES);
      if (json.bytes <= SNAPSHOT_V4_CHUNK_JSON_BYTES && !json.truncated) break;
      end = start + Math.max(1, Math.floor((end - start) / 2));
    }
    chunks.push(items.slice(start, end));
    start = end;
  }
  return chunks;
}

function releaseEncodedSegment(value: SnapshotV4Facts, kind: SnapshotV4SegmentKind): void {
  switch (kind) {
    case "files":
      value.files.length = 0;
      return;
    case "types":
      value.types.length = 0;
      return;
    case "fields":
      value.fields.length = 0;
      return;
    case "methods":
      value.methods.length = 0;
      return;
    case "edges":
      value.edges.length = 0;
      return;
    case "mybatis":
      value.myBatisResources.length = 0;
      return;
    case "entitySearch":
      if (value.entitySearch) value.entitySearch.entities.length = 0;
      value.entitySearch = undefined;
      return;
  }
}

export function encodeSnapshotV4(value: SnapshotV4Facts, options: { chunkRest?: boolean } = {}): Buffer {
  const chunkRest = options.chunkRest !== false;
  const bodies: Record<SnapshotV4SegmentKind, unknown> = {
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    mybatis: value.myBatisResources,
    entitySearch: value.entitySearch ?? null
  };
  const compressed: Buffer[] = [];
  const segments: SegmentDirectoryEntry[] = [];
  let offset = 0;
  for (const kind of SNAPSHOT_V4_SEGMENT_KINDS) {
    const parts = chunkRest && CHUNKED_SEGMENT_KINDS.has(kind) && Array.isArray(bodies[kind])
      ? splitJsonChunks(bodies[kind] as unknown[])
      : [bodies[kind]];
    const jsonParts = parts.map(part => JSON.stringify(part));
    bodies[kind] = null;
    for (let part = 0; part < parts.length; part += 1) parts[part] = null;
    releaseEncodedSegment(value, kind);
    for (let part = 0; part < jsonParts.length; part += 1) {
      const packed = gzipSync(Buffer.from(jsonParts[part]!), { level: 6 });
      jsonParts[part] = "";
      segments.push({ kind, part, crc32: crc32(packed), offset, length: packed.byteLength });
      compressed.push(packed);
      offset += packed.byteLength;
    }
  }
  const header: V4Header = {
    schemaVersion: SNAPSHOT_V4_VERSION,
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    segments
  };
  const headerBytes = gzipSync(Buffer.from(JSON.stringify(header)), { level: 6 });
  const prefix = Buffer.alloc(12);
  SNAPSHOT_V4_MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(SNAPSHOT_V4_VERSION, 4);
  prefix.writeUInt32LE(headerBytes.byteLength, 8);
  return Buffer.concat([prefix, headerBytes, ...compressed]);
}

const MAX_V4_HEADER_BYTES = 4 * 1024 * 1024;

/** Prefix + gzip header only. Does not decode files/rest segments. */
export function decodeSnapshotV4Header(bytes: Buffer): V4Header | { error: string } {
  if (!isSnapshotV4(bytes)) return { error: "not a v4 snapshot" };
  if (bytes.length < 12) return { error: "truncated v4 header" };
  const version = bytes.readUInt32LE(4);
  if (version !== SNAPSHOT_V4_VERSION) return { error: `unsupported schemaVersion ${version}` };
  const headerLength = bytes.readUInt32LE(8);
  if (headerLength <= 0 || headerLength > MAX_V4_HEADER_BYTES) return { error: "invalid v4 header length" };
  const headerStart = 12;
  const headerEnd = headerStart + headerLength;
  if (bytes.length < headerEnd) return { error: "truncated v4 header payload" };
  let header: V4Header;
  try {
    header = JSON.parse(gunzipSync(bytes.subarray(headerStart, headerEnd)).toString("utf8")) as V4Header;
  } catch {
    return { error: "invalid v4 header gzip/json" };
  }
  if (header.schemaVersion !== SNAPSHOT_V4_VERSION || !Array.isArray(header.segments)) {
    return { error: "invalid v4 header" };
  }
  return header;
}

export function v4HeaderByteLength(prefix: Buffer): number | undefined {
  if (prefix.length < 12 || !isSnapshotV4(prefix)) return undefined;
  if (prefix.readUInt32LE(4) !== SNAPSHOT_V4_VERSION) return undefined;
  const headerLength = prefix.readUInt32LE(8);
  if (headerLength <= 0 || headerLength > MAX_V4_HEADER_BYTES) return undefined;
  return headerLength;
}

export function decodeSnapshotV4View(bytes: Buffer, sourcePath?: string): SnapshotV4View | { error: string } {
  const header = decodeSnapshotV4Header(bytes);
  if ("error" in header) return header;
  const headerLength = bytes.readUInt32LE(8);
  const headerEnd = 12 + headerLength;
  const payload = bytes.subarray(headerEnd);
  const restSource: RestSource = sourcePath
    ? { kind: "file", path: sourcePath, payloadStart: headerEnd }
    : { kind: "buffer", payload: Buffer.from(payload) };
  let files: JavaFileFacts[];
  try {
    files = decodeSegment(readSegmentBytes({ kind: "buffer", payload }, header.segments, "files")) as JavaFileFacts[];
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const readSegmentChunks = (kind: Exclude<SnapshotV4SegmentKind, "files">): Iterable<unknown> =>
    readDecodedSegmentParts(restSource, header.segments, kind);
  const readSegment = (kind: Exclude<SnapshotV4SegmentKind, "files">): unknown =>
    concatDecodedParts(kind, [...readSegmentChunks(kind)]);
  const readRest = (): SnapshotV4Rest => ({
    types: readSegment("types") as JavaTypeFacts[],
    fields: readSegment("fields") as JavaFieldFacts[],
    methods: readSegment("methods") as JavaMethodFacts[],
    edges: readSegment("edges") as StaticEdge[],
    myBatisResources: readSegment("mybatis") as MyBatisMapperResourceFacts[],
    entitySearch: decodeEntitySearch(readSegment("entitySearch"))
  });
  return {
    header,
    files,
    restOnDisk: restSource.kind === "file",
    readRest,
    readSegment,
    readSegmentChunks,
    toFacts() {
      const rest = readRest();
      return {
        extractorVersion: header.extractorVersion,
        stableIdVersion: header.stableIdVersion,
        canonicalRepoRoot: header.canonicalRepoRoot,
        buildFingerprint: header.buildFingerprint,
        manifestFingerprint: header.manifestFingerprint,
        indexedGeneration: header.indexedGeneration,
        createdAt: header.createdAt,
        coverage: header.coverage,
        resourceCoverage: header.resourceCoverage,
        files,
        ...rest
      };
    }
  };
}

function segmentParts(directory: SegmentDirectoryEntry[], kind: SnapshotV4SegmentKind): SegmentDirectoryEntry[] {
  return directory
    .filter(item => item.kind === kind)
    .sort((left, right) => (left.part ?? 0) - (right.part ?? 0));
}

function readSegmentPartBytes(source: RestSource, entry: SegmentDirectoryEntry): Buffer {
  const slice = source.kind === "buffer"
    ? source.payload.subarray(entry.offset, entry.offset + entry.length)
    : readFileRange(source.path, source.payloadStart + entry.offset, entry.length);
  if (slice.byteLength !== entry.length) throw new Error(`truncated v4 segment ${entry.kind}`);
  if (crc32(slice) !== entry.crc32) throw new Error(`crc32 mismatch in v4 segment ${entry.kind}`);
  return slice;
}

function* readDecodedSegmentParts(
  source: RestSource,
  directory: SegmentDirectoryEntry[],
  kind: SnapshotV4SegmentKind
): Iterable<unknown> {
  const parts = segmentParts(directory, kind);
  if (parts.length === 0) throw new Error(`missing v4 segment ${kind}`);
  for (const entry of parts) {
    yield decodeSegment(readSegmentPartBytes(source, entry));
  }
}

function concatDecodedParts(kind: SnapshotV4SegmentKind, parts: unknown[]): unknown {
  if (kind === "entitySearch") return parts[0];
  const merged: unknown[] = [];
  for (const part of parts) {
    if (!Array.isArray(part)) return part;
    merged.push(...part);
  }
  return merged;
}

function readSegmentBytes(source: RestSource, directory: SegmentDirectoryEntry[], kind: SnapshotV4SegmentKind): Buffer {
  const entry = segmentParts(directory, kind)[0];
  if (!entry) throw new Error(`missing v4 segment ${kind}`);
  return readSegmentPartBytes(source, entry);
}

function decodeSegment(slice: Buffer): unknown {
  return JSON.parse(gunzipSync(slice).toString("utf8"));
}

function readFileRange(target: string, offset: number, length: number): Buffer {
  const fd = openSync(target, "r");
  try {
    const slice = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, slice, 0, length, offset);
    if (bytesRead !== length) throw new Error(`truncated v4 file read at ${offset}`);
    return slice;
  } finally {
    closeSync(fd);
  }
}

function decodeEntitySearch(value: unknown): EntitySearchSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as EntitySearchSnapshot;
  return snapshot.version === 1 ? snapshot : undefined;
}
