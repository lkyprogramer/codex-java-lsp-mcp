// input: LaunchAgent template, absolute runtime paths, and explicitly selected daemon environment entries.
// output: A fully escaped user LaunchAgent plist with no shell expansion at launch time.
// pos: Installer renderer for one fixed-port loopback daemon.
import { readFileSync, writeFileSync } from "node:fs";

const TEMPLATE_TOKENS = ["__LABEL__", "__RUNNER__", "__RUNTIME_DIR__", "__LOG_DIR__", "__ENVIRONMENT_ENTRIES__"];

export function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgent(template, values) {
  for (const token of TEMPLATE_TOKENS) {
    if (!template.includes(token)) throw new Error(`LaunchAgent template is missing ${token}.`);
  }
  for (const key of ["label", "runner", "runtimeDir", "logDir"]) {
    const value = values[key];
    if (typeof value !== "string" || !value || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Invalid LaunchAgent ${key}.`);
    }
  }
  const environment = values.environment instanceof Map ? values.environment : new Map(Object.entries(values.environment ?? {}));
  const entries = [...environment.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Invalid LaunchAgent environment entry: ${key}`);
    }
    return `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`;
  }).join("\n");
  return template
    .replaceAll("__LABEL__", xmlEscape(values.label))
    .replaceAll("__RUNNER__", xmlEscape(values.runner))
    .replaceAll("__RUNTIME_DIR__", xmlEscape(values.runtimeDir))
    .replaceAll("__LOG_DIR__", xmlEscape(values.logDir))
    .replaceAll("__ENVIRONMENT_ENTRIES__", entries);
}

export function parseArguments(args) {
  if (args.length < 6) {
    throw new Error("Usage: render-launch-agent-plist.mjs <template> <output> <label> <runner> <runtime-dir> <log-dir> <KEY=VALUE>...");
  }
  const [templatePath, outputPath, label, runner, runtimeDir, logDir, ...entries] = args;
  const environment = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid LaunchAgent environment argument: ${entry}`);
    environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return { templatePath, outputPath, values: { label, runner, runtimeDir, logDir, environment } };
}

function main(args) {
  const { templatePath, outputPath, values } = parseArguments(args);
  writeFileSync(outputPath, renderLaunchAgent(readFileSync(templatePath, "utf8"), values), { encoding: "utf8", mode: 0o600 });
}

if (process.argv[1]?.endsWith("render-launch-agent-plist.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error("[codex-java-lsp] could not render LaunchAgent plist", error);
    process.exitCode = 1;
  }
}
