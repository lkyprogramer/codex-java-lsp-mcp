// input: Unresolved dispatch obligations plus JDT availability.
// output: Whether bounded JDT verify should run. Writes nothing when JDTLS_BIN is false.
// pos: N3-03. Cold-nolsp must take the skip branch.

export function shouldEscalateToJdt(input: {
  unresolvedRoles: readonly string[];
  jdtlsBin?: string;
}): boolean {
  if (!input.unresolvedRoles.includes("type-closure") && !input.unresolvedRoles.includes("implementers")) return false;
  const bin = input.jdtlsBin ?? process.env.JDTLS_BIN ?? "";
  if (!bin || bin === "/usr/bin/false") return false;
  return true;
}
