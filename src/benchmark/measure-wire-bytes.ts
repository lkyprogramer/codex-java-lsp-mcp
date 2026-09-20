// input: Staged repos (default: the 24 M1 dev stages), one isolated
//         streamable-HTTP MCP server per repo (canary-style: private loopback
//         port, JDT_BIN=/usr/bin/false, isolated HOME set by the runner).
// output: Wire-byte measurement of the java_symbol payload with and without
//         the byte-exact source preview. M2-1 (locator batching) and any
//         preview size policy need measured motivation, not taste.
// pos: M2 T08 step 5 - signature vs preview wire bytes on the real corpus.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { JavaLspApplication } from "../application.js";
import { JavaLspHttpServer } from "../http-server.js";

type WireRow = {
  task_id: string;
  status: string;
  candidates?: number;
  previews?: number;
  wire_full_bytes?: number;
  wire_stripped_bytes?: number;
  preview_bytes?: number;
  stopReason?: string;
  truncated?: boolean;
  droppedUnlocatable?: number;
  error?: string;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback?: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const stageRoot = flag("--stage-root", "/Users/luo/Documents/github/java-devkit-v1-runs/m1/m1-quality/stage")!;
  const output = flag("--output", "/Users/luo/Documents/github/java-devkit-v1-runs/m2/wire-bytes.json")!;
  const portBase = Number(flag("--port-base", "38561"));
  if (portBase === 38456) throw new Error("refusing to bind the production port 38456");
  process.env.JDT_BIN = "/usr/bin/false";
  process.env.JDTLS_BIN = "/usr/bin/false";

  const taskIds = (await readdir(stageRoot)).sort();
  const rows: WireRow[] = [];
  let port = portBase;
  for (const taskId of taskIds) {
    const staged = path.join(stageRoot, taskId);
    const repo = path.join(staged, "repo");
    let query = "";
    try {
      const task = JSON.parse(await readFile(path.join(staged, "task.json"), "utf8")) as { query?: string; prompt?: string };
      query = task.query ?? task.prompt ?? "";
    } catch {
      rows.push({ task_id: taskId, status: "NO_TASK" });
      continue;
    }
    if (!query) {
      rows.push({ task_id: taskId, status: "NO_QUERY" });
      continue;
    }
    const root = await mkdtemp(path.join(tmpdir(), `wire-${taskId}-`));
    const projectsConfigPath = path.join(root, "projects.json");
    await (await import("node:fs/promises")).writeFile(projectsConfigPath, `${JSON.stringify({ aliases: [] })}\n`, "utf8");
    const application = new JavaLspApplication({
      transportMode: "streamable_http",
      projectsConfigPath,
      resolverOptions: { cwdFallback: "reject" },
      cacheJanitorIntervalMs: 0,
      cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] })
    });
    const daemon = new JavaLspHttpServer({
      application,
      port,
      instanceId: `wire-measure-${taskId}`,
      reportError: message => process.stderr.write(`${message}\n`)
    });
    let payload: { schemaVersion?: string; candidates?: Array<Record<string, unknown>>; scopeState?: string; stopReason?: string; truncated?: boolean; droppedUnlocatable?: number } | null = null;
    let status = "OK";
    let error: string | undefined;
    try {
      const address = await daemon.start();
      const client = new Client({ name: "wire-bytes-measure", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(address.url));
      await client.connect(transport);
      let lastError: unknown;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          const result = await client.callTool({
            name: "java_symbol",
            arguments: { repoRoot: repo, query }
          }, undefined, { timeout: 30000 });
          const content = (result as { content?: unknown }).content;
          const text = Array.isArray(content)
            ? content
              .map((part: unknown) => {
                const block = part as { text?: unknown } | null;
                return typeof block?.text === "string" ? block.text : "";
              })
              .join("\n")
            : "";
          const payloadText = text.trim().length > 0 ? text : "{}";
          payload = JSON.parse(payloadText);
          break;
        } catch (err) {
          lastError = err;
          if (attempt === 59) {
            status = "FAIL";
            error = String((lastError as Error | undefined)?.message ?? lastError).slice(0, 200);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      await client.close().catch(() => undefined);
    } catch (err) {
      status = "FAIL";
      error = String((err as Error | undefined)?.message ?? err).slice(0, 200);
    } finally {
      await daemon.shutdown(15_000).catch(() => undefined);
      await application.close({ releaseOwnership: true }).catch(() => undefined);
      port += 1;
    }
    if (!payload || payload.schemaVersion !== "java-discovery/v1") {
      rows.push({ task_id: taskId, status, ...(error ? { error } : {}) });
      continue;
    }
    const candidates = payload.candidates ?? [];
    let fullBytes = 0;
    let strippedBytes = 0;
    let previews = 0;
    for (const candidate of candidates) {
      fullBytes += Buffer.byteLength(JSON.stringify(candidate), "utf8");
      const stripped = { ...candidate };
      if (stripped.previewKind === "source" && typeof stripped.preview === "string") {
        previews += 1;
        delete stripped.preview;
        delete stripped.previewKind;
        delete stripped.evidenceRange;
      }
      strippedBytes += Buffer.byteLength(JSON.stringify(stripped), "utf8");
    }
    const wireFull = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const wireStripped = wireFull - fullBytes + strippedBytes;
    rows.push({
      task_id: taskId,
      status: payload.scopeState ?? "OK",
      candidates: candidates.length,
      previews,
      wire_full_bytes: wireFull,
      wire_stripped_bytes: wireStripped,
      preview_bytes: wireFull - wireStripped,
      stopReason: payload.stopReason,
      truncated: payload.truncated,
      droppedUnlocatable: payload.droppedUnlocatable
    });
  }
  const totals = rows.reduce((acc, row) => ({
    candidates: acc.candidates + (row.candidates ?? 0),
    previews: acc.previews + (row.previews ?? 0),
    wireFull: acc.wireFull + (row.wire_full_bytes ?? 0),
    wireStripped: acc.wireStripped + (row.wire_stripped_bytes ?? 0)
  }), { candidates: 0, previews: 0, wireFull: 0, wireStripped: 0 });
  const summary = {
    note: "M2-1 motivation: java_symbol wire bytes with vs without the byte-exact source preview, measured live on the staged M1 dev repos (canary-style isolated streamable-HTTP servers, JDT_BIN=/usr/bin/false)",
    stageRoot,
    rows,
    totals: {
      tasks: rows.length,
      candidates: totals.candidates,
      previews: totals.previews,
      wire_full_bytes: totals.wireFull,
      wire_stripped_bytes: totals.wireStripped,
      preview_bytes: totals.wireFull - totals.wireStripped,
      preview_fraction_of_wire: totals.wireFull > 0 ? (totals.wireFull - totals.wireStripped) / totals.wireFull : 0
    }
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(summary, null, 1)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(summary.totals, null, 1)}\n`);
}

main().catch(err => {
  process.stderr.write(`${String(err?.stack ?? err)}\n`);
  process.exit(1);
});