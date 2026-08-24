#!/usr/bin/env node
// input: Optional spawn hooks. Two install paths only: uvx git+serena, or an already-present pip package.
// output: READY with SERENA_MCP_COMMAND, or SERENA_ABANDONED. Never installs into git.
// pos: E4. Live kill criterion becomes old/jin paired hit-rate when abandoned.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const SERENA_UVX_FROM = "git+https://github.com/oraios/serena";
export const SERENA_UVX_ARGS = ["--from", SERENA_UVX_FROM, "serena-mcp-server", "--help"];
export const SERENA_PIP_PACKAGES = Object.freeze(["serena-mcp-server", "serena"]);

export async function probeSerenaMcp({
  execFileImpl = execFileAsync,
  uvxTimeoutMs = 45_000,
  pipTimeoutMs = 15_000,
  env = process.env
} = {}) {
  const attempts = [];
  const uvx = await tryExec(execFileImpl, "uvx", SERENA_UVX_ARGS, uvxTimeoutMs, env);
  attempts.push({
    method: "uvx",
    command: `uvx ${SERENA_UVX_ARGS.join(" ")}`,
    ok: uvx.ok,
    error: uvx.error
  });
  if (uvx.ok) {
    return {
      status: "READY",
      command: `uvx --from ${SERENA_UVX_FROM} serena-mcp-server`,
      attempts
    };
  }
  for (const pkg of SERENA_PIP_PACKAGES) {
    const pip = await tryExec(execFileImpl, "python3", ["-m", "pip", "show", pkg], pipTimeoutMs, env);
    attempts.push({
      method: "pip",
      package: pkg,
      command: `python3 -m pip show ${pkg}`,
      ok: pip.ok,
      error: pip.error
    });
    if (pip.ok) {
      return {
        status: "READY",
        command: `python3 -m ${pkg}`,
        attempts
      };
    }
  }
  return {
    status: "SERENA_ABANDONED",
    command: null,
    killCriterion: "old-jin-paired-hit-rate",
    attempts
  };
}

async function tryExec(execFileImpl, file, args, timeout, env) {
  try {
    await execFileImpl(file, args, { timeout, env, encoding: "utf8" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 500) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  probeSerenaMcp().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "SERENA_ABANDONED") process.exitCode = 3;
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
