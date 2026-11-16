#!/usr/bin/env node
// input: the Node executable running this script, on macOS.
// output: an ilv2-mac-runtime/v1 manifest on stdout that verifyRuntime (ilv2-mac-contracts.mjs) accepts.
// pos: CI only (.github/workflows/gates.yml). The owner's Mac freezes its runtime once under the work root;
//      a hosted runner has a fresh Node each job, so it records the one it was given. This proves the code,
//      not the production runtime's identity.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
if (process.platform !== "darwin") throw new Error("ci-runtime-manifest: macOS runner required");
const manifest = {
  schema: "ilv2-mac-runtime/v1",
  execPath: process.execPath,
  nodeRealpath: await realpath(process.execPath),
  nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
  arch: process.arch,
  versions: { ...process.versions },
  os: (await exec("/usr/bin/sw_vers", [])).stdout,
  // build-macos-native.mjs refuses a compiler whose --version differs from the frozen one.
  clang: (await exec("/usr/bin/clang", ["--version"])).stdout
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
