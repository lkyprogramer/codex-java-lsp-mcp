#!/usr/bin/env node
// input: live daemon with a warm hot-set pin (lishuedu). Avoids D3c on-demand hydrate.
// output: JSON with short-deadline then retry timings for D4.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";

const port = process.env.JAVA_LSP_HTTP_PORT ?? "38456";
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const outPath = process.argv[2] ?? "docs/phase-d/d4-clean.json";
const file = "/Users/luo/Documents/program/lishu/lishuedu/apps/lishu-edu-app/src/main/java/com/lishu/edu/LishuEduApiApplication.java";

function toolText(result) {
  return (result.content ?? []).map(part => part.text ?? "").join("");
}

async function call(client, args) {
  const t0 = performance.now();
  const result = await client.callTool({
    name: "java_impact",
    arguments: {
      projectId: "lishuedu",
      anchors: [{ file, line: 1, column: 1 }],
      mode: "balanced",
      semanticPolicy: "auto",
      ...args
    }
  });
  return {
    elapsedMs: performance.now() - t0,
    isError: Boolean(result.isError),
    text: toolText(result)
  };
}

const client = new Client({ name: "d4-clean-probe", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url));
const warmup = await call(client, {});
const shortCall = await call(client, { deadlineMs: 1500 });
const retry = await call(client, {});
await client.close().catch(() => undefined);

const payload = {
  schema: "d4-clean/v1",
  pin: "lishuedu",
  warmupMs: warmup.elapsedMs,
  warmupError: warmup.isError,
  shortElapsedMs: shortCall.elapsedMs,
  shortError: shortCall.isError,
  retryElapsedMs: retry.elapsedMs,
  retryError: retry.isError,
  result: !retry.isError && retry.elapsedMs <= 500 && !warmup.isError ? "PASS" : "FAIL"
};
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.result === "PASS" ? 0 : 1);
