import os from "node:os";
import path from "node:path";
import { requireValue, resolvedPath } from "./ilv2-mac-contracts.mjs";

export function formalTarget() {
  const home = os.userInfo().homedir;
  const runtime = path.join(home, "Library/Application Support/codex-java-lsp-ilv2");
  const cache = path.join(home, "Library/Caches/codex-java-lsp-ilv2");
  const label = "com.lky.codex-java-lsp-ilv2";
  return {
    home, runtime, cache, label, port: "38456",
    ownership: path.join(cache, ".ownership"),
    plist: path.join(home, "Library/LaunchAgents", label + ".plist"),
    logs: path.join(home, "Library/Logs/codex-java-lsp-ilv2"),
    projects: path.join(home, ".config/codex-java-lsp/projects.json"),
    gradleHome: path.join(runtime, "state/jdt-gradle-home")
  };
}

export async function requireFormalPath(expected, actual) {
  requireValue(actual === expected && await resolvedPath(actual) === expected,
    "formal installation path must be canonical: " + expected);
}
