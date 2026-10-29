// input: a public symbol reference (a mac1 symbolId, or a name: FQN, Type#method or Type#method(sig)).
// output: one static-index declaration to anchor on, or why there is none (rejected id, miss or candidates).
// pos: Shared by java_impact(symbol=...) and java_symbol(symbolId=...). Never guesses between candidates.
import path from "node:path";
import { runStaticDiscovery, type DiscoveryCandidate } from "../discovery/query.js";
import type { JavaMethodFacts, JavaTypeFacts, JavaTypeParameterFact, JavaTypeRef } from "../java-index/index-types.js";
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
 * "Type#method(String, int)" -> each parameter as erased name plus array dimensions: annotations (with their
 * arguments), modifiers, generics and parameter names dropped, varargs as [], "$" nesting as ".".
 * undefined when the name has no parameter list.
 */
export function selectorParameters(symbol: string): { name: string; parameters: string[] } | undefined {
  const match = /^([^()]*#[^#()]+)\((.*)\)$/s.exec(symbol.trim());
  if (!match) return undefined;
  let depth = 0, current = "";
  const parts: string[] = [];
  for (const character of withoutAnnotations(match[2]!)) {
    if (character === "<") depth++;
    else if (character === ">") depth--;
    else if (depth === 0 && character === ",") { parts.push(current); current = ""; }
    else if (depth === 0) current += character;
  }
  parts.push(current);
  // "final String... values" -> "String[]": modifiers and the parameter name go.
  const parameters = parts.map(part => part.replace(/\bfinal\b/g, " ").replace(/\.\.\./g, "[]").replace(/\s*\[\s*\]/g, "[]")
    .replace(/\s*\.\s*/g, ".").trim().split(/\s+/)[0]!.replace(/\$/g, "."));
  return { name: match[1]!.trim(), parameters: parameters.length === 1 && parameters[0] === "" ? [] : parameters };
}

/** "@Named(value = {"a", "b"}) int" -> " int": an annotation's arguments may hold commas, parentheses and strings. */
function withoutAnnotations(text: string): string {
  let out = "";
  for (let index = 0; index < text.length;) {
    const name = text[index] === "@" ? /^@\s*[\w$.]+/.exec(text.slice(index)) : undefined;
    if (!name) { out += text[index++]; continue; }
    index += name[0].length;
    const open = /^\s*\(/.exec(text.slice(index));
    if (open) {
      index += open[0].length;
      for (let depth = 1, quote = ""; index < text.length && depth > 0; index++) {
        const character = text[index]!;
        if (quote) { if (character === "\\") index++; else if (character === quote) quote = ""; }
        else if (character === "\"" || character === "'") quote = character;
        else if (character === "(") depth++;
        else if (character === ")") depth--;
      }
    }
    out += " ";
  }
  return out;
}

type Fit = "yes" | "no" | "maybe";
type MethodFacts = Pick<JavaMethodFacts, "parameters" | "typeParameters" | "ownerTypeId">;

/**
 * Whether a declared parameter list is the wanted one, read from the parsed parameter facts (never the erased
 * key text: its array spelling depends on how the source wrote the type). "maybe" when the facts cannot decide,
 * such as a type variable whose bound is out of reach or a simple source name against a qualified one.
 */
export function parametersFit(method: MethodFacts, wanted: string[], types: readonly Pick<JavaTypeFacts, "typeId" | "enclosingTypeId" | "typeParameters">[] = []): Fit {
  if (method.parameters.length !== wanted.length) return "no";
  let fit: Fit = "yes";
  method.parameters.forEach((parameter, index) => {
    const one = typeFits(parameter.type, wanted[index]!, method, types);
    if (one === "no" || fit === "no") fit = "no";
    else if (one === "maybe") fit = "maybe";
  });
  return fit;
}

function typeFits(type: JavaTypeRef, wanted: string, method: MethodFacts, types: readonly Pick<JavaTypeFacts, "typeId" | "enclosingTypeId" | "typeParameters">[], hops = 0): Fit {
  const dimensions = /(\[\])*$/.exec(wanted)![0].length / 2;
  if (dimensions !== type.arrayDepth) return "no";
  const name = wanted.slice(0, wanted.length - dimensions * 2);
  if (type.resolution.state === "TYPE_VARIABLE") {
    if (name === type.resolution.name) return "yes";
    // A type variable erases to its first bound (Object when unbounded).
    const variable = typeVariable(type.resolution.name, method, types);
    if (!variable) return "maybe";
    const bound = variable.bounds[0];
    if (!bound) return name === "Object" || name === "java.lang.Object" ? "yes" : "no";
    // <U extends T>: a bound that is itself a type variable erases through that variable.
    const chained = bound.resolution.state === "TYPE_VARIABLE" ? bound.resolution.name
      : bound.text !== type.resolution.name && typeVariable(bound.text, method, types) ? bound.text : undefined;
    if (chained !== undefined) {
      return hops >= 8 || chained === type.resolution.name ? "maybe"
        : typeFits({ ...type, resolution: { state: "TYPE_VARIABLE", name: chained } }, wanted, method, types, hops + 1);
    }
    return typeFits({ ...bound, arrayDepth: dimensions }, wanted, method, types);
  }
  const simple = (text: string) => text.slice(text.lastIndexOf(".") + 1);
  const declaredSimple = type.simpleName.replace(/\$/g, ".");
  if (simple(declaredSimple) !== simple(name)) return "no";
  if (!name.includes(".")) return "yes";
  const nested = (outer: string, inner: string) => outer === inner || outer.endsWith(`.${inner}`);
  const resolution = type.resolution;
  // Only an import, java.lang, the enclosing scope or a repo match proves the FQN. An EXTERNAL "QUALIFIED"
  // name is the source spelling ("Map.Entry" under an import of Map), and a wildcard or repo-unique pick is a guess.
  const proven = resolution.state === "EXTERNAL" ? (resolution.strategy !== "QUALIFIED" ? resolution.qualifiedName : undefined)
    : resolution.state === "RESOLVED_REPO" ? fqnOfNamedTypeId(resolution.typeId) : undefined;
  if (proven) {
    if (nested(proven.replace(/\$/g, "."), name)) return "yes";
    const guessed = resolution.state === "RESOLVED_REPO" && (resolution.strategy === "WILDCARD_IMPORT" || resolution.strategy === "REPO_UNIQUE_SIMPLE_NAME");
    return guessed ? "maybe" : "no";
  }
  // Otherwise only the source spelling is known.
  const source = type.text.split("<")[0]!.replace(/\[\s*\]|\s+/g, "").replace(/\$/g, ".");
  return nested(source, name) ? "yes" : nested(name, source) ? "maybe" : "no";
}

function typeVariable(name: string, method: MethodFacts, types: readonly Pick<JavaTypeFacts, "typeId" | "enclosingTypeId" | "typeParameters">[]): JavaTypeParameterFact | undefined {
  const own = method.typeParameters.find(parameter => parameter.name === name);
  if (own) return own;
  const byId = new Map(types.map(type => [type.typeId, type]));
  for (let owner = byId.get(method.ownerTypeId), hops = 0; owner && hops < 32; owner = owner.enclosingTypeId ? byId.get(owner.enclosingTypeId) : undefined, hops++) {
    const found = owner.typeParameters.find(parameter => parameter.name === name);
    if (found) return found;
  }
  return undefined;
}

function fqnOfNamedTypeId(typeId: string): string | undefined {
  if (!typeId.startsWith("type:v2:")) return undefined;
  try { return decodeURIComponent(typeId.slice(typeId.lastIndexOf("#") + 1)); } catch { return undefined; }
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
        : parsed.reason === "NOT_STABLE" ? `A local or anonymous declaration has no lasting symbolId. ${RELOCATE}` : `Malformed or obsolete declaration key in symbolId. ${RELOCATE}`;
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
  const { fits, unread } = signature ? await signatureFits(context, result.candidates, signature.parameters, request)
    : { fits: result.candidates.map((): Fit => "yes"), unread: false };
  const matched = result.candidates.filter((_, index) => fits[index] !== "no");
  const uncertain = result.candidates.some((_, index) => fits[index] === "maybe");
  const limited = result.selectionLimited === true || result.candidates.length >= SYMBOL_CANDIDATE_LIMIT;
  const candidates = matched.map(candidate => publicCandidate(candidate.declaration, view?.workspaceId));
  // Discovery marks every hit of a multi-hit name "ambiguous"; the parameter list is what settles them.
  const only = matched.length === 1 && !uncertain && (signature !== undefined || matched[0]!.binding === "source-declaration") ? matched[0]!.declaration : undefined;
  // A capped list may hide a same-named (or same-signature) declaration in another source root.
  const settled = result.exact === "match" || (signature !== undefined && result.exact === "ambiguous");
  if (only && settled && !limited) {
    return { ok: true, target: { relativePath: only.relativePath, line: only.selection.line, column: only.selection.column, ...symbolIdOf(only.id, view?.workspaceId) } };
  }
  if (candidates.length > 0) {
    return { ok: false, miss: { status: "AMBIGUOUS", symbol, candidates, ...(limited ? { truncated: true as const } : {}),
      hint: unread ? "The parameter facts of these declarations could not be read (budget or index); retry, or pass one candidate's symbolId instead. Nothing was guessed."
        : uncertain ? "The parameter types could not be compared exactly against these declarations; pass one candidate's symbolId instead. Nothing was guessed."
        : "Several declarations match; pass one candidate's symbolId (or Type#method(ParamType, ...)) instead. Nothing was guessed." } };
  }
  const partial = result.scopeState !== "READY" || result.stopReason !== undefined || !absenceProvable(context, request) || (signature !== undefined && limited);
  return { ok: false, miss: { status: partial ? "NOT_READY" : "NOT_FOUND", symbol, ...(result.stopReason ? { reason: result.stopReason } : {}),
    hint: partial ? NOT_SETTLED : result.candidates.length > 0
      ? "Declarations with this name exist, but none has this parameter list; drop the list to see them as candidates."
      : "No indexed declaration has this name. Use java_symbol operation=query with a text query to search." } };
}

/** Each candidate against the wanted parameter list, from the parsed method facts of its file (one batched read). */
async function signatureFits(context: ToolContext, candidates: readonly DiscoveryCandidate[], wanted: string[], request: LocateRequest | undefined): Promise<{ fits: Fit[]; unread: boolean }> {
  const methods = candidates.filter(candidate => candidate.declaration.id.startsWith("method:"));
  const files = [...new Set(methods.map(candidate => candidate.declaration.relativePath))];
  let unread = false;
  let bundles: Awaited<ReturnType<NonNullable<ToolContext["javaIndexClient"]>["queryFiles"]>> = [];
  try {
    if (files.length > 0) bundles = await context.javaIndexClient!.queryFiles(files.map(file => path.join(context.repoRoot, file)), request ? { budget: request.budget } : undefined);
  } catch {
    // Unreadable facts decide nothing: those candidates stay listed, never picked.
    unread = true;
  }
  const fits = candidates.map((candidate): Fit => {
    if (!candidate.declaration.id.startsWith("method:")) return "no";
    const bundle = bundles.find(entry => entry.methods.some(method => method.methodId === candidate.declaration.id));
    const method = bundle?.methods.find(entry => entry.methodId === candidate.declaration.id);
    if (!method) unread = true;
    return method ? parametersFit(method, wanted, bundle!.types) : "maybe";
  });
  return { fits, unread };
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
