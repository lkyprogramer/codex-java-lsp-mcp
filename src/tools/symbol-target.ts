// input: a public symbol reference (a mac1 symbolId, or a name: FQN, Type#method or Type#method(sig)).
// output: one static-index declaration to anchor on, or why there is none (rejected id, miss or candidates).
// pos: Shared by java_impact(symbol=...) and java_symbol(symbolId=...). Never guesses between candidates.
import { runStaticDiscovery } from "../discovery/query.js";
import { splitOwnerMemberKey } from "../java-index/stable-id.js";
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
  /** More declarations matched than the candidate list holds. */
  truncated?: true;
  hint: string;
};

type LocateRequest = Pick<RequestContext, "budget"> & Partial<Pick<RequestContext, "negativeLookupAllowed">>;

const RELOCATE = 'Re-locate with java_symbol({operation:"query", query:"<Type or Type#method>"}) and pass a returned declaration.symbolId.';

export function isSymbolIdLike(symbol: string): boolean {
  return /^(jsym|jev):/.test(symbol) || /^(type|type-local|method|field|file):/.test(symbol);
}

/** A miss proves absence only from a FRESH view of complete coverage (the MAC-11 miss-suppression rule). */
function absenceProvable(context: ToolContext, request: LocateRequest | undefined): boolean {
  return (!context.indexView || context.indexView.state === "FRESH") && request?.negativeLookupAllowed !== false;
}

const NOT_SETTLED = "The index view is behind the workspace or not complete, so this miss is not proof of absence; retry shortly.";

/**
 * "Type#method(String, int)" -> the parameter types as an erased declaration key spells them: generics,
 * parameter names and whitespace dropped, varargs as []. undefined when the name has no parameter list.
 */
export function selectorParameters(symbol: string): { name: string; parameters: string[] } | undefined {
  const match = /^([^()]*#[^#()]+)\((.*)\)$/s.exec(symbol.trim());
  if (!match) return undefined;
  let depth = 0, current = "";
  const parts: string[] = [];
  for (const character of match[2]!) {
    if (character === "<") depth++;
    else if (character === ">") depth--;
    else if (depth === 0 && character === ",") { parts.push(current); current = ""; }
    else if (depth === 0) current += character;
  }
  parts.push(current);
  // "@NotNull final String... values" -> "String[]": annotations, modifiers and the parameter name go.
  const parameters = parts.map(part => part.replace(/@[\w.]+(\([^)]*\))?/g, " ").replace(/\bfinal\b/g, " ")
    .replace(/\.\.\./g, "[]").replace(/\s*\[\s*\]/g, "[]").trim().split(/\s+/)[0] ?? "");
  return { name: match[1]!.trim(), parameters: parameters.length === 1 && parameters[0] === "" ? [] : parameters };
}

/** Same parameter list, comparing each type by simple name when either side is qualified. */
function parametersMatch(declarationKey: string, wanted: string[]): boolean {
  const member = declarationKey.startsWith("method:") ? splitOwnerMemberKey(declarationKey.slice("method:".length))?.member : undefined;
  const open = member?.indexOf("(") ?? -1;
  if (!member || open < 0 || !member.endsWith(")")) return false;
  const inner = member.slice(open + 1, -1);
  const actual = inner === "" ? [] : inner.split(",").map(type => type.replace(/\.\.\./g, "[]").replace(/\s+/g, ""));
  const simple = (type: string) => type.slice(type.lastIndexOf(".") + 1);
  return actual.length === wanted.length && actual.every((type, index) => type === wanted[index] || simple(type) === simple(wanted[index]!));
}

/** One declaration, or why not. A name that matches several declarations (overloads, one FQN in several source roots) lists them. */
export async function locateSymbol(
  context: ToolContext,
  symbol: string,
  request?: LocateRequest
): Promise<{ ok: true; target: SymbolTarget } | { ok: false; miss: SymbolMiss }> {
  const view = context.indexView;
  const client = context.javaIndexClient;
  if (!client || view?.state === "NOT_READY") {
    return { ok: false, miss: { status: "NOT_READY", symbol, hint: "This workspace has no verified index view yet; retry shortly or poll java_status." } };
  }
  if (isSymbolIdLike(symbol)) {
    if (symbol.startsWith("jev:mac1:")) {
      return { ok: false, miss: { status: "REJECTED", symbol, reason: "MALFORMED", hint: `This is an evidence handle, not a symbolId. ${RELOCATE}` } };
    }
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
    const located = fromResolution(symbol, resolution);
    // An id from a later snapshot than this held view can miss here without being gone.
    if (!located.ok && located.miss.status === "NOT_FOUND" && !absenceProvable(context, request)) {
      return { ok: false, miss: { ...located.miss, status: "NOT_READY", hint: `${NOT_SETTLED} ${located.miss.hint}` } };
    }
    return located;
  }
  // The exact selector matches names only; a parameter list picks among overloads here.
  const signature = selectorParameters(symbol);
  const result = await runStaticDiscovery(client, {
    query: signature?.name ?? symbol,
    searchMode: "exact",
    limit: SYMBOL_CANDIDATE_LIMIT,
    preview: "none",
    repoRoot: context.repoRoot,
    repoHash: context.repoHash,
    budget: request ? { remainingMs: () => request.budget.remainingMs() } : undefined
  });
  const matched = signature ? result.candidates.filter(candidate => parametersMatch(candidate.declaration.id, signature.parameters)) : result.candidates;
  const limited = result.selectionLimited === true || result.candidates.length >= SYMBOL_CANDIDATE_LIMIT;
  const candidates = matched.map(candidate => publicCandidate(candidate.declaration, view?.workspaceId));
  // Discovery marks every hit of a multi-hit name "ambiguous"; the parameter list is what settles them.
  const only = matched.length === 1 && (signature !== undefined || matched[0]!.binding === "source-declaration") ? matched[0]!.declaration : undefined;
  // A capped list may hide a same-named (or same-signature) declaration in another source root.
  const settled = result.exact === "match" || (signature !== undefined && result.exact === "ambiguous");
  if (only && settled && !limited) {
    return { ok: true, target: { relativePath: only.relativePath, line: only.selection.line, column: only.selection.column, ...symbolIdOf(only.id, view?.workspaceId) } };
  }
  if (candidates.length > 0) {
    return { ok: false, miss: { status: "AMBIGUOUS", symbol, candidates, ...(limited ? { truncated: true as const } : {}),
      hint: "Several declarations match; pass one candidate's symbolId (or Type#method(ParamType, ...)) instead. Nothing was guessed." } };
  }
  const partial = result.scopeState !== "READY" || result.stopReason !== undefined || !absenceProvable(context, request) || (signature !== undefined && limited);
  return { ok: false, miss: { status: partial ? "NOT_READY" : "NOT_FOUND", symbol, ...(result.stopReason ? { reason: result.stopReason } : {}),
    hint: partial ? NOT_SETTLED : "No indexed declaration has this name. Use java_symbol operation=query with a text query to search." } };
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
