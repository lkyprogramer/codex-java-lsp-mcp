// input: a repository root and a private cache directory.
// output: a RouterJavaIndex over a mutable development index database built by one-shot builders.
// pos: Tests, benchmarks and offline tools only (MAC-08B removed RouterJavaIndex.create). The
//      production call graph reads sealed snapshots through the daemon's IndexOwner instead.
import path from "node:path";
import { RouterJavaIndex } from "../agent-router/java-index-router.js";
import { repoCacheRoot } from "../repo-layout.js";
import type { JavaIndexOpenOptions } from "./java-index-client-api.js";
import { LocalBuilder } from "./local-builder.js";
import { SqlJavaIndexClient } from "./sql/sql-client.js";

export function localRouterIndex(repoRoot: string, cacheDir = repoCacheRoot(repoRoot), openOptions: JavaIndexOpenOptions = {}): RouterJavaIndex {
  const dbPath = path.join(cacheDir, "index.sqlite");
  return new RouterJavaIndex(repoRoot, new SqlJavaIndexClient(repoRoot, dbPath, new LocalBuilder({ repoRoot, dbPath })), openOptions);
}
