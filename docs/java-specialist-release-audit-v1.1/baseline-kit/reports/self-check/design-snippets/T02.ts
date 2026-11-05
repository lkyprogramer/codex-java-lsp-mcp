export function scopedNamedTypeId(relativePath: string, fqn: string): string {
  const p = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.includes("\0") || p.includes(":") ||
      p.split("/").some(s => !s || s === "." || s === "..")) {
    throw new Error("invalid repo-relative path");
  }
  if (!fqn) throw new Error("named type requires FQN");
  return `type:v2:${encodeURIComponent(p)}#${encodeURIComponent(fqn)}`;
}