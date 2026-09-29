export interface SearchDocument {
  documentId: string; declarationId: string; path: string; contentHash: string;
  representationVersion: 1;
  sourceKind: "signature"|"comment"|"framework-key";
  startLine: number; endLine: number; normalizedText: string;
}
export function searchDocumentId(d: Omit<SearchDocument,"documentId">): string {
  return [d.declarationId,d.sourceKind,d.startLine,d.endLine,d.contentHash,d.representationVersion].join("|");
}