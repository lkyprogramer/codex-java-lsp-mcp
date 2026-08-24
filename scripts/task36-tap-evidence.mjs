// input: Raw TAP emitted by `node --test` and the authority name pattern.
// output: Exact behavior-subtest results selected by that pattern.
// pos: Prevents Task 36 runners from mistaking Node's zero-test file wrapper for evidence.
export function selectedSubtests(output, pattern) {
  const matcher = new RegExp(pattern);
  const pendingByIndent = new Map();
  const results = [];
  for (const line of output.split(/\r?\n/)) {
    const header = /^(\s*)# Subtest: (.+)$/.exec(line);
    if (header) {
      pendingByIndent.set(header[1], header[2]);
      continue;
    }
    const result = /^(\s*)(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line);
    if (!result) continue;
    const name = pendingByIndent.get(result[1]);
    if (name === undefined) continue;
    pendingByIndent.delete(result[1]);
    if (!matcher.test(name)) continue;
    results.push({
      name,
      status: result[2].toLowerCase() === "ok" ? "passed" : "failed",
      ...(result[4] ? { directive: result[4].toUpperCase() } : {})
    });
  }
  return results;
}

export function selectedSubtestNames(output, pattern) {
  return selectedSubtests(output, pattern)
    .filter(result => result.status === "passed" && result.directive === undefined)
    .map(result => result.name);
}
