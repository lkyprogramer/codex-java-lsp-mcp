// input: a public symbol reference (a mac1 symbolId, or a name: FQN, Type#method or Type#method(sig)).
// output: one static-index declaration to anchor on, or why there is none (rejected id, miss or candidates).
// pos: Shared by java_impact(symbol=...) and java_symbol(symbolId=...). Never guesses between candidates.
import { runStaticDiscovery } from "../discovery/query.js";
import { declarationStability, formatSymbolId, parseSymbolId, type SymbolResolution } from "../java-index/symbol-identity.js";
import type { RequestContext } from "../runtime/request-context.js";
import type { ToolContext } from "./context.js";

/** At most this many candidates are listed for an ambiguous name. */
export const SYMBOL_CANDIDATE_LIMIT = 10;

export type SymbolTarget = { relativePath: string; line: number; column: number; symbolId?: string };

export type SymbolCandidate = {
  symbolId?: string;
  stability: "STABLE" | "SNAPSHOT";
  kind: string;
  name: string;
  signature: string;
  relativePath: string;
  module: string;
  sourceRoot: string;
  selection: { line: number; column: number };
};

export type SymbolMiss = {
  status: "REJECTED" | "NOT_FOUND" | "AMBIGUOUS" | "NOT_READY";
  symbol: string;
  reason?: string;
  candidates?: SymbolCandidate[];
  hint: string;
};

const RELOCATE = 'Re-locate with java_symbol({operation:"query", query:"<Type or Type#method>"}) and pass a returned declaration.symbolId.';

export function isSymbolIdLike(symbol: string): boolean {
  return /^(jsym|jev):/.test(symbol) || /^(type|type-local|method|field|file):/.test(symbol);
}

/** One declaration, or why not. A name that matches several declarations (overloads, one FQN in several source roots) lists them. */
export async function locateSymbol(
  context: ToolContext,
  symbol: string,
  request?: Pick<RequestContext, "budget">
): Promise<{ ok: true; target: SymbolTarget } | { ok: false; miss: SymbolMiss }> {
  const view = context.indexView;
  const client = context.javaIndexClient;
  if (!client || view?.state === "NOT_READY") {
    return { ok: false, miss: { status: "NOT_READY", symbol, hint: "This workspace has no verified index view yet; retry shortly or poll java_status." } };
  }
  if (isSymbolIdLike(symbol)) {
    const parsed = parseSymbolId(symbol);
    if (!parsed.ok) {
      const hint = parsed.reason === "PRE_MAC1_FORMAT" ? `Ids issued before mac1 are no longer accepted. ${RELOCATE}`
        : parsed.reason === "NOT_STABLE" ? `A local or anonymous declaration has no lasting symbolId. ${RELOCATE}` : `Not a mac1 symbolId. ${RELOCATE}`;
      return { ok: false, miss: { status: "REJECTED", symbol, reason: parsed.reason, hint } };
    }
    if (!view?.workspaceId || !client.resolveSymbolIds) {
      return { ok: false, miss: { status: "NOT_READY", symbol, hint: "symbolIds resolve against a workspace snapshot view; none is held for this request." } };
    }
    const [resolution] = await client.resolveSymbolIds(view.workspaceId, [symbol], request ? { budget: request.budget } : undefined);
    return fromResolution(symbol, resolution);
  }
  const result = await runStaticDiscovery(client, {
    query: symbol,
    searchMode: "exact",
    limit: SYMBOL_CANDIDATE_LIMIT,
    preview: "none",
    repoRoot: context.repoRoot,
    repoHash: context.repoHash,
    budget: request ? { remainingMs: () => request.budget.remainingMs() } : undefined
  });
  const candidates = result.candidates.map(candidate => publicCandidate(candidate.declaration, view?.workspaceId));
  const only = result.candidates.length === 1 && result.candidates[0]!.binding === "source-declaration" ? result.candidates[0]!.declaration : undefined;
  if (only && result.exact === "match" && !result.selectionLimited) {
    return { ok: true, target: { relativePath: only.relativePath, line: only.selection.line, column: only.selection.column, ...symbolIdOf(only.id, view?.workspaceId) } };
  }
  if (candidates.length > 0) {
    return { ok: false, miss: { status: "AMBIGUOUS", symbol, candidates, hint: "Several declarations match; pass one candidate's symbolId (or a Type#method(sig) name) instead. Nothing was guessed." } };
  }
  const partial = result.scopeState !== "READY" || result.stopReason !== undefined;
  return { ok: false, miss: { status: partial ? "NOT_READY" : "NOT_FOUND", symbol, ...(result.stopReason ? { reason: result.stopReason } : {}),
    hint: partial ? "The index could not settle this lookup (partial or interrupted); retry shortly." : "No indexed declaration has this name. Use java_symbol operation=query with a text query to search." } };
}

function fromResolution(symbol: string, resolution: SymbolResolution | undefined): { ok: true; target: SymbolTarget } | { ok: false; miss: SymbolMiss } {
  if (resolution?.status === "FOUND") {
    return { ok: true, target: { relativePath: resolution.relativePath, line: resolution.selection.line, column: resolution.selection.column, symbolId: symbol } };
  }
  if (resolution?.status === "NOT_FOUND") {
    return { ok: false, miss: { status: "NOT_FOUND", symbol, reason: "DECLARATION_CHANGED",
      hint: `${resolution.hint.relocate} (${resolution.hint.sameNameCandidates} ${resolution.hint.kind} declaration(s) named ${resolution.hint.name}). ${RELOCATE}` } };
  }
  const reason = resolution?.status === "REJECTED" ? resolution.reason : "MALFORMED";
  const hint = reason === "WORKSPACE_MISMATCH" ? `This symbolId belongs to another workspace (or a replaced root). ${RELOCATE}` : `Not a usable symbolId. ${RELOCATE}`;
  return { ok: false, miss: { status: "REJECTED", symbol, reason, hint } };
}

function symbolIdOf(key: string, workspaceId: string | undefined): { symbolId?: string } {
  if (!workspaceId || declarationStability(key) !== "STABLE") return {};
  try { return { symbolId: formatSymbolId(workspaceId, key) }; } catch { return {}; }
}

function publicCandidate(declaration: { id: string; kind: string; name: string; signature: string; relativePath: string; module: string; sourceRoot: string; selection: { line: number; column: number } }, workspaceId: string | undefined): SymbolCandidate {
  return {
    ...symbolIdOf(declaration.id, workspaceId),
    stability: declarationStability(declaration.id),
    kind: declaration.kind,
    name: declaration.name,
    signature: declaration.signature,
    relativePath: declaration.relativePath,
    module: declaration.module,
    sourceRoot: declaration.sourceRoot,
    selection: declaration.selection
  };
}
