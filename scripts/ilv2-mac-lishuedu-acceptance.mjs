#!/usr/bin/env node
// Run under the sealed native owner. The enclosing fixture supervisor owns its quota and process group.
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cliOptions, isMain, managedPath, readJson, requireUnprotectedRoot, requireValue, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyPreparedLishuedu } from "./ilv2-mac-lishuedu-preparation.mjs";

const sourceFile = "apps/lishu-edu-app/src/main/java/com/lishu/edu/config/flyway/LishuFlywayOrchestrator.java";
const fqn = "com.lishu.edu.config.flyway.LishuFlywayOrchestrator";

function anchor(source, phrase) {
  const matches = source.split("\n").flatMap((line, index) => line.includes(phrase)
    ? [{ file: sourceFile, line: index + 1, column: line.indexOf("initialize", line.indexOf(phrase)) + 1 }] : []);
  requireValue(matches.length === 1 && matches[0].column > 0, "lishuedu semantic source anchor changed: " + phrase);
  return matches[0];
}

async function accept({ result, repo, deadline }) {
  const { assertOwnerLock, ownerCacheRoot } = await import("../dist/mac-platform/owner-lock.js");
  const root = process.env.ILV2_RUN_ROOT;
  requireValue(process.env.JAVA_LSP_ISOLATED_VALIDATION === "1" && root && await realpath(root) === root
    && (await readFile(path.join(root, "run-root.txt"), "utf8")).trim() === root, "registered isolated acceptance root required");
  requireUnprotectedRoot(root, "lishuedu acceptance");
  const cache = ownerCacheRoot();
  requireValue(cache && cache === process.env.JAVA_LSP_CACHE_BASE && await managedPath(root, cache) === cache, "isolated native owner binding required");
  assertOwnerLock();
  for (const file of [result, repo, process.env.HOME, process.env.GRADLE_USER_HOME, process.env.JAVA_LSP_SERVICE_STATE_ROOT,
    process.env.JAVA_LSP_OWNERSHIP_BASE, process.env.JAVA_LSP_PROJECTS_JSON, process.env.JAVA_LSP_GRADLE_DISTRIBUTIONS]) {
    requireValue(file && await managedPath(root, file) === file, "acceptance paths must belong to the isolated run");
  }
  const { jdtGradleHome } = await import("../dist/mac-platform/gradle-domain.js");
  requireValue(jdtGradleHome() === process.env.GRADLE_USER_HOME, "JDT must use the prepared Gradle home");
  const projects = await readJson(process.env.JAVA_LSP_PROJECTS_JSON);
  requireValue(projects.aliases?.some(row => row.id === "lishuedu" && row.root === repo && row.lspEnabled === true),
    "enabled isolated lishuedu alias required");
  const remaining = Date.parse(deadline) - Date.now();
  requireValue(Number.isFinite(remaining) && remaining > 0 && remaining <= 2147483647, "valid acceptance deadline required");
  const signal = AbortSignal.timeout(remaining);
  const prepared = await verifyPreparedLishuedu(result, { repoRoot: repo, gradleHome: jdtGradleHome(), ownerHome: process.env.HOME, signal });
  const target = path.join(repo, sourceFile);
  requireValue(await managedPath(repo, target) === target, "lishuedu source anchor must be canonical");
  const source = await readFile(target);
  const definition = anchor(source.toString("utf8"), "void initialize() {");
  const reference = anchor(source.toString("utf8"), "initialize();");
  Object.assign(process.env, { JAVA_LSP_PREPARED_JAR_INDEX_DIR: prepared.indexRoot, JAVA_LSP_LOMBOK_JAR: prepared.appLombok,
    JAVA_LSP_ISOLATED_GRADLE_PROXY_PORT: prepared.gradleProxyPort,
    JDTLS_START_TIMEOUT_MS: "120000", JDTLS_INDEX_TIMEOUT_MS: "600000" });

  const { JavaLspHttpServer } = await import("../dist/http-server.js");
  const daemon = new JavaLspHttpServer({ port: 0 });
  const client = new Client({ name: "lishuedu-prepared-acceptance", version: "1" });
  let failure;
  try {
    signal.throwIfAborted();
    const address = await daemon.start();
    const endpoint = await readJson(path.join(cache, "owner-endpoint.json"));
    requireValue(address.host === "127.0.0.1" && ![38456, 38457].includes(address.port)
      && endpoint.pid === process.pid && endpoint.url === address.url, "owner endpoint identity mismatch");
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)), { signal, timeout: 15000 });
    async function call(name, args) {
      const response = await client.callTool({ name, arguments: { repoRoot: repo, detail: "diagnostic", ...args } }, undefined, { signal, timeout: 15000 });
      const body = response.content?.find(row => row.type === "text")?.text;
      if (response.isError) throw new Error(body ?? "MCP tool failed");
      return response.structuredContent ?? JSON.parse(body);
    }
    const status = async () => {
      const value = await call("java_status", { start: false });
      requireValue(value.repoRoot === repo, "owner resolved a different repository");
      return value;
    };
    let current;
    do {
      current = await status();
      requireValue(!current.started && !current.pid && !current.startingPid, "JDT started before preflight");
      if (current.indexView?.state === "FRESH") break;
      await delay(750, undefined, { signal });
    } while (true);
    const probe = await call("java_symbol", { operation: "query", backend: "static", searchMode: "exact", query: fqn, limit: 5, preview: "none" });
    const hit = probe.candidates?.[0]?.declaration;
    const view = probe.indexView;
    requireValue(view?.state === "FRESH" && /^w-[a-f0-9]+$/.test(view.workspaceId) && /^s-[a-z0-9]+-[a-f0-9]+$/.test(view.snapshotId)
      && hit?.fqn === fqn && hit.relativePath === sourceFile && hit.contentHash === sha256(source), "static snapshot did not match lishuedu source");
    const binding = await readJson(path.join(cache, "mac1/workspaces", view.workspaceId, "binding.json"));
    requireValue(binding.root.canonicalRoot === repo && binding.snapshotId === view.snapshotId, "static snapshot binding mismatch");
    console.log(JSON.stringify({ phase: "preflight", status: "PASS", prepared, owner: endpoint, snapshotId: view.snapshotId }));

    const began = Date.now();
    const refAnchor = { ...definition, column: definition.column + 1 };
    let initialError;
    try { await call("java_symbol", { operation: "references", ...refAnchor, semanticTimeoutMs: 3000 }); }
    catch (error) {
      if (!/deadline exceeded during request\.handler|startup\/project import is in progress/i.test(error.message)) throw error;
      initialError = error.message;
    }
    let pid;
    do {
      current = await status();
      const live = current.pid ?? current.startingPid;
      if (live) {
        requireValue(!pid || pid === live, "JDT PID changed during acceptance");
        pid = live;
      }
      if (current.restartBackoff?.lastErrorMessage) throw new Error(current.restartBackoff.lastErrorMessage);
      if (current.state === "READY" && current.started) break;
      await delay(1000, undefined, { signal });
    } while (true);
    const barrier = current.progress?.indexBarrier;
    const importMs = Date.parse(barrier?.startedAt) - began;
    requireValue(pid && barrier?.state === "READY" && barrier.timeoutMs === 600000 && importMs >= 0 && importMs <= 120000,
      "JDT import or index barrier did not satisfy the acceptance budget");
    const readyMs = Date.now() - began;
    const matches = (item, expected) => {
      const file = item.path ?? item.relativePath;
      return file && (path.isAbsolute(file) ? path.relative(repo, file) : file) === expected.file
        && item.line === expected.line && item.column === expected.column;
    };
    const exact = await call("java_symbol", { operation: "position", ...reference, column: reference.column + 1, semanticTimeoutMs: 10000 });
    requireValue(exact.definitions?.some(item => matches(item, definition)), "exact definition did not match lishuedu source");
    const refs = await call("java_symbol", { operation: "references", ...refAnchor, includeDeclaration: false, positionsPerFile: 20, limit: 100, semanticTimeoutMs: 10000 });
    requireValue(refs.groups?.some(group => group.files?.some(file => file.positions?.some(item => matches({ ...item, path: file.path }, reference)))),
      "exact reference did not match lishuedu source");
    const after = await status();
    requireValue(after.started && after.pid === pid && after.semanticGateway.cacheMisses > current.semanticGateway.cacheMisses, "semantic queries did not reach the same live JDT");
    return { phase: "semantic", status: "PASS", pid, initialError, importMs, readyMs, barrier, definition, reference };
  } catch (error) { failure = error; throw error; }
  finally {
    const clientError = await client.close().then(() => null, error => error);
    const daemonError = await daemon.shutdown().then(() => null, error => error);
    for (const error of [clientError, daemonError].filter(Boolean)) console.error(error);
    if (!failure && (clientError || daemonError)) throw clientError ?? daemonError;
  }
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await accept(cliOptions(process.argv.slice(2), ["--result", "--repo", "--deadline"])))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
