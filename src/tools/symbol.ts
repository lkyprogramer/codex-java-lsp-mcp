// input: java_symbol query, source position, reference lookup, or explicit evidence request.
// output: Symbol context, references, or bounded source units linked to a located declaration.
// pos: Public symbol tool handler. Folds the retired java_references tool in as
//      operation="references" (Task 31 Step 7 - measured 235 saved tokens on tools/list,
//      cleared the plan's savedTokens>=200 merge gate).
import { z } from "zod";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import { clampLimit, normalizeRepoFile } from "../repo-layout.js";
import { DISCOVERY_DEFAULT_LIMIT, DISCOVERY_MAX_LIMIT, runStaticDiscovery, type DiscoveryResult } from "../discovery/query.js";
import { runEvidenceUnit, type EvidenceUnitResult } from "../discovery/evidence-unit.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { LspLocation, LspLocationLink } from "../jdtls-session.js";
import type { RequestContext } from "../runtime/request-context.js";
import { declarationStability, formatSymbolId, type DeclarationIdentity } from "../java-index/symbol-identity.js";
import type { ToolContext } from "./context.js";
import { isSymbolIdLike, locateSymbol } from "./symbol-target.js";
import { compact, describeFile, describeLocation, detailSchema, isDiagnosticDetail, normalizeHover, symbolKindName, type ResponseDetail } from "./shared.js";

// R07: the static query limit contract comes from the one discovery/SQL
// constant. The schema field is shared with references/jdt (clamped at
// SYMBOL_LIMIT_MAX); a static query outside 1..DISCOVERY_MAX_LIMIT is
// rejected by discovery, never clamped, and the description says so.
export const SYMBOL_LIMIT_MAX = 300;
export const STATIC_QUERY_LIMIT_DESCRIPTION =
  `limit 1..${DISCOVERY_MAX_LIMIT} (default ${DISCOVERY_DEFAULT_LIMIT}; larger is rejected; selectionLimited=true means more matched)`;

export const symbolSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  operation: z.enum(["query", "position", "references", "evidence"]).optional(),
  query: z.string().min(1).max(512).optional(),
  symbolId: z.string().min(1).max(4096).optional()
    .describe("Instead of file/line/column for evidence/references/position: a declaration.symbolId from an earlier java_symbol query."),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(SYMBOL_LIMIT_MAX).optional(),
  semanticTimeoutMs: z.number().int().positive().max(10000).default(3000),
  includeDeclaration: z.boolean().default(false),
  positionsPerFile: z.number().int().positive().max(20).default(3),
  module: z.string().min(1).optional(),
  layer: z.string().min(1).optional(),
  sourceSet: z.enum(["main", "test"]).optional(),
  // T06: operation=query defaults to the static discovery backend (on-disk
  // index, no JDT); backend=jdt keeps the legacy workspace-symbol channel.
  backend: z.enum(["static", "jdt"]).optional(),
  searchMode: z.enum(["auto", "exact", "text"]).optional(),
  terms: z.array(z.string().min(1).max(64)).max(6).optional(),
  // Static query previews: head (default, short declaration heads under a
  // small per-request cap), window (12-line windows) or none (locators only).
  preview: z.enum(["none", "head", "window"]).optional(),
  detail: detailSchema
};

type SymbolArgs = z.infer<z.ZodObject<typeof symbolSchema>>;
type SymbolRequest = Pick<RequestContext, "budget"> & Partial<Pick<RequestContext, "negativeLookupAllowed">>;

/** T06: single JDT admission predicate shared by the public registration
 *  (mayStartLsp/requireLspEnabled) and the handler, so a static query can
 *  never be admitted by one layer and rejected by the other. */
export function symbolNeedsJdt(args: Pick<SymbolArgs, "operation" | "query" | "backend">): boolean {
  const operation = args.operation ?? (args.query ? "query" : "position");
  if (operation === "evidence") return false;
  const backend = args.backend ?? (operation === "query" ? "static" : "jdt");
  return operation !== "query" || backend === "jdt";
}

export async function javaSymbol(
  context: ToolContext,
  args: SymbolArgs,
  request?: SymbolRequest
): Promise<unknown> {
  const operation = args.operation ?? (args.query ? "query" : "position");
  if (args.symbolId !== undefined) {
    if (operation === "query" || args.file !== undefined || args.line !== undefined || args.column !== undefined) {
      throw new JavaIntelligenceError("INVALID_INPUT",
        'symbolId replaces file/line/column for operation=evidence|references|position, e.g. {"operation":"evidence","symbolId":"jsym:mac1:..."}; it does not combine with query or a position.');
    }
    if (!isSymbolIdLike(args.symbolId)) {
      throw new JavaIntelligenceError("INVALID_INPUT", 'symbolId takes an id from java_symbol results; to look a name up use {"operation":"query","query":"OrderService#create"}.');
    }
    if (context.javaIndexClient) await waitStaticIndexReady(context.javaIndexClient, request?.budget);
    const located = await locateSymbol(context, args.symbolId, request);
    // A rejected, changed or deleted symbol is reported with a re-locate hint, never rebound.
    if (!located.ok) return { ...located.miss, ...(context.indexView ? { indexView: context.indexView } : {}) };
    return javaSymbol(context, { ...args, symbolId: undefined, operation, file: located.target.relativePath, line: located.target.line, column: located.target.column }, request);
  }
  if (operation === "evidence") {
    if (!args.file || !args.line || !args.column) {
      throw new Error("java_symbol operation=evidence requires file/line/column of a located Java type or method.");
    }
    if (args.backend === "jdt") {
      throw new Error("java_symbol operation=evidence uses the static index, not backend=jdt.");
    }
    const client = context.javaIndexClient;
    if (!client) throw new Error("java_symbol operation=evidence requires the on-disk Java index.");
    await waitStaticIndexReady(client, request?.budget);
    return staticResultForView(await withPublicIdentity(await runEvidenceUnit(client, {
      repoRoot: context.repoRoot,
      file: args.file,
      line: args.line,
      column: args.column,
      budget: request?.budget
    }), context, request), context, request);
  }
  if (operation === "references") {
    return javaSymbolReferences(context, args, request);
  }
  if (operation === "query") {
    if (!args.query) {
      throw new Error("java_symbol operation=query requires query.");
    }
    const backend = args.backend ?? "static";
    if (backend !== "jdt") {
      const client = context.javaIndexClient;
      if (!client) {
        throw new Error("java_symbol operation=query backend=static requires the on-disk Java index; open the repository first.");
      }
      // A cold repo may still be building its snapshot; the static route waits
      // for the index to become servable instead of answering "not open",
      // mirroring the router's lazy-open semantics for java_impact.
      await waitStaticIndexReady(client, request?.budget);
      // Static discovery consumes the shared index snapshot; it never touches
      // the LSP session, so no semantic timeout is projected onto it. The
      // request deadline (when present) bounds the query work instead.
      return staticResultForView(await withPublicIdentity(await runStaticDiscovery(client, {
        query: args.query,
        terms: args.terms,
        searchMode: args.searchMode,
        limit: args.limit,
        module: args.module,
        sourceSet: args.sourceSet,
        preview: args.preview,
        repoRoot: context.repoRoot,
        repoHash: context.repoHash,
        budget: request ? { remainingMs: () => request.budget.remainingMs() } : undefined
      }), context, request), context, request);
    }
    const limit = clampLimit(args.limit);
    const result = await context.session.workspaceSymbols(args.query, limit, request?.budget ?? args.semanticTimeoutMs);
    return {
      mode: "query",
      query: args.query,
      limit,
      truncated: result.truncated,
      // A workspace symbol whose only location is outside the repo is dropped
      // entirely: without a location it is not actionable evidence.
      items: (await Promise.all(result.items.map(async item => {
        const location = item.location
          ? await describeLocation(context.repoRoot, item.location, { detail: args.detail })
          : undefined;
        if (item.location && !location) {
          return undefined;
        }
        return {
          name: item.name,
          kind: symbolKindName(item.kind),
          containerName: item.containerName,
          location
        };
      }))).filter(item => item !== undefined)
    };
  }
  if (!args.file || !args.line || !args.column) {
    throw new Error("java_symbol requires either query, or file/line/column, or operation=references with file/line/column.");
  }
  const file = normalizeRepoFile(context.repoRoot, args.file);
  // symbolContext() degrades every failure to an absent field: a closed semantic domain is reported, not hidden.
  context.session.assertSemanticAdmission?.();
  const result = await context.session.symbolContext(file, args.line, args.column, request?.budget ?? args.semanticTimeoutMs);
  throwIfJdtImporting(context);
  return {
    mode: "position",
    file: isDiagnosticDetail(args.detail) ? file : describeFile(context.repoRoot, file).path,
    line: args.line,
    column: args.column,
    hover: normalizeHover(result.hover),
    definitions: await describeContainedLocations(context.repoRoot, result.definitions, args.detail),
    implementations: await describeContainedLocations(context.repoRoot, result.implementations, args.detail)
  };
}

/**
 * Public identity (§2.8): a declaration key never leaves the server. A named declaration is
 * returned as its workspace-bound mac1 symbolId; a position-keyed one only as stability=SNAPSHOT
 * with an evidence handle of the held snapshot, when the view can mint it. A named declaration
 * gets no handle: its symbolId plus evidenceRange.contentHash already pin it, and a handle would
 * repeat the view, path and hash in every candidate (MAC-13 dev eval: +46% payload).
 */
async function withPublicIdentity<T extends DiscoveryResult | EvidenceUnitResult>(result: T, context: ToolContext, request?: SymbolRequest): Promise<T> {
  const view = context.indexView;
  const keys = "units" in result ? (result.anchor ? [result.anchor.declarationId] : []) : result.candidates.map(candidate => candidate.declaration.id);
  const snapshotKeys = [...new Set(keys.filter(key => declarationStability(key) !== "STABLE"))];
  const minted = new Map<string, DeclarationIdentity>();
  if (snapshotKeys.length > 0 && view?.workspaceId && view.contentManifestId && context.javaIndexClient?.declarationIdentities) {
    const identities = await context.javaIndexClient.declarationIdentities(view.workspaceId, view.contentManifestId, snapshotKeys, request ? { budget: request.budget } : undefined)
      .catch(() => undefined);
    identities?.forEach((identity, index) => minted.set(snapshotKeys[index]!, identity));
  }
  const identity = (key: string): DeclarationIdentity => {
    const handled = minted.get(key);
    if (handled) return handled;
    const stability = declarationStability(key);
    if (stability !== "STABLE" || !view?.workspaceId) return { stability };
    try { return { stability, symbolId: formatSymbolId(view.workspaceId, key) }; } catch { return { stability }; }
  };
  if ("units" in result) {
    if (!result.anchor) return result;
    const { declarationId, ...anchor } = result.anchor;
    return { ...result, anchor: { ...anchor, ...identity(declarationId) } } as unknown as T;
  }
  // Same result shape for the view labeling below; only the declaration's id is swapped.
  return {
    ...result,
    candidates: result.candidates.map(candidate => {
      const { id, ...declaration } = candidate.declaration;
      return { ...candidate, declaration: { ...declaration, ...identity(id) } };
    })
  } as unknown as T;
}

/** Snapshot coverage describes its build; freshness belongs to this request's held view. */
function staticResultForView(result: DiscoveryResult | EvidenceUnitResult, context: ToolContext, request?: SymbolRequest): unknown {
  const view = context.indexView;
  const labels = view ? { indexView: view } : {};
  if ((!view || view.state === "FRESH") && request?.negativeLookupAllowed !== false) return { ...result, ...labels };
  // No verified binding of this workspace: say so instead of a partial answer.
  const scopeState = view?.state === "NOT_READY" ? "NOT_READY" : "PARTIAL";
  if ("units" in result) {
    const reason = view && view.state !== "FRESH" ? `INDEX_VIEW_${view.state}` : "INDEX_COVERAGE_INCOMPLETE";
    return { ...result, ...labels, scopeState, reasons: [...new Set([...result.reasons, reason])] };
  }
  // Positive locators remain useful after their source hash check. A miss or an
  // empty vocabulary cannot establish absence while the workspace is changing.
  // A STALE view is behind edits on disk (source_changed); NOT_READY or a caller
  // that disallows negatives has no complete coverage (index_partial).
  const { exact, emptyReason: _emptyReason, ...rest } = result;
  const stopReason = result.stopReason ?? (view?.state === "STALE" ? "source_changed" : "index_partial");
  return { ...rest, ...labels, scopeState, stopReason, ...(exact && exact !== "miss" ? { exact } : {}) };
}

function throwIfJdtImporting(context: ToolContext, cause?: unknown): void {
  if (context.session.status().state === "STARTING") {
    throw new JavaIntelligenceError("JDT_NOT_READY",
      "JDT startup/project import is in progress. Poll java_status(start=false) until state=READY, then retry this semantic request; import continues in the background.", cause);
  }
}

export async function waitStaticIndexReady(client: JavaIndexClientApi, budget?: DeadlineBudget): Promise<void> {
  try {
    const status = await client.status();
    if (status.state !== "BUILDING") return; // READY/DEGRADED serve the current snapshot; discovery reports its coverage
  } catch {
    // Client not opened yet (cold repository).
  }
  try {
    await client.awaitPrewarmReady(budget ? { budget } : undefined);
  } catch {
    throw new Error("java_symbol static query requires the on-disk Java index, which is not ready yet (repository still building or index unavailable). Retry once the index is READY.");
  }
}

async function javaSymbolReferences(
  context: ToolContext,
  args: SymbolArgs,
  request?: Pick<RequestContext, "budget">
): Promise<unknown> {
  if (!args.file || !args.line || !args.column) {
    throw new Error("java_symbol operation=references requires file/line/column.");
  }
  const file = normalizeRepoFile(context.repoRoot, args.file);
  const limit = clampLimit(args.limit);
  let result;
  try {
    result = await context.session.references(
      file,
      args.line,
      args.column,
      args.includeDeclaration,
      request?.budget ?? args.semanticTimeoutMs
    );
  } catch (error) {
    if (error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED") {
      throwIfJdtImporting(context, error);
    }
    throw error;
  }
  const described = await Promise.all(result.items.map(location => describeLocation(context.repoRoot, location, { detail: args.detail })));
  // describeLocation returns undefined for hits outside this repo (jars, JDK
  // sources); they are counted, not rendered.
  const contained = described.filter((item): item is Record<string, unknown> => item !== undefined);
  const matched = contained
    .filter(item => !args.module || item.module === args.module)
    .filter(item => !args.layer || item.layer === args.layer)
    .filter(item => !args.sourceSet || item.sourceSet === args.sourceSet);
  const filtered = matched.slice(0, limit);
  return {
    totalReferences: result.totalReferences,
    matchedReferences: matched.length,
    returnedReferences: filtered.length,
    externalReferencesSuppressed: described.length - contained.length,
    truncated: result.truncated || matched.length > filtered.length,
    groups: groupReferences(filtered, args.positionsPerFile)
  };
}

function groupReferences(items: Array<Record<string, unknown>>, positionsPerFile: number): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown> & { files: Map<string, Record<string, unknown> & { positions: unknown[]; referenceCount: number }> }>();
  for (const item of items) {
    const groupKey = `${item.module || "unknown"}/${item.layer || "unknown"}`;
    const fileKey = String(item.path || item.relativePath || item.absolutePath || item.uri);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        module: item.module,
        layer: item.layer,
        referenceCount: 0,
        files: new Map()
      };
      groups.set(groupKey, group);
    }
    group.referenceCount = Number(group.referenceCount || 0) + 1;
    let file = group.files.get(fileKey);
    if (!file) {
      file = {
        path: item.path || item.relativePath || item.absolutePath,
        sourceSet: item.sourceSet,
        referenceCount: 0,
        positions: []
      };
      group.files.set(fileKey, file);
    }
    file.referenceCount += 1;
    if (file.positions.length < positionsPerFile) {
      file.positions.push(compact({ line: item.line, column: item.column, range: item.range }));
    }
  }
  return [...groups.values()].map(group => ({
    module: group.module,
    layer: group.layer,
    referenceCount: group.referenceCount,
    files: [...group.files.values()]
  }));
}

async function describeContainedLocations(
  repoRoot: string,
  locations: Array<LspLocation | LspLocationLink>,
  detail: ResponseDetail | undefined
): Promise<Array<Record<string, unknown>>> {
  const described = await Promise.all(
    locations.map(location => describeLocation(repoRoot, location, { detail }))
  );
  return described.filter((item): item is Record<string, unknown> => item !== undefined);
}
