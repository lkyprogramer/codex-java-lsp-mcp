// input: Type/method facts or a task string.
// output: Identifier/chunk tokens and BM25 scores. No store I/O.
// pos: P0-T7 extraction from entity-search.ts; query and SQL writer share these functions.
import type { JavaFieldFacts, JavaMethodFacts, JavaTypeFacts } from "./index-types.js";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
const ASCII_STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "for", "with", "on", "by"]);

export function fileStem(relativePath: string): string {
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.replace(/\.java$/i, "");
}

export function unique(tokens: readonly string[]): string[] {
  return [...new Set(tokens.filter(Boolean))];
}

/** Split camelCase / PascalCase / snake_case / digits without touching CJK runs. */
export function splitIdentifier(token: string): string[] {
  if (!token) return [];
  if (/^\p{Script=Han}+$/u.test(token)) return [token];
  const withSplits = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ");
  return withSplits
    .split(/\s+/)
    .map(part => part.toLowerCase())
    .filter(part => part.length > 0 && !ASCII_STOP.has(part));
}

/**
 * Lexical tokenize for queries and source-derived text.
 * CJK runs pass through as a whole token plus adjacent bigrams (no dictionary).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const source = text.normalize("NFKC");
  const matcher = /[A-Za-z][A-Za-z0-9_]*|[0-9]+|\p{Script=Han}+/gu;
  for (const match of source.matchAll(matcher)) {
    const lexeme = match[0]!;
    if (/^\p{Script=Han}+$/u.test(lexeme)) {
      tokens.push(lexeme);
      if (lexeme.length >= 2) {
        for (let index = 0; index < lexeme.length - 1; index += 1) {
          tokens.push(lexeme.slice(index, index + 2));
        }
      }
      continue;
    }
    const lowered = lexeme.toLowerCase();
    if (!ASCII_STOP.has(lowered)) tokens.push(lowered);
    tokens.push(...splitIdentifier(lexeme));
  }
  return unique(tokens);
}

export function extractFqnCandidates(text: string): string[] {
  const matches = text.match(/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+(?:#[A-Za-z_][\w]*)?/g) ?? [];
  const hashed = text.match(/[A-Za-z_][\w]*#[A-Za-z_][\w]*/g) ?? [];
  return unique([...matches, ...hashed]);
}

/** Whole identifier lexemes before camelCase split — used by the simpleName dictionary. */
export function identifierLexemes(text: string): string[] {
  const source = text.normalize("NFKC");
  const matcher = /[A-Za-z][A-Za-z0-9_]*|\p{Script=Han}+/gu;
  return unique([...source.matchAll(matcher)]
    .map(match => match[0]!.toLowerCase())
    .filter(token => token.length > 1 && !ASCII_STOP.has(token)));
}

export function identifierTokensForType(type: JavaTypeFacts, relativePath: string): string[] {
  return unique([
    ...tokenize(type.simpleName),
    ...tokenize(type.fqn ?? ""),
    ...tokenize(fileStem(relativePath)),
    type.simpleName.toLowerCase()
  ]);
}

export function identifierTokensForMethod(method: JavaMethodFacts, owner: JavaTypeFacts | undefined, relativePath: string): string[] {
  const ownerName = owner?.simpleName ?? "";
  const ownerFqn = owner?.fqn ?? ownerName;
  return unique([
    ...tokenize(method.name),
    ...tokenize(ownerName),
    ...tokenize(`${ownerFqn}#${method.name}`),
    ...tokenize(fileStem(relativePath)),
    method.name.toLowerCase()
  ]);
}

export function chunkTokensForType(type: JavaTypeFacts, fields: readonly JavaFieldFacts[], methods: readonly JavaMethodFacts[]): string[] {
  return unique([
    ...fields.flatMap(field => tokenize(field.name)),
    ...methods.flatMap(method => tokenize(method.name))
  ]);
}

export function chunkTokensForMethod(method: JavaMethodFacts): string[] {
  return unique([
    ...method.parameters.flatMap(parameter => tokenize(parameter.name)),
    ...method.callSites.flatMap(site => tokenize(site.name)),
    ...method.localTypes.flatMap(local => tokenize(local.simpleName)),
    ...tokenize(method.returnType?.simpleName ?? "")
  ]);
}

function idf(df: number, documentCount: number): number {
  return Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
}

export function bm25Score(
  queryTokens: readonly string[],
  documentTf: ReadonlyMap<string, number>,
  documentLength: number,
  avgdl: number,
  dfByToken: ReadonlyMap<string, number>,
  documentCount: number
): number {
  if (queryTokens.length === 0 || documentCount === 0 || avgdl <= 0) return 0;
  let score = 0;
  const seen = new Set<string>();
  for (const token of queryTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const tf = documentTf.get(token) ?? 0;
    if (tf === 0) continue;
    const df = dfByToken.get(token) ?? 0;
    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (documentLength / avgdl));
    score += idf(df, documentCount) * (tf * (BM25_K1 + 1)) / denom;
  }
  return score;
}
