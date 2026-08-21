// input: In-memory JavaIndex snapshot DTO (schema 3 facts).
// output: Segmented v4 bytes with per-segment gzip + crc32; lazy files-only decode.
// pos: M3 P2 disk format. v3 gzip JSON is discarded by the loader, never migrated.
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

export const SNAPSHOT_V4_MAGIC = Buffer.from("CJV4");
export const SNAPSHOT_V4_VERSION = 4;

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
  crc32: number;
  offset: number;
  length: number;
};

type V4Header = {
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

export type SnapshotV4View = {
  header: V4Header;
  files: JavaFileFacts[];
  payload: Buffer;
  readRest(): Pick<SnapshotV4Facts, "types" | "fields" | "methods" | "edges" | "myBatisResources" | "entitySearch">;
  toFacts(): SnapshotV4Facts;
};

export function isSnapshotV4(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(SNAPSHOT_V4_MAGIC);
}

export function encodeSnapshotV4(value: SnapshotV4Facts): Buffer {
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
    const packed = gzipSync(Buffer.from(JSON.stringify(bodies[kind])), { level: 6 });
    segments.push({ kind, crc32: crc32(packed), offset, length: packed.byteLength });
    compressed.push(packed);
    offset += packed.byteLength;
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

export function decodeSnapshotV4View(bytes: Buffer): SnapshotV4View | { error: string } {
  if (!isSnapshotV4(bytes)) return { error: "not a v4 snapshot" };
  if (bytes.length < 12) return { error: "truncated v4 header" };
  const version = bytes.readUInt32LE(4);
  if (version !== SNAPSHOT_V4_VERSION) return { error: `unsupported schemaVersion ${version}` };
  const headerLength = bytes.readUInt32LE(8);
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
  const payload = bytes.subarray(headerEnd);
  let files: JavaFileFacts[];
  try {
    files = readSegment(payload, header.segments, "files") as JavaFileFacts[];
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const readRest = () => ({
    types: readSegment(payload, header.segments, "types") as JavaTypeFacts[],
    fields: readSegment(payload, header.segments, "fields") as JavaFieldFacts[],
    methods: readSegment(payload, header.segments, "methods") as JavaMethodFacts[],
    edges: readSegment(payload, header.segments, "edges") as StaticEdge[],
    myBatisResources: readSegment(payload, header.segments, "mybatis") as MyBatisMapperResourceFacts[],
    entitySearch: decodeEntitySearch(readSegment(payload, header.segments, "entitySearch"))
  });
  return {
    header,
    files,
    payload,
    readRest,
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

function readSegment(payload: Buffer, directory: SegmentDirectoryEntry[], kind: SnapshotV4SegmentKind): unknown {
  const entry = directory.find(item => item.kind === kind);
  if (!entry) throw new Error(`missing v4 segment ${kind}`);
  const slice = payload.subarray(entry.offset, entry.offset + entry.length);
  if (slice.byteLength !== entry.length) throw new Error(`truncated v4 segment ${kind}`);
  if (crc32(slice) !== entry.crc32) throw new Error(`crc32 mismatch in v4 segment ${kind}`);
  return JSON.parse(gunzipSync(slice).toString("utf8"));
}

function decodeEntitySearch(value: unknown): EntitySearchSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as EntitySearchSnapshot;
  return snapshot.version === 1 ? snapshot : undefined;
}
