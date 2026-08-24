// input: Unresolved obligations plus a task string and the entity-search index.
// output: Bounded lexical hits used only when graph search left an obligation open.
// pos: N3-03. Cold-nolsp never requires JDT. Zero hits when everything already closed.
import type { EntityHit, EntitySearchIndex } from "../java-index/entity-search.js";
import type { GraphSearchResult } from "./graph-search.js";

export function shouldLexicalFallback(result: GraphSearchResult, taskText: string): boolean {
  const tokens = taskText.trim();
  if (!tokens) return false;
  const covered = new Set(result.bundles.map(bundle => bundle.path.split("/").pop()?.replace(/\.java$/i, "").toLowerCase()));
  return ![...tokens.split(/\W+/).filter(token => token.length > 2)].every(token => [...covered].some(name => name?.includes(token.toLowerCase())));
}

export function lexicalFallbackHits(index: EntitySearchIndex, taskText: string, limit = 5): EntityHit[] {
  return index.search(taskText, limit);
}
