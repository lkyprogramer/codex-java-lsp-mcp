// input: `codex mcp get --json` output for the existing named stdio registration.
// output: An executable, shell-escaped command that restores only that MCP registration.
// pos: Activation rollback artifact; never reads or overwrites the whole Codex config.toml.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function renderStdioRollback(configuration) {
  const name = configuration?.name;
  const transport = configuration?.transport;
  if (typeof name !== "string" || !name) throw new Error("MCP backup is missing name.");
  if (transport?.type !== "stdio" || typeof transport.command !== "string" || !transport.command) {
    throw new Error("Only an existing stdio MCP registration can be restored by this rollback script.");
  }
  const args = Array.isArray(transport.args) ? transport.args : [];
  if (!args.every(value => typeof value === "string")) throw new Error("MCP backup contains a non-string stdio argument.");
  const env = transport.env && typeof transport.env === "object" && !Array.isArray(transport.env) ? transport.env : {};
  const envEntries = Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
  if (!envEntries.every(([key, value]) => typeof key === "string" && key && typeof value === "string")) {
    throw new Error("MCP backup contains an invalid stdio environment entry.");
  }
  const lines = [
    "#!/usr/bin/env bash",
    "# Generated from codex mcp get --json before HTTP activation.",
    "set -euo pipefail",
    `server_name=${shellQuote(name)}`,
    'codex_bin="${CODEX_BIN:-codex}"',
    '"$codex_bin" mcp remove "$server_name" >/dev/null 2>&1 || true',
    'command=(mcp add "$server_name")'
  ];
  for (const [key, value] of envEntries) lines.push(`command+=(--env ${shellQuote(`${key}=${value}`)})`);
  lines.push(`command+=(-- ${[transport.command, ...args].map(shellQuote).join(" ")})`);
  lines.push('"$codex_bin" "${command[@]}"');
  lines.push("");
  return lines.join("\n");
}

export function renderHttpRollback(name, url) {
  if (typeof name !== "string" || !name) throw new Error("HTTP rollback is missing MCP name.");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("HTTP rollback requires a valid MCP URL.");
  }
  if (parsed.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || parsed.pathname !== "/mcp"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password) {
    throw new Error("HTTP rollback requires an exact loopback /mcp URL.");
  }
  return [
    "#!/usr/bin/env bash",
    "# Generated for reverse recovery after a failed stdio rollback.",
    "set -euo pipefail",
    `server_name=${shellQuote(name)}`,
    `server_url=${shellQuote(parsed.href)}`,
    'codex_bin="${CODEX_BIN:-codex}"',
    '"$codex_bin" mcp remove "$server_name" >/dev/null 2>&1 || true',
    '"$codex_bin" mcp add "$server_name" --url "$server_url"',
    ""
  ].join("\n");
}

export function writeStdioRollback(inputPath, outputPath) {
  const configuration = JSON.parse(readFileSync(inputPath, "utf8"));
  const rendered = renderStdioRollback(configuration);
  writeFileSync(outputPath, rendered, { encoding: "utf8", mode: 0o700 });
  chmodSync(outputPath, 0o700);
}

export function writeHttpRollback(name, url, outputPath) {
  writeFileSync(outputPath, renderHttpRollback(name, url), { encoding: "utf8", mode: 0o700 });
  chmodSync(outputPath, 0o700);
}

function main(args) {
  if (args[0] === "--http") {
    if (args.length !== 4) throw new Error("Usage: write-mcp-rollback.mjs --http <name> <url> <rollback.sh>");
    writeHttpRollback(args[1], args[2], path.resolve(args[3]));
    return;
  }
  if (args.length !== 2) throw new Error("Usage: write-mcp-rollback.mjs <backup.json> <rollback.sh>");
  writeStdioRollback(path.resolve(args[0]), path.resolve(args[1]));
}

if (process.argv[1]?.endsWith("write-mcp-rollback.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("[codex-java-lsp] could not generate stdio rollback command", error);
    process.exitCode = 1;
  }
}
