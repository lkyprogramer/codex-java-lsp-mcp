// Synthetic transport fixture. Contains no business source or expected gold.
import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const port = Number(process.argv[2]);
const behavior = process.argv[3] ?? "correct";
const identity = { ...JSON.parse(process.env.ILV2_EXPECTED_IDENTITY), pid: process.pid };
if (behavior === "descendant") {
  const descendant = spawn(process.execPath, [fileURLToPath(new URL("./stubborn-descendant.mjs", import.meta.url))], { stdio: "ignore", env: { PATH: process.env.PATH } });
  identity.descendantPid = descendant.pid;
}
let barrier = null;
let queryCount = 0;
let prewarmCount = 0;
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const parameters = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  const operation = request.url.slice(1);
  requests.push({ operation, parameters });
  await appendFile("requests.jsonl", `${JSON.stringify({ operation, parameters })}\n`);
  let result;
  if (operation === "identity") result = identity;
  else if (operation === "exit") { response.end('{}'); setImmediate(() => process.exit(0)); return; }
  else if (operation === "status") result = { status: "OK", queryCount, prewarmCount, start: parameters.start, requests };
  else if (operation === "prewarm") { prewarmCount += 1; result = { status: "OK" }; }
  else if (operation === "query") {
    queryCount += 1;
    if (behavior === "hang") return;
    result = { status: barrier ? "NOT_READY" : "OK", workspaceId: behavior === "wrong-workspace" ? "fixture-other" : "fixture-w1",
      sourceHash: behavior === "wrong-hash" ? "wrong" : "fixture-source-hash", snapshotId: "fixture-snapshot", token: "fresh-token" };
  } else if (operation === "barrier-arm") { barrier = parameters.phase; result = { phase: barrier, blocked: true, pid: process.pid }; }
  else if (operation === "barrier-wait") result = { phase: barrier, blocked: Boolean(barrier), pid: process.pid };
  else if (operation === "barrier-release") { const phase = barrier; barrier = null; result = { phase, blocked: false, pid: process.pid }; }
  else { response.writeHead(404).end(); return; }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(result));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
