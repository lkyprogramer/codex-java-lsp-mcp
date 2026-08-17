// input: Existing stdio MCP JSON and the daemon's canonical ownership directory.
// output: Exit 0 only when an old stdio owner would use that same namespace.
// pos: Transport handoff guard; attestation cannot replace this machine check.
import path from "node:path";

export function effectiveStdioOwnershipBase(config, home = process.env.HOME) {
  if (config?.transport?.type !== "stdio") {
    return undefined;
  }
  if (!home || !path.isAbsolute(home)) {
    throw new Error("HOME must be an absolute path to evaluate stdio ownership.");
  }
  const env = config.transport.env;
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env))) {
    throw new Error("Existing stdio MCP environment must be an object.");
  }
  const values = env ?? {};
  const cacheBase = values.JAVA_LSP_CACHE_BASE === undefined
    ? path.join(home, "Library", "Caches", "codex-java-lsp")
    : normalizeConfiguredPath(values.JAVA_LSP_CACHE_BASE, home, "JAVA_LSP_CACHE_BASE");
  return values.JAVA_LSP_OWNERSHIP_BASE === undefined
    ? path.join(cacheBase, ".ownership")
    : normalizeConfiguredPath(values.JAVA_LSP_OWNERSHIP_BASE, home, "JAVA_LSP_OWNERSHIP_BASE");
}

export function assertStdioOwnershipHandoff(config, expectedOwnershipBase, home = process.env.HOME) {
  if (!path.isAbsolute(expectedOwnershipBase)) {
    throw new Error("Expected daemon ownership base must be absolute.");
  }
  const actual = effectiveStdioOwnershipBase(config, home);
  if (actual === undefined) {
    return;
  }
  if (actual !== path.resolve(expectedOwnershipBase)) {
    throw new Error(`Existing stdio MCP ownership base differs from the managed daemon (${actual} != ${path.resolve(expectedOwnershipBase)}). Reinstall or migrate the daemon with the same JAVA_LSP_OWNERSHIP_BASE before activation.`);
  }
}

function normalizeConfiguredPath(value, home, name) {
  if (typeof value !== "string" || !value) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  if (value === "~") return path.resolve(home);
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be absolute or start with ~/.`);
  }
  return path.resolve(value);
}

function main(args) {
  if (args.length !== 1) {
    throw new Error("Usage: verify-stdio-ownership-handoff.mjs <expected-ownership-base>");
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try {
      assertStdioOwnershipHandoff(JSON.parse(input), args[0]);
    } catch (error) {
      console.error("[codex-java-lsp] stdio ownership handoff check failed", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });
}

if (process.argv[1]?.endsWith("verify-stdio-ownership-handoff.mjs")) {
  main(process.argv.slice(2));
}
