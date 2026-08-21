// input: A JavaFileBundle from JavaIndexStore.files / QUERY_FILES.
// output: Canonical JSON and SHA-256. Order-insensitive; field semantics unchanged.
// pos: M0 identity primitive. Used by verify-facts-digest and M1–M3 digest gates.
import { createHash } from "node:crypto";

export function sortBy(items, key) {
  return [...(items ?? [])].sort((left, right) => String(key(left)).localeCompare(String(key(right))));
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function canonicalizeFileBundle(bundle) {
  if (!bundle?.file) throw new Error("bundle.file is required");
  return canonicalize({
    file: bundle.file,
    types: sortBy(bundle.types, item => item.typeId),
    fields: sortBy(bundle.fields, item => item.fieldId),
    methods: sortBy(bundle.methods, item => item.methodId),
    edges: sortBy(bundle.edges, item => item.edgeId)
  });
}

export function digestFileBundle(bundle) {
  const json = JSON.stringify(canonicalizeFileBundle(bundle));
  return {
    relativePath: bundle.file.relativePath,
    sha256: createHash("sha256").update(json).digest("hex"),
    bytes: Buffer.byteLength(json)
  };
}

export function digestManifest(files) {
  const sorted = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = createHash("sha256");
  for (const file of sorted) hash.update(`${file.relativePath}:${file.sha256}\n`);
  return { fileCount: sorted.length, sha256: hash.digest("hex"), files: sorted };
}
