import { realpath } from "node:fs/promises";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { parseJavaSourceFile } from "./java-index-file-parse.js";
import { createJavaParserBackend, type JavaParserBackend } from "./java-parser-backend.js";
import type { DiscoveredJavaFile } from "./manifest.js";
import { ParseTreeCache } from "./parse-tree-cache.js";
import type { SweepParsedFile, SweepWorkerRequest, SweepWorkerResponse } from "./java-index-sweep-protocol.js";

let repoRoot = "";
let resolvedRepoRoot = "";
let backend: JavaParserBackend | undefined;
let cache: ParseTreeCache | undefined;
let layout: LayoutContext | undefined;
let closing = false;

function respond(response: SweepWorkerResponse): void {
  parentPort?.postMessage(response);
}

async function parseChunk(files: DiscoveredJavaFile[], generation: number): Promise<SweepParsedFile[]> {
  if (!backend || !cache) throw new Error("sweep PARSE_CHUNK called before OPEN");
  const results: SweepParsedFile[] = [];
  for (const file of files) {
    if (closing) {
      results.push({ relativePath: file.relativePath, sourceRoot: file.sourceRoot, ok: false, error: "sweep worker closing" });
      continue;
    }
    try {
      const bundle = await parseJavaSourceFile({
        repoRoot,
        resolvedRepoRoot,
        inputPath: file.absolutePath,
        generation,
        backend,
        cache,
        layout
      });
      results.push({ relativePath: file.relativePath, sourceRoot: file.sourceRoot, ok: true, bundle });
    } catch (error) {
      results.push({
        relativePath: file.relativePath,
        sourceRoot: file.sourceRoot,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

async function handle(request: SweepWorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case "OPEN": {
        repoRoot = request.repoRoot;
        resolvedRepoRoot = await realpath(repoRoot).catch(() => path.resolve(repoRoot));
        backend = await createJavaParserBackend();
        cache = new ParseTreeCache();
        layout = probeLayout(repoRoot);
        respond({ id: request.id, ok: true, value: { type: "OPENED" } });
        return;
      }
      case "PARSE_CHUNK": {
        respond({
          id: request.id,
          ok: true,
          value: { type: "PARSED", files: await parseChunk(request.files, request.generation) }
        });
        return;
      }
      case "CLOSE": {
        closing = true;
        backend = undefined;
        cache = undefined;
        respond({ id: request.id, ok: true, value: { type: "CLOSED" } });
        return;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`unhandled sweep command: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    respond({
      id: request.id,
      ok: false,
      error: {
        code: "SWEEP_UNHANDLED",
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

parentPort?.on("message", (request: SweepWorkerRequest) => {
  if (request.type === "CLOSE") closing = true;
  void handle(request);
});
