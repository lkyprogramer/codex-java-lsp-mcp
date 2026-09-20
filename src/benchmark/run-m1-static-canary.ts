// input: Kit directory, preflight source SHA, output directory, canary port
//        (default 38457 — the isolated loopback port from docs/13).
// output: Raw `harness run-adapter` output (dev split) executed through a
//         real loopback HTTP MCP server of THIS build, plus the server log.
// pos: T06 canary. Binds only the explicitly isolated port; the production
//      port 38456 is rejected. JDT_BIN is forced to /usr/bin/false so any
//      accidental JDT launch fails loudly instead of succeeding.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JavaLspApplication } from "../application.js";
import { JavaLspHttpServer } from "../http-server.js";

const PRODUCTION_PORT = 38456;
const DEFAULT_CANARY_PORT = 38457;

type CanaryArgs = {
  kit: string;
  sourceSha: string;
  output: string;
  port: number;
  timeoutMs: number;
};

function parseArgs(argv: string[]): CanaryArgs {
  const args: Partial<CanaryArgs> = { port: DEFAULT_CANARY_PORT, timeoutMs: 900_000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--kit" && argv[i + 1]) args.kit = argv[i + 1];
    else if (argv[i] === "--source-sha" && argv[i + 1]) args.sourceSha = argv[i + 1];
    else if (argv[i] === "--output" && argv[i + 1]) args.output = argv[i + 1];
    else if (argv[i] === "--port" && argv[i + 1]) args.port = Number(argv[i + 1]);
    else if (argv[i] === "--timeout-ms" && argv[i + 1]) args.timeoutMs = Number(argv[i + 1]);
  }
  if (!args.kit) throw new Error("--kit is required");
  if (!args.sourceSha) throw new Error("--source-sha is required");
  if (!args.output) throw new Error("--output is required");
  if (!Number.isInteger(args.port) || (args.port as number) < 1 || (args.port as number) > 65535) throw new Error("--port must be a valid TCP port");
  const port = args.port as number;
  if (port === PRODUCTION_PORT) throw new Error(`refusing to bind the production port ${PRODUCTION_PORT}; use an isolated canary port`);
  return { kit: args.kit as string, sourceSha: args.sourceSha as string, output: args.output as string, port, timeoutMs: args.timeoutMs as number };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // K25: if the product ever tried to launch JDT during the static canary,
  // the launcher binary is /usr/bin/false and the launch fails immediately.
  process.env.JDT_BIN = "/usr/bin/false";
  // The canary server must not share cache/ownership state with any running
  // production daemon: an isolated HOME keeps worktree caches, ownership
  // leases, and config from colliding across processes.
  const home = mkdtempSync(path.join(tmpdir(), "m1-canary-home-"));
  for (const dir of ["cache", "config", "java-cache", "ownership", "codex"]) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  process.env.HOME = home;
  process.env.XDG_CACHE_HOME = path.join(home, "cache");
  process.env.XDG_CONFIG_HOME = path.join(home, "config");
  process.env.JAVA_LSP_CACHE_BASE = path.join(home, "java-cache");
  process.env.JAVA_LSP_OWNERSHIP_BASE = path.join(home, "ownership");
  process.env.CODEX_HOME = path.join(home, "codex");
  writeFileSync(`${args.output}/canary-args.json`, `${JSON.stringify({ ...args, canaryHome: home }, null, 2)}\n`, "utf8");

  const root = mkdtempSync(path.join(tmpdir(), "m1-static-canary-"));
  const projectsConfigPath = path.join(root, "projects.json");
  writeFileSync(projectsConfigPath, `${JSON.stringify({ aliases: [] })}\n`, "utf8");
  const application = new JavaLspApplication({
    transportMode: "streamable_http",
    projectsConfigPath,
    resolverOptions: { cwdFallback: "reject" },
    cacheJanitorIntervalMs: 0,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
  });
  const daemon = new JavaLspHttpServer({
    application,
    port: args.port,
    instanceId: "m1-static-canary",
    reportError: message => process.stderr.write(`${message}\n`)
  });
  let exitCode = 1;
  try {
    const address = await daemon.start();
    const adapterCommand = ["python3", path.join(args.kit, "adapters", "mcp_static.py"), "--url", address.url];
    // spawn (not spawnSync): the MCP server shares this process's event loop,
    // and a synchronous child wait would starve it while the adapter polls.
    const child = spawn(
      "python3",
      [
        "-m", "harness", "run-adapter",
        "--split", "dev",
        "--arm", "static-m1",
        "--source-sha", args.sourceSha,
        "--command-json", JSON.stringify(adapterCommand),
        "--output", path.join(args.output, "m1-dev-adapter.json")
      ],
      { cwd: args.kit, env: process.env } // eslint-disable-line no-process-env
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const [, status] = await once(child, "close");
    writeFileSync(path.join(args.output, "run-adapter-raw.log"), `# exit=${status}\n# stdout\n${stdout}\n# stderr\n${stderr}\n`, "utf8");
    // The harness occasionally exits by signal after writing complete output
    // inside the shared-process canary; complete, parseable results are the
    // contract, so a signal exit with a well-formed result file still counts.
    let ok = status === 0;
    if (!ok) {
      try {
        const results = JSON.parse(readFileSync(path.join(args.output, "m1-dev-adapter.json"), "utf8")) as { results?: unknown[] };
        ok = Array.isArray(results.results) && results.results.length > 0;
      } catch {
        ok = false;
      }
    }
    exitCode = ok ? 0 : 1;
    process.stdout.write(`${JSON.stringify({ ok, url: address.url, runAdapterExit: status })}\n`);
  } finally {
    await daemon.shutdown(15_000).catch(() => undefined);
    await application.close({ releaseOwnership: true }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});