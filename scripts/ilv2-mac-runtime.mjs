#!/usr/bin/env node
import { isMain, runCli, verifyRuntime } from "./ilv2-mac-contracts.mjs";

if (isMain(import.meta.url)) runCli(async () => {
  if (!["--verify", "--identity"].includes(process.argv[2]) || process.argv.length !== 3) throw new Error("expected --verify or --identity");
  const identity = await verifyRuntime();
  if (process.argv[2] === "--identity") console.log(JSON.stringify(identity));
});
