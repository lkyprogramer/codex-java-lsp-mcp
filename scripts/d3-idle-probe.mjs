#!/usr/bin/env node
// input: live daemon at JAVA_LSP_HTTP_PORT after index-idle has had time to fire.
// output: JSON with per-pin first java_impact elapsedMs/isError for D3-idle.
// pos: §9.4 D3-idle — omit deadlineMs so hot uses default 3s and cold uses S5 15s.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { writeFileSync } from "node:fs";

const port = process.env.JAVA_LSP_HTTP_PORT ?? "38456";
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const outPath = process.argv[2];

const pins = {
  lishuedu: {
    projectId: "lishuedu",
    hot: true,
    file: "/Users/luo/Documents/program/lishu/lishuedu/apps/lishu-edu-app/src/main/java/com/lishu/edu/LishuEduApiApplication.java"
  },
  "lishu-v2": {
    projectId: "lishu-v2",
    hot: true,
    file: "/Users/luo/Documents/program/lishu-v2/apps/lishu-education-backend/src/main/java/com/lishu/edu/education/LishuEducationBackendApplication.java"
  },
  cipherlink: {
    projectId: "cipherlink",
    hot: false,
    file: "/Users/luo/Documents/program/cipherlink/apps/cipherlink-backend/src/main/java/com/hhtele/cipherlink/backend/CipherlinkBackendApplication.java"
  },
  "exam-parent-v3": {
    projectId: "exam-parent-v3",
    hot: false,
    file: "/Users/luo/Documents/program/exam-parent-v3/exam-management/src/main/java/com/hhtele/exam/management/ExamManagementApplication.java"
  }
};

function toolText(result) {
  return (result.content ?? []).map(part => part.text ?? "").join("");
}

async function call(client, name, args) {
  const t0 = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const text = toolText(result);
  return {
    elapsedMs: performance.now() - t0,
    isError: Boolean(result.isError),
    text
  };
}

const client = new Client({ name: "d3-idle-probe", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url));
const impacts = {};
for (const [id, pin] of Object.entries(pins)) {
  const first = await call(client, "java_impact", {
    projectId: pin.projectId,
    anchors: [{ file: pin.file, line: 1, column: 1 }],
    mode: "balanced",
    semanticPolicy: "auto"
  });
  const gateMs = pin.hot ? 3000 : 15000;
  const warming = /warming after idle close/.test(first.text);
  impacts[id] = {
    hot: pin.hot,
    elapsedMs: first.elapsedMs,
    isError: first.isError,
    warming,
    errorText: first.isError ? first.text.slice(0, 240) : "",
    pass: !first.isError && first.elapsedMs <= gateMs
  };
}
await client.close().catch(() => undefined);

const hotPass = Object.values(impacts).filter(row => row.hot).every(row => row.pass);
const coldPass = Object.values(impacts).filter(row => !row.hot).every(row => row.pass);
const payload = {
  schema: "d3-idle/v1",
  impacts,
  result: hotPass && coldPass ? "PASS" : "FAIL"
};
if (outPath) writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload, null, 2));
process.exit(payload.result === "PASS" ? 0 : 1);
