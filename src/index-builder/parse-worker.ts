// input: { id, args } messages from parseOffThread: parseJavaSourceFile's arguments without backend/cache.
// output: { id, bundle }, or { id, error, code } when the parse threw.
// pos: a delta builder's parse off its main thread. Extraction walks the tree through the native
//      binding, about 13 ms a file: a 191-file seed spent 2.6 s of a 14.3 s job parsing serially.
import { parentPort } from "node:worker_threads";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../java-index/builder/parse-cache.js";
import type { ParseArgs } from "./parse-pool.js";

const backend = createJavaParserBackend();
const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });

parentPort!.on("message", async (input: { id: number; args: ParseArgs }) => {
  try {
    const { capture } = input.args;
    // Structured clone delivers a Buffer as a plain Uint8Array.
    const bytes = capture && Buffer.from(capture.bytes.buffer, capture.bytes.byteOffset, capture.bytes.byteLength);
    const bundle = await parseJavaSourceFile({ ...input.args, ...(capture ? { capture: { ...capture, bytes: bytes! } } : {}), backend: await backend, cache });
    cache.delete(bundle.file.relativePath);
    parentPort!.postMessage({ id: input.id, bundle });
  } catch (error) {
    parentPort!.postMessage({ id: input.id, error: error instanceof Error ? error.message : String(error), code: (error as NodeJS.ErrnoException).code });
  }
});
