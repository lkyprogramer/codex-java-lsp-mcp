// input: A `codex mcp get <name> --json` document.
// output: Whitelisted project-JDK environment entries from its stdio transport.
// pos: Migration boundary; only supported JDK overrides cross stdio -> daemon.

const PROJECT_JDK_ENV = /^JAVA_LSP_PROJECT_JAVA_HOME(?:_[A-Z0-9_]+)?$/;

export function extractStdioProjectJdkEnv(config) {
  if (config?.transport?.type !== "stdio") {
    return new Map();
  }
  const env = config.transport.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return new Map();
  }
  const result = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (!PROJECT_JDK_ENV.test(key)) continue;
    if (typeof value !== "string" || !value || /[\r\n\t]/.test(value)) {
      throw new Error(`Unsupported stdio project JDK environment value: ${key}`);
    }
    result.set(key, value);
  }
  return result;
}

export function renderProjectJdkEnv(config) {
  return [...extractStdioProjectJdkEnv(config).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\t${value}`)
    .join("\n");
}

function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try {
      const rendered = renderProjectJdkEnv(JSON.parse(input));
      if (rendered) process.stdout.write(`${rendered}\n`);
    } catch (error) {
      console.error("[codex-java-lsp] could not extract stdio project JDK overrides", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });
}

if (process.argv[1]?.endsWith("extract-stdio-project-jdk-env.mjs")) {
  main();
}
