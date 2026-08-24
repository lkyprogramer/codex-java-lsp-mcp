// input: One explicit loopback MCP URL and optional explicit repository root.
// output: Machine-readable HTTP initialize/tools/status smoke result.
// pos: Installer/doctor validation helper; never starts, stops, or registers a daemon.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type SmokeArguments = {
  url: URL;
  repoRoot?: string;
  projectId?: string;
  expectedBuildSha?: string;
  start: boolean;
};

const expectedTools = [
  "java_diagnostics",
  "java_impact",
  "java_runtime",
  "java_status",
  "java_symbol"
];

async function main(): Promise<void> {
  const options = parseSmokeArguments(process.argv.slice(2));
  assertLoopbackUrl(options.url);
  const client = new Client({ name: "codex-java-lsp-http-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(options.url);
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
      throw new Error(`Unexpected HTTP MCP tool list: ${tools.join(", ")}`);
    }
    const status = await client.callTool({ name: "java_status", arguments: {} });
    if (status.isError) {
      throw new Error(`java_status failed: ${toolText(status)}`);
    }
    const payload = JSON.parse(toolText(status)) as {
      server?: { transport?: string; buildSha?: string; state?: string };
    };
    if (payload.server?.transport !== "streamable_http") {
      throw new Error(`Unexpected MCP transport: ${payload.server?.transport ?? "missing"}`);
    }
    if (options.expectedBuildSha && payload.server?.buildSha !== options.expectedBuildSha) {
      throw new Error(`Unexpected daemon build SHA: ${payload.server?.buildSha ?? "missing"}`);
    }
    if (options.repoRoot || options.projectId) {
      const projectStatus = await client.callTool({
        name: "java_status",
        arguments: options.repoRoot
          ? { repoRoot: options.repoRoot, start: options.start }
          : { projectId: options.projectId, start: options.start }
      });
      if (projectStatus.isError) {
        throw new Error(`repo-scoped java_status failed: ${toolText(projectStatus)}`);
      }
      const projectPayload = JSON.parse(toolText(projectStatus)) as { started?: unknown; pid?: unknown };
      if (options.start && projectPayload.started !== true) {
        throw new Error("JDT LS did not start for the requested HTTP smoke repository.");
      }
      if (options.start && (!Number.isInteger(projectPayload.pid) || (projectPayload.pid as number) <= 0)) {
        throw new Error("JDT LS did not expose a PID for the requested HTTP smoke repository.");
      }
      const jdtlsPid = Number.isInteger(projectPayload.pid) ? projectPayload.pid as number : undefined;
      process.stdout.write(`${JSON.stringify({
        ok: true,
        url: options.url.href,
        tools,
        buildSha: payload.server?.buildSha,
        state: payload.server?.state,
        repoScoped: true,
        started: options.start,
        ...(jdtlsPid ? { jdtlsPid } : {})
      })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      url: options.url.href,
      tools,
      buildSha: payload.server?.buildSha,
      state: payload.server?.state,
      repoScoped: Boolean(options.repoRoot || options.projectId),
      started: options.start
    })}\n`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function parseSmokeArguments(args: string[]): SmokeArguments {
  let urlValue = process.env.JAVA_LSP_HTTP_URL;
  let repoRoot: string | undefined;
  let projectId: string | undefined;
  let expectedBuildSha: string | undefined;
  let start = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--url") urlValue = requiredValue(args, ++index, value);
    else if (value === "--repo-root") repoRoot = requiredValue(args, ++index, value);
    else if (value === "--project-id") projectId = requiredValue(args, ++index, value);
    else if (value === "--expect-build") expectedBuildSha = requiredValue(args, ++index, value);
    else if (value === "--start") start = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!urlValue) throw new Error("--url or JAVA_LSP_HTTP_URL is required.");
  if (repoRoot && projectId) throw new Error("--repo-root and --project-id are mutually exclusive.");
  return { url: new URL(urlValue), repoRoot, projectId, expectedBuildSha, start };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function assertLoopbackUrl(url: URL): void {
  if (url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.pathname !== "/mcp"
    || url.search
    || url.hash
    || url.username
    || url.password) {
    throw new Error(`HTTP smoke only accepts an exact loopback /mcp URL: ${url.href}`);
  }
}

function toolText(result: unknown): string {
  const payload = result as { content?: Array<{ type?: string; text?: string }> };
  const content = payload.content?.[0];
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected one text MCP tool result.");
  }
  return content.text;
}

if (process.argv[1]?.endsWith("/smoke-http.js")) {
  main().catch(error => {
    console.error("[codex-java-lsp] HTTP smoke failed", error);
    process.exitCode = 1;
  });
}
